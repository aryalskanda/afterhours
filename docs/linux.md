# Afterhours on Linux, servers and WSL2

Afterhours runs the same on Linux as on a Mac: the queue, plans, permissions, usage limits and chats all work. What differs is how it runs in the background (a systemd user service instead of a LaunchAgent), how Claude Code signs in on a machine without a browser, how it stays awake (a systemd lock instead of caffeinate), and that there's no Full Disk Access to grant.

## What you need

- Linux on x64 or arm64: Ubuntu 22.04 or newer, Debian 12 or newer, Fedora, Amazon Linux 2023, and the like. Windows 11 works through WSL2 (see below).
- tmux, git and curl: `sudo apt-get install -y tmux git curl` (or `dnf`, `pacman`…).
- Claude Code: `curl -fsSL https://claude.ai/install.sh | bash`, then sign in (see below).

## Install

```sh
curl -fsSL https://github.com/jackReacher1234/afterhours/releases/latest/download/install.sh | sh
```

The script:
- checks that tmux, git, curl and Claude Code are there;
- downloads the build for your machine and checks it against the release's checksums;
- runs `cq install`, which puts `cq` in `~/.afterhours/bin`, links it into `~/.local/bin`, and starts it as a **systemd user service**.

It also turns on lingering, so the service keeps running after you log out and starts at boot. Where your system doesn't allow that without `sudo`, it shows the command to run.

From source instead, with [Bun](https://bun.sh): `git clone … && cd afterhours && bun install && bun src/cli/cq.ts install`.

Then connect your Telegram bot and check everything (`cq setup`, which the installer runs for you, does this too):

```sh
cq telegram <token>   # the token from @BotFather: send it /newbot in Telegram
cq doctor
```

Day to day:
- `systemctl --user status afterhours` shows the service, and `cq logs -f` follows its log.
- `cq restart` restarts it. The Claude sessions keep running in tmux and are picked up again.
- `cq uninstall` removes the service.

## Signing Claude Code in on a server

- **Over SSH:** run `claude` and pick how to sign in. It shows a link; open it on any device, sign in, and paste the code back into the terminal.
- **Without a browser on the server, or for many servers:**
  1. On your own computer, run `claude setup-token` (needs a Claude Pro or Max plan). It shows a long-lived token.
  2. Put it on the server, readable only by you:

     ```sh
     install -m 600 /dev/null ~/.afterhours/env
     echo 'CLAUDE_CODE_OAUTH_TOKEN=<the token>' >> ~/.afterhours/env
     cq restart
     ```

     The service reads that file and passes the token to the Claude sessions it starts. The same file takes `HTTPS_PROXY=…` if the machine reaches the internet through a proxy.

## A server in the cloud (EC2 and the like)

- **Network:** Afterhours only connects out (to Anthropic, Telegram and GitHub), so the server needs no inbound ports. Keep SSH for setup, or use your cloud's console session (AWS Systems Manager, say).
- **User:** run it as an ordinary user, not root. Claude Code won't skip permission prompts as root anyway.
- **Folders:** `cq setup` asks which folders hold your projects; the bot only browses those.
- **Sleep:** a server doesn't sleep. On a Linux laptop, `cq awake lid on` keeps it working with the lid closed (no password), and `/sleep` in the bot suspends it.

This cloud-init (Ubuntu 24.04) sets everything up at first boot; you then sign in and connect Telegram over SSH (`claude`, then `cq setup`):

```yaml
#cloud-config
package_update: true
packages: [tmux, git, curl]
runcmd:
  # A user service manager for "ubuntu" that runs without a login, and the tools as that user.
  - loginctl enable-linger ubuntu
  - sudo -iu ubuntu bash -lc 'curl -fsSL https://claude.ai/install.sh | bash'
  - sudo -iu ubuntu env XDG_RUNTIME_DIR=/run/user/1000 bash -lc 'curl -fsSL https://github.com/jackReacher1234/afterhours/releases/latest/download/install.sh | sh'
```

To skip the SSH sign-in, put the `claude setup-token` token in `/home/ubuntu/.afterhours/env` (mode 600, owned by ubuntu) from a secret store (AWS Secrets Manager, say). Don't put it in the user data, which other processes on the machine can read.

## Windows

Windows runs Afterhours inside WSL2. The one-line installer sets that up: see [windows.md](windows.md).

## Docker

The engine image has Claude Code, tmux and git, and runs as a non-root user:

```sh
docker build -f packaging/docker/Dockerfile -t afterhours .
docker run -d --name afterhours --hostname build-box --restart unless-stopped -v afterhours:/home/afterhours afterhours
docker exec -it afterhours claude              # sign in once
docker exec -it afterhours cq telegram <token>  # connect your Telegram bot
```

- **Name:** `--hostname` is the name the bot uses for the machine.
- **State:** the volume keeps the sign-in, settings, queue and your projects.
- **Signing in without `docker exec`:** pass `-e CLAUDE_CODE_OAUTH_TOKEN=<token>` instead.
- **Projects:** clone them into `/home/afterhours/projects`, or mount a folder there: `-v ~/code:/home/afterhours/projects`.
- **Updates:** rebuild or pull the image, then recreate the container. The volume carries everything over.

## Checking it

- `cq doctor` checks Claude Code, tmux, the service (and whether it lingers) and Telegram.
