# Launch post drafts

Post these when the landing page and the demo video are live. Read each community's rules on self-promotion first, reply to every comment, and never post the same text to more than one place on the same day.

## r/ClaudeAI and r/ClaudeCode

**Title:** I queue Claude Code tasks from my phone at night and they're done by morning, even past my usage limit

> I'm on the Pro plan and kept losing evenings to the 5-hour limit: the task stops at 1 AM, and I'm asleep when it resets.
>
> So I built Afterhours. It's a queue for Claude Code that runs on my Mac:
>
> - I send tasks from my phone. Each one gets its own folder, model, effort and mode, and they run one after another.
> - When a usage limit hits, the task waits and continues at the reset. The next task starts after it.
> - Claude plans first. Afterhours approves the plan, or sends it to me if I asked.
> - Permission requests come to my phone. If I don't answer, they're declined and Claude finds another way, so nothing stalls.
> - I can open any Claude Code chat on my Mac from my phone and keep typing in it, including the ones open in VS Code.
>
> It runs the real Claude Code with my own subscription, on my Mac. Nothing touches my credentials.
>
> Demo (75 s): [link]. Waitlist for the phone app: [link]. The free version, driven by your own Telegram bot, is open source: [link].
>
> What would you queue overnight? And what would make you trust a tool like this with your repo?

## Show HN

**Title:** Show HN: Afterhours – a queue for Claude Code that runs overnight and waits out usage limits

> Afterhours runs Claude Code tasks one after another on your Mac while you're away. You send tasks from your phone. It approves plans, relays permission prompts (declining them if you don't answer), and waits for usage-limit resets before continuing.
>
> How it works:
> - The unmodified `claude` CLI runs in a private tmux session.
> - Per-session `--settings` add hooks that report to a local daemon.
> - Two dialogs that hooks can't answer (plan approval, folder trust) are read and answered with keystrokes. A compatibility check runs that against each new Claude Code release before Afterhours ships.
> - Each new conversation can run on its own git branch, in a worktree.
>
> The engine is open source (TypeScript, Bun). I'm testing whether people would pay for a hosted version: an end-to-end encrypted relay and a phone app instead of a Telegram bot.
>
> [landing page] · [repo]

## X / Twitter

> My Mac kept coding while I slept.
>
> I queue Claude Code tasks from my phone. Afterhours runs them one after another, approves the plans, waits out the 5-hour limit, and messages me only when it needs me.
>
> 75-second demo 👇 [video]
> Beta: [link]

## dev.to (later)

**Title:** How my Mac works through my Claude usage limits overnight

An article version of the HN post. Cover:
- the hooks;
- the screens answered with keystrokes;
- the limit fallback ladder: Claude Code's own continue, then a typed continue, then a restart;
- what broke along the way.
