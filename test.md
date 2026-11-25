# Test two remote Claude Code accounts on Windows

Run the gateway and both Claude Code workers in Ubuntu on WSL2. Use PowerShell and a browser as the clients. Both sides run on the same Windows computer, so no VPS is required.

## 1. Prepare WSL2

Use an existing Ubuntu WSL2 distribution or install one from PowerShell:

```powershell
wsl --install Ubuntu-24.04
wsl --list --verbose
```

Confirm that the distribution uses version 2. Complete Ubuntu's initial user setup. In Ubuntu, install Podman and its user namespace tools:

```bash
sudo apt-get update
sudo apt-get install -y podman uidmap openssl tmux
podman info --format '{{.Host.Security.Rootless}}'
```

The last command should print `true`. Use that same Linux user for image builds, account sign-in, and the gateway. Install Node.js 22.18+ in Ubuntu and on Windows.

Open the same revision of this repository in both environments. The example assumes the Windows checkout is `D:\VS\multiclaude`. In Ubuntu, run:

```bash
cd /mnt/d/VS/multiclaude
podman build -t localhost/multiclaude-worker:1 -f remote/Containerfile remote
```

Install the Linux dependencies from a separate checkout or copy on the WSL filesystem to give each OS its own `node_modules`. In that Linux checkout, run `npm ci --omit=dev` and use it for the rest of the Ubuntu commands.

## 2. Configure the gateway and sign in twice

In Ubuntu, create a local TLS certificate and a client key. The settings below bind the gateway to loopback and use port 4881.

```bash
umask 077
cfg="$HOME/.config/multiclaude-remote"
mkdir -p "$cfg"
openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
  -subj /CN=localhost -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
  -keyout "$cfg/localhost-key.pem" -out "$cfg/localhost.pem"
digest=$(node src/cli.ts server keygen "$cfg/laptop.key")
cat > "$cfg/grants.json" <<EOF
[
  { "digest": "$digest", "owner": "tester", "profiles": ["personal", "work"] }
]
EOF
cat > "$cfg/server.json" <<EOF
{
  "host": "127.0.0.1",
  "port": 4881,
  "cert": "$cfg/localhost.pem",
  "key": "$cfg/localhost-key.pem",
  "grants": "$cfg/grants.json",
  "profiles": [
    { "owner": "tester", "name": "personal" },
    { "owner": "tester", "name": "work" }
  ]
}
EOF
```

Run these commands one at a time. Open the sign-in URL printed by each and use the matching Claude account. Use separate browser profiles or private windows if your browser keeps selecting the first account. Paste any authorization code into the Ubuntu terminal that printed the URL.

```bash
node src/cli.ts server login "$cfg/server.json" tester personal
node src/cli.ts server login "$cfg/server.json" tester work
node src/cli.ts server serve "$cfg/server.json"
```

Leave the gateway running. These are two subscription profiles. Each uses the account you signed into for that profile and draws on that account's plan limits.

## 3. Connect from PowerShell

Run these commands from the Windows checkout. Replace `Ubuntu-24.04` and `YOUR_LINUX_USER` with the distro name from `wsl --list --verbose` and the output of `whoami` in Ubuntu.

```powershell
Set-Location D:\VS\multiclaude
npm ci --omit=dev
$remoteConfig = '\\wsl.localhost\Ubuntu-24.04\home\YOUR_LINUX_USER\.config\multiclaude-remote'
$env:MC_SERVER_URL = 'https://127.0.0.1:4881'
$env:MC_ACCESS_KEY_FILE = Join-Path $remoteConfig 'laptop.key'
$env:NODE_EXTRA_CA_CERTS = Join-Path $remoteConfig 'localhost.pem'

.\mc.cmd r ls
$personal = .\mc.cmd r new personal
$work = .\mc.cmd r new work
.\mc.cmd r a personal $personal
```

`r ls` should list `personal` and `work`. On the first attachment, complete Claude Code's terminal setup and review the workspace trust prompt. Use `/status` in each session to check that it has the intended account.

1. In `personal`, send a short prompt such as `What is 2 + 2? Reply with just the number.` Check that it answers `4`.
2. Press **Ctrl+]** to detach. Run `.\mc.cmd r a work $work` from PowerShell and send a different prompt. Confirm that the first conversation is absent.
3. Detach again and run `.\mc.cmd r a personal $personal`. The original prompt and reply should still be visible in that session. Detach once more before opening it from another terminal.
4. Open [the remote dashboard](https://127.0.0.1:4881/) and choose the `laptop.key` file from `$remoteConfig`. For this loopback test, use your browser's trust settings for the certificate you generated if it warns about the self-signed certificate. **Accounts** should show one running session for each profile. In **Sessions**, **Copy attach command** should copy a command for the matching session.

End the sessions from PowerShell, one at a time:

```powershell
.\mc.cmd r rm work $work
.\mc.cmd r ps personal
.\mc.cmd r rm personal $personal
.\mc.cmd r ps personal
.\mc.cmd r ps work
```

After ending `work`, `personal` should still list its session. After ending both, the lists should be empty. Refresh the dashboard to confirm. Press **Ctrl+C** in the Ubuntu terminal to stop the gateway. Your account logins remain in the separate Podman profile volumes.

For an offline second profile or API-key billing, see the [remote sessions guide](docs/remote.md).
