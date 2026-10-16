# The Afterhours app

The app for your Afterhours machines, on iPhone, Android and the web. The desktop app ([apps/desktop](../desktop/README.md)) wraps the web build for Mac, Windows and Linux. It replaces the Telegram bot. It talks to each machine end-to-end encrypted, through a relay that can't read anything ([how](../../docs/architecture.md)).

- **Machines**: each machine you paired: online or not, the running task, the queue, what waits on you, and the 5-hour limit.
- **Needs you**, with a badge: everything waiting on you, across machines, soonest settled first.
  - Permissions: the tool and what it wants to do, in full, and how often you allowed the same before. Allow, Deny, Deny with a note for Claude, or allow with Claude Code's own rule so it stops asking ("Always allow commands starting with npm test in this project").
  - Questions: one at a time, every option in full. Tick several where Claude allows it, or type an answer; Back goes to the previous question.
  - Plans: rendered, with the version before when Claude revised it. Approve, choosing how it works on (auto, or accepting edits), or Ask for changes; tap a step to quote it.
  - Folder trust.
- **A machine**:
  - the running task, with Screen (live, in colour, with find and text size), Stop, Skip, Continue now (after a limit), typing and keys;
  - the queue (Run next, Remove);
  - usage limits, recent tasks, Pause and Resume;
  - the machine's rules, its devices and its text commands (owners).
- **A task**: what it was asked and how it runs, how full its context is, its tokens and cost (as Claude Code counts them). Then three views:
  - Activity: the conversation as it happens: what you and Claude said, each tool call in a line (tap it for what came back), and what it's doing right now.
  - Changes: the files it changed, with lines added and removed; each opens its diff, numbered, and the whole file as the task left it.
  - Answer: Claude's final answer and the plan, rendered, and every notice about the task.
  While it runs, message Claude from under the conversation. A queued task can be edited, moved, or run next; one waiting for a busy conversation can take it over or use a copy. A finished task on its own branch can be merged into your checkout, opened as a pull request (owners), or thrown away. Follow up in the same conversation, or open it in VS Code on the machine.
- **New task**: the machine, a folder (recent ones, or search), the prompt, then plan or not, permission mode, model, effort, its own branch, run next; when it starts (now, at a time or every day, when the 5-hour limit resets, after another task finishes well) and a time limit. It starts from what you used last time on that machine. What the machine doesn't allow isn't offered.
- **Chats**: your Claude Code conversations on a machine. Read one whole, tool calls included, and write into it.
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

- Expo SDK 57 and Expo Router. Screens are in `app/`. Each tab has its own stack, so the tab bar (the sidebar, in a wide window) stays while you go deeper:
  - `(tabs)/(machines)`: the machines, then `machine/[id]` with its `task/[job]`, `screen` and `devices`;
  - `(tabs)/(inbox)/inbox`; `(tabs)/(chats)/chats`, with one chat at `chats/[machine]/[session]`; `(tabs)/(settings)/settings`;
  - `pair` and `new`, over the tabs.
- `src/theme.ts` and `src/components/ui.tsx`: the look. Grouped lists on a grey page, the system's fonts, and one accent (amber) for what needs you and a screen's main action. A wide window gets a denser type scale and the tabs as a sidebar.
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
