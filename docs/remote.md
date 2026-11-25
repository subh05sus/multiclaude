# Remote Claude Code sessions

Run Claude Code on a Linux host you control and connect from a terminal on macOS, Windows, or Linux. The remote client selects a server profile by name. Each session starts Claude Code in its own container and holds the terminal open while you disconnect.

## Set up the Linux host

Use a dedicated non-root Linux account with Node.js 22.18+ and working rootless Podman. Run the setup below from the multiclaude checkout as that account. Keep the gateway and worker image in the same account's Podman storage.

```sh
npm ci --omit=dev
podman info --format '{{.Host.Security.Rootless}}'   # should print true
podman build -t localhost/multiclaude-worker:1 -f remote/Containerfile remote
umask 077
mkdir -p "$HOME/.config/multiclaude-remote"
```

Create a server configuration in that directory, for example `/home/multiclaude/.config/multiclaude-remote/server.json`. Replace the absolute paths and profile names with your own.

```json
{
  "host": "0.0.0.0",
  "port": 8443,
  "cert": "/home/multiclaude/.config/multiclaude-remote/fullchain.pem",
  "key": "/home/multiclaude/.config/multiclaude-remote/privkey.pem",
  "grants": "/home/multiclaude/.config/multiclaude-remote/grants.json",
  "profiles": [
    { "owner": "alice", "name": "personal" },
    { "owner": "alice", "name": "api", "apiSecret": "alice-api" }
  ]
}
```

The owner, profile name and optional Podman secret name each take 1–32 characters. Start with a lowercase letter or digit, then use lowercase letters, digits, hyphens or underscores. The owner and profile name together identify a profile. Keep the same pair to keep using its existing data.

Use a PEM certificate chain matching the HTTPS hostname and its PEM private key. The service account needs read access to both. The listener requires TLS 1.2 or later and defaults to `127.0.0.1` if you omit `"host"`. Bind to a private network interface when available and limit inbound access to the intended clients. With a private CA, set `NODE_EXTRA_CA_CERTS` on each client to its CA certificate file before launching the CLI.

## Provision profiles

- **Subscription profile.** Omit `"apiSecret"`. On the host, run the command below and complete Claude Code's own browser sign-in. The login is stored in the profile's worker home. Repeat the host command when Claude Code needs you to sign in again. Usage goes to the Claude account you sign in with and is subject to its plan limits. [Claude Code authentication](https://code.claude.com/docs/en/authentication)
- **API profile.** Set `"apiSecret"` to a Podman secret you create under the service account, using a private file containing the account owner's Anthropic API key. The gateway passes the secret to the worker as `ANTHROPIC_API_KEY`. Approve the key when Claude Code prompts on first attachment. Console API usage is metered and billed to the API key's account. Use a separate profile for API billing and keep credentials out of the server JSON, access key files and shell history. [Claude Code authentication](https://code.claude.com/docs/en/authentication#authentication-precedence) · [Podman secrets](https://docs.podman.io/en/latest/markdown/podman-secret-create.1.html)

```sh
config="$HOME/.config/multiclaude-remote/server.json"
./bin/mc s in "$config" alice personal
podman secret create alice-api /path/to/private-file-with-api-key
```

Each start selects one profile and uses its Claude Code authentication. Local multiclaude account picking and paid fallback apply to local launches. Use your own accounts and follow Anthropic's rules for subscription sign-in and third-party hosting. [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)

### Test with one Claude account

Keep `personal` as your real subscription profile and add an offline `work` profile to the server configuration:

```json
"profiles": [
  { "owner": "alice", "name": "personal" },
  { "owner": "alice", "name": "work", "mock": true }
]
```

Build the mock image on your Linux host under the same account that runs the gateway. Keep the regular worker image from the host setup for `personal`.

```sh
podman build --target worker-base -t localhost/mc-worker-test-base -f remote/Containerfile remote
podman build --pull=never -t localhost/multiclaude-worker-mock:1 -f test/fixtures/Containerfile test/fixtures
./bin/mc s in "$config" alice personal
```

Sign in only to `personal`. The mock worker runs with networking disabled and accepts no API secret. Grant your laptop key access to `["personal", "work"]`, then start or restart the gateway. From PowerShell, with the client environment variables set, run:

```powershell
.\mc r new work
.\mc r a work
```

Type `hello` and expect `reply=hello`. Press **Ctrl-]** to detach, then run `.\mc r new personal` and `.\mc r a personal` for real Claude Code. Detach again and run `.\mc r a work` to check that the mock terminal still shows your earlier reply. Type `finish` in the mock terminal to exit.

## Grant access and start the gateway

Generate a new access key file for each client you want to be able to revoke independently. The command creates the file with mode 0600, refuses to overwrite an existing file and prints its SHA-256 digest.

```sh
./bin/mc s key "$HOME/.config/multiclaude-remote/alice-client.key"
```

Save `grants.json` next to `server.json`. Replace the placeholder with the printed digest. Use `[]` to start with no grants.

```json
[
  {
    "digest": "<printed SHA-256 digest>",
    "owner": "alice",
    "profiles": ["personal", "api"]
  }
]
```

Copy the key file to the intended client over a trusted channel and keep it readable only by that user. Delete the host copy after delivery if it is no longer needed. The gateway uses the digest to authorize access to the listed profiles for that owner. Each grant permits starting, attaching to and ending sessions in its profiles. Treat access to a profile as access to its work and any Claude credentials the worker can use.

```sh
./bin/mc s up "$config"
```

Run one foreground gateway per rootless service account. The command reads the TLS material and profile list at startup. Restart it to pick up changes to either. Replace `grants.json` atomically when editing it while the gateway is running. To revoke a key, remove its grant. New requests lose access immediately, and active attachments recheck authorization every five seconds. Other keys granted the same profile can still attach. End the session separately if you also need to stop the worker. For rotation, issue and test the new key before removing the old grant.

The full server command names are `mc server serve CONFIG`, `mc server login CONFIG OWNER PROFILE`, and `mc server keygen NEW_KEY_FILE`.

Open the gateway's HTTPS URL in a browser to view the remote dashboard. Choose the same access key file you use with the CLI. **Accounts** shows the authentication mode and running session count for each granted profile, with a command to start a session. **Sessions** lists running sessions and provides a terminal attach command for each. The page keeps the key in memory until you lock or close it.

## Connect from a terminal

Install Node.js 22.18+, get the multiclaude checkout and run `npm ci --omit=dev` in it. If `mc` is missing from your PATH, run `node src/cli.ts --install-launcher` once from the checkout and follow its PATH instructions. This installs only the launcher. In PowerShell, use `.\mc` from the checkout if the global `mc` points to another copy.

```sh
export MC_SERVER_URL=https://claude-host.example.com:8443
export MC_ACCESS_KEY_FILE="$HOME/.config/alice-client.key"
```

In PowerShell, set the same variables this way.

```powershell
$env:MC_SERVER_URL = 'https://claude-host.example.com:8443'
$env:MC_ACCESS_KEY_FILE = "$HOME\.config\alice-client.key"
```

Use an HTTPS origin with the certificate's hostname and optional port. The access key authenticates the terminal client to your server. Claude Code authenticates separately inside the worker.

```sh
mc r ls
mc r new personal
mc r ps personal
mc r a personal SESSION_ID
mc r rm personal SESSION_ID
```

The start command prints the new session ID. Use that ID to attach from an interactive terminal, or look up running IDs with `mc r ps`. Both `mc r a` and `mc r rm` accept a full ID or a unique ID prefix. You can omit the ID when the profile has exactly one running session. Press **Ctrl-]** to detach. To reconnect after detaching or losing your network connection, attach again with the same ID. Each session allows one terminal attachment at a time. An attachment conflict (HTTP 409) clears once the gateway detects the old connection has closed.

The full client command names are `mc remote profiles`, `mc remote sessions PROFILE`, `mc remote start PROFILE`, `mc remote attach PROFILE [ID]`, and `mc remote end PROFILE [ID]`. If a local profile uses one of these command names, use `mc --r`, `mc --s`, `mc --remote`, or `mc --server` to select the command explicitly.

## Connect from your own harness

Send `Authorization: Bearer <key>` with every HTTPS request and WSS upgrade. Use the access key itself from the client file, with surrounding whitespace removed. Omit the `Origin` header. The gateway accepts terminal clients and rejects browser-origin requests.

| Method | Path | Success |
|---|---|---|
| GET | `/v1/profiles` | 200, JSON array of authorized profile names |
| GET | `/v1/profiles/{profile}/sessions` | 200, JSON array of running session IDs |
| POST | `/v1/profiles/{profile}/sessions` | 201, JSON object with an `id` |
| DELETE | `/v1/profiles/{profile}/sessions/{id}` | 200, empty JSON object |
| WebSocket upgrade | `wss://<host>[:port]/v1/profiles/{profile}/sessions/{id}` | 101, single terminal attachment |

Use binary WebSocket messages of up to 64 KiB for raw terminal input and output. Send a text message like `{"cols":120,"rows":36}` after connecting and when the terminal size changes. Both values must be integers from 1 to 4096. Closing the WebSocket detaches. On reconnect, tmux redraws the live terminal, so the harness can render fresh output without replaying prior messages. Revoking the bearer grant cuts off its requests and attachments, while detached sessions keep running until they exit, expire or are ended by an authorized client.

## Session data and cleanup

- Each owner/profile pair has a separate Podman home volume. Its Claude Code login, history, settings and `~/workspace` persist across sessions. The workspace lives on the host's worker volume. Clone or create your project there. The client's working folder and local Claude profiles are outside that volume.
- Sessions within a profile share the same home and workspace, so changes to files can affect other sessions in that profile. The gateway allows up to eight concurrent sessions per profile. If a start is already in progress (HTTP 409), retry when it finishes. If the profile is full (HTTP 429), wait for a session to exit or end one. Each worker has a 24-hour maximum lifetime and a limit of 512 processes.
- The tmux terminal lives inside its worker container. Exiting Claude Code, ending the session or reaching the lifetime limit removes that container. Ending or restarting a worker discards its live terminal. A host reboot can also end live sessions. Use the same profile to access its retained files in a new session.
- Workers run under rootless Podman with dropped capabilities and without a host home mount or the Podman socket. The gateway does not log streamed terminal contents. Claude Code can still write conversation history in the profile volume. Protect the host and treat its administrator and the service account as trusted.
- To retire a profile, end its sessions, remove its grants and server profile entry, and restart the gateway. Remove its Podman secret if present, and revoke the Anthropic credential separately if needed. Remove the profile volume only when you intend to delete its retained data, including work and any stored login. Under the service account, use `podman volume ls` and `podman volume inspect` to check the target before running `podman volume rm` with its exact name. The name is `mc-<SHA-256 digest of the JSON array ["owner","profile"]>-home`.
