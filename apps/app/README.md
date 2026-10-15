# The Afterhours app

The app for your Afterhours machines, on iPhone, Android and the web. The desktop app ([apps/desktop](../desktop/README.md)) wraps the web build for Mac, Windows and Linux. It replaces the Telegram bot. It talks to each machine end-to-end encrypted, through a relay that can't read anything ([how](../../docs/architecture.md)).

- **Machines**: each machine you paired: online or not, the running task, the queue, what waits on you, and the 5-hour limit.
- **Needs you**, with a badge: everything waiting on you, across machines, soonest settled first.
  - Permissions: the tool and what it wants to do, in full. Allow, Deny, or Deny with a note for Claude.
  - Questions: one at a time, every option in full. Tick several where Claude allows it, or type an answer; Back goes to the previous question.
  - Plans: rendered. Approve, or Ask for changes.
  - Folder trust.
- **A machine**:
  - the running task, with Screen (live), Stop, Skip, Continue now (after a limit), typing and keys;
  - the queue (Run next, Remove);
  - usage limits, recent tasks, Pause and Resume;
  - the machine's rules, and its devices (owners).
- **A task**: what it was asked and how it runs, what happened, Claude's final answer and the plan, rendered. Follow up in the same conversation.
- **New task**: the machine, a folder (recent ones, or search), the prompt, then plan or not, permission mode, model, effort, its own branch, run next. It starts from what you used last time on that machine. What the machine doesn't allow isn't offered.
- **Chats**: your Claude Code conversations on a machine. Read where one left off and write into it.
- **Settings**: this device's name and key, app lock and Face ID before Allow, machines, about.

A banner (and a buzz) tells you when something new needs you while the app is open. Push notifications for when it's closed come later; they need your accounts (below).

## Run it

You need Node 22 and, for the tests, Bun. Install once:

```sh
cd apps/app
npm install
```

Then pick one:

```sh
npx expo start        # then scan the QR code: the Camera app (iPhone) or Expo Go (Android)
npm run ios           # the iPhone simulator
npm run android       # an Android emulator
npm run web           # a browser
```

On a phone, install **Expo Go** from the App Store or Play Store first (it must be the version for SDK 57).

### Pair a machine

On the machine:

```sh
cq pair --relay wss://relay.example.com     # shows a QR code and a link, valid once for 10 minutes
```

In the app, scan the code or paste the link. The machine asks you to say yes (`cq pair --yes` skips that).

A link `afterhours://pair?…` opens the app straight on pairing. In Expo Go, links start with `exp://<your computer>:8081/--/` instead, followed by `pair?` and the same fields.

### Without a machine

A scripted machine with sample tasks, requests and chats:

```sh
bun e2e/fake-machine.ts     # prints a pairing link, and links for Expo Go on simulators
```

## Tests

```sh
bun test                    # from the repository root: includes the app's logic (src/lib)
npm run typecheck           # the app and the end-to-end scripts
npm run export:web          # the web build, used by the next two
npm run e2e:web             # headless Chrome against the scripted machine, through a real relay
npm run e2e:engine          # headless Chrome against a private Afterhours daemon (no Claude task runs)
```

The end-to-end runs pair, answer a permission, three questions and a plan, queue a task, and check what the machine received, not just the screen. Screenshots land in `e2e/out/` and `e2e/out-engine/`. Chrome: set `CHROME` if it isn't at the usual macOS path.

Checked by hand in Expo Go 57.0.9: an iPhone 17 Pro simulator (iOS 26.3) and a Pixel 3a emulator (Android 14). Pairing through a relay, Needs you, answering by touch, the machine and task screens.

## How it's built

- Expo SDK 57 and Expo Router. Screens are in `app/`:
  - tabs `(tabs)/index`, `inbox`, `chats`, `settings`;
  - `pair` and `new` (modals);
  - `machine/[id]`, with its `task/[job]`, `screen`, `chat/[session]` and `devices`.
- `src/lib/hub.ts` owns the connections (the protocol's `AppClient`), the paired machines and what they report, and keeps what must survive a restart. Screens read it with `useSyncExternalStore`.
- `src/lib/state.ts`: pure functions from a snapshot, a queue change or an event to a machine's state, plus "needs you" and a task's timeline.
- `src/lib/markdown.ts` and `src/components/Markdown.tsx`: Claude's Markdown, drawn natively. Tables become one entry per row, which reads better on a phone.
- `src/lib/results.ts`: what machines send back, checked before use (a machine may run another version).
- The protocol comes from `../../packages/protocol` (a `file:` dependency). `metro.config.js` resolves its imports from this app's `node_modules`, so there's one copy of zod and noble.
- `src/polyfills.ts`: random bytes for the keys (expo-crypto), and zod without code generation (Hermes doesn't allow it).

## Security

- This device's key is in the Keychain or Keystore: this device only, never in a backup. In a browser it's in the site's storage, which Settings says.
- Pairing links are checked before use. The machine's key comes from the link, and the handshake proves it.
- With **Lock the app** on, Face ID or a fingerprint opens it, and again after a minute away. With **Confirm Allow** on, it asks before allowing a permission.
- The machine's rules (folders, skipping permission prompts, screens, typing) are enforced on the machine. The app only shows them.

## Builds for testers and the stores (later)

Expo Go is for development. A real app needs:

- **iPhone (TestFlight, the App Store, iOS push):** the Apple Developer Program, and an Expo account (free) for EAS Build.
- **Android (Play, or an APK by link):** an Expo account; a Google Play developer account for the store; a Firebase project for push.

With those: `npx eas build --platform ios` / `android`. Without them you can still make a development build locally: `npx expo run:ios` or `npx expo run:android`. That needs Xcode or Android Studio, and signing for a real iPhone.
