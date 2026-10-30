# multiclaude decisions

## 2026-10-30 — scope and product

- Build "Switcher + API fallback": profiles per Claude account with shared history, settings, skills, plugins,
  MCP servers and memory; logins stay separate. Hidden automatic swapping between Claude subscriptions is out
  (against Anthropic's terms). Switching an open session is always one click or command by the owner.
- Paid API-key fallback: seamless, through a local relay, only when Anthropic answers "plan limit reached";
  daily $ cap; notification when it starts.
- Views: local web dashboard + macOS menu bar (tiny native Swift app) + terminal picker (TUI).
- Stack: Node / TypeScript (type stripping, no build), no runtime dependencies.
- Extras: usage alerts, stats from local logs, local handover note (no AI), encrypted export.
- Dashboard pages: Accounts, Sessions, Stats, Activity, Settings (fallback and alerts).
- Status line shows the account and usage.
- Name: multiclaude, command `mc`.
- Owner: "Mostly we will be adding multiple claude pro/max accounts, make sure that we set priority ordering and
  setting it all around it." → priority order (drag in dashboard, `mc order`), per-account switch-at level,
  pause, pick mode (first in order with room / most room), `mc auto`, `mc next`.

## 2026-10-30 — dashboard look (apple-glass, alive-ui)

- Apple-style dark; glass only on the floating top bar and phone tab bar; content solid.
- Account colours: dataviz reference dark steps (#3987e5 #d95926 #199e70 #c98500 #d55181 #9085e9), validated
  on #1C1C1E; each account keeps its slot when reordered.
- Motion: **Alive but calm** (presses, cards slide on reorder, bars glide, numbers roll, cross-fades, charts draw
  once per visit, sections rise once, icons act, check draws on Saved, rare shine when an account resets; Reduce
  Motion keeps fades only).
- Accounts list: **rich rows in priority order**, one full-width card per account with 5h and weekly bars; API key
  row last.
- Accounts header: **briefing** ("Next session goes to …", why, one Start button, pick settings under it).
- Density: **comfortable** (15 px body, 52 px session rows).
- Sessions: **a row opens a continue panel** (what's in it, pick the account, same chat or fresh with a note, one
  Continue button).
- Stats: **four number tiles, then the daily chart** stacked by account, then splits by account, model, project.
- Feedback: **inline "Saved ✓" by the control; toasts only for async results** (Terminal opened, refresh).
- Delight: **a quiet shine when a full account resets** ("Ready again"); nothing else.

## 2026-10-30 — navigation fix

- Owner: "the navbar there looks really reaaly weird". Picked **floating islands** with the note **"no glass"**:
  brand on the page at the left, the page tabs in one centered solid pill, actions (refresh, Start) in a small solid
  pill on the right. No full-width bar.
- Selected tab: **glass lens thumb** that slides between tabs and swells while pressed (the only glass left in
  the shell).
- Phone tab bar follows: solid elevated island with the same lens on the current tab. The "Surface style"
  setting is removed (nothing large is glass any more).
