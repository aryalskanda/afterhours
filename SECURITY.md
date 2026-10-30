# Security

Afterhours runs Claude Code on your Mac while you're away, so it holds real power over your files. This page says what it can reach, what it never does, and how to report a problem.

## What it touches

| What | Why |
| --- | --- |
| `~/.afterhours` (mode 700) | Its settings, queue database, logs and the local token. Your Telegram bot token is in `config.json` (mode 600). |
| `127.0.0.1:7787` | The background service. It listens only on this Mac, and every call needs the token from `~/.afterhours/token`. |
| A private tmux server (`tmux -L afterhours`) | Where the tasks run. |
| Windows: the terminal host (`cq.exe term-host`) on `127.0.0.1`, a random port | Where the tasks run instead of tmux. It listens only on this PC, and every call needs the same token. |
| `~/.claude/sessions`, `~/.claude/projects` (read) | To list your chats and see usage-limit stops. |
| The inbox socket of a running Claude Code session | Only to post "continue" into a chat of yours after a usage limit, when Auto-continue is on. |
| Your Claude Code processes | SIGTERM to a chat's process only when you take that chat over. Never SIGKILL. (Windows has no SIGTERM: there the process is ended.) |
| Git, in the folders you queue tasks for | To make a branch and worktree per task (when asked) and commit the task's work there. |
| `api.telegram.org` | The only outside service Afterhours talks to, besides Claude Code talking to Anthropic. |

## What it never does

- Read, store or pass on your Claude credentials. Claude Code signs in as it always does.
- Change the Claude Code binary, or your own `~/.claude/settings.json` (each task gets its own settings file).
- Open a port to the network, or accept commands from anyone but the Telegram account you paired.
- Approve a permission request by itself. A request you don't answer is denied after 15 minutes.

## Things to know

- **Telegram bot chats aren't end-to-end encrypted.** Your prompts, plans, Claude's answers and your chats' titles pass through Telegram's servers.
- **On Windows**, `%USERPROFILE%\.afterhours` has no mode bits: it's protected as your user folder is (only you, administrators and the system can read it). Afterhours starts as a startup app of your account and needs no administrator rights.
- **Full Disk Access** goes to the small launcher (`~/.afterhours/bin/cq-launcher`), so tasks can work in folders like `~/Documents` while nobody is there to click "Allow".
- **The `yolo` mode** runs Claude Code with no permission checks. Use it only in folders where that is safe.

## Reporting a vulnerability

Please don't open a public issue. Email the maintainer with the steps to reproduce, the version (`cq --version`) and what you expected. You'll get a reply within a week. Fixes for security problems are released before anything else.
