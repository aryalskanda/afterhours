# Afterhours as a paid product: the plan

As of October 15, 2026.

> **Changed later the same day:** the product's shape is now in [architecture.md](architecture.md), and it replaces "The decision" and "Architecture" below:
> - No Mac-only or iOS-only apps.
> - The engine runs anywhere: macOS, Linux, Windows through WSL2, and cloud servers.
> - One React Native app covers phones and desktops.
> - The relay is open source and self-hostable.
>
> Pricing comes later. The business sections below stay as notes for then.

## The decision

Build the Mac app and a phone app, but in this order, and keep today's engine (the TypeScript daemon) inside them instead of rewriting it:

| Step | What | Time | Gate to move on |
| --- | --- | --- | --- |
| 0. Validate | Landing page, demo video, waitlist, launch posts, optional pre-orders | 2 weeks | About 300 sign-ups, or 30 paid pre-orders |
| 1. Relay and web app | Accounts, QR pairing, an end-to-end encrypted relay, an installable web app with push, checkout; the agent connects to the relay | 3–4 weeks | 20 paying beta users |
| 2. Mac app | A SwiftUI menu-bar app around the engine: a signed, notarized download with automatic updates, and guided setup (Claude Code check, Full Disk Access, QR pairing) | 3–4 weeks | New users set up in under 5 minutes |
| 3. iOS app | SwiftUI; push through APNs, a Live Activity for the running task, widgets; on the App Store as a free companion | 4–6 weeks | Approved, and Telegram retired |

**Why not start with the native apps:**
- It's months of work and $99 a year before the first sale.
- App Store review sits between you and every fix.
- You don't yet know who will pay.

## Why validate first

Anthropic ships into this space, and its tools are free with a Claude plan:

- **Remote Control:** steer a live chat from the Claude app.
- **Dispatch** (Claude Desktop, Pro and Max, in limited beta and closed to new users):
  - Message a task from the Claude app, and it runs on your Mac with a push when it's done or needs approval.
  - It's a single thread. Its docs mention no queue, no usage-limit handling, and no per-task model, effort or mode.
  - It needs Claude Desktop open and the Mac awake.
- **Scheduled tasks** and **cloud sessions.**

What only Afterhours does today:
- a queue across projects with per-task settings;
- unattended plan approval;
- approvals that never stall the queue;
- waiting out limits;
- continuing VS Code chats after a limit;
- a branch per task.

That's a real edge, but a narrow one: Anthropic could add a queue to Dispatch. Two weeks of validation tells you whether people pay for that edge before months go into apps.

## What's free and what's paid

| | Free (open source) | Pro |
| --- | --- | --- |
| Price | $0 | About $9/month or $79/year, 14-day trial; $99 lifetime for the first 100 |
| Engine: queue, plans, limits, permissions, chats | Yes | Yes |
| Phone access | Your own Telegram bot | The Afterhours app, end-to-end encrypted, push |
| Install | Command line and Homebrew | Mac app with guided setup |
| Extras | | Several Macs, schedules, a morning summary |

The paid part is the hosted part (relay, accounts, push, apps). That's what makes it a subscription rather than a one-off sale. Prices are a hypothesis: the pre-order test in step 0 checks them.

## Architecture

```
iPhone / web app  ⇄  relay (Cloudflare)  ⇄  Mac agent (today's daemon)  ⇄  Claude Code (tmux)
       └──── end-to-end encrypted ────┘       accounts, devices, billing in Postgres (Neon)
```

- **Mac agent:** today's daemon gets a second transport next to Telegram. It speaks one client-independent protocol (events out, commands in) over a WebSocket to the relay. Everything the bot does today (cards, chats, approvals, peek) maps onto that protocol, so the web app and the iOS app share it.
- **Relay:**
  - Cloudflare Workers with one Durable Object per account holds the live WebSockets.
  - Postgres (Neon) stores accounts, devices and subscriptions.
  - It forwards only encrypted messages.
  - Push notifications carry minimal content; the iOS app decrypts the full text on the phone.
- **Pairing:** the Mac shows a QR code; the phone scans it. They exchange X25519 keys, and every message after that is sealed with XChaCha20-Poly1305. The server can't read prompts, plans or code. That's the trust story, and it keeps you from ever holding customer code.
- **Billing:**
  - A merchant of record (Paddle, Lemon Squeezy, Polar or Dodo) handles tax and invoices, if it pays out to you.
  - Otherwise, a US LLC (Stripe Atlas) and Stripe.
  - The agent checks the subscription with the relay, with 14 days of grace offline.
- **Phone app rules (Apple 3.1.3(f)):** the iOS app is a free companion to a paid service. It sells nothing inside, so no in-app purchase and no Apple cut. US apps may link to your website; elsewhere the app shouldn't point to purchasing.
- **Mac app:**
  - Distributed outside the Mac App Store, because the sandbox forbids running Claude Code in tmux and reading `~/.claude`.
  - A Developer ID signed, notarized DMG with Sparkle updates.
  - The engine ships inside it as the compiled binary.

## Anthropic's rules for third-party products

From the [Claude Code legal page](https://code.claude.com/docs/en/legal-and-compliance):
- Run the **unmodified** Claude Code, signed in with each user's **own** subscription or API key.
- Never offer a Claude.ai login of your own, and never collect, store or pass on credentials or session tokens.
- Never pay for, resell or sit in the middle of customers' Claude usage.
- No "Claude" or "Anthropic" in the product name, company name or logo, and nothing implying endorsement. "Works with Claude Code" in plain text is fine.
- Whoever builds Claude Code into a product accepts Anthropic's Commercial Terms: create a Claude Console account.
- Pro and Max limits assume ordinary individual use. Market it as workflow automation that respects limits, never as "unlimited" or as a way around limits.

## Costs to start

| Item | Cost |
| --- | --- |
| Domain | About $15/year |
| Landing page hosting (Cloudflare Pages) | Free |
| Waitlist form (Formspree or Tally) | Free tier |
| Apple Developer Program (from step 2) | $99/year |
| Relay (Workers, Durable Objects, Neon) | Free to about $25/month at beta scale |
| Merchant of record | About 5% + 50¢ per sale |

## Risks

| Risk | Response |
| --- | --- |
| Anthropic adds a queue and limit handling to Dispatch | Validate first; stay on what's hard to build natively: VS Code hand-off, several Macs, schedules, the morning review |
| Anthropic tightens the rules on automating subscriptions | Stay inside the published rules, support API keys, keep in touch with Anthropic |
| Claude Code updates break the screens Afterhours reads | The compatibility check (needs CI); prefer hooks over the screen |
| No payouts to Nepal | Check before step 1; US LLC as the fallback |
| App Store review | A free companion app with no purchases; precedent from other Claude Code companion apps |

## Your to-dos

- [ ] Confirm the name; buy the domain.
- [ ] Make the waitlist form; put its link in `site/config.js`; deploy `site/`.
- [ ] Publish the engine's repo on GitHub before launch. The page and the posts call the free version open source (`LICENSE` is Apache 2.0), and the Homebrew formula and the nightly compatibility check in CI need it.
- [ ] Record the demo video (`docs/demo-script.md`) and post the launch drafts (`docs/launch-posts.md`).
- [ ] Ask Paddle, Lemon Squeezy, Polar and Dodo whether they pay out to Nepal; otherwise look at Stripe Atlas.
- [ ] Create a Claude Console account (this accepts the Commercial Terms).
- [ ] Before step 2: join the Apple Developer Program.

## Sources

- Claude Code legal and compliance: https://code.claude.com/docs/en/legal-and-compliance
- Dispatch: https://support.claude.com/en/articles/13947068
- Claude Desktop (scheduled tasks, Dispatch): https://code.claude.com/docs/en/desktop
- Remote Control: https://code.claude.com/docs/en/remote-control
- App Store Review Guidelines (3.1.3(f), 4.2.7): https://developer.apple.com/app-store/review/guidelines/
- Merchant-of-record fees and payout countries: each provider's own pricing and supported-countries pages. Payouts to Nepal are not confirmed for any of them yet.
