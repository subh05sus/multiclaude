import { join } from 'node:path';
import { MC_DIR } from './paths.ts';
import type { Config } from './config.ts';
import type { Usage, UsageWindow } from './usage.ts';
import { readJson, writeJson, notify, logActivity } from './util.ts';

const STATE = join(MC_DIR, 'alert-state.json');

interface Fired {
  /** Highest threshold already announced for this window. */
  level: number;
  resetsAt?: number;
}

type AlertState = Record<string, Fired>;

const WINDOWS: { key: 'fiveHour' | 'sevenDay'; label: string }[] = [
  { key: 'fiveHour', label: '5-hour' },
  { key: 'sevenDay', label: 'weekly' },
];

function when(ms?: number): string {
  if (!ms) return 'soon';
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

/** Two readings of one window can differ by a little in their reset time (seconds vs ms). */
function sameWindow(a?: number, b?: number): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a - b) < 5 * 60_000;
}

/** True when this reading would announce a new threshold crossing (used to confirm it first). */
export function wouldAlert(cfg: Config, profile: string, u: Usage): boolean {
  if (!cfg.alerts.enabled || u.error) return false;
  const state = readJson<AlertState>(STATE, {});
  const thresholds = [...cfg.alerts.thresholds].sort((a, b) => a - b);
  return WINDOWS.some((w) => {
    const win = u[w.key];
    if (!win) return false;
    const crossed = thresholds.filter((t) => win.pct >= t).pop();
    const prev = state[`${profile}|${w.key}`];
    return crossed !== undefined && !(prev && prev.level >= crossed && sameWindow(prev.resetsAt, win.resetsAt));
  });
}

/**
 * Compare fresh usage against the thresholds and announce anything new.
 * `next` names the account a switch would go to, for the message.
 */
export function checkAlerts(cfg: Config, profile: string, u: Usage, next: () => string | null): void {
  if (!cfg.alerts.enabled || u.error) return;
  const state = readJson<AlertState>(STATE, {});
  const thresholds = [...cfg.alerts.thresholds].sort((a, b) => a - b);
  let changed = false;

  for (const w of WINDOWS) {
    const key = `${profile}|${w.key}`;
    const win: UsageWindow | undefined = u[w.key];
    const prev = state[key];

    // A window that was announced and has now reset.
    if (prev && (!win || win.pct < (thresholds[0] ?? 0)) && prev.level > 0 && (!prev.resetsAt || prev.resetsAt <= Date.now() + 60_000)) {
      if (cfg.alerts.notifyReset) {
        notify('multiclaude', `${profile}'s ${w.label} limit has reset. It's ready to use again.`);
        logActivity('reset', `${w.label} window reset`, profile);
      }
      delete state[key];
      changed = true;
      continue;
    }
    if (!win) continue;
    const crossed = thresholds.filter((t) => win.pct >= t).pop();
    if (crossed === undefined || (prev && prev.level >= crossed && sameWindow(prev.resetsAt, win.resetsAt))) continue;

    const n = next();
    const tail = n ? ` Next in your order with room: ${n}. Run "mc next" to move there, or press "Move to ${n}" under the prompt once it appears.` : '';
    notify('multiclaude', `${profile} is at ${Math.round(win.pct)}% of its ${w.label} limit (resets ${when(win.resetsAt)}).${tail}`);
    logActivity('alert', `${Math.round(win.pct)}% of the ${w.label} limit${n ? `; next with room: ${n}` : ''}`, profile);
    state[key] = { level: crossed, resetsAt: win.resetsAt };
    changed = true;
  }
  if (changed) writeJson(STATE, state);
}
