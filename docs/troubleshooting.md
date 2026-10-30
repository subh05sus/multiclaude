# Troubleshooting and FAQ

Start with `mc doctor`. It checks Node, `claude`, the service, the status line, the hook, each account's login,
the API key (when the fallback is on) and the shell function.

## Problems

**`mc: command not found`**
`~/.local/bin` isn't on your PATH, or the tab predates setup. Open a new tab, or add
`export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc`.

**Typing `claude` still opens main**
- Run `mc shell status`. If it's off, run `mc shell on` and open a new tab.
- `type claude` should say "claude is a shell function". If it says an alias, a `claude` alias in your shell
  file wins over the function; remove it.
- Commands that manage Claude Code (`claude mcp`, `claude update`, `--version` and others) always run plain on
  purpose. So does any `claude` started while `CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY` or `MC_BYPASS` is set.

**"The multiclaude service isn't answering" / dashboard won't load**
- `mc start`, then `mc doctor`.
- `mc daemon` runs it in the foreground and shows errors. A common one is the port being taken: change `port`
  in `~/.multiclaude/config.json`.
- Log: `~/.multiclaude/daemon.log`. LaunchAgent: `launchctl print gui/$(id -u)/com.multiclaude.daemon`.

**An account shows "token expired" or no usage**
multiclaude reads the login Claude Code saved and never refreshes it, so an account you haven't used for a while
can't be checked. Start a session on it once (`mc <name>`) and its usage comes back. "signed out" means there's
no login at all: `mc <name> auth login`.

**I signed in to the wrong account**
`mc <name> auth logout`, then `mc <name> auth login` with the right account. Use a private browser window if
claude.ai keeps picking the account you're already signed in to.

**A plugin, skill or mod is missing in another account**
Everything in `~/.claude` that's in the shared list ([configuration.md](configuration.md#what-a-profile-shares))
appears in every profile. If you added something new, start a session again (links are checked at launch) or
run `mc doctor`. Things that don't carry over by design: claude.ai connectors (they belong to that Claude
account), and MCP servers that need a sign-in (sign in once per account).

**An MCP server I added doesn't show up in other accounts**
Add user-scoped MCP servers from main: `command claude mcp add …` (or `claude mcp add …` with the shell
function, which runs it on main). They're copied into every profile at its next launch. Servers added while
inside another profile stay in that profile only.

**Settings changed in one account didn't reach another**
They should, because `settings.json` is shared. If Claude Code replaced the link with its own copy, multiclaude
merges the newer copy back within 5 minutes or at the next launch, and logs it in Activity as "Re-linked".

**Start / Continue in the dashboard does nothing**
macOS asks once whether the service may control Terminal. Allow it in System Settings → Privacy & Security →
Automation. With iTerm, choose it in Settings → Open sessions in.

**No notifications**
They come from macOS's `osascript`, which shows up as "Script Editor". Allow its notifications in System Settings
→ Notifications. Check that alerts are on in Settings.

**I got a notification that looks wrong**
Look at Activity for the reading it was based on, and press refresh. Alerts on status-line readings are confirmed
with Anthropic first, so it should be rare. Clearing `~/.multiclaude/alert-state.json` resets which levels fired.

**The API-key fallback didn't kick in**
- Was the session started after turning it on? Open sessions keep their route; restart them.
- `mc fallback status`: the key is saved and today's spend is under the cap?
- Settings → Accounts that may use it: is this account allowed (none ticked means all)?
- It only triggers on the plan's limit (`429` with unified status `rejected`), not on short rate limits or
  overload errors.

**Claude Code behaves differently with the fallback on**
Turn off "Keep every Claude Code feature on" in Settings and restart the session. If that helps, a Claude Code
update changed the internal setting it relies on; please open an issue.

**Two windows on one conversation**
After `mc next`, close the old window. Both write to the same transcript file otherwise.

**The menu bar app didn't build**
It needs `swiftc` from the Xcode command line tools: `xcode-select --install`, then `mc setup` again. Or skip
it with `mc setup --no-menubar`; everything else works without it.

**Stats look empty or wrong**
The first scan of a large history takes a little while. Delete `~/.multiclaude/cache/stats.json` to rebuild from
scratch. Sessions from before the hook was installed count as main.

## FAQ

**Is this allowed?**
Having more than one Claude account and choosing which one to use is up to you and Anthropic's terms.
multiclaude doesn't hide which account you're on and doesn't move sessions between accounts by itself. Pooling
subscriptions to get around usage limits is against Anthropic's terms. Read
[their terms](https://www.anthropic.com/legal/consumer-terms) and use your accounts within them.

**Does a session ever switch Claude accounts automatically?**
No. New sessions start on the picked account; an open session stays where it is until you run `mc next` or
click Continue. The only automatic switch is to your own API key, if you turned the fallback on.

**Does `claude --resume` work across accounts?**
Yes. All profiles share the same `projects` folder, so every account sees every conversation.

**What about my plugins, skills, hooks, mods and memory?**
Shared, with one copy in `~/.claude`. See [configuration.md](configuration.md#what-a-profile-shares).

**Do I need the dashboard or the menu bar?**
No. The service powers both, plus alerts and the fallback; the CLI works on its own for picking and launching.

**Does it send anything anywhere?**
No telemetry. The only network traffic is Claude Code's own API requests (through the relay when the fallback
is on) and the usage checks to Anthropic.

**How do I try it without touching my setup?**
`MC_HOME=/tmp/mc-try mc daemon` runs a separate instance, or `npm run demo` serves the dashboard with sample
data.

**Windows?**
Not supported. Claude Code's login storage and the terminal integration differ there.
