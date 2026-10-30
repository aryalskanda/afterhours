# Afterhours on Windows

Afterhours runs natively on **Windows 10 (version 1809 or newer) and Windows 11**. You don't need WSL, Ubuntu or administrator rights. Claude Code, your projects and Afterhours all stay on Windows, and you talk to it from Telegram on your phone.

## What you need

- **Windows 10 1809+ or Windows 11**, 64-bit. Windows on Arm works too: it runs the x64 build.
- **A Claude account** with a Pro or Max plan, or an API key.
- **Git for Windows**. Claude Code on Windows runs its commands with Git Bash. If it's missing, the installer offers to install it with `winget`.
- **Claude Code**. If it's missing, the installer offers to install it with Anthropic's own installer.
- **Telegram** on your phone.

## Install

Open **PowerShell** or **Windows Terminal**. A normal window is fine; you don't need "Run as administrator". Paste:

```powershell
irm https://github.com/aryalskanda/afterhours/releases/latest/download/install.ps1 | iex
```

It asks before it installs anything. Step by step:

1. **Git for Windows**, if it isn't installed (`winget install Git.Git`).
2. **Claude Code**, if it isn't installed (`irm https://claude.ai/install.ps1 | iex`, Anthropic's installer).
3. **Afterhours itself**: it downloads `cq.exe`, checks it against the release's checksums, puts it in `%USERPROFILE%\.afterhours\bin` and adds that folder to your Path.
4. **`cq setup`**, which walks you through the rest:
   - signing Claude Code in, if you haven't;
   - choosing your code folders. Type a path such as `D:\Projects`, or `"D:\My Projects"` when it has spaces. Several are fine, separated by commas.
   - the defaults for new tasks;
   - **starting in the background**: Afterhours is added to your startup apps, so it runs whenever you sign in to Windows, with no window;
   - **your Telegram bot**: in Telegram, open **@BotFather**, send `/newbot`, pick a name and a username ending in "bot", paste the token it gives you, then send your bot the `/start <code>` message that `cq setup` shows.

When it's done, open a **new** terminal window (so it picks up the new Path) and run `cq doctor`. Every line should have a ✔ or a •.

To install a particular version, set `$env:AFTERHOURS_VERSION = 'v0.6.0'` before the line. To answer yes to every question, set `$env:AFTERHOURS_YES = '1'`.

### Install by hand

Download `cq-windows-x64.exe` from the [latest release](https://github.com/aryalskanda/afterhours/releases/latest), then in PowerShell:

```powershell
cd $HOME\Downloads
.\cq-windows-x64.exe setup
```

`cq setup` copies itself to `%USERPROFILE%\.afterhours\bin\cq.exe`, puts that folder on your Path and starts the background service.

### From source

With [Bun](https://bun.sh) (`irm bun.sh/install.ps1 | iex`) and Git:

```powershell
git clone https://github.com/aryalskanda/afterhours
cd afterhours
bun install
bun src/cli/cq.ts setup
```

`cq setup` builds `cq.exe` from the code and installs it the same way. To update later, run `git pull`, then `bun src/cli/cq.ts install`.

## How it runs on Windows

- **Tasks run in Windows' own terminals.** On macOS and Linux each task runs in tmux. Windows has no tmux, so Afterhours runs each Claude Code session in a Windows pseudo console (ConPTY, the same thing Windows Terminal uses), inside a small background process, the *terminal host*. That process is `cq.exe term-host`. It keeps the sessions running while the background service restarts or updates, and it closes by itself after 10 minutes with nothing to run.
- **The background service is a startup app.** You'll see **Afterhours** in Settings → Apps → Startup (and in Task Manager → Startup apps). It runs `cq.exe service`, which keeps `cq.exe daemon` running and starts it again if it stops. It runs only while you're signed in, like any app. That's on purpose: Claude Code's sign-in, your files and the PC's sleep settings are yours.
- **Hooks are `cq.exe` itself.** The Claude sessions Afterhours starts report to it with `cq.exe hook …` and `cq.exe statusline`, so nothing else (sh, curl) is needed. Your own `%USERPROFILE%\.claude\settings.json` is never touched.
- **Everything is in `%USERPROFILE%\.afterhours`**: `config.json`, `state.db` (the queue and history), `logs\cqd.log`, `logs\term-host.log` and `bin\cq.exe`.

## Day to day

Use **PowerShell** or **Windows Terminal**:

| Command | What it does |
| --- | --- |
| `cq doctor` | Checks Claude Code, Git Bash, the terminal host, the background service and Telegram |
| `cq logs -f` | The background service's log, as it's written (Ctrl-C to stop) |
| `cq attach` | Watches the running task's screen live, read-only (Ctrl-C to stop watching) |
| `cq restart` | Restarts the background service; running tasks keep going |
| `cq st`, `cq ls`, `cq q …` | The queue from the terminal, as in the [README](../README.md#text-commands) |

- **Folders.** Windows paths work everywhere: `cq folders add "D:\My Projects"`, or `q D:\Code\shop plan: …` in the bot or the terminal.
- **Staying awake.** While tasks run, Afterhours asks Windows not to sleep. When the work is done, the PC sleeps as usual.
- **Lid closed (laptops).** Windows decides this, not Afterhours. In Control Panel → Power Options → "Choose what closing the lid does", pick **Do nothing** for plugged in (and on battery, if you like).
- **Sleeping from your phone.** **Sleep now** in the bot (or `/sleep`) puts the PC to sleep. It can't wake it again: open the lid or press a key.
- **VS Code chats.** **💬 Chats** lists your VS Code and terminal chats too. When Afterhours takes over a chat that's open in VS Code, it ends that window's Claude process. Windows has no polite "please quit" signal for it, so finish what you were typing first.

## Updating and uninstalling

- **Update:** `cq update`. The running `cq.exe` can't be overwritten, so the old one is moved aside and deleted later. The background service restarts into the new version by itself, and running tasks keep going.
- **Uninstall:** `cq uninstall`. It stops Afterhours and removes it from the startup apps and your Path. Your queue and settings stay in `%USERPROFILE%\.afterhours`; delete that folder to remove them too.

## Troubleshooting

- **`cq` is not recognized.** Open a new terminal window, since the installer changed your Path. Or run it by its full path: `& "$env:USERPROFILE\.afterhours\bin\cq.exe" doctor`.
- **`cq doctor` says Git for Windows isn't found.** Run `winget install --id Git.Git -e`, or install it from <https://git-scm.com/downloads/win>, then open a new terminal. If Git is somewhere unusual, set `CLAUDE_CODE_GIT_BASH_PATH` to its `bash.exe`.
- **Claude Code installed with npm.** That's fine: Afterhours finds the real `claude.exe` behind npm's `claude.cmd`. If it still can't, set `claudePath` in `%USERPROFILE%\.afterhours\config.json` to your `claude.exe`.
- **The first task waits on a question.** The first time Claude Code runs in a folder, it asks whether to trust it. Your phone gets a 🔐 with **Allow** (or answer with `cq y <code>`). A first-run notice from Claude Code itself (for example about the Claude in Chrome extension) shows on **Screen**: use **Keys → Esc** from the bot, or `cq keys esc`.
- **Windows Defender scans `cq.exe`** the first time it runs, so the first start can take a few seconds.
- **Afterhours doesn't start when you sign in.** Check that **Afterhours** is switched on in Settings → Apps → Startup, then run `cq install`.
- Still stuck? Run `cq report`. It writes a support file to your Desktop with no prompts, code or tokens in it. Open an issue with that file attached.

## Coming from the WSL version

Earlier versions ran Afterhours inside WSL (Ubuntu). To move to the native version:

1. In Ubuntu, run `cq uninstall`, so only one Afterhours uses your Telegram bot.
2. In PowerShell, run the install line above. It offers to remove the old **Afterhours** scheduled task that kept Ubuntu running.
3. Run `cq telegram <token>` with your bot's token (or paste it during `cq setup`). Your queue and history from Ubuntu stay there; the Windows install starts with an empty queue.

If you'd rather keep Afterhours in WSL, that still works: it's the Linux version, set up as in [linux.md](linux.md) inside Ubuntu.
