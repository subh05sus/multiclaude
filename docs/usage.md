# Usage guide

- [The idea in one minute](#the-idea-in-one-minute)
- [Starting Claude Code](#starting-claude-code)
- [Plain `claude` (the shell function)](#plain-claude-the-shell-function)
- [When an account fills up](#when-an-account-fills-up)
- [The terminal picker](#the-terminal-picker)
- [The dashboard](#the-dashboard)
- [The menu bar app](#the-menu-bar-app)
- [The status line](#the-status-line)
- [Alerts](#alerts)
- [Auto-resume](#auto-resume)
- [The API-key fallback](#the-api-key-fallback)
- [Sessions and handover notes](#sessions-and-handover-notes)
- [Stats](#stats)
- [Export and import](#export-and-import)
- [Command reference](#command-reference)

## The idea in one minute

Each Claude account is a **profile**. `main` is your normal `~/.claude`; every other profile is a folder in
`~/.multiclaude/profiles/` that has its own login and links everything else back to `~/.claude`. So any profile
sees the same history, memory, settings, skills, plugins and mods.

Profiles are kept in a **priority order**. Each has a **switch-at** level (90% by default): once its 5-hour or
weekly usage reaches that level, it counts as full. "Picking" means choosing where a new session starts:

- **priority** (default): the first account in your order that isn't full, paused or signed out;
- **most-room**: the account with the lowest usage.

Picking happens when a session **starts**. An open session stays on its account; moving it is one command
(`mc next`).

## Starting Claude Code

| You type | It starts on |
|---|---|
| `claude` (with `mc shell on`) | the picked account |
| `mc auto` | the picked account |
| `mc` | whatever you choose in the [picker](#the-terminal-picker) |
| `mc work` | the `work` account |
| `command claude` | plain Claude Code on main, skipping multiclaude |

Anything after the account name goes straight to Claude Code:

```sh
mc work --resume                 # Claude Code's own session picker, on work
mc auto -p "summarise CHANGES.md" # print mode on the picked account
mc personal --model sonnet
```

Before Claude starts, one line says where and why (only in a terminal, so scripts stay clean):

```
▸ personal · personal is first in your order with room (skipped work: at 94%)
```

If no account has room, `mc auto` starts on your **default account** (Settings → When nothing has room, or
`mc use <name>`) and says so.

## Plain `claude` (the shell function)

```sh
mc shell on       # or: mc setup --shell
mc shell status
mc shell off
```

This adds a small function to your shell's startup file (`~/.zshrc`, `~/.bashrc`, `~/.bash_profile` on macOS
bash, `~/.config/fish/functions/claude.fish`, or on Windows your PowerShell profile and Git Bash's `~/.bashrc`),
between marker lines:

```sh
# >>> multiclaude: `claude` picks an account (remove with: mc shell off) >>>
claude() { "/path/to/multiclaude/bin/mc" claude "$@"; }
# <<< multiclaude <<<
```

On Windows, PowerShell gets `function claude { & "...\mc.cmd" claude @args }`. cmd.exe has no functions; use
`mc auto` there.

Open a new tab afterwards. Then `claude`, `claude -p "…"`, `claude --resume` and `claude "fix the bug"` all
start on the picked account.

These run **plain**, without picking, so they behave exactly as before:

- commands that manage Claude Code itself: `claude mcp …`, `claude update`, `claude install`, `claude doctor`,
  `claude plugin …`, `claude auth …`, `claude config …`, `claude agents`, `claude attach`, `claude logs`,
  `claude --version`, `claude --help`;
- any `claude` started inside a multiclaude session (it stays on that session's account);
- when `CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or Bedrock/Vertex variables are set;
- when `MC_BYPASS=1` is set.

The function only exists in interactive shells. Editors, the Claude desktop app and scripts that run the
`claude` binary by path aren't affected.

## When an account fills up

1. As it crosses your alert levels (80% and 95% by default) you get a notification, which names the next account
   with room. The status line shows `→ mc next` once it's past its switch-at level.
2. When you're ready, in the same folder:

   ```sh
   mc next            # the same conversation continues on the next account with room
   mc next --fresh    # a new session there, primed with a handover note
   ```

   Close the old Claude Code window first, so two windows don't write to one conversation.

3. If you turned on the [API-key fallback](#the-api-key-fallback) and the plan actually runs out mid-session,
   that session continues on your key without you doing anything, and you get a notification.

`mc next` finds the most recent session whose folder is the current folder, works out which account it was on,
and picks again excluding that one. From the dashboard: **Sessions → open a session → Continue on …**.

## The terminal picker

Run `mc` with no arguments:

```
 multiclaude  pick: first in order with room · switch at 90%
 ────────────────────────────────────────────────────────────
 ❯ 1 work         Max 20x  5h ██████████  94%  2h42   wk ████░░░░░░  41%  full
   2 personal     Max 5x   5h ████░░░░░░  38%  2h42   wk ██░░░░░░░░  22%  ★ pick
   3 side         Pro      5h █░░░░░░░░░  12%  2h42   wk ░░░░░░░░░░   4%
     API key               $1.24 of $5 today (used only when a plan is out)
 ────────────────────────────────────────────────────────────
 personal is first in your order with room (skipped work: at 94%)
 ↵ launch   a auto-pick   r resume last session here   ↑↓ select   J/K move in order   p pause   u refresh   d dashboard   q quit
```

| Key | Action |
|---|---|
| ↑ ↓ (or `k` `j`) | Select an account |
| ↵ | Start Claude Code on it (or sign it in, if signed out) |
| `a` | Start on the picked account |
| `r` | Continue the most recent session in this folder on the selected account |
| `J` / `K` | Move the selected account down / up in the order |
| `p` | Pause or unpause it |
| `u` | Refresh usage from Anthropic |
| `d` | Open the dashboard |
| `q`, Esc, Ctrl-C | Quit |

## The dashboard

`mc ui` opens http://127.0.0.1:4880. It refreshes every 10 seconds, and the refresh button (or `R`) asks
Anthropic right away.

**Accounts**
- A briefing: where the next session goes and why, one **Start** button, the pick mode, the default switch-at
  level, and the API-key status.
- One card per account, in priority order: plan and email, 5-hour and weekly bars (the tick mark is the
  switch-at level), reset times, per-model weekly limits when your plan has them, and a status:
  - **Next pick**, **Ready**, **Getting full** (within 15 points of switch-at), **Full**, **Limit reached**,
    **On API key**, **Paused**, **Signed out**.
- Drag a card by its handle to reorder, or focus the handle and use ↑/↓. The ⋯ menu has Start, Sign in again,
  Move up/down, Pause, Switch at (per account), Add a note and Remove.
- The API key row, and **Add an account** (opens Terminal to sign in).

**Sessions**
- Recent conversations from every account, with folder, branch, account and time. Search, or filter by account.
- Click one to open its panel: the original request, how many requests, files changed and open todos, then
  **Continue on** an account, either **Same chat** (whole conversation) or **Fresh, with a note**.
  **Preview note** shows the handover note first.

**Stats**
- Tiles: API value, tokens, replies, sessions, plus what was actually billed to your API key.
- API value per day, stacked by account (hover for the numbers; **Show as a table** for a table).
- Splits by account, model and project. Ranges: 7, 30 or 90 days.

**Activity**
- Every start, switch, alert, reset, fallback, setting change and repair, grouped by day. Filter by kind.

**Settings**
- Picking: pick mode, default switch-at, the account to use when nothing has room, Terminal or iTerm.
- Usage alerts: on/off, levels (add or remove), reset notifications, how often to check accounts with no open
  session.
- API key fallback: on/off, the key (saved to the Keychain), daily cap, which accounts may use it, and "Keep
  every Claude Code feature on" (see [How it works](how-it-works.md#the-relay)). Accounts currently on the key
  have a **Back to plan** button.

Every change saves right away and shows **Saved ✓** beside the control.

## The menu bar app

macOS only. On Windows and Linux the dashboard covers the same ground.

The icon shows the account a new session would go to and its usage, like `◐ personal 38%`. The menu lists:

- **Next session: personal** and **Start on personal** (⌘N);
- every account with its 5-hour and weekly usage and a coloured dot (green ready, orange getting full, red full
  or signed out, purple on the API key). Each has a submenu: Start a session, Sign in again, Pause, and its email
  and plan;
- the API key's spend today, when the fallback is on;
- **Open dashboard** (⌘D), **Refresh usage** (⌘R), **Quit**.

If the service isn't running, the menu offers **Start it**.

## The status line

After `mc setup`, every Claude Code session shows its account and usage at the bottom:

```
◆ personal 5h 38% wk 22%  │ work 94% · side 12%
```

- The account and its 5-hour and weekly usage, coloured green, then orange from 70%, red from 90%.
- `● API key` while that account is on the fallback.
- The other accounts' peak usage.
- `→ mc next` once this account is past its switch-at level and another has room.

The status line also reports the session's usage to the service, so the dashboard and menu bar stay current
without extra requests to Anthropic. If you had a status line before, it's kept and shown first.

## Alerts

Notifications come from the background service:

- when an account crosses each alert level (80% and 95% by default) in its 5-hour or weekly window, with the
  reset time and the next account with room;
- when a window that crossed a level resets ("ready to use again");
- when the API-key fallback starts, and when the daily cap is reached.

Each level fires once per window. Before alerting on a reading from a status line or the relay, the service
confirms it with Anthropic's usage endpoint, so a stale reading can't set one off.

Change the levels in **Settings → Usage alerts**, or `alerts.thresholds` in the [config](configuration.md).

## Auto-resume

On by default after `mc setup`. When a Claude Code session stops because its account hit a usage limit:

1. A background hook (`StopFailure`, matcher `rate_limit`) works out which of that account's windows is full and
   when it resets.
2. You get a notification: "work is out until 6:30 PM. This session will continue by itself when it resets."
   If another account has room, it says so, in case you'd rather run `mc next` now.
3. Just after the reset time, it checks with Anthropic that the limit really lifted (and keeps checking every
   few minutes if the reset is late), then wakes the session: Claude continues where it stopped, without
   repeating finished work.

Details:
- It waits for the **same** account. It never moves the session to another one.
- A short rate limit (the account isn't actually full) is retried after a minute.
- One waiter per session. Closing the session, turning auto-resume off, or `maxWaitHours` (8 days by default,
  enough for a weekly limit) ends the wait quietly.
- Activity shows "Session paused at the limit until …" and "Limit lifted; continuing the session".

```sh
mc autoresume status
mc autoresume off      # sessions just stop at a limit, as before
mc autoresume on
```

Or **Settings → Usage alerts → Continue stopped sessions by themselves**. Changes apply to sessions started
afterwards.

Claude Code also has its own `autoContinueAtUsageLimit` setting. You can leave it on; if both fire, Claude gets a
second "continue" note and carries on.

## The API-key fallback

Off by default. With it on, sessions started by multiclaude route through a relay on `127.0.0.1` that passes
every request to Anthropic unchanged, on that account's own login. Only when Anthropic answers "plan limit
reached" does the relay:

1. send the same request again with your API key (paid per token, at API prices);
2. keep sending that account's requests on the key until the reset time Anthropic gave;
3. stop for the day once today's spend reaches your cap. After that, Claude Code shows the plan's normal limit
   message.

It never moves a request to another Claude account.

```sh
mc fallback key       # save the key (hidden input) to the Keychain; empty input removes it
mc fallback cap 10    # dollars per day
mc fallback on
mc fallback status
mc fallback off
```

Spend is worked out from the token counts in each reply at list prices (see `src/pricing.ts`). It's a close
estimate; your Anthropic Console is the source of truth.

## Sessions and handover notes

`mc sessions` lists recent conversations, newest first:

```
1a2b3c4d  Oct 30, 7:41 PM  work       ~/code/shop-web                     Fix the login redirect loop
```

- `mc resume work 1a2b3c4d-…` continues one on an account. With no id, it continues the latest in this folder.
- `mc handover <id> --to personal` writes a handover note and starts a fresh session there, in the session's
  folder, asking Claude to read it.

A **handover note** is built from the session file alone, with no AI call:

- the original request and the latest requests;
- the todo list at the time;
- files changed;
- Claude's last reply;
- the folder, branch and session id.

Notes are saved in `~/.multiclaude/handovers/`.

## Stats

Read from `~/.claude/projects/**/*.jsonl`, including subagents, incrementally (only new lines are read after the
first run), cached in `~/.multiclaude/cache/stats.json` and refreshed every 15 minutes or when you open Stats.

- **API value** is what those tokens would cost on the API at list prices. Plans aren't billed per token, so it
  measures how much work each account did, not a bill.
- Each message counts toward the account its session was on at that time (from the session hook). Sessions from
  before you installed multiclaude count as main.

## Export and import

```sh
mc export ~/Desktop/multiclaude.mcx                 # settings and profiles
mc export ~/Desktop/multiclaude.mcx --with-logins   # also each account's login and the API key
mc import ~/Desktop/multiclaude.mcx                 # on the other Mac (after mc setup there)
mc import ~/Desktop/multiclaude.mcx --overwrite     # replace logins already there
```

The file is encrypted with AES-256-GCM, using a key derived from your passphrase with scrypt. Logins refresh
themselves, so after moving logins use each account on one Mac only, or sign in again on the old one.

## Command reference

| Command | What it does |
|---|---|
| `mc` | Terminal picker (when run in a terminal; otherwise like `mc auto`) |
| `mc <name> [claude args]` | Start Claude Code on an account |
| `mc auto [claude args]` | Start on the picked account |
| `mc claude [claude args]` | What the `claude` shell function runs: pick, or plain for management commands |
| `mc next [--fresh] [claude args]` | Move this folder's latest session to the next account with room |
| `mc resume <name> [id]` | Continue a session on an account (default: latest in this folder) |
| `mc handover <id> --to <name>` | Fresh session on an account with a handover note |
| `mc list` (`ls`, `status`) | Accounts, usage, order, the pick |
| `mc refresh` | Ask Anthropic for every account's usage now, then list |
| `mc sessions` | Recent sessions and their accounts |
| `mc add <name> [--label text]` | Add an account and sign in |
| `mc remove <name>` | Remove an account: its folder and Keychain login (shared data stays) |
| `mc order <a> <b> …` | Set the priority order |
| `mc set <name> switch-at <n>\|default` | Per-account switch-at level (10–100) |
| `mc set <name> pause\|unpause` | Skip an account when picking |
| `mc set <name> label <text>` | A note shown next to the name |
| `mc use <name>` | The account used when nothing has room |
| `mc pick priority\|most-room` | How accounts are picked |
| `mc fallback on\|off\|cap <usd>\|key\|status` | The API-key fallback |
| `mc shell on\|off\|status` | Make plain `claude` pick an account |
| `mc autoresume on\|off\|status` | Continue sessions by themselves when their account's limit resets |
| `mc ui` | Open the dashboard |
| `mc start` / `mc stop` | Start / stop the background service |
| `mc daemon` | Run the service in the foreground (shows errors) |
| `mc setup [--shell] [--no-shell] [--no-menubar]` | Install (safe to re-run) |
| `mc uninstall` | Undo setup (profiles and logins stay) |
| `mc export <file> [--with-logins]` | Encrypted backup |
| `mc import <file> [--overwrite]` | Restore a backup |
| `mc doctor` | Check the wiring |
| `mc help` | Short help |
