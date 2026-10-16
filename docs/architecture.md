# Afterhours on any machine, from any device

As of October 15, 2026. This replaces the Mac-app and iOS-app plan in [saas-plan.md](saas-plan.md); pricing comes later.

## Goals

- **Run anywhere:** the engine (today's daemon) runs on macOS, Linux and Windows (through WSL2), including servers in the cloud such as EC2.
- **One app:** one cross-platform app replaces the Telegram bot, on iPhone, Android, and on Mac, Windows and Linux desktops, all at once, so testers don't wait. The app only communicates; the work stays in the engine.
- **Secure:** a phone controlling a machine in the cloud gets the same protection as one controlling a Mac at home.

## Decisions

| Decision | Why |
| --- | --- |
| **App:** Expo (React Native) for iOS, Android and the web; **desktop:** Electron around the same web build | React Native's desktop ports have no Linux. This way one codebase reaches all six platforms. |
| **Engine:** keep today's TypeScript daemon. macOS and Linux natively (x64, arm64), Windows through WSL2 first | It's where the value is, and it already runs on Bun. tmux runs on Linux and in WSL2. A native Windows engine becomes a second `TmuxDriver` later. |
| **Connectivity:** machines and apps connect *out* to a small relay | No open ports, no SSH exposure, no VPN: a server in a private subnet only needs outbound HTTPS. |
| **Security:** end-to-end encryption between each app and each machine (Noise), pairing by QR code | The relay can't read or forge anything, so it can be hosted by anyone, including you. |
| **Identity:** keys only, no accounts | Nothing to sign up for. Accounts and billing can attach later without changing the protocol. |
| **Rules live on the machine** | No app, and no stolen phone, can loosen what a machine allows. |
| **No plain shell commands** | Apps queue Claude tasks and answer Claude's prompts, and nothing else. That's less to secure. |
| **Telegram** stays until the app does everything it does | Then it becomes optional. |

## How it fits together

```
 iPhone · Android · web                 ┌──────────── relay (wss) ────────────┐          Mac · Linux · WSL2 · EC2
 Electron: Mac · Windows · Linux  ⇄     │ signs peers in by key; forwards     │    ⇄     engine (cq daemon) ⇄ Claude Code in tmux
                                        │ only between linked keys; can't read│          + remote: devices, rules, events, audit
 └──────────────── Noise session, end to end, one per app ↔ machine ──────────────────────┘
```

- **`packages/protocol`**: keys, Noise, frames, pairing links, message schemas, the app's client (`AppClient`) and the machine's side (`Host`). The engine, the relay, the tests and the apps all use it.
- **`relay/`**: about 400 lines of Bun. It keeps keys, links and connection times in SQLite. It runs in Docker anywhere.
- **`src/daemon/remote/`**: the engine's side. Requests from apps go to the same Runner and Store calls the Telegram bot uses. It adds devices, the machine's rules, the event log apps catch up from, and the audit trail.

## Security model

**Keys.**
- Every app install and every machine has one Ed25519 key pair.
- The public key is its id on the relay and in pairing links.
- Noise uses the X25519 form of the same key, so an id names exactly one Noise key. (Thormarker, 2021, analyses using one key pair for both.)
- Where the key is kept:
  - machines: `~/.afterhours/identity.json`, mode 0600;
  - phones: the Keychain or Keystore;
  - desktops: Electron `safeStorage`.

**Sessions.**
- Every session is `Noise_IK_25519_ChaChaPoly_SHA256`, started by the app, which knows the machine's key from pairing.
- This gives mutual authentication and forward secrecy.
- A changed, replayed, reordered or dropped message makes the session fail.
- The prologue binds both peer ids and the session id, so a relay can't splice or redirect sessions.
- The machine also checks that the key the app proved it holds is the one the relay says sent the frame.
- Built on the audited `@noble` libraries (pure JS: the same code in Bun, browsers, Hermes and Electron). It passes the cacophony test vectors for IK, IKpsk1, IKpsk2, NN and XX.

**Pairing.**
1. `cq pair` shows a QR code and a link: `afterhours://pair?r=<relay>&m=<machine id>&s=<secret>&n=<name>&x=<expiry>`. The secret is 128 random bits; the code works once, for 10 minutes.
2. The relay only learns the offer id, `SHA-256("afterhours-offer-v1" ‖ secret)[0..16]`. It can't get the secret back from it.
3. The app runs `Noise_IKpsk2` with `psk = SHA-256("afterhours-psk-v1" ‖ secret)`. The machine's key is in the link, so nobody can impersonate the machine.
4. The machine's reply is sealed with the psk, so only a holder of the secret can read it and send the confirmation.
5. The machine then asks in the terminal: *“Skanda's iPhone” (iOS, key 4F2A 9C1B 77E0 D3A8) wants to control this machine as owner. Allow?* `--yes` skips the question, for scripts.

**Who may do what.**
- Roles are per device:
  - **owner**: everything, including devices and text commands;
  - **operator**: tasks, answers, chats, typing;
  - **viewer**: read-only.
- The machine's rules sit in `config.json`, and only `cq remote` changes them:
  - the folders tasks may run in (default: the home folder; symlinks are resolved);
  - whether tasks may skip permission prompts (off);
  - whether apps may see the screen, and whether they may type (both on).
- Text commands from apps go through the same folder rule. `trust` stays a machine-only command.

**Removal.**
- `cq devices remove <name>` (or an owner app) marks the device removed.
- It tells the relay to drop the link, and ends the device's open sessions at once.
- The device's next attempt gets *not paired*.

**Retries and audit.**
- Every request has an id. Changes are remembered for a day, so a retry gets the first answer instead of running twice.
- Every change is audited: device, action, and a short detail. Never the prompt or what was typed. See it with `cq audit`.

**The relay.**
- It signs peers in with a fresh challenge per connection.
- It forwards data only between a machine and the devices it linked, or to a device holding a live pairing offer.
- It limits message rate, bytes, connections per key, open offers and links.
- It sees which keys talk, when, and how much. It never sees content.

### Threat model

| Threat | What stops it | What's left |
| --- | --- | --- |
| Someone on the network (Wi-Fi, ISP) | TLS to the relay, and Noise inside it | Traffic timing and sizes |
| A compromised or malicious relay | It can't read, change or forge messages, can't splice sessions, can't pair itself (no secret) | It can drop or delay traffic, and sees who talks to whom |
| A leaked pairing code (a photo of the QR) | One use, 10 minutes, and the machine asks yes or no showing the device's name and key | With `--yes`, whoever uses it first gets in: keep `--yes` for automation, and `cq devices` shows who's paired |
| A lost or stolen phone | `cq devices remove`, or removal from another owner device; app lock with biometrics (Phase 3) | Until removed, it can do what its role and the machine's rules allow |
| A compromised owner device | The machine's rules (folders, no bypass), the audit trail, removal | Tasks within those rules |
| Another user or app on the same machine | Local API on 127.0.0.1 with a 0600 token; key file 0600 in a 0700 folder | The machine's own administrator |
| Replayed commands | Noise nonces; request ids remembered | — |
| Supply chain | Few dependencies, pinned and at least two weeks old (`@noble/*` 2.4.0, `zod` 4.6.5); lockfile | — |

The protocol and the crypto get an external review before a public launch.

## Protocol v1

### Relay connection

- **Signing in:**
  - The peer opens a WebSocket to `/v1`.
  - The relay sends `{t:"challenge", v:1, nonce}`.
  - The peer answers `{t:"auth", v:1, id, kind:"agent"|"device", sig}`, signing `afterhours-relay-auth-v1\n<kind>\n<nonce>`.
  - The relay replies `ready`, or an `error` and closes.
  - A key stays a machine or a device for good.
- **Control messages** (JSON):
  - from peers: `ping`, `links` (machines: the full list of allowed devices, sent after every sign-in), `link`, `unlink`, `offer`, `offer.close`;
  - from the relay: `pong`, `presence` (a linked peer came or went), `undeliverable` (`offline`, `not-linked`, `no-offer`), `error`.
- **Data frames** (binary):
  - layout: `version(1) kind(1) peer(32) session(16) [offer(16)] payload`;
  - `kind` is `session`, `pairing` or `reset`;
  - the sender names the recipient, and the relay swaps in the sender before delivering;
  - each frame carries one Noise message, so at most 64 KiB.
- **Keepalive:** peers ping every 20 s and reconnect with backoff and jitter (1 s up to 30 s).

### Sessions

- **Handshake:**
  - The app sends the first IK message, carrying `Hello {v, app, name, platform}`.
  - The machine answers with `Welcome {v, ok, machine, role}`, or `{ok:false, error:"not-paired"}`.
- **Messages:**
  - After the handshake, each message is JSON in one or more Noise messages: up to 60,000 bytes each, plus a "more follows" byte.
  - A message is at most 8 MiB.
- **Recovery:**
  - Anything that breaks a session (a reset frame, a failed decryption, the relay reconnecting, the machine restarting) makes the app start a new one.
  - Requests still waiting are sent again with the same id.

### Messages

| Request (app → machine) | Role | What it does |
| --- | --- | --- |
| `sync {since}` | viewer | Start receiving events: the ones after `since` (up to 200), then a snapshot |
| `snapshot`, `jobs` | viewer | The queue, the running task, waiting approvals, limits, the machine's rules |
| `peek {lines, ansi}` | viewer | The running task's screen (if the machine shows screens), with its colours when `ansi` |
| `chats`, `folders` | viewer | Conversations and folders, only within the allowed folders |
| `transcript {job\|session, before, after, limit}` | viewer | A conversation a page at a time: what you and Claude said, each tool call in a line with an excerpt of its result, and Claude Code's own cost and token totals (a task counts only its own runs) |
| `timeline {job}` | viewer | Every notice about one task (events are kept 14 days) |
| `diff {job, file}` | viewer | The files a task changed, exactly: git trees of its folder when it started and ended (written to the object store; no commit, ref or index touched), so your own earlier edits aren't in it. With `file`, that file's diff. Only files inside the allowed folders, never secrets |
| `files {job\|folder, path, query, read}` | operator | Browse, search names and read files inside the allowed folders; never `.env` files, keys, credentials or `.git`, and never through a link that leaves the folder. A finished task's files are read as it left them |
| `queue {folder, prompt, options}` | operator | Queue a task: plan or not, review, mode, model, effort, conversation, own branch, front; when it may start (`notBefore`, `atReset`, `afterJob`, `repeatDaily` on the machine's clock) and a work-time limit (`maxMinutes`) |
| `answer {code, decision, text, rule, mode}` | operator | Answer a permission request, a question, a plan review, a folder-trust prompt. `rule`: allow and apply one of Claude Code's own `permission_suggestions` (allow rules, accepting edits, folders inside the shared ones; never one that skips prompts), returned in the hook's `updatedPermissions` so Claude Code writes it. `mode`: approve a plan and work on in that mode (skipping prompts only if the machine allows it) |
| `control {action, job}` | operator | go, pause, stop, skip, continue (after a limit), fork, take over. `job` makes sure it's still the running one |
| `job {remove\|top\|edit\|move}`, `say`, `keys` | operator | Queue order and a queued task's prompt and options; typing and keys in the running task (if the machine allows typing) |
| `branch {job, merge\|discard\|pr}` | operator (`pr`: owner) | A finished task's own branch: merged into the checkout (only when it has nothing uncommitted, and only if it merges cleanly), thrown away, or pushed and opened as a pull request with `gh` |
| `open {job\|session}` | operator | Opens the conversation in VS Code on the machine's screen |
| `chat.write {session, text}` | operator | Write into a conversation: typed in if the queue runs it, else a task continues it |
| `devices`, `devices.remove`, `devices.rename` | owner | Paired devices |
| `command {text}` | owner | Any text command (`help`), under the same rules |

**Machine → app messages:**
- `result {id, ok, text, data, error, code}`;
- `event {seq, at, notice, text}`: every daemon notice, plus `resolved` when an approval was answered anywhere or expired. Events are stored 14 days.
- `state`: the queue changed;
- `activity {job, phase, tool, detail}`: a tool call starting or ending in the running task (not stored);
- `snapshot`, with `features`: what this machine can do beyond the first version, so apps hide what an older one can't;
- `pair.result` (pairing only).

## Phases

| Phase | What | Status |
| --- | --- | --- |
| 1. Secure core | Protocol package, relay (with Docker image), the engine's remote module, `cq pair` / `devices` / `remote` / `audit`, a command-line app, tests | **Done.** 40 new tests (Noise vectors, relay rules, sessions through a real relay, the engine's rules) pass on macOS and on Linux (arm64, in Docker). The end-to-end check pairs, runs a real Claude Code task and allows its permission from the app, then checks the folder rules, tampering and removal. |
| 2. Engine everywhere | `src/platform/` (systemd user service with linger, `xdg-open`, no Full Disk Access or caffeinate off macOS); Linux x64 and arm64 binaries with checksums and build attestations; `install.sh`; an engine Docker image (Claude Code, tmux, git, non-root); EC2/cloud-init, WSL2 and Docker guides ([linux.md](linux.md)); CI on Ubuntu and macOS | **Done.** In a systemd container: the install script, the user service with linger, an update, and a restart that leaves a running task alone. In the engine image: a task queued from this Mac through the relay runs in tmux, and Claude's screen comes back. Not yet run on a real EC2 instance. |
| 3. The app (Expo) | Machines; "Needs you" across machines; queue and new task; the running task (screen, plan, answer, stop, continue, type, keys); chats; settings (devices, machines, app lock). Pairing by scan, paste or link. Built on `AppClient` ([apps/app](../apps/app/README.md)) | **Done** (Expo Go and the web; store builds need your accounts). The web build passes end to end in headless Chrome against a scripted machine and against a private daemon. Checked by hand on an iPhone simulator and an Android emulator in Expo Go: pairing, Needs you, answering by touch. Engine additions: requests carry what's needed to show them (a permission's detail, the questions, the plan, the deadline); the snapshot carries the machine's defaults and models; one task in full; recent folders; a device may rename or remove itself; waking up checks the connection with a ping |
| 4. Desktop and testers | Electron around the web build: bundled code only, context isolation, sandbox, strict CSP, tray, notifications, start at login, `afterhours://` links, the key in the OS keychain. dmg, NSIS, AppImage ([apps/desktop](../apps/desktop/README.md)). Testers: web build at a URL, desktop builds on GitHub Releases, Android APK by link, iOS on TestFlight | **Desktop done**, unsigned. End to end in test mode: pairing, closing to the tray, a notification that opens Needs you, a link handed over by a second launch, the CSP, start at login, a relay on the LAN. The installed Mac app (arm64) and the Linux arm64 build (in Docker, without a keyring) pass the same checks; the Windows installer is built but not run. Also new: the relay heartbeat counts silence from an unanswered ping, so a late timer (a hidden tab, an app in the background) no longer drops the connection. Still to come: signing and auto-update, the `.deb` (it needs a homepage), and tester distribution (your accounts and a pushed repo) |
| 5. Push and fleets | Push through the relay to Expo push (generic text by default); enrollment tokens for autoscaling servers; optional direct connections on a LAN or Tailscale; Telegram optional; native Windows engine | |

## Trying it now

```sh
bun run relay                                          # a local relay on ws://127.0.0.1:8787/v1
cq pair --relay ws://127.0.0.1:8787/v1                 # on the machine: QR code and link
bun scripts/remote-client.ts pair '<link>'             # on any computer
bun scripts/remote-client.ts status <machine>
bun scripts/remote-client.ts queue <machine> ~/code/shop "Fix the failing test" --mode edits
bun scripts/remote-client.ts watch
bun run e2e:remote                                     # the whole flow with a real Claude Code task
```

The app (Phase 3), in a browser or Expo Go ([more](../apps/app/README.md)):

```sh
cd apps/app && npm install
npm run web                                            # or: npx expo start, then scan with your phone
bun e2e/fake-machine.ts                                # a scripted machine to pair with, if you have none
```

The desktop app (Phase 4), around the same web build ([more](../apps/desktop/README.md)):

```sh
cd apps/desktop && npm install
npm start                                              # or npm run dist:mac (dist:win, dist:linux) for installers
```

## What you need to provide (later phases)

- A server for the relay: any small VPS or Fly.io, with a subdomain and TLS (`docker build -f relay/Dockerfile .`).
- An Expo account (free), a Firebase project (Android push), and the Apple Developer Program (TestFlight, iOS push).
