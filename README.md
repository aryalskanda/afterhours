# Afterhours

**Line up Claude Code tasks from your phone. They run one after another on your Mac while you're away, wait out usage limits, and message you only when they need you.**

Afterhours is a free, open-source task queue for [Claude Code](https://claude.com/claude-code) on macOS. You send a prompt to your own Telegram bot and tap buttons to choose the folder, mode, model and effort. Afterhours then runs the real Claude Code CLI on your Mac. It:

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
| **Your VS Code chats too** | Send a follow-up into any chat in a folder, including one open in VS Code. When one stops on a usage limit, you get a message, and one tap has Afterhours continue it after the reset. |
| **Your phone, your bot** | Afterhours talks to a Telegram bot you create, straight from your Mac. No servers, accounts or open ports. |

## Requirements

- A Mac with macOS 13 or newer.
- Claude Code, signed in with a Claude Pro or Max plan or an API key. Developed against Claude Code 2.1.296–2.1.299.
- tmux (`cq setup` offers to install it with Homebrew).
- Telegram on your phone.

## Install

With Homebrew:

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
| **🗺 Mode** | `plan → auto` (Afterhours approves the plan), `review → auto` (you approve it), `auto`, `accept edits`, `yolo` (no permission checks) |
| **🧠 Model** | `opus` · `sonnet` · `haiku` |
| **⚡ Effort** | `low` · `medium` · `high` · `xhigh` · `max` |
| **💬 Chat…** | Which conversation to continue: **🆕 New chat**, **🔁 Last Afterhours chat** in that folder, or one of the folder's recent chats from anywhere, VS Code and the terminal included. 🟢 open elsewhere · 🟡 working there · ⏸ stopped at a usage limit |
| **🤝 Take over** / **⏳ Wait instead** | For a chat that's open in VS Code or a terminal: close it there when the task starts, or wait until you close it ([more](#continue-a-vs-code-chat-from-your-phone)) |
| **🌿 Own branch** / **📂 Work in place** | For a new conversation: run it on its own branch, or in your checkout |

The buttons under the text box:

- **➕ New task**: pick the folder first, then send the prompt.
- **📋 Queue**: every waiting task, with **⬆️ Run next** and **🗑 Remove**.
- **📊 Status**: the current task, what it last did, your 5-hour and weekly usage, and **⏸ Pause** / **▶️ Resume**.
- **👀 Peek**: the running task's screen.

**Messages from the bot come with buttons:**

| Message | Buttons |
| --- | --- |
| 🔐 Claude wants permission | **✅ Allow**, **❌ Deny**. Denied automatically after 15 minutes. |
| ❓ Claude asks a question | One button per option, or **✍️ Type an answer**. After 15 minutes Claude decides itself. |
| 📝 A plan for review | **✅ Approve**, **✏️ Ask for changes** |
| ⚠️ / ❌ A task paused or failed | **▶️ Go**, **⏭ Skip**, **👀 Peek** |
| ⚠️ A task's chat is open in VS Code | **🤝 Take over**, **🍴 Continue in a copy**, **⏭ Skip** |
| ⏸ Your chat in VS Code hit a usage limit | **▶️ Continue after the reset**, **✏️ Follow up…**, **✖️ Ignore** |
| ✅ A task is done | **➕ Follow up**: the next prompt for the same folder and conversation |

Commands in the menu: `/new /queue /status /peek /pause /resume /settings /cancel /help`. `/settings` sets how much the bot messages you (all, important, or off), and whether it watches your other chats for usage limits.

## Continue a VS Code chat from your phone

Two Claude processes can't share one conversation, so there are two ways to carry on a chat you started in VS Code (or in a terminal):

- **Hand it to Afterhours.** Afterhours closes the chat in VS Code and continues the *same* conversation on your Mac. It relays permissions and questions to Telegram, waits out usage limits and tells you when it's done. When you're back, reopen the chat from VS Code's Session history: everything it did is there.
  - **Send a follow-up:** start a card in that folder, tap **💬 Chat…** and pick the chat. Chats open elsewhere get **🤝 Take over**: when the task starts, Afterhours closes the chat there and continues it. If the chat is in the middle of a turn, Afterhours waits for the turn to end. Tap **⏳ Wait instead** to start only once you close it yourself.
  - **A usage limit hit in VS Code:** within about 30 seconds the bot sends **⏸ Your chat in VS Code hit the 5-hour limit · resets 4:55 AM**. Tap **▶️ Continue after the reset** and Afterhours takes the chat over and sends Claude Code's own "Continue from where you left off." It runs as soon as the limit resets, even if the Mac slept through it (keep it plugged in with the lid open). A chat that was still planning comes back as `review`, so you approve the plan on your phone.
  - Afterhours only closes a chat after you ask, only while it's idle, and only in a window that was already open when you asked. If the window doesn't close, or opens the chat again, the task stops and asks you. It never closes anything twice.
- **Steer the live chat with Remote Control**, Anthropic's own feature. In VS Code, run `/remote-control` in a chat, or turn on *Enable Remote Control for all sessions* in the command menu's Settings. Then open the chat in the Claude app (**Code** tab) and type into the same VS Code chat from your phone. In Remote Control chats, Claude Code doesn't wait out usage limits by itself, so for those, hand the chat to Afterhours instead.

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
- **Your other chats.** To list a folder's chats and spot a usage-limit stop, Afterhours reads Claude Code's own records: running sessions in `~/.claude/sessions` and transcripts in `~/.claude/projects`. Taking a chat over sends that window's Claude process a normal quit signal (SIGTERM), then resumes the conversation with `--resume`.
- **Your phone.** Afterhours polls the Telegram Bot API from your Mac. Only the Telegram account you paired can use the bot.

## Privacy and security

- Afterhours runs entirely on your Mac and collects nothing.
- Your prompts go to Anthropic through Claude Code, as they always would. They also go to Telegram, because bot chats aren't end-to-end encrypted: prompts, plans and Claude's summaries pass through Telegram's servers. The same goes for the titles and last prompts of your other chats when **💬 Chat…** lists them or one hits a usage limit; turn the latter off in `/settings`.
- The background service listens only on `127.0.0.1` and requires a token.
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
- `src/cli/`: `cq` and `cq setup`.
- `bin/cq-launcher.c`: the launcher that holds Full Disk Access.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) for attributions.
