# Configuration

Most settings are in the dashboard (**Settings**) or have a command. They all live in
`~/.multiclaude/config.json`, which you can also edit by hand; the service reads it on every request.

## config.json

```json
{
  "version": 1,
  "port": 4880,
  "defaultProfile": "main",
  "pick": "priority",
  "switchAt": 90,
  "profiles": [
    { "name": "work", "label": "Team Max", "color": 1 },
    { "name": "personal", "switchAt": 85, "color": 2 },
    { "name": "main", "color": 0 },
    { "name": "side", "paused": true, "color": 3 }
  ],
  "fallback": { "enabled": false, "dailyCapUsd": 5, "assumeFirstParty": true, "profiles": [] },
  "alerts": { "enabled": true, "thresholds": [80, 95], "notifyReset": true },
  "autoResume": { "enabled": true, "maxWaitHours": 192 },
  "pollMinutes": 5,
  "terminalApp": "Terminal"
}
```

| Field | Default | Meaning |
|---|---|---|
| `port` | `4880` | Port for the dashboard, API and relay, on `127.0.0.1`. After changing it, run `mc stop` (the LaunchAgent restarts the service) and restart open sessions |
| `defaultProfile` | `"main"` | Used by `mc auto` when no account has room (`mc use <name>`) |
| `pick` | `"priority"` | `"priority"`: first in order with room. `"most-room"`: lowest usage (`mc pick`) |
| `switchAt` | `90` | Percent at which an account counts as full, unless it has its own |
| `profiles` | `[main]` | **In priority order.** First is tried first (`mc order`) |
| `profiles[].name` | | Folder name and command name |
| `profiles[].label` | | Note shown next to the name |
| `profiles[].paused` | `false` | Skip when picking |
| `profiles[].switchAt` | | Overrides `switchAt` for this account (`mc set <name> switch-at`) |
| `profiles[].color` | auto | Colour slot 0–5 in charts. Fixed when the profile is added, so reordering never repaints |
| `fallback.enabled` | `false` | Route new sessions through the relay so the API key can take over at a plan limit |
| `fallback.dailyCapUsd` | `5` | Most the key may spend per calendar day. `0` means never |
| `fallback.assumeFirstParty` | `true` | Tell Claude Code the relay is Anthropic's API, so features that need a direct connection stay on |
| `fallback.profiles` | `[]` | Accounts allowed to use the key. Empty means all |
| `alerts.enabled` | `true` | Desktop notifications |
| `alerts.thresholds` | `[80, 95]` | Levels that notify, in percent |
| `alerts.notifyReset` | `true` | Also notify when a window that crossed a level resets |
| `autoResume.enabled` | `true` | Continue a session by itself once its account's limit resets (`mc autoresume`) |
| `autoResume.maxWaitHours` | `192` | Stop waiting after this long |
| `pollMinutes` | `5` | How often to ask Anthropic for usage of accounts with no open session (1–60) |
| `terminalApp` | `"Terminal"` | `"Terminal"` or `"iTerm"`, for the dashboard and menu bar's Start buttons |
| `statuslineWrap` | | Your previous status line command, shown before multiclaude's. Set by `mc setup` |
| `claudePath` | | Full path to `claude`, if it isn't on PATH |

## Environment variables

| Variable | Effect |
|---|---|
| `MC_HOME` | Use another folder instead of `~/.multiclaude` (handy for trying things out) |
| `MC_BYPASS=1` | Make the `claude` shell function run plain Claude Code |
| `MC_NO_NOTIFY=1` | No desktop notifications from this process |
| `MC_API_KEY` | Use this API key instead of the saved one (CI, scripts) |
| `MC_MAIN_CLAUDE_DIR`, `MC_MAIN_CLAUDE_JSON` | Point "main" somewhere other than `~/.claude` and `~/.claude.json` (used by the tests) |
| `MC_UPSTREAM` | Send relay traffic somewhere other than `https://api.anthropic.com` (used by the tests) |

multiclaude sets these for the Claude Code it starts:

| Variable | Value |
|---|---|
| `MC_PROFILE` | The account name. The status line, hook and `claude` function use it |
| `CLAUDE_CONFIG_DIR` | The profile's folder (not set for main) |
| `ANTHROPIC_BASE_URL` | Only with the fallback on: `http://127.0.0.1:4880/relay/<token>/<account>` |
| `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` | Only with the fallback on and `assumeFirstParty` |

## Files

| Path | What |
|---|---|
| `~/.multiclaude/config.json` | Settings, above |
| `~/.multiclaude/secret` | Random token for the relay path and dashboard changes (mode 600) |
| `~/.multiclaude/profiles/<name>/` | A profile: its `.claude.json` plus links into `~/.claude` |
| `~/.multiclaude/state.json` | Last computed state, for the status line and CLI |
| `~/.multiclaude/usage-live/<name>.json` | Usage reported by status lines and the relay |
| `~/.multiclaude/session-map.jsonl` | Which account each session started or resumed on |
| `~/.multiclaude/activity.jsonl` | The Activity log |
| `~/.multiclaude/alert-state.json` | Which alert levels already fired, per window |
| `~/.multiclaude/spend.json` | API-key spend per day, account and model (120 days) |
| `~/.multiclaude/cache/stats.json` | Stats cache (safe to delete; rebuilt on the next visit) |
| `~/.multiclaude/handovers/*.md` | Handover notes |
| `~/.multiclaude/waiters/<session>.json` | A session waiting to auto-resume (removed when it resumes or stops) |
| `~/.multiclaude/autoresume-off` | If this file exists, auto-resume is paused without editing the config |
| `~/.multiclaude/daemon.log` | Service output and errors |
| `~/.multiclaude/MultiClaude.app` | The menu bar app |
| Keychain `Claude Code-credentials[-<hash>]` (macOS) or `<profile>/.credentials.json` (Windows, Linux) | Claude Code's own login for each profile (read only) |
| Keychain `multiclaude-api-key` (macOS) or `~/.multiclaude/api-key` (Windows, Linux) | The fallback API key |
| `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\multiclaude.vbs` (Windows) | Starts the service at login |
| `~/.config/systemd/user/multiclaude.service` (Linux) | Starts the service at login |
| `%USERPROFILE%\.local\bin\mc.cmd` (Windows) | The `mc` command |

## What a profile shares

Linked to `~/.claude` (one copy for every account):

| Shared | Why |
|---|---|
| `projects/` | Conversations and **memory** (auto-memory lives inside each project folder) |
| `todos/`, `tasks/`, `plans/`, `file-history/`, `paste-cache/`, `uploads/`, `session-env/` | What a resumed session needs, so `--resume` works across accounts |
| `skills/`, `commands/`, `agents/`, `hooks/`, `output-styles/` | Your customisation |
| `plugins/`, `local-marketplace/`, `dev-mods/` | Plugins, their data and marketplaces, local directory marketplaces, and mods (panels, bands) |
| `settings.json`, `CLAUDE.md`, `keybindings.json`, `history.jsonl` | Settings (including which plugins are on), instructions, keys, prompt history |

Copied from `~/.claude.json` into the profile's own `.claude.json` at every launch: your MCP servers
(`mcpServers`), per-project settings and trust, plugin panel layout (`pluginPanes`), and onboarding state.

Kept separate per account: the login, `oauthAccount`, MCP OAuth tokens, claude.ai connectors, background agent
sessions (`sessions/`, `jobs/`), caches and telemetry.
