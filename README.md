# Afterhours

**Line up Claude Code tasks from Telegram. They run one after another on your computer while you're away, wait out usage limits, and message you only when they need you.**

Afterhours is a free, open-source task queue for [Claude Code](https://claude.com/claude-code) on **macOS, Linux and Windows**, from a laptop to a server in the cloud. You send a prompt to your own Telegram bot and tap buttons to choose the folder, mode, model and effort. Afterhours then runs the real Claude Code CLI on that computer. It:

- approves plans;
- sends permission requests and questions to your phone;
- carries on after a usage limit resets;
- keeps the computer awake while it works, and puts it to sleep when it's done;
- puts each new piece of work on its own git branch for you to review.

> Afterhours runs Claude Code with your own Claude sign-in and plan. It is not made by, affiliated with, or endorsed by Anthropic.

```
you  Add a dark mode toggle to the settings page
bot  New task
     │ Add a dark mode toggle to the settings page
     Folder: shop/web · Chat: new, on its own branch
     How: Plan first · Auto · Plan: Opus · Max · Work: Sonnet · Low
     [Folder] [Chat] [How] [Model] [When] [More]
     [Queue] [Discard]
you  taps Queue
bot  Queued #14 · Starting now.
bot  #14 started … Plan approved (Yes, and use auto mode)
bot  #14 hit the 5-hour limit · resets 3:30 PM · it continues on its own
bot  #14 done in 48m · 6 files changed, 212 insertions(+)
     On branch afterhours/14-add-a-dark-mode-toggle
     [Follow up] [New task here] [Merge] [Pull request]
```

## What it adds to Claude Code

| | |
| --- | --- |
| **A queue across projects** | Each task has its own folder, mode, model and effort. Tasks run one at a time, in order. |
| **Unattended plans** | `plan` tasks plan first, then Afterhours approves the plan. `review` tasks send you the plan to approve or change. |
| **Limit-aware** | No new task starts while a 5-hour or weekly limit is active. The running task continues after the reset, even if the computer slept through it. |
| **Never stalls on you** | You get permission requests and questions on your phone. If you don't answer, the request is denied, or Claude uses its best judgment and lists its assumptions. |
| **Your checkout stays clean** | Each new conversation runs on its own branch in a git worktree, and its work is committed there for you to review and merge. |
| **Every chat, from your phone** | **💬 Chats** lists your recent chats from every project, VS Code ones included. Open one and type: your messages go into that same conversation. A chat in VS Code that hits a usage limit continues by itself at the reset, inside VS Code. |
| **Your phone, your bot** | Afterhours talks to a Telegram bot you create, straight from your computer. No servers, accounts or open ports. |

## Isn't this what the Claude app does?

Partly, and the Claude app is very good at what it does. **Remote Control** (`claude remote-control`, which the app shows as `claude rc`) lets you steer a Claude Code session that's running on your computer from your phone. **Cloud sessions** (Claude Code on the web) run on Anthropic's machines against a GitHub repo, so your computer can be off.

Afterhours is for something else: **lining up work on your own computer and walking away.** You pick any project folder from your phone, queue several tasks, and they run one after another, through plans, permission requests and usage limits, without you sitting at the computer or starting anything there first.

The question people ask most: *can I, straight from my phone, start Claude in a project folder where nothing is running?* With Remote Control, no: a `claude` process has to be running on the computer, in that folder, first (its server mode only opens sessions in the folder it was started in). With Afterhours, yes: it runs in the background as a service and starts Claude in whichever folder you pick.

| | Remote Control | Cloud sessions | Afterhours |
| --- | --- | --- | --- |
| **Where Claude runs** | Your computer | Anthropic's cloud VM | Your computer |
| **Start in any local folder from your phone, with nothing running there** | No: start `claude` in that folder first | Only GitHub repos (or an uploaded copy) | Yes |
| **A queue: task 2 starts when task 1 is done** | No | No (sessions run separately) | Yes, across projects, with order, hold, "after #N", schedules |
| **Plan approved without you** | No: a person approves the plan | No | Yes for **Plan first** tasks; **Plan, I approve** sends it to your phone |
| **Plan with one model and effort, work with another** | `opusplan` only (Opus plans, Sonnet works) | `opusplan` only | Any pair, each with its own effort (e.g. Opus · Max, then Sonnet · Low) |
| **After a usage limit** | You resume it at the terminal | Not documented | Waits for the reset (5-hour or weekly) and continues; nothing new starts meanwhile |
| **Your local files, `.env`, databases, local services** | Yes | Not by default (untracked files and local services aren't there) | Yes |
| **Permission requests and questions on your phone** | Yes | Yes | Yes (unanswered ones are denied, or Claude uses its judgment, after a timeout) |
| **Computer must stay on** | Yes | No | Yes (and it keeps the computer awake while there's work) |
| **Setup** | Built in | Built in | Install it, make a Telegram bot (about five minutes) |
| **Cost** | Your Claude plan | Your Claude plan (counts toward its limits) | Your Claude plan; Afterhours is free |

Use the **Claude app** to talk to one live session, or when the work is in a GitHub repo and your computer is off. Use **Afterhours** to hand off a list of tasks for your own machine: tonight's refactor in one project, then tests in another, then a fix that waits for the limit reset. They work together, too: every task Afterhours runs is an ordinary Claude Code conversation you can open in VS Code, the terminal or, with Remote Control, the Claude app.

This comparison is from Anthropic's docs for Claude Code 2.1 ([Remote Control](https://code.claude.com/docs/en/remote-control), [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web), [models](https://code.claude.com/docs/en/model-config)). Those features change quickly, so check there for the latest.

## Install

You need three things before you start:

1. **A Claude account** with a Pro or Max plan (or an API key). Afterhours uses Claude Code with it; the installer can install Claude Code for you.
2. **Telegram** on your phone. You make a bot in it during setup (it takes a minute, and the setup tells you how).
3. **A computer that stays on**: a Mac, a Windows PC, a Linux machine or a cloud server. The tasks run there.

Then paste **one** line into a terminal. It asks before it installs anything, and shows you what it's doing.

### macOS

Open **Terminal** (press ⌘Space, type "Terminal", press Enter) and paste:

```sh
curl -fsSL https://github.com/aryalskanda/afterhours/releases/latest/download/install.sh | sh
```

### Windows 10 or 11

Afterhours runs natively on Windows: no WSL, and no administrator rights. Open **PowerShell** or **Windows Terminal** and paste:

```powershell
irm https://github.com/aryalskanda/afterhours/releases/latest/download/install.ps1 | iex
```

It installs Git for Windows and Claude Code if they're missing (it asks first), puts `cq` on your Path and runs `cq setup`. More in [docs/windows.md](docs/windows.md).

### Linux, and servers in the cloud

```sh
curl -fsSL https://github.com/aryalskanda/afterhours/releases/latest/download/install.sh | sh
```

Works on Ubuntu 22.04+, Debian 12+, Fedora, Arch, Amazon Linux 2023 and the like (x64 or arm64). For a server with no browser, see [docs/linux.md](docs/linux.md).

### What the installer does

1. Installs `tmux`, `git` and `curl` with your system's package manager if they're missing (Homebrew on a Mac; it asks first). On Windows it needs only Git for Windows (with `winget`): tasks run in Windows' own terminals instead of tmux.
2. Installs Claude Code with Anthropic's own installer if it isn't there.
3. Downloads Afterhours, checks it against the release's checksums, and puts `cq` on your PATH.
4. Starts it in the background, so it runs whenever you're signed in (a LaunchAgent on a Mac, a systemd service on Linux, a startup app on Windows).
5. Runs **`cq setup`**, which walks you through:
   - signing Claude Code in, if you haven't;
   - **the folder that holds your projects**: you browse for it like in a file picker, starting in your home folder. Type a number to open a folder, `u` to go up (as far as the top of the disk; on Windows, to your drives), Enter to choose the folder you're in. Setup also offers shortcuts to places it found (where you've used Claude Code, folders full of git projects). You can change it later, or add another, from Telegram (**Settings → Project folders**) or the Afterhours app;
   - new tasks start with the recommended settings (Claude plans first, Sonnet, high effort, on its own git branch), which you change on any task from your phone. `cq setup --custom` asks about them instead;
   - **Full Disk Access** (Mac only): it opens the right System Settings pane and tells you what to add. The Claude sessions Afterhours starts need it to work in folders like `~/Documents` while nobody is there to click "Allow". The permission goes to a tiny launcher that never changes, so updates keep it;
   - whether this is a laptop you want to keep working with its lid closed;
   - **your Telegram bot**: setup opens **BotFather** (Telegram's official bot for making bots) for you. Send it `/newbot`, pick a name and a username ending in "bot", and tap the token it sends back to copy it. Press Enter in the terminal and setup picks the token up from your clipboard (pasting works too). Then send your bot the `/start <code>` message setup shows you.

Setup shows "Step 2 of 6" as it goes, so you can see the end. After it, you don't need commands: **everything else happens in Telegram** (the folders, the settings, sleeping the computer). If you do want the terminal, just type **`cq`** on its own for a short numbered menu (check everything, choose folders, connect Telegram again, update, restart). `cq doctor` checks that everything works. Run `cq setup` again whenever you like; it is safe to repeat.

### From source

With [Bun](https://bun.sh):

```sh
git clone https://github.com/aryalskanda/afterhours && cd afterhours
bun install
bun src/cli/cq.ts setup
```

`cq setup` builds `cq` from the code, installs the background service and links `cq` into `~/.local/bin`. To update later, `git pull` and run `bun src/cli/cq.ts install`.

### Updating and uninstalling

- **Update:** `cq update`. The background service restarts into the new version by itself.
- **Uninstall:** `cq uninstall` stops it and removes it from login items. Your queue and settings stay in `~/.afterhours`; delete that folder to remove them too.

## Using it from Telegram

The bot is plain words and buttons that stay where they are. Nothing opens a screen of its own that needs a Back.

**Send a prompt.** The bot answers with a task card, already set to your last choices. Each line of the card has a button under it. Tap **Queue**, or change something first: a button opens its choices on the card, above the buttons, and tapping it again closes them. A ✓ marks what's chosen, and • marks what's open.

```
New task
│ Add a dark mode toggle to the settings page
Folder: web
Chat: new, on its own branch
How: Plan first · Auto
Plan: Opus · Max
Work: Sonnet · Low
Starts: now

[ Folder ] [ Chat ] [ How  ]
[ Model  ] [ When ] [ More ]
[     Queue     ] [ Discard ]
```

| Button | What it does |
| --- | --- |
| **Folder** | Your recent folders by number, or **Browse** your code folders (a number marked `›` opens that folder, one without picks it; **Use this folder** picks the one shown) or **Search** by part of a name (`api`, `shop web`). `(git)` marks git repos. |
| **Chat** | Which conversation: **New chat**, **Last chat** (the last Afterhours chat in that folder), or one of the folder's recent chats from anywhere, VS Code and the terminal included. **Own branch: on/off** runs a new chat on its own branch or in your checkout. For a chat that's open in VS Code or a terminal, **Take over: on** closes it there when the task starts; off, the task waits until you close it ([more](#continue-a-vs-code-chat-from-your-phone)). |
| **How** | How it goes about it: **Plan first** (Afterhours approves the plan), **Plan, I approve**, **Just do it** (no plan), **Only answer** (Claude reads and answers, and changes nothing). What it may do without asking: **Auto**, **Accept edits**, **No prompts**. So "plan, then no prompts" is two taps. |
| **Model** | The model and the effort. With a plan, **Plan** and **Work** pick which side you're setting: plan with Opus at Max, then tap **Work** and set Sonnet at Low. Both show on the card ([more](#plan-with-one-model-work-with-another)). |
| **When** | **Now**, **Next** (before everything waiting), **At the reset** of the 5-hour limit, **In an hour**, **Tonight** (23:00), **Morning** (07:00), **Type a time** (`23:00`, `11pm`, `in 2h`, `tomorrow 9am`), **Every day at…** a time, or after one of the tasks ahead (by number) has finished well. |
| **More** | **Live link: on/off** (a claude.ai page showing the result, [more](#live-links)), and a **time limit** (30m to 4h). |
| **Files** | Send a photo or file in the chat (with a caption as the prompt, if you like): it's kept on the computer and Claude is told to read it. Up to 10, 5 MB each. The card comes down to where you are. |

When the bot asks you to type something (a time, a folder name, an answer), the text box opens as a reply with a hint in it. After you type, the card comes down to where you are and the old one goes.

The keys under the text box:

```
[ New task ] [ Status ] [ Queue ]
[ Tasks    ] [ Chats  ] [ Mac   ]
[ Settings ] [ Help ]
```

- **New task**: the card opens on Folder; then send the prompt.
- **Status**: what's running and what it last did, anything waiting on you (with **Allow** / **Deny** right there), what's next, your 5-hour and weekly usage as bars, and **Pause** / **Resume**. Each running task has **Screen**, **Stop** (or **Continue**) and **Kill**.
- **Queue**: the waiting tasks by number. Tap a number and that task's buttons show under the numbers: **Move up**, **Move down**, **Run next**, **Hold** / **Release**, **Change** (anything about it: prompt, how, models, efforts, when it starts, time limit, live link, then **Save**) and **Remove**. They stay with the task as it moves. **Clear** empties the queue.
- **Tasks**: finished tasks, with **Search**. A number opens one: follow up, new task in its folder, live link, merge, pull request, discard.
- **Chats**: your recent chats from every project, newest first. Open one to see your last prompt and Claude's last reply, then **Write here**: everything you type goes into that chat until you tap **Leave chat** (the first key, while you're in a chat). Photos, screenshots and files go in too, with their caption as the message; an album goes in as one message.
- **Mac** (**PC** or **Computer** elsewhere): stay awake and sleep, [below](#stay-awake-and-sleep).
- **Settings**: how much the bot messages you (all, important, or off), tasks at once, whether it watches your other chats for usage limits and continues them by itself, and rescanning your folders.

**Messages from the bot come with buttons.** A list (folders, chats, a question's options) is numbered in the message, every line in full, and its buttons are only the numbers, so nothing is cut off:

| Message | Buttons |
| --- | --- |
| Claude wants permission | **Allow**, **Deny**, and Claude Code's own "stop asking" rules as numbers to tap (allow this and never ask again for that command, say). Denied automatically after 15 minutes. |
| Claude asks a question | One question at a time, every option numbered and written out in full. Tap its number; where several apply, tick them and tap **Done**; or **Type an answer**. **Back** goes to the previous question. After 15 minutes Claude decides itself. |
| A plan for review | The whole plan, formatted, then **Approve**, **Ask for changes**, **Approve, then accept edits**, **Approve, then no prompts** |
| A task hit a usage limit | **Screen**, **Continue now** (try before the reset, e.g. after buying extra usage), **Kill** |
| A task paused or failed | **Screen**, **Continue** (or **Retry**), **Kill** |
| A task's chat is open in VS Code | **Take over**, **Use a copy**, **Kill** |
| Your chat in VS Code hit a usage limit | **Don't continue**, **Continue here instead**, **Follow up…** |
| A task is done | Claude's final answer, formatted and in full (a few messages, or a file when it's very long), then **Follow up** (the next prompt for the same conversation), **New task here** (a fresh one in its folder) and **Open the live link** (or **Get a live link**). On its own branch: **Merge**, **Pull request** and **Discard branch**. |

A task's screen (**Screen**, or `/peek`) has **Type** (type into it) and **Keys**, which opens a keypad on the screen itself (1, 2, 3, Enter, Esc, Tab, arrows) for a screen Afterhours can't answer; the screen shows again after each key.

**Kill**, **Sleep now**, **Clear**, **Remove**, **Discard branch**, **Pull request** and **Keep** ask twice, on the button itself: the first tap turns it into **Yes, kill #12** (or the like), where it was, and the second does it.

Keeping it tidy:

- Each task has one card. It's edited as the task goes on: started, plan approved (**Full plan** shows it all), done. Its buttons go away when the task ends.
- News that needs nothing from you arrives silently: started, plan approved, resumed, queue empty. Your phone only buzzes when something needs you or a task ends.
- A request answered somewhere else (the terminal, another device) or timed out loses its buttons, with a line saying what happened.
- Claude's Markdown shows as formatting (headings, bold, code, lists, tables), not as `##` and `**`.

If Telegram can't be reached, messages wait on the computer and arrive in order once it can.

Commands in the menu: `/new /status /queue /tasks /chats /mac /sleep /settings /kill /peek /pause /resume /leave /cancel /help`. Typing `q myapp plan opus max>low: …` fills in a card too.

## Continue a VS Code chat from your phone

Your phone sees every chat: **Chats** lists them all, and the same conversation carries on wherever it lives.

- **Write into any chat.** Open it in **Chats** and tap **Write here**. Then everything you type goes into that conversation, in the order you sent it:
  - The queue is running it → typed straight in, and Claude reads it when its current step ends.
  - It's not open anywhere → the queue resumes it with your message.
  - It's open in VS Code or a terminal → the queue takes it over: closes it there and continues it, so your message counts as yours and permission requests come to your phone. When it's done, the chat opens in VS Code again (if VS Code is running).
- **A usage limit hit in VS Code continues by itself.** Within about 30 seconds you get **⏸ Your chat in VS Code hit the 5-hour limit · resets 4:55 AM**. At the reset:
  - If it already runs again (Claude Code continued it, or you did), nothing happens.
  - If it's still open and waiting, Afterhours tells it to continue through Claude Code's messaging between sessions. VS Code stays live, and you see it carry on there. Claude sees the message as coming from another session working on your behalf.
  - If it hasn't started 2 minutes later, or the chat was closed, the queue continues it instead.
  - **Don't continue** and **Continue here instead** are on the message. **Auto-continue** in **Settings** turns it off.
- **Taking a chat over is careful.** Afterhours only closes a chat when you asked (or wrote into it), only while it's idle, and only in a window that was already open then. If the window doesn't close, or opens the chat again, the task stops and asks you. It never closes anything twice.
- **Remote Control**, Anthropic's own feature, lets you type into a live chat from the Claude app: run `/remote-control` in it (or `claude remote-control` in a terminal), or in VS Code turn on *Enable Remote Control for all sessions*. Afterhours works alongside it ([how they differ](#isnt-this-what-the-claude-app-does)).

## Run tasks side by side

By default one task runs at a time. To run two or three (Claude Code in two projects, say), set **Tasks at once**: `cq parallel 2` or **Settings** in the bot. The next task starts beside the running ones only when it can't get in their way:

- **never in the same conversation**, and **never changing the same folder** (or one inside the other);
- another folder, a task on **its own branch** (its own worktree), or a task that **only answers** runs beside anything.

A task that can't start yet keeps its place; a later one that can goes first. They share your usage limit: when one hits it, nothing new starts until the reset, and each running task continues then. With several running, **stop**, **kill**, **say**, **peek** and the bot's buttons name the task (`stop #14`, or its number in the list).

## Kill a stuck task

A task can get stuck: waiting for a chat that's open in VS Code, at a screen nobody can answer, or silent. **Kill** ends it now, from the bot (**Kill**, `/kill`) or the terminal (`cq kill [#]`):

- Claude and everything it started stop: the task's window, then every process under it (a dev server, a long command). Whatever ignores the polite signal gets a firm one after 2 seconds.
- Whatever the task waited on from you is settled, and a chat it took over from VS Code goes back there.
- The task ends as *Killed by* the device that did it. It doesn't come back by itself, even if it was just starting.
- The queue moves on.

**Stop** is gentler: it presses Escape and pauses the task, which **Continue** picks up again.

## The queue

In the bot, **Queue** lists every waiting task by number: tap one, then **Move up** / **Move down** move it, **Run next** puts it first, **Hold** keeps it in its place (it doesn't start until you tap **Release**), **Change** changes it, **Remove** removes it, and **Clear** empties the queue (both ask twice). From the terminal: `top`, `rm`, `hold`, `release`, `clear`.

## Plan with one model, work with another

A task that plans first can plan with one model and carry the plan out with another: Opus to think it through, Sonnet (or Haiku) to do the work. Once the plan is approved, by Afterhours or by you, the planner's session closes and the same conversation resumes on the work model, in the task's mode, told to carry the plan out. The plan is already in the conversation, so nothing is lost. The effort can differ the same way: plan at Max, work at Low. In the bot, pick **Plan first** in **How**, then in **Model** set the plan, tap **Work** and set the work; in text, `q myapp plan opus>sonnet max>low: …`, or `default opus>sonnet`.

## Live links

When you're away from the Mac and want to see what a task made, ask for a **live link**: at the end of the task, Claude publishes a [claude.ai artifact](https://claude.ai) showing the result (screenshots of a UI running when it can, else a faithful preview, and how to try it), and the link comes to your phone. It opens wherever you're signed in to claude.ai, even with the computer asleep, and you can share it from there.

- Ask when you queue the task (**Live link** in **More**, `q … link: …`), or later: a running task ends with one, and a finished one gets a short task of its own, next, in the same conversation (**Get a live link**, `cq link #14`).
- The task's answer stays Claude's answer; the link is kept beside it. If Claude can't make one, the task still ends and says why.
- Only when you ask. The task may use Claude Code's Artifact tool for that, nothing else changes.

## Stay awake, and sleep

Nothing extra to install: Afterhours uses what each system already has.

- **While tasks run, the computer stays awake** (on by default; `cq awake off` to turn it off). A Mac uses `caffeinate`, Linux uses a `systemd-inhibit` lock, and Windows uses its own power API. When the work is done, the computer sleeps as usual.
- **With the lid closed too** (laptops): `cq awake lid on`, or **Lid closed** under **Mac** in the bot.
  - **Mac:** it turns sleep off while tasks run and back on after (and when the battery drops below 20%). That takes your password **once**, to allow exactly two `pmset` commands and nothing else.
  - **Linux:** the same lock also holds off the lid switch. No password.
  - **Windows:** while tasks run, the power plan's "When I close the lid" is set to **Do nothing**, and put back afterwards (also below 20% battery). No password or administrator rights. If a managed PC doesn't allow it, `cq awake lid on` says so; set **Do nothing** by hand in Control Panel → Power Options → "Choose what closing the lid does".
- **Stay awake for a while, tasks or not** (for a task set for later, or to reach the computer): **Awake 1h**, **Awake 4h** or **Awake 12h** under **Mac** in the bot (tap the ticked one again to stop), or the text commands `awake 2h`, `awake 30m`, `awake stop`. At most a day at a time; then it sleeps as usual. With **Lid closed** on, it stays awake with the lid closed too.
- **Sleep now, or when the queue is done:** **Sleep now** (it asks twice, on the button) and **Sleep when done** under **Mac** in the bot, `/sleep`, or the text commands `sleep`, `sleep done`, `sleep cancel`. Sleeping says so first, then goes a few seconds later so the message reaches you. "When done" waits for nothing to be running, a quiet minute, and nobody at the computer for 5 minutes. Then the switch turns itself off. Sleeping, now or when done, ends staying awake for a while, and staying awake for a while turns sleeping when done off: the last one you asked for wins.
- A running task pauses while the computer sleeps, and continues when it wakes. The phone can't wake it: open the lid or press a key.

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

- `cq attach` shows the running task live, read-only. Detach with `Ctrl-b d` (on Windows, `Ctrl-C`).
- Finished tasks are ordinary Claude Code conversations named `Afterhours: <prompt>`, so you can pick one up in VS Code or the terminal.
- **Don't** open a conversation elsewhere while Afterhours is running it: two Claude processes writing one conversation will fork it. If the conversation a task needs is already open elsewhere, Afterhours waits until you close it. You can also tap **Take over** (close it there and continue here) or **Use a copy**.

## The `cq` command

| Command | What it does |
| --- | --- |
| `cq setup` | Guided setup (safe to run again) |
| `cq doctor` | Check Claude Code, tmux (Git Bash and the terminal host on Windows), the background service, Full Disk Access (Mac) and Telegram |
| `cq telegram <token>` · `cq telegram off` | Connect a different bot · stop using Telegram |
| `cq` (on its own) | A short numbered menu of what people do after setup |
| `cq folders` · `cq folders add\|remove <path>` | The project folders the bot searches · add or remove one (the bot does it too: **Settings → Project folders**) |
| `cq awake` · `cq awake on\|off` · `cq awake lid on\|off` | Whether the computer stays awake while tasks run · turn that on or off · with the lid closed too |
| `cq restart` · `cq logs [-f]` · `cq attach` | Restart the background service · its log · watch the running task |
| `cq install` · `cq daemon` | Install the background service again · run Afterhours in this terminal instead |
| `cq update` · `cq --version` | Update to the latest release · the version you have |
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
| `parallel 1\|2\|3` | How many tasks may run at once ([more](#run-tasks-side-by-side)) |
| `sleep` · `sleep done` · `sleep cancel` | Put the computer to sleep now · once the queue is done · never mind |
| `awake 2h` · `awake stop` | Stay awake that long (30m to 24h), tasks or not · sleep as usual again |
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
| `folders.roots` | chosen in `cq setup` | The project folders the folder browser and search cover. Change them with `cq folders add\|remove <path>`. The map stays current: a watch updates it within seconds of a folder being made, renamed or removed, and the whole tree is checked every 15 minutes. It goes as deep as your folders do, and two levels inside a project (a git repo, a package…) |
| `defaults` | plan → auto, `sonnet`, `high` | Used for your first task; after that, new cards start with your last choices |
| `isolate` | `true` | New conversations run on their own branch |
| `models` | `opus`, `sonnet`, `haiku` | Model buttons |
| `notify` | `all` | `important` skips started, approved and resumed messages |
| `timeouts.approvalSec` / `questionSec` | 900 | How long 🔐 and ❓ wait for you |
| `timeouts.reviewSec` | 3600 | How long a 📝 review waits |
| `timeouts.stuckSec` | 1200 | Silence before a task counts as stuck |
| `timeouts.limitGraceSec` | 180 | Wait after a reset before Afterhours types `continue` itself |
| `timeouts.backgroundSec` | 600 | How long to wait for background commands after a turn |
| `keepAwake` | `true` | Keep the computer from idle-sleeping while tasks are pending (closing the lid still sleeps it unless the next row is on) |
| `keepAwakeLidClosed` | `false` | And with the lid closed too. On a Mac, sleep is turned off while tasks are pending and back on when they're done or the battery is below 20%; set it up with `cq awake lid on` (asks for your password once; until then `cq doctor` says so, and Afterhours tells you on Telegram once a day). On Linux it's a lock on the lid switch. On Windows it sets the power plan's lid action to "do nothing" while tasks are pending |
| `remoteControl` | `false` | Start sessions with `--remote-control` so they also appear in the Claude app |
| `watchSessions` | `true` | Message you when one of your other chats (VS Code, a terminal) stops on a usage limit |
| `autoContinueChats` | `true` | And continue it by itself at the reset: inside the open chat, else through the queue |
| `reopenInVsCode` | `true` | When a task that took a chat from VS Code ends, open the chat there again |
| `telegram` | set by `cq telegram` | The bot token and your paired account |
| `aliases`, `trustedDirs` | | Project names for text commands, and folders whose trust prompt Afterhours may accept |
| `port`, `claudePath`, `tmuxPath` | 7787, from `PATH` | |

Next to it: `state.db` (queue and history), the folder map (in `state.db`), `logs/cqd.log`, `jobs/` (per-task session settings) and `token` (how `cq` and the hooks talk to the background service).


## How it works

- **The real Claude Code.** Each task runs the unmodified `claude` command in a private tmux session (`tmux -L afterhours`); on Windows, in a pseudo console in Afterhours's own terminal host ([more](docs/windows.md#how-it-runs-on-windows)). It starts with `--model`, `--effort` and `--permission-mode`, and follow-ups use `--resume`. Claude Code signs in as it always does on your computer; Afterhours never sees your credentials.
- **Hooks for everything else.** Afterhours passes per-session settings with `--settings`, so your own `~/.claude/settings.json` is never touched. These settings add hooks that report to Afterhours on `127.0.0.1`: the end of a turn, usage-limit stops, permission requests and Claude's questions. They also add a status line that carries your limit windows.
- **Two dialogs answered with keystrokes.** Claude Code doesn't let hooks approve a plan or trust a folder, so Afterhours reads those dialogs and presses the option for the task. It accepts the folder-trust dialog only for folders you've approved: the first time a task runs in a new folder, your phone asks you. A [compatibility check](scripts/compat.ts) runs all of this against the newest Claude Code release before each Afterhours release.
- **Your other chats.** To list chats and spot usage-limit stops, Afterhours reads Claude Code's own records: running sessions in `~/.claude/sessions` and transcripts in `~/.claude/projects`. To continue an open chat after a limit, it posts one message into that session's inbox, Claude Code's own messaging between sessions on this computer. Taking a chat over sends that window's Claude process a normal quit signal (SIGTERM), then resumes the conversation with `--resume`.
- **Your phone.** Afterhours polls the Telegram Bot API from your computer. Only the Telegram account you paired can use the bot.

## Privacy and security

- Afterhours runs entirely on your computer and collects nothing.
- Your prompts go to Anthropic through Claude Code, as they always would. They also go to Telegram, because bot chats aren't end-to-end encrypted: prompts, plans and Claude's summaries pass through Telegram's servers. The same goes for the titles and last prompts of your other chats when the card's **Chat** tab or **Chats** lists them, or one hits a usage limit; turn the latter off in **Settings**.
- The background service listens only on `127.0.0.1` and requires a token.
- Afterhours writes into your other chats only to continue them after a usage limit (when Auto-continue is on), and closes a chat only when you take it over.
- See [SECURITY.md](SECURITY.md) for the details and how to report a vulnerability.

## Troubleshooting

- `cq doctor` first, then `cq logs -f`.
- The bot doesn't answer:
  - `cq telegram` shows whether it's paired;
  - only one Afterhours may use a bot token at a time;
  - Telegram must be reachable from the computer.
- A task is paused on a screen Afterhours doesn't know: use **Screen** (its **Keys** and **Type**), or `cq keys …` and `cq say …`, then **Continue**.
- Still stuck? Open an issue with the file from `cq report` attached.

- `cq: command not found` right after installing: open a **new** terminal (the installer added `~/.local/bin` to your PATH), or run `~/.afterhours/bin/cq doctor`.
- Windows: `cq: not recognized` right after installing means the window predates the new Path: open a new one. More in [docs/windows.md](docs/windows.md#troubleshooting).
- Linux over SSH: if the background service stops when you log out, run `loginctl enable-linger $USER`.

## Development

```sh
bun install
bun test                    # unit tests, including the Telegram bot against a fake Telegram
bun run typecheck
bun run compat              # end-to-end check against the real Claude Code (a few cents of Haiku)
bun src/cli/cq.ts daemon    # run in the foreground (Ctrl-C to stop; tasks keep running in tmux)
```

For an isolated instance, set `CQ_HOME=/tmp/ah-dev CQ_TMUX_SOCKET=ah-dev` and set a different `port` in that home's `config.json`.

Releases: bump `version` in `package.json`, run `bun run compat`, then push a matching tag (`git tag v0.6.0 && git push origin v0.6.0`). The release workflow:

1. runs the type check and the tests;
2. builds the macOS (Apple Silicon, Intel), Linux (arm64, x64) and Windows (x64) binaries, with checksums and build attestations;
3. publishes them with `install.sh`, `install.ps1` and a filled-in Homebrew formula (macOS and Linux);
4. updates the tap when a `HOMEBREW_TAP_TOKEN` secret is set (write access to `<owner>/homebrew-tap`).

The release doesn't run the compatibility check, because the check needs a Claude sign-in. It also runs every night in CI when the repository has an `ANTHROPIC_API_KEY` secret. Without one, that run is skipped.

Where things are:

- `src/daemon/runner.ts`: the task lifecycle.
- `src/daemon/launch.ts`: the `claude` command line and per-session settings.
- `src/daemon/screens.ts`: the screens answered with keystrokes.
- `src/daemon/commands.ts`: the text commands.
- `src/telegram/`: the bot.
- `src/platform/`: what differs by system: the background service, staying awake and sleeping, Full Disk Access, and Windows' own APIs (`win32.ts`: pseudo consoles, the process list).
- `src/daemon/winterm.ts`: on Windows, the terminal host the tasks run in (what tmux is elsewhere).
- `src/cli/`: `cq` and `cq setup`.
- `bin/cq-launcher.c`: the launcher that holds Full Disk Access.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) for attributions.
