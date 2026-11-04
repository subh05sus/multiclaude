# Changelog

## Unreleased

- **Move to <account>** button: under the prompt, right below the status line, through a small plugin `mc setup`
  installs (status line links don't work in Apple Terminal), and in the menu bar under each session waiting to resume. One click reopens the conversation on that account in a new window and stops the old session's
  auto-resume. It still takes your click; nothing moves by itself.
- Notifications at a limit name the button instead of `mc next`.

## 0.3.2 — 2026-10-31

- Menu bar app: a "Waiting to resume" section listing sessions paused at a limit and when each will continue, a
  ⏸ next to the icon's percentage while any session waits, and an "Auto-resume at limits" on/off item.
- Dashboard: account cards show "⏸ 1 session resumes at 6:29 PM" while a session waits on that account.

## 0.3.1 — 2026-10-31

- Fix: running `mc setup` again (to update) could fail while reloading the menu bar app's login item, because
  macOS hadn't finished unloading the old one. It now waits and retries, and restarts the app in place if needed.

## 0.3.0 — 2026-10-31

- **Auto-resume:** when a session stops at its account's usage limit, a background `StopFailure` hook waits for
  that account to reset, confirms with Anthropic, and wakes the session to continue where it left off. It never
  moves the session to another account; the notification names one with room if you'd rather `mc next`. On by
  default after `mc setup`; `mc autoresume on|off|status` and a dashboard switch.
- Windows: hooks and the status line call a bare `node`, so they also run when Claude Code uses PowerShell.

## 0.2.0 — 2026-10-30

- **Windows support:** `mc.cmd`, start at login from the Startup folder, `claude` function in PowerShell and Git
  Bash, Windows toasts, Windows Terminal launch, junctions and symlink/hard-link file sharing with self-repair,
  logins from `.credentials.json`, API key in a private file. CI runs on Windows too.
- Linux: the service runs as a systemd user unit; Start buttons open the desktop's terminal.
- Dashboard: custom dropdown, checkboxes and radio buttons (no native controls, same look on every OS), slim dark
  scrollbars; the Terminal/iTerm choice shows only on macOS.

## 0.1.1 — 2026-10-30

- Status line readings from a session started on an older login are filed under the account they belong to
  (matched by reset time), or dropped, instead of landing on the session's profile. This caused a false
  "90% of the weekly limit" alert.
- Tests never send desktop notifications.

## 0.1.0 — 2026-10-30

First release.

- Profiles per Claude account with shared history, memory, settings, hooks, skills, plugins, mods, commands,
  agents and MCP servers; self-repairing links.
- Priority order, per-account switch-at levels, pause, pick modes (first with room, most room left).
- `claude` shell function (`mc shell on`), `mc auto`, `mc next`, `mc resume`, `mc handover`, terminal picker.
- Usage from the status line, relay headers and Anthropic's usage endpoint; alerts confirmed before notifying.
- Optional API-key fallback through a local relay, with a daily cap and per-account allow list.
- Dashboard (Accounts, Sessions, Stats, Activity, Settings), menu bar app, status line.
- Stats from local transcripts, handover notes, encrypted export and import.
