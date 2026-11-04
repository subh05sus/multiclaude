# Setup guide

Everything from a fresh Mac to several accounts working, step by step.

- [1. Check the requirements](#1-check-the-requirements)
- [2. Get the code](#2-get-the-code)
- [3. Run setup](#3-run-setup)
- [4. Add your accounts](#4-add-your-accounts)
- [5. Set the priority order](#5-set-the-priority-order)
- [6. Optional: the API-key fallback](#6-optional-the-api-key-fallback)
- [7. Permissions macOS asks for](#7-permissions-macos-asks-for)
- [What setup changed](#what-setup-changed)
- [Updating](#updating)
- [Moving the folder](#moving-the-folder)
- [Uninstalling](#uninstalling)
- [Windows](#windows)
- [Linux](#linux)

## 1. Check the requirements

```sh
node --version     # v22.18 or newer, or v23.6 or newer
claude --version   # Claude Code is installed
xcode-select -p    # the command line tools, for the menu bar app (install with: xcode-select --install)
```

If Node is older, install a current one (for example `brew install node`, or from nodejs.org). multiclaude runs
its TypeScript directly with Node's built-in type stripping, so there's no build step and nothing to compile
except the optional menu bar app.

Sign in to Claude Code once the normal way (`claude`, then `/login`) if you haven't. That login becomes your
**main** profile.

## 2. Get the code

```sh
git clone https://github.com/subh05sus/multiclaude.git ~/multiclaude
cd ~/multiclaude
```

Any folder works. Setup records where it is (see [Moving the folder](#moving-the-folder)).

## 3. Run setup

```sh
./bin/mc setup --shell
```

You'll see something like:

```
• mc is on your PATH (~/.local/bin/mc)
• Added to ~/.claude/settings.json: status line (backup saved next to it)
• Added to ~/.claude/settings.json: SessionStart hook (records which account runs each session)
• Background service starts at login (LaunchAgent com.multiclaude.daemon)
• Menu bar app installed and opens at login
• `claude` now picks an account (/Users/you/.zshrc). Open a new tab to use it.

Dashboard: http://127.0.0.1:4880
```

Options:

| Flag | Effect |
|---|---|
| `--shell` | Also make plain `claude` pick an account (same as running `mc shell on` later) |
| `--no-shell` | Don't mention the shell function |
| `--no-menubar` | Skip building the menu bar app (for example without the Xcode command line tools) |

Open a **new terminal tab** (so the PATH and the `claude` function load), then:

```sh
mc doctor
```

```
✓ Node 24.21.0
✓ claude found at /Users/you/.local/bin/claude
✓ background service on port 4880
✓ status line installed
✓ session hook installed
✓ main: you@example.com (Pro)
✓ plain `claude` picks an account
```

If `mc` isn't found, `~/.local/bin` isn't on your PATH. Add `export PATH="$HOME/.local/bin:$PATH"` to your
`~/.zshrc`, or run `~/multiclaude/bin/mc` directly.

## 4. Add your accounts

For each additional Claude account:

```sh
mc add work --label "Team Max"
```

- A browser window opens. **Sign in with the account you want in this profile.** If the browser is already
  signed in to claude.ai with another account, sign out there first or use a private window: the profile gets
  whichever account approves the sign-in.
- Names: 1–32 lowercase letters, numbers, `-` or `_`. Command names (`add`, `next`, `list` and so on) are
  reserved.
- `--label` is an optional note shown next to the name.
- The new profile joins the end of your priority order.

When it finishes:

```
✓ work: dev@example.com · Max 20x · position 2 in your order
```

If you signed in with an account another profile already uses, it says so. Remove it with `mc remove work` and
add it again.

From the dashboard: **Accounts → Add an account** opens Terminal and runs the same sign-in.

To sign a profile in again later (for example after you signed it out on claude.ai):

```sh
mc work auth login
```

## 5. Set the priority order

```sh
mc order work personal main
```

The first account is tried first. Or drag the cards on the dashboard's Accounts page (or use ↑/↓ on a card's
handle), or press `J`/`K` in the `mc` picker.

Then choose how picking works:

```sh
mc pick priority     # first account in your order that's under its switch-at level (default)
mc pick most-room    # whichever account has the most room left
```

And when an account counts as full:

```sh
# Default for every account: in the dashboard (Settings → Switch at), or in config.json
mc set work switch-at 85        # this account only
mc set work switch-at default   # back to the default
mc set side pause               # skip this account when picking (it stays set up)
mc set side unpause
```

An account counts as full when **either** its 5-hour or its weekly usage reaches its switch-at level.

## 6. Optional: the API-key fallback

When a plan's limit is reached in the middle of a session, multiclaude can keep that session going on your own
Anthropic API key (pay as you go) until the plan resets.

```sh
mc fallback key        # paste a key from https://console.anthropic.com (input is hidden); stored in the Keychain
mc fallback cap 5      # spend at most $5 per day on it
mc fallback on
```

Or in the dashboard under **Settings → API key fallback**, where you can also limit it to certain accounts.

Sessions started **after** turning it on route through the local relay. Ones already open keep going directly
until you restart them.

## 7. Permissions macOS asks for

The first time each happens, macOS may ask:

| When | Prompt | Why |
|---|---|---|
| You click **Start** or **Continue** in the dashboard or menu bar | "multiclaude/node wants to control Terminal" | To open a Terminal window and run `mc <account>` there. Allow it. |
| The first alert | Notifications from "Script Editor" | Alerts use macOS's built-in `osascript`. Allow notifications in System Settings → Notifications → Script Editor. |
| The first usage check | Usually nothing | multiclaude reads Claude Code's Keychain items with the `security` tool, which Claude Code itself uses, so no prompt is expected. If you see one, choose "Always Allow". |

For iTerm instead of Terminal: **Settings → Open sessions in → iTerm**.

## What setup changed

| Where | What | Undo |
|---|---|---|
| `~/.local/bin/mc` | A link to `bin/mc` in the repo | `mc uninstall` |
| `~/.claude/settings.json` | `statusLine` set to `mc statusline`; a `SessionStart` hook running `mc hook session-start`. A backup is saved as `settings.json.mc-backup-<time>` | `mc uninstall` (restores your previous status line) |
| `~/Library/LaunchAgents/com.multiclaude.daemon.plist` | Runs the background service at login | `mc uninstall` |
| `~/Library/LaunchAgents/com.multiclaude.menubar.plist` and `~/.multiclaude/MultiClaude.app` | The menu bar app | `mc uninstall` |
| Claude Code plugin `multiclaude-move@multiclaude` | The **Move to <account>** button, read from `plugin/` in the repo | `mc uninstall` |
| `~/.zshrc`, `~/.bashrc`, `~/.bash_profile` or fish (only with `--shell` / `mc shell on`) | A `claude` function between `# >>> multiclaude` marker lines; the old file is saved as `.mc-backup` | `mc shell off` |
| `~/.multiclaude/` | Config, profiles, usage, logs | Delete the folder after `mc uninstall` |

## Updating

```sh
cd ~/multiclaude
git pull
mc setup            # safe to run again; rebuilds the menu bar app and restarts the service
```

## Moving the folder

Setup writes the repo's absolute path into the status line, the hook, the shell function and the LaunchAgents.
After moving the folder, run `./bin/mc setup` (and `mc shell on` if you use it) from the new place.

## Uninstalling

```sh
mc uninstall          # status line, hook, shell function, background service, menu bar app
mc remove work        # for each extra profile: deletes its folder and its Keychain login
rm -rf ~/.multiclaude # config, logs, stats cache, handover notes
rm -rf ~/multiclaude  # the code
```

Your main `~/.claude` and its login are never touched. History created in other profiles already lives in
`~/.claude/projects`, so it stays.

## Windows

Requirements: Windows 10 or 11, [Node.js](https://nodejs.org) 22.18+ (or 23.6+), Claude Code
(`irm https://claude.ai/install.ps1 | iex`, or npm), and git.

```powershell
git clone https://github.com/subh05sus/multiclaude.git $HOME\multiclaude
node --disable-warning=ExperimentalWarning $HOME\multiclaude\src\cli.ts setup --shell
```

What it does on Windows:

| | |
|---|---|
| `%USERPROFILE%\.local\bin\mc.cmd` (and `mc` for Git Bash) | Runs the CLI. Claude Code's installer already put that folder on PATH; if not, setup tells you |
| `~/.claude/settings.json` | Status line and session hook, as `"node.exe" "...\src\cli.ts" statusline` so they work from any shell |
| `Startup\multiclaude.vbs` | Starts the service hidden at login. No admin rights, no scheduled task |
| PowerShell profile (`$PROFILE.CurrentUserAllHosts`, for Windows PowerShell and PowerShell 7) and `~/.bashrc` if Git Bash uses one | The `claude` function (with `--shell`) |

Then, in a **new** PowerShell window:

```powershell
mc doctor
mc add work          # signs in through your browser
mc order work main
claude               # starts on the account with room
```

Notes:

- **Execution policy.** Windows PowerShell 5 blocks profile scripts by default. If a new window says scripts are
  disabled, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once.
- **cmd.exe** has no functions; use `mc auto` (or `mc`) there.
- **Logins** live in `.credentials.json` inside each profile folder, as Claude Code keeps them on Windows. The API
  key goes to `~/.multiclaude/api-key`.
- **Links.** Shared folders are directory junctions. Shared files are symlinks if Developer Mode is on, otherwise
  hard links, which multiclaude re-links if Claude Code replaces a file. No admin rights needed either way.
- **Start buttons** in the dashboard open Windows Terminal, or a console window if it isn't installed.
- **No menu bar app** on Windows; the dashboard (`mc ui`) does the same job.
- Uninstall with `mc uninstall`: it removes the Startup entry, the shell function, the status line and hook, and
  `mc.cmd`.

## Linux

Everything works except the menu bar app:

- Logins are read from `.credentials.json` in each profile folder, as Claude Code stores them on Linux. The API
  key is kept in `~/.multiclaude/api-key` (mode 600), or comes from `MC_API_KEY`.
- `mc setup` runs the service as a systemd user unit (`~/.config/systemd/user/multiclaude.service`). Without
  systemd, start it with `mc start` after login.
- Alerts use `notify-send`.
- Dashboard Start buttons open `x-terminal-emulator`, GNOME Terminal, Konsole or xterm, whichever exists.
