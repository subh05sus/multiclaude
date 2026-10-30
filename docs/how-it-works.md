# How it works

```
            you                                   ┌──────────── your Mac ────────────────────────────────┐
             │                                    │                                                      │
  claude / mc auto / mc work                      │  ~/.claude  (main: history, memory, settings,        │
             │                                    │             skills, plugins, mods, hooks …)           │
             ▼                                    │      ▲ links          ▲ links                         │
   mc picks an account ──► Claude Code ───────────┼──────┼─── profiles/work ┼── profiles/personal          │
   (priority / most room)   CLAUDE_CONFIG_DIR=…   │      │   own login      │   own login (Keychain)      │
                                   │              │                                                      │
                 fallback off      │ fallback on  │  multiclaude service (127.0.0.1:4880)                │
                     │             └──────────────┼─► relay ── same request ──► api.anthropic.com        │
                     ▼                            │      │  plan limit? resend on your API key (≤ cap)   │
              api.anthropic.com                   │   dashboard · usage polling · alerts · stats         │
                                                  │      ▲                      ▲                        │
                                                  │  status line reports    menu bar app, mc picker      │
                                                  └──────────────────────────────────────────────────────┘
```

## Profiles

Claude Code reads its configuration from `~/.claude` and `~/.claude.json`, or from the folder in
`CLAUDE_CONFIG_DIR`. Its login is stored in the macOS Keychain under a name derived from that folder:
`Claude Code-credentials` for the default, `Claude Code-credentials-<first 8 hex of sha256(folder)>` otherwise.
So two folders mean two independent logins.

A multiclaude profile is such a folder, `~/.multiclaude/profiles/<name>`, containing:

- its own `.claude.json` (account, onboarding, per-project state), seeded and kept in step from `~/.claude.json`
  at each launch;
- symbolic links to the shared entries in `~/.claude` (the list is in
  [configuration.md](configuration.md#what-a-profile-shares)).

Claude Code sometimes saves a file by writing a temporary file and renaming it over the original, which replaces
a link with a real file. multiclaude checks the links at every launch and every 5 minutes. When it finds a real
file where a link should be, it keeps the newer copy (backing up the other as `*.mc-backup-<time>`), puts it in
`~/.claude`, restores the link, and logs a "Re-linked" entry in Activity.

`~/.claude.json` is only ever read, never written: the main account's open sessions rewrite it constantly.
That's why MCP servers flow one way, from main into profiles. Add them with plain `claude mcp add` (with the
shell function, `claude mcp` always runs plain on main).

## Usage

Three sources, merged per window with the freshest reading winning:

1. **The status line.** Claude Code passes the plan's 5-hour and weekly usage to the status line command
   (`rate_limits` in its input). `mc statusline` saves it to `~/.multiclaude/usage-live/<account>.json` after
   every reply, so accounts with an open session are always current at no extra cost.
2. **The relay** (fallback on) reads Anthropic's `anthropic-ratelimit-unified-*` response headers.
3. **The usage endpoint.** For accounts with no fresh reading, the service calls
   `https://api.anthropic.com/api/oauth/usage` every `pollMinutes` with the login Claude Code saved. It never
   refreshes that login: refreshing would rotate the token under a running session. An account idle long enough
   for its token to expire shows "token expired" until you use it again.

A window whose reset time has passed counts as 0%. Before an alert fires on a status-line or relay reading, the
service asks the usage endpoint to confirm it.

## Picking

For each account in priority order:

- skipped if it's paused, signed out, or its peak (the higher of 5-hour and weekly usage, or 100% if Anthropic
  marked it limited) has reached its switch-at level;
- an account with no reading yet counts as having room.

In `priority` mode the first remaining account wins; in `most-room` mode the one with the lowest peak. `mc next`
does the same while excluding the account the session was on.

## Moving a session

All profiles share `~/.claude/projects`, so every profile can see every conversation. `mc next` and
"Continue on" run `claude --resume <id>` under the target profile, and the whole conversation carries over.
The prompt cache doesn't, since caches belong to an account, so the first reply on the new account reads the
context at full price.

"Fresh, with a note" writes a handover note from the transcript (no AI call) and starts a new session with a
prompt to read it.

## The relay

Only used when the fallback is on. Claude Code is started with
`ANTHROPIC_BASE_URL=http://127.0.0.1:4880/relay/<secret>/<account>`, so its API requests reach the relay, which:

1. forwards each request to `api.anthropic.com` byte for byte, with the account's own login;
2. if the answer is `429` with `anthropic-ratelimit-unified-status: rejected` (the plan's limit, not a short
   rate limit), and the fallback is allowed for that account, and today's spend is under the cap: drops the reply,
   sends the same body again with `x-api-key: <your key>` (removing the login and the `oauth-` beta flag), and
   streams that answer back. Claude Code just sees a normal reply;
3. remembers the reset time from `anthropic-ratelimit-unified-reset` and keeps sending that account's requests on
   the key until then, while the cap allows;
4. meters each paid reply from its token counts (`message_start` / `message_delta` in the stream) at list prices.

With a custom `ANTHROPIC_BASE_URL`, Claude Code turns off a few features that need a direct connection to
Anthropic. The relay is a transparent pass-through to Anthropic, so multiclaude sets Claude Code's internal
`_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` to keep them on. That's an internal setting and could change; turn
it off in Settings ("Keep every Claude Code feature on") if an update misbehaves.

The relay URL contains the random secret from `~/.multiclaude/secret`, so nothing else on the machine can spend
your key through it.

## Stats

Claude Code writes every assistant message, with its model and token usage, to the session's `.jsonl` file. The
stats scanner:

- reads only lines with usage, and only the part of each file that's new since the last scan;
- skips duplicate lines for one message (Claude Code writes one line per content block);
- buckets usage by hour and model, and prices it with `src/pricing.ts`;
- attributes each bucket to the account the session was on at that hour, from the `SessionStart` hook's log;
  sessions with no record count as main.

## Security model

- The service binds to `127.0.0.1` and rejects any request whose `Host` header isn't `127.0.0.1:<port>` or
  `localhost:<port>`, and any cross-origin request. That stops web pages, including DNS-rebinding attacks.
- Reads (`GET /api/*`) are open to local processes; anything that changes state needs the `x-mc-token` header,
  which matches `~/.multiclaude/secret` (mode 600). The dashboard gets it from its own page, which only a
  same-origin request can read; the menu bar app reads the file.
- The dashboard sends a strict Content-Security-Policy (scripts from itself only).
- Keychain writes go through `security -i` on stdin, so secrets never appear in a process list.
- Exports use AES-256-GCM with an scrypt-derived key (N=2^15, r=8, p=1).

## What can break with a Claude Code update

multiclaude relies on a few things Claude Code doesn't document as stable:

| Thing | Used for | If it changes |
|---|---|---|
| Keychain naming per `CLAUDE_CONFIG_DIR` | Reading each account's usage | Usage shows "signed out"; launching still works |
| `rate_limits` in the status line input | Live usage | Falls back to polling |
| `/api/oauth/usage` | Usage for idle accounts | Usage only from open sessions |
| `anthropic-ratelimit-unified-*` headers | Detecting a plan limit in the relay | The fallback doesn't trigger |
| `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` | Keeping features on behind the relay | Turn the setting off |
| Transcript format | Stats, sessions, handover notes | Those pages show less |

Profiles, sharing, picking and launching use only `CLAUDE_CONFIG_DIR` and normal `claude` arguments.
