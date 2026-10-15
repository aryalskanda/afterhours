# Afterhours

**Line up Claude Code tasks from your phone. They run one after another on your computer while you're away, wait out usage limits, and message you only when they need you.**

Afterhours is a free, open-source task queue for [Claude Code](https://claude.com/claude-code) on macOS and Linux (Windows through WSL2), from a laptop to a server in the cloud. You send a prompt to your own Telegram bot and tap buttons to choose the folder, mode, model and effort. Afterhours then runs the real Claude Code CLI on that machine. It:

- approves plans;
- sends permission requests and questions to your phone;
- carries on after a usage limit resets;
- puts each new piece of work on its own git branch for you to review.

> Afterhours runs Claude Code with your own Claude sign-in and plan. It is not made by, affiliated with, or endorsed by Anthropic.

```
you  Add a dark mode toggle to the settings page
bot  📝 Add a dark mode toggle to the settings page
     📁 shop/web · 🗺 plan→auto · 🧠 sonnet · ⚡ high
     💬 new chat · 🌿 on its own branch
     [📁 Folder] [🗺 Mode] [🧠 Model] [⚡ Effort] [💬 Chat…] [📂 Work in place] [▶️ Queue] [✖️ Discard]
you  taps ▶️ Queue
bot  ✅ Queued #14 · Starting now.
bot  📝 #14 plan approved (Yes, and use auto mode) …
bot  ⏸ #14 hit the 5-hour limit · resets 3:30 PM · it continues on its own
bot  ✅ #14 done in 48m · 6 files changed, 212 insertions(+)
     🌿 On branch afterhours/14-add-a-dark-mode-toggle · merge with git merge afterhours/14-add-a-dark-mode-toggle
     [➕ Follow up]
```

## What it adds to Claude Code

| | |
| --- | --- |
| **A queue across projects** | Each task has its own folder, mode, model and effort. Tasks run one at a time, in order. |
| **Unattended plans** | `plan` tasks plan first, then Afterhours approves the plan. `review` tasks send you the plan to approve or change. |
| **Limit-aware** | No new task starts while a 5-hour or weekly limit is active. The running task continues after the reset, even if the Mac slept through it. |
| **Never stalls on you** | You get permission requests and questions on your phone. If you don't answer, the request is denied, or Claude uses its best judgment and lists its assumptions. |
| **Your checkout stays clean** | Each new conversation runs on its own branch in a git worktree, and its work is committed there for you to review and merge. |
| **Every chat, from your phone** | **💬 Chats** lists your recent chats from every project, VS Code ones included. Open one and type: your messages go into that same conversation. A chat in VS Code that hits a usage limit continues by itself at the reset, inside VS Code. |
| **Your phone, your bot** | Afterhours talks to a Telegram bot you create, straight from your Mac. No servers, accounts or open ports. |

## Requirements

- macOS 13 or newer, or Linux on x64 or arm64 (Ubuntu 22.04+, Debian 12+, Fedora, Amazon Linux 2023…). Windows 11 through WSL2.
- Claude Code, signed in with a Claude Pro or Max plan or an API key. Developed against Claude Code 2.1.296–2.1.300.
- tmux, git and curl (`cq setup` offers to install tmux with Homebrew on a Mac).
- Telegram on your phone, or the Afterhours app once it ships (see [remote access](#remote-access-with-the-afterhours-apps-preview)).

On Linux, a server, WSL2 or Docker, see **[docs/linux.md](docs/linux.md)**. It covers the install script, the systemd service, signing Claude Code in without a browser, and an EC2 cloud-init example.

## Install

On Linux: `curl -fsSL https://github.com/<owner>/afterhours/releases/latest/download/install.sh | sh`, then see [docs/linux.md](docs/linux.md). On a Mac, with Homebrew:

```sh
brew install <owner>/tap/afterhours
cq setup
```

From source, with [Bun](https://bun.sh):

```sh
git clone https://github.com/<owner>/afterhours && cd afterhours
bun install
bun src/cli/cq.ts setup
```

`cq setup` walks you through:

- checking Claude Code and tmux;
- choosing your code folders;
- choosing the defaults for new tasks;
- starting Afterhours at login;
- **Full Disk Access**: it opens the right System Settings pane and tells you what to add. The Claude sessions Afterhours starts need it to work in folders like `~/Documents` while nobody is there to click "Allow". The permission goes to a tiny launcher that never changes, so updates keep it.
- **your Telegram bot**: create one with @BotFather (`/newbot`), paste its token, then send the bot the `/start <code>` message `cq setup` shows you.

Check everything at any time with `cq doctor`.

## Using it from Telegram

**Send a prompt.** The bot answers with a card already set to your last choices. Tap **▶️ Queue**, or change things first:

| Button | What it does |
| --- | --- |
| **📁 Folder** | Browse your code folders. Tap a folder marked `›` to open it; tap one without `›` (or **✅ Use …**) to pick it. **⭐ Recent**, **🔍 Search** (type part of a name, e.g. `api` or `shop web`), **⬆️ Up**, **🔄 Rescan**. 📦 marks git repos. |
| **🗺 Mode** | `plan → auto` (Afterhours approves the plan), `review → auto` (you approve it), `auto`, `accept edits`, `yolo` (no permission checks), `ask` (a question: Claude reads and answers, changes nothing) |
| **🧠 Model** | `opus` · `sonnet` · `haiku` |
| **⚡ Effort** | `low` · `medium` · `high` · `xhigh` · `max` |
| **💬 Chat…** | Which conversation to continue: **🆕 New chat**, **🔁 Last Afterhours chat** in that folder, or one of the folder's recent chats from anywhere, VS Code and the terminal included. 🟢 open elsewhere · 🟡 working there · ⏸ stopped at a usage limit |
| **🤝 Take over** / **⏳ Wait instead** | For a chat that's open in VS Code or a terminal: close it there when the task starts, or wait until you close it ([more](#continue-a-vs-code-chat-from-your-phone)) |
| **🌿 Own branch** / **📂 Work in place** | For a new conversation: run it on its own branch, or in your checkout |

The buttons under the text box:

- **➕ New task**: pick the folder first, then send the prompt.
- **📋 Queue**: every waiting task, with **⬆️ Run next** and **🗑 Remove**.
- **📊 Status**: the current task and what it last did, anything waiting on you (with its **✅ Allow** / **❌ Deny** right there), what's next, your 5-hour and weekly usage as bars, and **⏸ Pause** / **▶️ Resume**.
- **👀 Peek**: the running task's screen, with **⌨️ Type** (type into it) and **🔘 Keys** (press 1, 2, 3, Enter, Esc, arrows) for a screen Afterhours can't answer.
- **💬 Chats**: your recent chats from every project, newest first. Open one to see your last prompt and Claude's last reply, then **✍️ Write here**: everything you type goes into that chat until you tap **⬅️ Leave chat**.

**Messages from the bot come with buttons:**

| Message | Buttons |
| --- | --- |
| 🔐 Claude wants permission | **✅ Allow**, **❌ Deny**. Denied automatically after 15 minutes. |
| ❓ Claude asks a question | One question at a time, every option written out in full. Tap one; where several apply, tick them and tap **✅ Done**; or **✍️ Type an answer**. **⬅️ Back** goes to the previous question. After 15 minutes Claude decides itself. |
| 📝 A plan for review | The whole plan, formatted, then **✅ Approve**, **✏️ Ask for changes** |
| ⏸ A task hit a usage limit | **▶️ Continue now** (try before the reset, e.g. after buying extra usage), **👀 Peek** |
| ⚠️ / ❌ A task paused or failed | **▶️ Go**, **⏭ Skip**, **👀 Peek**, **⌨️ Type**, **🔘 Keys** |
| ⚠️ A task's chat is open in VS Code | **🤝 Take over**, **🍴 Continue in a copy**, **⏭ Skip** |
| ⏸ Your chat in VS Code hit a usage limit | **✖️ Don't continue**, **🤝 Continue here instead**, **✏️ Follow up…** |
| ✅ A task is done | Claude's final answer, formatted and in full (a few messages, or a file when it's very long), then **➕ Follow up**: the next prompt for the same folder and conversation. |

Keeping it tidy:

- Each task has one card. It's edited as the task goes on: started, plan approved (**📄 Full plan** shows it all), done. Its buttons go away when the task ends.
- News that needs nothing from you arrives silently: started, plan approved, resumed, queue empty. Your phone only buzzes when something needs you or a task ends.
- A request answered somewhere else (the terminal, another device) or timed out loses its buttons, with a line saying what happened.
- Claude's Markdown shows as formatting (headings, bold, code, lists, tables), not as `##` and `**`.

If Telegram can't be reached, messages wait on the Mac and arrive in order once it can.

Commands in the menu: `/new /chats /leave /queue /status /peek /pause /resume /settings /cancel /help`. `/settings` sets how much the bot messages you (all, important, or off), whether it watches your other chats for usage limits, and whether it continues them by itself.

## Continue a VS Code chat from your phone

Your phone sees every chat: **💬 Chats** lists them all, and the same conversation carries on wherever it lives.

- **Write into any chat.** Open it in **💬 Chats** and tap **✍️ Write here**. Then everything you type goes into that conversation, in the order you sent it:
  - The queue is running it → typed straight in, and Claude reads it when its current step ends.
  - It's not open anywhere → the queue resumes it with your message.
  - It's open in VS Code or a terminal → the queue takes it over: closes it there and continues it, so your message counts as yours and permission requests come to your phone. When it's done, the chat opens in VS Code again (if VS Code is running).
- **A usage limit hit in VS Code continues by itself.** Within about 30 seconds you get **⏸ Your chat in VS Code hit the 5-hour limit · resets 4:55 AM**. At the reset:
  - If it already runs again (Claude Code continued it, or you did), nothing happens.
  - If it's still open and waiting, Afterhours tells it to continue through Claude Code's messaging between sessions. VS Code stays live, and you see it carry on there. Claude sees the message as coming from another session working on your behalf.
  - If it hasn't started 2 minutes later, or the chat was closed, the queue continues it instead.
  - **✖️ Don't continue** and **🤝 Continue here instead** are on the message. **▶️ Auto-continue** in `/settings` turns it off.
- **Taking a chat over is careful.** Afterhours only closes a chat when you asked (or wrote into it), only while it's idle, and only in a window that was already open then. If the window doesn't close, or opens the chat again, the task stops and asks you. It never closes anything twice.
- **Remote Control**, Anthropic's own feature, lets you type into a live VS Code chat from the Claude app. In VS Code, run `/remote-control`, or turn on *Enable Remote Control for all sessions*. Afterhours works alongside it.

## Remote access with the Afterhours apps (preview)

The Telegram bot is being replaced by Afterhours apps for iPhone, Android, Mac, Windows and Linux. They talk to your machine end-to-end encrypted, through a small relay that machines and apps both connect out to, so a machine needs no open ports. That is also what will let a server in the cloud work like the Mac at home: running the engine on Linux is the next step. The design and the plan are in [docs/architecture.md](docs/architecture.md).

The engine side works now; until the apps ship, a command-line app stands in for them:

```sh
# 1. A relay, anywhere both sides can reach (put TLS in front for wss://):
docker build -f relay/Dockerfile -t afterhours-relay . && docker run -d -p 8787:8787 -v afterhours-relay:/data afterhours-relay

# 2. On the machine: pair (shows a QR code and a link, valid once for 10 minutes)
cq pair --relay wss://relay.example.com

# 3. On another computer: pair with the link, then drive the machine
bun scripts/remote-client.ts pair '<the link>'
bun scripts/remote-client.ts queue <machine> ~/code/shop "Add a dark mode toggle"
bun scripts/remote-client.ts watch
```

The machine decides what apps may do, and no app can change it:

- `cq remote allow <folder>`: apps run tasks only in these folders (default: your home folder).
- `cq remote bypass on|off`: tasks that skip permission prompts (off by default).
- `cq remote screens on|off` and `cq remote typing on|off`: seeing and typing into the running task.
- `cq devices` lists paired devices; `cq devices remove <name>` cuts one off at once; `cq audit` shows what apps did.

## What happens to a task

1. **Start.** For a new conversation on its own branch, Afterhours makes a git worktree under `<repo>/.claude/worktrees/` on a new branch `afterhours/<id>-<words-from-the-prompt>`. Outside a git repo, the task runs in the folder itself. Claude Code then starts with the task's model, effort and mode.
2. **Plan.** For `plan` tasks, Afterhours approves the plan when Claude presents it and sends you a copy.
3. **Permissions and questions** reach you as 🔐 and ❓. No answer means "denied, find another way" or "use your best judgment and list your assumptions".
4. **Usage limits.** Claude Code's own auto-continue resumes at the reset. If it doesn't, Afterhours types `continue` a few minutes later. If that doesn't take either, it restarts the session.
5. **End of turn.** The task is done when Claude finishes with no background work still running. Afterhours waits for subagents, and up to 10 minutes for background commands (a dev server never finishes). It then:
   - commits the work on the task's branch;
   - sends ✅ with a `git diff` summary;
   - starts the next task.
6. **Problems.** A crash, an unexpected screen, or 20 minutes of silence pauses the queue and sends you the last lines of the screen.

Follow-ups continue in the same worktree and branch. Review a branch with `git log -p main..afterhours/14-…`. Merge it with `git merge`. When you're done with it, remove it with `git worktree remove .claude/worktrees/afterhours-14 && git branch -D afterhours/14-…`.

### Watching and taking over

- `cq attach` shows the running task live, read-only. Detach with `Ctrl-b d`.
- Finished tasks are ordinary Claude Code conversations named `Afterhours: <prompt>`, so you can pick one up in VS Code or the terminal.
- **Don't** open a conversation elsewhere while Afterhours is running it: two Claude processes writing one conversation will fork it. If the conversation a task needs is already open elsewhere, Afterhours waits until you close it. You can also tap **🤝 Take over** (close it there and continue here) or **🍴 Continue in a copy**.

## The `cq` command

| Command | What it does |
| --- | --- |
| `cq setup` | Guided setup (safe to run again) |
| `cq doctor` | Check Claude Code, tmux, the background service, Full Disk Access and Telegram |
| `cq telegram <token>` · `cq telegram off` | Connect a different bot · stop using Telegram |
| `cq pair` · `cq devices` · `cq remote` · `cq audit` | Pair an Afterhours app · list or remove paired devices · remote access settings · what apps did |
| `cq restart` · `cq logs [-f]` · `cq attach` | Restart the background service · its log · watch the running task |
| `cq update` | Update (Homebrew installs: `brew upgrade afterhours`) |
| `cq report` | Write a support file to your Desktop. It holds no prompts, code or tokens; read it before you send it. |
| `cq uninstall` | Stop it and remove it from login items (keeps `~/.afterhours`) |

### Text commands

In a terminal, the queue takes text commands as `cq <command>`; tasks default to the current folder. Typing `q …` to the bot fills in a card the same way.

```
q <prompt>                                   queue with your defaults
q myapp plan opus max: <prompt>              options go before the colon
q myapp review: <prompt>                     plan, send me the plan, wait for my y / n <changes>
q myapp new auto sonnet high: <prompt>       fresh conversation, no plan
q here: <prompt>                             in your checkout instead of on its own branch
q @9a7a2477: <prompt>                        continue that conversation (any Claude session id prefix)
q @9a7a2477 take: continue                   …closing it first where it's open (VS Code, a terminal)
```

The words before the first colon count as options only if every one of them is an option, so `q fix: the login bug` queues "fix: the login bug".

| Option | Meaning |
| --- | --- |
| `plan` / `review` | Plan first; Afterhours approves it / you approve it |
| `auto` / `edits` / `yolo` | No plan. Run in auto mode / accept edits / bypass permissions |
| `plan+edits`, `plan+yolo`, `review+edits`, … | Plan first, then run in that mode |
| `opus` `sonnet` `haiku` `fable` `claude-…` | Model |
| `low` `med` `high` `xhigh` `max` | Effort |
| `new` / `now` | Fresh conversation / put the task at the front of the queue |
| `ask` | A question: Claude reads and answers, changes nothing, no plan |
| `@<id>` / `take` | Continue that conversation / close it first where it's open |
| `branch` / `here` | On its own branch / in your checkout |
| `<alias>` or a path | Project folder |

| Command | What it does |
| --- | --- |
| `ls` · `st` · `peek [lines]` · `plan [#]` | Queue · status · screen · latest plan |
| `chats [project]` | The folder's recent Claude Code chats from anywhere, with the ids `q @<id>:` takes |
| `pause` / `go` | Stop starting new tasks / resume. `go` also retries a paused task |
| `stop` · `skip` · `rm <#>` · `top <#>` | Interrupt · drop the current task · remove one · run one next |
| `say <text>` · `keys <keys>` | Type into the running session · press keys in it (`keys 1`, `keys esc`, `keys down enter`) |
| `y [code]` · `n [code] [note]` · `a [code] <answer>` | Answer a permission, plan review or folder-trust request · answer a question |
| `take` · `fork` | For a task that's waiting on a conversation open elsewhere: close it there and continue it · continue in a copy |
| `projects` · `alias <name> <path>` · `unalias <name>` · `trust <name\|path>` | Projects |
| `default <options>` · `notify all\|important\|off` | Defaults · how much the bot messages you |

## Configuration

`~/.afterhours/config.json`. Afterhours updates it when you change settings from Telegram or with commands, and reloads it when you edit it.

| Key | Default | |
| --- | --- | --- |
| `folders.roots` / `maxDepth` | chosen in `cq setup` / 6 | What the folder browser and search cover |
| `defaults` | plan → auto, `sonnet`, `high` | Used for your first task; after that, new cards start with your last choices |
| `isolate` | `true` | New conversations run on their own branch |
| `models` | `opus`, `sonnet`, `haiku` | Model buttons |
| `notify` | `all` | `important` skips started, approved and resumed messages |
| `timeouts.approvalSec` / `questionSec` | 900 | How long 🔐 and ❓ wait for you |
| `timeouts.reviewSec` | 3600 | How long a 📝 review waits |
| `timeouts.stuckSec` | 1200 | Silence before a task counts as stuck |
| `timeouts.limitGraceSec` | 180 | Wait after a reset before Afterhours types `continue` itself |
| `timeouts.backgroundSec` | 600 | How long to wait for background commands after a turn |
| `keepAwake` | `true` | Keep the Mac from idle-sleeping while tasks are pending (closing the lid still sleeps it) |
| `remoteControl` | `false` | Start sessions with `--remote-control` so they also appear in the Claude app |
| `watchSessions` | `true` | Message you when one of your other chats (VS Code, a terminal) stops on a usage limit |
| `autoContinueChats` | `true` | And continue it by itself at the reset: inside the open chat, else through the queue |
| `reopenInVsCode` | `true` | When a task that took a chat from VS Code ends, open the chat there again |
| `telegram` | set by `cq telegram` | The bot token and your paired account |
| `aliases`, `trustedDirs` | | Project names for text commands, and folders whose trust prompt Afterhours may accept |
| `imessage.enabled` | `false` | Text commands over iMessage instead of Telegram (see below) |
| `port`, `claudePath`, `tmuxPath` | 7787, from `PATH` | |

Next to it: `state.db` (queue and history), `folders.json` (the folder map), `logs/cqd.log`, `jobs/` (per-task session settings) and `token` (how `cq` and the hooks talk to the background service).

**iMessage** (optional): text the commands to yourself at your **Apple ID email**. SMS is ignored on purpose, because SMS senders can be faked.

## How it works

- **The real Claude Code.** Each task runs the unmodified `claude` command in a private tmux session (`tmux -L afterhours`). It starts with `--model`, `--effort` and `--permission-mode`, and follow-ups use `--resume`. Claude Code signs in as it always does on your Mac; Afterhours never sees your credentials.
- **Hooks for everything else.** Afterhours passes per-session settings with `--settings`, so your own `~/.claude/settings.json` is never touched. These settings add hooks that report to Afterhours on `127.0.0.1`: the end of a turn, usage-limit stops, permission requests and Claude's questions. They also add a status line that carries your limit windows.
- **Two dialogs answered with keystrokes.** Claude Code doesn't let hooks approve a plan or trust a folder, so Afterhours reads those dialogs and presses the option for the task. It accepts the folder-trust dialog only for folders you've approved: the first time a task runs in a new folder, your phone asks you. A nightly [compatibility check](scripts/compat.ts) runs all of this against the newest Claude Code release.
- **Your other chats.** To list chats and spot usage-limit stops, Afterhours reads Claude Code's own records: running sessions in `~/.claude/sessions` and transcripts in `~/.claude/projects`. To continue an open chat after a limit, it posts one message into that session's inbox, Claude Code's own messaging between sessions on this Mac. Taking a chat over sends that window's Claude process a normal quit signal (SIGTERM), then resumes the conversation with `--resume`.
- **Your phone.** Afterhours polls the Telegram Bot API from your Mac. Only the Telegram account you paired can use the bot.

## Privacy and security

- Afterhours runs entirely on your Mac and collects nothing.
- Your prompts go to Anthropic through Claude Code, as they always would. They also go to Telegram, because bot chats aren't end-to-end encrypted: prompts, plans and Claude's summaries pass through Telegram's servers. The same goes for the titles and last prompts of your other chats when **💬 Chat…** lists them or one hits a usage limit; turn the latter off in `/settings`.
- The background service listens only on `127.0.0.1` and requires a token.
- Remote access is end-to-end encrypted (Noise, with keys from pairing). The relay passes on what it can't read or change; it sees which keys talk, when, and how much. Apps can only do what the machine's rules allow, and every action is in `cq audit`.
- Afterhours writes into your other chats only to continue them after a usage limit (when Auto-continue is on), and closes a chat only when you take it over.
- See [SECURITY.md](SECURITY.md) for the details and how to report a vulnerability.

## Troubleshooting

- `cq doctor` first, then `cq logs -f`.
- The bot doesn't answer:
  - `cq telegram` shows whether it's paired;
  - only one Afterhours may use a bot token at a time;
  - Telegram must be reachable from the Mac.
- A task is paused on a screen Afterhours doesn't know: use **👀 Peek**, then `cq keys …` or `cq say …`, then **▶️ Go**.
- Still stuck? Open an issue with the file from `cq report` attached.

## Development

```sh
bun install
bun test                    # unit tests, including the Telegram bot against a fake Telegram
bun run typecheck
bun run compat              # end-to-end check against the real Claude Code (a few cents of Haiku)
bun run e2e:remote          # remote access end to end: relay, daemon, app, real Claude Code (a few cents)
bun run relay               # a relay on port 8787, for trying remote access locally (ws://127.0.0.1:8787)
bun src/cli/cq.ts daemon    # run in the foreground (Ctrl-C to stop; tasks keep running in tmux)
```

For an isolated instance, set `CQ_HOME=/tmp/ah-dev CQ_TMUX_SOCKET=ah-dev` and set a different `port` in that home's `config.json`.

Releases: bump `version` in `package.json`, then push a matching tag (`git tag v0.2.0 && git push origin v0.2.0`). The release workflow:

1. runs the tests and the compatibility check;
2. builds the Apple Silicon and Intel binaries;
3. publishes them with a filled-in Homebrew formula;
4. updates the tap when a `HOMEBREW_TAP_TOKEN` secret is set.

The compatibility check needs an `ANTHROPIC_API_KEY` secret.

Where things are:

- `src/daemon/runner.ts`: the task lifecycle.
- `src/daemon/launch.ts`: the `claude` command line and per-session settings.
- `src/daemon/screens.ts`: the screens answered with keystrokes.
- `src/daemon/commands.ts`: the text commands.
- `src/telegram/`: the bot.
- `packages/protocol/`: keys, Noise sessions, pairing and the messages apps and machines exchange (shared with the apps).
- `relay/`: the relay server and its Docker image.
- `src/daemon/remote/`: the machine's side of remote access: devices, rules, events, audit.
- `src/cli/`: `cq` and `cq setup`.
- `bin/cq-launcher.c`: the launcher that holds Full Disk Access.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) for attributions.
