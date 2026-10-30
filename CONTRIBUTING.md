# Contributing to Afterhours

Thanks for helping. Bug reports, fixes, docs and ideas are all welcome. This page says how to report a problem, how to set up the code, and what a pull request needs before it's merged.

## What's in this repository

- **The engine** (`src/`): the `cq` command, the background service, and the Telegram bot.
- **The protocol** (`packages/protocol`): keys, end-to-end encryption and the messages between apps and machines.
- **The relay** (`relay/`): the small server that forwards encrypted messages between apps and machines.
- **The landing page** (`site/`).

The phone and desktop apps live in a separate repository that isn't open source. Problems with the engine, the bot, the relay or the protocol belong here.

## Reporting a bug

[Open an issue](https://github.com/aryalskanda/afterhours/issues/new) and include:

- what you did, what you expected, and what happened instead;
- your system (macOS, Linux distribution, or Windows with WSL) and its version;
- `cq --version` and `claude --version`;
- the output of `cq doctor`;
- if you can, the file from `cq report`. Read it first and remove anything you'd rather not share.

**Security problems are different.** Please don't open a public issue. Follow [SECURITY.md](SECURITY.md) instead.

## Suggesting a change

For anything bigger than a small fix (a new feature, a new command or setting, a change to how tasks run), open an issue first and describe the problem you want solved. That way we can agree on the approach before you spend time on code.

## Setting up

You need:

- [Bun](https://bun.sh) 1.3.3 (the version CI uses);
- `git` and `tmux` (some tests start a real tmux server);
- macOS or Linux. On Windows, work inside WSL ([docs/windows.md](docs/windows.md));
- [Claude Code](https://claude.com/claude-code), signed in, only if you want to run the engine for real or run the compatibility check.

Fork the repository, then:

```sh
git clone https://github.com/<you>/afterhours && cd afterhours
bun install
bun test
bun run typecheck
```

### Running your copy

```sh
bun src/cli/cq.ts daemon    # the background service, in the foreground (Ctrl-C stops it; tasks keep running in tmux)
bun src/cli/cq.ts <command> # any cq command
```

If Afterhours is also installed on your computer, keep your development copy apart from it. Give it its own home folder, tmux server and port:

```sh
export CQ_HOME=/tmp/ah-dev CQ_TMUX_SOCKET=ah-dev
mkdir -p /tmp/ah-dev
echo '{ "port": 7797 }' > /tmp/ah-dev/config.json
bun src/cli/cq.ts daemon
```

Don't run `cq setup`, `cq install` or `cq telegram <token>` for a development copy. They install or restart the background service, which would replace the Afterhours you have installed.

To try the bot, make a second bot with [@BotFather](https://t.me/BotFather), because only one Afterhours can use a bot token at a time. Add it to the config:

```json
{ "port": 7797, "telegram": { "enabled": true, "token": "<your test bot's token>" } }
```

Then restart the daemon and run `bun src/cli/cq.ts telegram` in the same shell. It prints the code to send to the bot.

## Where things are

| Path | What it does |
| --- | --- |
| `src/daemon/runner.ts` | The task lifecycle |
| `src/daemon/launch.ts` | The `claude` command line and per-session settings |
| `src/daemon/screens.ts` | The Claude Code screens Afterhours answers with keystrokes |
| `src/daemon/commands.ts` | The text commands |
| `src/daemon/remote/` | The engine's side of the apps: devices, rules, events |
| `src/telegram/` | The bot |
| `src/platform/` | What differs by system: the background service, staying awake and sleeping |
| `src/cli/` | `cq` and `cq setup` |
| `bin/cq-launcher.c` | The macOS launcher that holds Full Disk Access |
| `packages/protocol/` | The protocol shared by the engine, the relay and the apps |
| `relay/` | The relay |
| `test/` | The tests, with fakes for tmux, Telegram and the system in `test/fakes.ts` |

[docs/architecture.md](docs/architecture.md) explains how the apps, the relay and the engine fit together, and the security model behind them.

## Making a change

1. Branch from `main` in your fork.
2. Keep each pull request to one change. A bug fix and an unrelated tidy-up are two pull requests.
3. Add or update tests for what you changed. Tests run against fakes: no real Telegram, Claude Code or network. Name each test after the behaviour it checks, in plain words, like the existing ones (`'a clock time: today if it is still ahead, else tomorrow'`).
4. Run `bun test` and `bun run typecheck` before you push.
5. If you change what users see or do (a command, a setting, a bot message, the installer), update the README or the page in `docs/` that covers it.

### Code style

- TypeScript in strict mode, run by Bun. Prefer Bun's and Node's built-ins to new dependencies. Afterhours has very few dependencies, so please ask in an issue before adding one.
- Match the code around your change: its naming, its structure and how much it comments. Comments explain *why*, not what the next line does.
- Text that users read, in the bot, in `cq` and in the docs, is short and plain. Say what happened and what to do next, without jargon.

### Changes that need extra care

- **`src/daemon/screens.ts` and `src/daemon/launch.ts`** depend on how Claude Code looks and behaves. If you change them, run the end-to-end check against the real Claude Code if you can:

  ```sh
  bun run compat
  ```

  It uses your Claude sign-in, runs three small Haiku tasks, and costs a few cents. If you can't run it, say so in the pull request. The check also runs every night in CI.

- **Anything system-specific** (`src/platform/`, `install.sh`, `install.ps1`): say in the pull request which systems you tested on.

- **The protocol and the relay**: changes here affect apps that aren't in this repository, and anything touching keys, pairing or encryption gets a careful security review. Open an issue first.

## Commit messages

Write the subject as one plain sentence that says what changes for someone using Afterhours, not which files changed. No `feat:` or `fix:` prefixes. Some examples from the history:

```
A finished task no longer waits on background work it didn't start
Plan and work each get their own effort
Usage limits: a window that has reset since the last reading is unknown
```

If the reason isn't obvious, explain it in the body.

## Pull requests

- Open the pull request against `main` and say what it changes and why. Link the issue it fixes (`Fixes #12`).
- CI runs on macOS and Linux. It runs the type check and the tests, builds the `cq` binary and the launcher, and checks `install.sh`. Both runs must pass before a merge. The first time you contribute, a maintainer has to approve CI before it runs.
- A maintainer reviews every pull request. Every review comment must be resolved before the pull request can be merged.
- Don't change `version` in `package.json`. Maintainers bump it when they release.

## License

Afterhours is licensed under [Apache-2.0](LICENSE). By opening a pull request, you agree that your contribution is licensed under the same terms, as section 5 of the license describes. If your change includes code adapted from another project, say where it came from in the pull request, so it can be credited in [NOTICE](NOTICE).
