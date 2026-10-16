# The Afterhours app

The app for your Afterhours machines, on iPhone, Android and the web. The desktop app ([apps/desktop](../desktop/README.md)) wraps the web build for Mac, Windows and Linux. It replaces the Telegram bot. It talks to each machine end-to-end encrypted, through a relay that can't read anything ([how](../../docs/architecture.md)).

- **Machines**: each machine you paired: online or not, the running task, the queue, what waits on you, and the 5-hour limit. What finished while you were away (done, failed, stopped since you last left the app). With several machines, what each is running. Search finds tasks (by their prompt or Claude's answer) and chats on every machine at once.
- **Needs you**, with a badge: everything waiting on you, across machines, soonest settled first.
  - Permissions: the tool and what it wants to do, in full, and how often you allowed the same before. A command also says what it does in words ("Runs the tests") and, in red, what to look at twice: deleting recursively, force pushes, throwing away work, running a script from the internet, sudo, keys and secrets, files outside the project (`src/lib/risk.ts`: a guide, not a guard; the machine's rules still decide). Allow, Deny, Deny with a note for Claude, or allow with Claude Code's own rule so it stops asking ("Always allow commands starting with npm test in this project").
  - Questions: one at a time, every option in full. Tick several where Claude allows it, or type an answer; Back goes to the previous question.
  - Plans: rendered, with the version before when Claude revised it. Approve, choosing how it works on (auto, or accepting edits), or Ask for changes; tap a step to quote it.
  - Folder trust.
- **A machine**:
  - the running task, with Screen (live, in colour, with find and text size), Stop, Skip, Continue now (after a limit), typing and keys;
  - the queue (Run next, Remove);
  - usage limits, with their last day and week charted and when each runs out at the current pace ("At this rate you reach it at 3:40 PM"); hold the queue until the 5-hour limit resets;
  - recent tasks, and All tasks: every finished one, a page at a time, by how it ended or by words;
  - About: Afterhours and Claude Code versions, uptime, disk, battery and load, the Claude account (owners) and MCP servers by name, a project's CLAUDE.md to read or edit; owners also see the engine's log and can restart it;
  - Pause and Resume;
  - the machine's rules, its devices (owners: invite another device with a QR code and link, and a role) and its text commands; what devices did there (owners).
- **A task**: what it was asked and how it runs, how full its context is, its tokens and cost (as Claude Code counts them). Then three views:
  - Activity: the conversation as it happens: what you and Claude said, each tool call in a line (tap it for what came back), and what it's doing right now.
  - Changes: the files it changed, with lines added and removed; each opens its diff, numbered, and the whole file as the task left it.
  - Answer: Claude's final answer and the plan, rendered, and every notice about the task.
  While it runs, message Claude from under the conversation. A queued task can be edited, moved in the queue or to another machine, or run next; one waiting for a busy conversation can take it over or use a copy. A finished task on its own branch can be merged into your checkout, opened as a pull request (owners), or thrown away. Follow up in the same conversation, or open it in VS Code on the machine.
- **New task**: the machine (or any free one: the least to do and the most limit left), a folder (recent ones, or search), the prompt, then plan or not, permission mode, model, effort, its own branch, run next; when it starts (now, at a time or every day, when the 5-hour limit resets, after another task finishes well) and a time limit. It starts from what you used last time on that machine. What the machine doesn't allow isn't offered.
  - Type `/` for the project's slash commands and skills, `@` for a file in the folder.
  - Attach photos (sent as JPEG) and files; Claude is told to read them.
  - Your saved prompts and the machine's recent ones, one tap away; what you were writing is kept until it's queued.
  - Try it three ways: the same prompt as three tasks on their own branches (three models, or one model three times), then Compare them and keep one (merged; the others thrown away).
  - With the machine offline, the task waits on the device and goes out when it's back.
- **A diff**: tap a line to comment; the comments go to Claude as a follow-up in the same conversation.
- **Read aloud**: Claude's answers and questions, in the system's voice.
- **Chats**: your Claude Code conversations on a machine. Read one whole, tool calls included, and write into it.
- **Settings**: this device's name and key, app lock and Face ID before Allow, machines, removing a lost device from every machine you own, about.
  - Notifications: push on a phone, the browser's when its tab is in the background, the desktop app's when its window isn't in front. Choose what they're about (requests, finished, failed or stuck, usage limits), whether they say what the task asks (on by default: pushes pass through Expo and Apple or Google, outside the encryption), and quiet hours. A push's buttons (Allow, Deny on a permission; Approve on a plan) open the app and answer; a request answered anywhere takes its notification down.
  - Back up and restore: this device's key, machines, name and settings sealed with a passphrase (scrypt, XChaCha20-Poly1305), to restore on a new phone, which then is this device (machines stop pushing to the old one).
  - Check the connection (each machine's round trip, through which relay), Report a problem (to a machine's owner, into its `app-reports.log`, showing what's sent first; a screen that breaks offers the same), Help, What's new.

- **Everywhere**: a long press on a task offers Open, Copy the prompt and, in a queue, Run next and Remove (on a phone, swiping a queued task left shows those two); screen readers get the same as an action. Claude's code is coloured, with Copy; tables are a grid in a wide window; images from the web show when you ask (the desktop app opens them in the browser). Appearance: system, light or dark, and the text a size smaller or larger. On an iPad held wide, the tabs are a sidebar. No machine yet? Try the demo machine: it lives in the app, nothing runs and nothing leaves the device.

A banner (and a buzz) tells you when something new needs you while the app is open. Pushes for when it's closed need the app built under your Expo account (below); until then, Settings says so.

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

The end-to-end runs pair, answer a permission, three questions and a plan, queue a task, and check what the machine received, not just the screen. They also walk fifteen screens through the browser's accessibility tree: every button, switch, choice and field must have a name a screen reader can say. Screenshots land in `e2e/out/` and `e2e/out-engine/`. Chrome: set `CHROME` if it isn't at the usual macOS path.

Checked by hand in Expo Go 57.0.9: an iPhone 17 Pro simulator (iOS 26.3) and a Pixel 3a emulator (Android 14). Pairing through a relay, Needs you, answering by touch, the machine and task screens.

## How it's built

- Expo SDK 57 and Expo Router. Screens are in `app/`. Each tab has its own stack, so the tab bar (the sidebar, in a wide window) stays while you go deeper:
  - `(tabs)/(machines)`: the machines and `search`, then `machine/[id]` with its `task/[job]`, `tasks`, `screen`, `usage`, `about`, `instructions`, `devices`, `audit`, `console` and `compare`;
  - `(tabs)/(inbox)/inbox`; `(tabs)/(chats)/chats`, with one chat at `chats/[machine]/[session]`; `(tabs)/(settings)/settings` and `lost-device`;
  - `pair` and `new`, over the tabs.
- `src/theme.ts` and `src/components/ui.tsx`: the look. Grouped lists on a grey page, the system's fonts, and one accent (amber) for what needs you and a screen's main action. A wide window gets a denser type scale and the tabs as a sidebar.
- `src/lib/hub.ts` owns the connections (the protocol's `AppClient`), the paired machines and what they report, and keeps what must survive a restart. Screens read it with `useSyncExternalStore`.
- `src/lib/state.ts`: pure functions from a snapshot, a queue change or an event to a machine's state, plus "needs you", a task's timeline, what runs and finished across machines, and the free machine.
- `src/lib/forecast.ts`: usage limits charted and forecast; `src/lib/risk.ts`: what a permission request does and what to look at twice; `src/lib/qr.ts`: QR codes drawn with plain views (`uqr`).
- `src/lib/highlight.ts`: code colours; `src/components/Menu.tsx`: long-press menus (the system's action sheet on iPhone) and swipe actions (`react-native-gesture-handler`); `src/lib/demo.ts`: the demo machine.
- `src/lib/push.ts`: what notifications are about and say, where they open, what their buttons answer; `src/notifications.ts`: push on phones (`expo-notifications`); `src/lib/backup.ts`: sealed backups; `src/lib/problems.ts` and `src/components/Report.tsx`: problem reports.
- `src/lib/markdown.ts` and `src/components/Markdown.tsx`: Claude's Markdown, drawn natively. Tables become one entry per row, which reads better on a phone.
- `src/lib/results.ts`: what machines send back, checked before use (a machine may run another version).
- The protocol comes from `../../packages/protocol` (a `file:` dependency). `metro.config.js` resolves its imports from this app's `node_modules`, so there's one copy of zod and noble.
- `src/polyfills.ts`: random bytes for the keys (expo-crypto), and zod without code generation (Hermes doesn't allow it).

## Security

- This device's key is in the Keychain or Keystore: this device only, never in a backup. In a browser it's in the site's storage, which Settings says.
- Pairing links are checked before use. The machine's key comes from the link, and the handshake proves it.
- With **Lock the app** on, Face ID or a fingerprint opens it, and again after a minute away. With **Confirm Allow** on, it asks before allowing a permission.
- The machine's rules (folders, skipping permission prompts, screens, typing) are enforced on the machine. The app only shows them.

## Builds for testers and the stores

Expo Go is for development. Installable builds are configured (`app.json`, `eas.json`) and need your accounts:

| For | You need | Then |
| --- | --- | --- |
| Push notifications (both) | An Expo account (free) | `npx eas-cli login`, then `npx eas-cli init` here: it writes the project id into `app.json`, and Settings > Notifications can switch push on |
| iPhone: TestFlight and the App Store | The Apple Developer Program | `npx eas-cli build -p ios --profile production`, then `npx eas-cli submit -p ios`. EAS makes the certificates and the push key if you let it |
| Android: an APK for testers | The Expo account | `npx eas-cli build -p android --profile preview`: a link to install from |
| Android: Google Play, and push | A Play developer account; a Firebase project | `--profile production` makes the bundle for Play. Push needs Firebase's `google-services.json` and its FCM key, added with `npx eas-cli credentials` |

Build numbers are kept by EAS (`appVersionSource: remote`, `autoIncrement`); the version is `app.json`'s. Over-the-air updates (expo-updates) come later: they also need the Expo project.

Without accounts, locally (the native folders are made fresh and stay out of git):

- **iOS simulator**: `npx expo prebuild -p ios`, `cd ios && pod install`, then
  `xcodebuild -workspace Afterhours.xcworkspace -scheme Afterhours -configuration Release -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGN_IDENTITY=- build`
  and `xcrun simctl install booted <the .app>`. Checked: it builds in about four minutes and runs from its own bundle. Keep the ad-hoc signing (`CODE_SIGN_IDENTITY=-`): an unsigned build can't use the Keychain, where this device's key lives.
- **Android APK** (side-loading only, signed with the debug key): Android SDK 36, build-tools 36, NDK 27.1 and JDK 17 (Android Studio's), then `npx expo prebuild -p android` and `cd android && ./gradlew assembleRelease`. Not run here yet.
- `expo prebuild` changes the `ios` and `android` scripts in `package.json`; put them back.
