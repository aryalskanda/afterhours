# Afterhours on Windows

Afterhours runs inside **WSL2**, Linux built into Windows 10 (2004 or newer) and Windows 11. Claude Code, your projects and Afterhours all live in Ubuntu; you talk to it from Telegram on your phone, so you rarely need to open Ubuntu again.

## Install

In PowerShell **as administrator** (right-click Start → Terminal (Admin)):

```powershell
irm https://github.com/aryalskanda/afterhours/releases/latest/download/install.ps1 | iex
```

What happens, step by step. It asks before each one:

1. **WSL and Ubuntu.** If they aren't there, Windows installs them. It may ask you to restart; after that Ubuntu opens and asks you to choose a username and password. Close it, and run the same line again.
2. **systemd.** Afterhours runs as a background service, which needs systemd inside Ubuntu. The installer turns it on and restarts Ubuntu once.
3. **Afterhours itself.** The Linux installer runs inside Ubuntu: it installs `tmux` and Claude Code if needed, then runs `cq setup` (sign Claude in, choose your folders, connect your Telegram bot).
4. **A sign-in task.** Windows stops Ubuntu when nothing is using it, which would stop Afterhours. A scheduled task named **Afterhours** keeps Ubuntu running whenever you're signed in. Remove it with `Unregister-ScheduledTask Afterhours`.

You can also do it by hand: `wsl --install -d Ubuntu`, turn on systemd (put `[boot]` and `systemd=true` in `/etc/wsl.conf`, then `wsl --shutdown`), and follow the [Linux install](linux.md#install) inside Ubuntu.

## Day to day

- **Closing the Ubuntu window is fine.** Windows stops Ubuntu when nothing is using it, which would stop Afterhours too, so `cq install` (and the installer) add a sign-in task named **Afterhours** that keeps it running. `cq doctor` shows whether it's there; if not, run `cq install` again.

- **Staying awake.** While tasks run, Windows is kept awake (Afterhours asks Windows not to sleep). When the work is done, it sleeps as usual.
- **Lid closed (laptops).** Windows decides this, not Afterhours. In Control Panel → Power Options → "Choose what closing the lid does", pick **Do nothing** for plugged in and on battery.
- **Sleeping from your phone.** `/sleep` in the bot puts the PC to sleep (through Windows). It can't wake it again: open the lid or press a key.
- **Commands.** Open Ubuntu from the Start menu and run `cq doctor`, `cq logs -f` or `cq restart`.

## Tips

- Keep your projects in the Linux file system (`~/code`), not under `/mnt/c`: Claude Code and git are much faster there.
- Projects on a Windows drive work too. When `cq setup` asks for your folders, type the Windows path (`D:\Projects`, or `"D:\My Projects"` with spaces); Ubuntu sees that drive as `/mnt/d`.
- VS Code's WSL extension works with Afterhours's chats; they live in `~/.claude` inside WSL.
- If Windows restarts, Ubuntu and Afterhours start again when you sign in (the scheduled task).
- Not working? `wsl --update`, then run the installer line again; it is safe to repeat.
