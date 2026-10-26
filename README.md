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
- Telegram on your phone, or the Afterhours app (a preview for now: see [remote access](#remote-access-with-the-afterhours-apps-preview)).

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
| **🧠 Model** | `opus` · `sonnet` · `haiku`. With a plan, a second row picks the model that carries it out: plan with Opus, work with Sonnet ([more](#plan-with-one-model-work-with-another)) |
| **⚡ Effort** | `low` · `medium` · `high` · `xhigh` · `max` |
| **💬 Chat…** | Which conversation to continue: **🆕 New chat**, **🔁 Last Afterhours chat** in that folder, or one of the folder's recent chats from anywhere, VS Code and the terminal included. 🟢 open elsewhere · 🟡 working there · ⏸ stopped at a usage limit |
| **🤝 Take over** / **⏳ Wait instead** | For a chat that's open in VS Code or a terminal: close it there when the task starts, or wait until you close it ([more](#continue-a-vs-code-chat-from-your-phone)) |
| **🌿 Own branch** / **📂 Work in place** | For a new conversation: run it on its own branch, or in your checkout |
| **🔗 Live link** | End with a live link: a claude.ai page showing the result, to open on your phone ([more](#live-links)) |
| **⏰ Later** | When it may start: in an hour, tonight at 23:00, 07:00, or a time you type (`23:00`, `11pm`, `in 2h`, `tomorrow 9am`) |

The buttons under the text box:

- **➕ New task**: pick the folder first, then send the prompt.
- **📋 Queue**: every waiting task, with **⬆️** / **⬇️** (move it), **⏸** (hold it in its place; **▶️** lets it go), **✏️** (change its prompt, mode, models, effort, live link or time, then **💾 Save**) and **🗑**, and **🧹 Clear** (tap twice).
- **📊 Status**: the current task and what it last did, anything waiting on you (with its **✅ Allow** / **❌ Deny** right there), what's next, your 5-hour and weekly usage as bars, and **⏸ Pause** / **▶️ Resume**.
- **👀 Peek**: the running task's screen, with **⌨️ Type** (type into it) and **🔘 Keys** (press 1, 2, 3, Enter, Esc, arrows) for a screen Afterhours can't answer.
- **💬 Chats**: your recent chats from every project, newest first. Open one to see your last prompt and Claude's last reply, then **✍️ Write here**: everything you type goes into that chat until you tap **⬅️ Leave chat**.

**Messages from the bot come with buttons:**

| Message | Buttons |
| --- | --- |
| 🔐 Claude wants permission | **✅ Allow**, **❌ Deny**. Denied automatically after 15 minutes. |
| ❓ Claude asks a question | One question at a time, every option written out in full. Tap one; where several apply, tick them and tap **✅ Done**; or **✍️ Type an answer**. **⬅️ Back** goes to the previous question. After 15 minutes Claude decides itself. |
| 📝 A plan for review | The whole plan, formatted, then **✅ Approve**, **✏️ Ask for changes** |
| ⏸ A task hit a usage limit | **▶️ Continue now** (try before the reset, e.g. after buying extra usage), **👀 Peek**, **🛑 Kill** |
| ⚠️ / ❌ A task paused or failed | **▶️ Go**, **🛑 Kill**, **👀 Peek**, **⌨️ Type**, **🔘 Keys** |
| ⚠️ A task's chat is open in VS Code | **🤝 Take over**, **🍴 Continue in a copy**, **🛑 Kill** |
| ⏸ Your chat in VS Code hit a usage limit | **✖️ Don't continue**, **🤝 Continue here instead**, **✏️ Follow up…** |
| ✅ A task is done | Claude's final answer, formatted and in full (a few messages, or a file when it's very long), then **➕ Follow up**: the next prompt for the same folder and conversation, and **🔗 Live link** (or **🔗 Get a live link**). On its own branch: **🌿 Merge** and **🗑 Discard branch** (tap twice). |
| 🔗 A live link | **🔗 Open the live link** |

Keeping it tidy:

- Each task has one card. It's edited as the task goes on: started, plan approved (**📄 Full plan** shows it all), done. Its buttons go away when the task ends.
- News that needs nothing from you arrives silently: started, plan approved, resumed, queue empty. Your phone only buzzes when something needs you or a task ends.
- A request answered somewhere else (the terminal, another device) or timed out loses its buttons, with a line saying what happened.
- Claude's Markdown shows as formatting (headings, bold, code, lists, tables), not as `##` and `**`.

If Telegram can't be reached, messages wait on the Mac and arrive in order once it can.

**🛑 Kill** (tap it twice) ends a stuck task now: Claude and everything it started stop, whatever it waited on from you is settled, and the queue moves on ([more](#kill-a-stuck-task)). It's also on the task's card, **📊 Status** and **👀 Peek**, and `/kill` does it.

**🖥 /mac** shows what's open on the Mac and what keeps it awake, to quit an app or put the Mac to sleep, now or once the queue is done; **/sleep** goes straight there ([more](#quit-apps-and-sleep-the-mac)).

Commands in the menu: `/app /new /chats /leave /queue /status /peek /kill /mac /sleep /pause /resume /settings /cancel /help`. `/settings` sets how much the bot messages you (all, important, or off), whether it watches your other chats for usage limits, and whether it continues them by itself.

### The app inside Telegram

The bot does everything above by itself. As an extra, it can also open the whole Afterhours app inside Telegram, as a Mini App: full screen, light or dark like Telegram, with Telegram's own Back button. It needs no app store and no account anywhere. Your Mac serves the app, and Tailscale Funnel gives it the public https address Telegram requires.

1. Install [Tailscale](https://tailscale.com/download), sign in and connect. Turn on **HTTPS Certificates** once (Tailscale's admin page → DNS).
2. On the Mac: `cq app setup`. It copies the app's web build (from the apps' repository next to this one, or `--web <its app/dist-web>`), runs the relay inside Afterhours (on `127.0.0.1:7788`), and opens it to the internet with `tailscale funnel`. The first time, Tailscale shows a link to allow Funnel. Open it, then run `cq app setup` again.
3. In Telegram, send `/app` to your bot and tap **Finish setup**. That pairs this Telegram with your Mac in one tap. The link works once, for 10 minutes, and the Mac also checks Telegram's signed proof that you're the bot's owner.

4. In the bot, `/settings` → **📱 Turn the app inside Telegram on**.

From then on:

- The **Afterhours** button next to the text box opens the app.
- The bot's messages are a line or two, and **Open ↗** shows the rest in the app:
  - 🔐 *#14 wants to run a command · Runs the tests*: **✅ Allow** · **❌ Deny** · **Open ↗**
  - ✅ *#14 done in 48m · 6 files changed*: **Open ↗** · **➕ Follow up**
  - ❓ questions: **Answer ↗**
  - 📝 plans: **✅ Approve** · **Review ↗**
  - ⚠️ / ❌ paused or failed: **▶️ Go** · **⏭ Skip** · **Open ↗**
- A prompt you type still gets a card: **▶️ Queue** as it is, or **Change ↗** in the app.
- The buttons under the text box go away, since the app has them all. The typed commands still work.
- `/settings` → **📄 Turn the app inside Telegram off** brings back the full messages and every button, and the commands menu.

Inside the app, everything goes end to end through the relay, not through Telegram; the bot's short notices still pass through Telegram, as before. The app only opens while the Mac is awake and online, and so does the bot. `cq app status` checks it's reachable; `cq app off` stops serving it. Every newly paired device is announced in your chat.

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

The Telegram bot is being replaced by the Afterhours app, for iPhone, Android, the web, and the Mac, Windows and Linux desktop. It talks to your machines end-to-end encrypted, through a small relay that machines and apps both connect out to, so a machine needs no open ports, whether it's the Mac at home or a server in the cloud. The design and the plan are in [docs/architecture.md](docs/architecture.md).

The apps (the phone and web app, and the desktop app around it) live in their own repository, which isn't open source; this one has everything they talk to: the engine, the relay and the protocol (`packages/protocol`). Until the apps are in the stores:

```sh
# 1. A relay, anywhere both sides can reach (put TLS in front for wss://):
docker build -f relay/Dockerfile -t afterhours-relay . && docker run -d -p 8787:8787 -v afterhours-relay:/data afterhours-relay

# 2. On the machine: pair (shows a QR code and a link, valid once for 10 minutes)
cq pair --relay wss://relay.example.com

# 3. The app: scan the code, or paste the link
```

A command-line app does the same from any computer: `bun scripts/remote-client.ts pair '<the link>'`, then `status`, `queue` and `watch`.

The machine decides what apps may do, and no app can change it:

- `cq remote allow <folder>`: apps run tasks only in these folders (default: your home folder).
- `cq remote bypass on|off`: tasks that skip permission prompts (off by default).
- `cq remote screens on|off` and `cq remote typing on|off`: seeing and typing into the running task.
- `cq remote mac on|off`: whether owners may quit apps on this Mac and put it to sleep (on by default).
- `cq devices` lists paired devices; `cq devices remove <name>` cuts one off at once; `cq audit` shows what apps did.

To move to another relay (a hosted one, say): `cq remote relay wss://relay.example.com/v1`. It checks the relay answers first, waiting up to a minute for a free host to wake. Apps connected at that moment hear the new address and follow by themselves; any other app pairs again. `cq remote status` and `cq doctor` say whether the relay answers, and how fast.

The relay can also run inside Afterhours, serving the app's web build at the same address: that's how [the app inside Telegram](#the-app-inside-telegram) works (`cq app setup`). To serve the app from a relay you run yourself, set `APP_DIR` to the app's web build.

## Kill a stuck task

A task can get stuck: waiting for a chat that's open in VS Code, at a screen nobody can answer, or silent. **Kill** ends it now, from the app, the bot (**🛑 Kill**, `/kill`) or the terminal (`cq kill [#]`):

- Claude and everything it started stop: the task's window, then every process under it (a dev server, a long command). Whatever ignores the polite signal gets a firm one after 2 seconds.
- Whatever the task waited on from you is settled, and a chat it took over from VS Code goes back there.
- The task ends as *Killed by* the device that did it. It doesn't come back by itself, even if it was just starting.
- The queue moves on (in the app, Kill can pause it too).

**Stop** is gentler: it presses Escape and pauses the task, which **Continue** picks up again.

## The queue

From the app, drag a task to its place: touch and hold it until it lifts (or grab its **≡**), and the others slide out of the way. Swipe it for **Hold** and **Remove**, and **Edit** opens the whole queue:
- **Select** several to run next, hold or remove at once;
- **Clear the queue**;
- **Undo** puts removed tasks back, in their places.

A task on **hold** keeps its place but doesn't start until you release it. From the bot, **📋 Queue** does the same with buttons. From the terminal: `top`, `rm`, `hold`, `release`, `clear`.

## Plan with one model, work with another

A task that plans first can plan with one model and carry the plan out with another: Opus to think it through, Sonnet (or Haiku) to do the work. Once the plan is approved, by Afterhours or by you, the planner's session closes and the same conversation resumes on the work model, in the task's mode, told to carry the plan out. The plan is already in the conversation, so nothing is lost. In the app it's **Plan with** and **Work with**; in the bot, the second row of **🧠 Model**; in text, `q myapp plan opus>sonnet: …`, or `default opus>sonnet`.

## Live links

When you're away from the Mac and want to see what a task made, ask for a **live link**: at the end of the task, Claude publishes a [claude.ai artifact](https://claude.ai) showing the result (screenshots of a UI running when it can, else a faithful preview, and how to try it), and the link comes to your phone. It opens wherever you're signed in to claude.ai, even with the Mac asleep, and you can share it from there.

- Ask when you queue the task (**Live link at the end**, **🔗 Live link**, `q … link: …`), or later: a running task ends with one, and a finished one gets a short task of its own, next, in the same conversation (**Get a live link**, `cq link #14`).
- The task's answer stays Claude's answer; the link is kept beside it. If Claude can't make one, the task still ends and says why.
- Only when you ask. The task may use Claude Code's Artifact tool for that, nothing else changes.

## Quit apps and sleep the Mac

For when you're away: quit an app (Vorssaint, say, which keeps the Mac awake) and put the Mac to sleep, from the app (**This Mac**, owners only), the bot (`/mac`, `/sleep`) or a text (`apps`, `quit <app>`, `quit! <app>`, `sleep`, `sleep done`, `sleep cancel`).

- Quitting asks the app the way the Dock does, with no permission prompt. An app that asks about unsaved work stays open, and **Force quit** closes it without asking.
- Keep-awake apps turn sleep off entirely (`pmset disablesleep`: even closing the lid doesn't sleep the Mac). Sleeping quits them first, waits for sleep to be allowed again, then sleeps a few seconds later, so the reply reaches you first. If sleep stays off, it says why and stays awake.
- **Sleep when the queue is done**: once nothing is running or can start, a minute has passed, and nobody has used the Mac for 5 minutes. Then the switch turns itself off.
- A running task pauses while the Mac sleeps. The phone can't wake it: open its lid or press a key. The app shows when it went to sleep.

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
| `cq awake` · `cq awake lid on` | Whether the Mac stays awake while tasks run · with the lid closed too (no keep-awake app needed) |
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
| `opus>sonnet` | Plan with the first, work with the second |
| `link` | End with a live link |
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
| `stop` · `kill [#]` · `rm <#>` · `top <#>` | Interrupt (pauses it) · end a task now, with what it started (`skip` too) · remove one · run one next |
| `hold <#>` · `release <#>` · `clear` | Keep one in its place without starting it · let it start · take every task off the queue |
| `link [#]` | A live link for a task: at its end, or now for one that has ended |
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
| `keepAwakeLidClosed` | `false` | And with the lid closed: sleep is turned off while tasks are pending, back on when they're done or the battery is below 20%. Set it up with `cq awake lid on` (asks for your password once) |
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
- `packages/protocol/`: keys, Noise sessions, pairing and the messages apps and machines exchange. The apps' repository keeps a copy of it.
- `relay/`: the relay server and its Docker image.
- `src/daemon/remote/`: the machine's side of remote access: devices, rules, events, audit.
- `src/cli/`: `cq` and `cq setup`.
- `bin/cq-launcher.c`: the launcher that holds Full Disk Access.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) for attributions.
