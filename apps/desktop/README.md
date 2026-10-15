# The Afterhours desktop app

The [Afterhours app](../app/README.md) for Mac, Windows and Linux. It's the app's web build in Electron, so the screens are the same as on the phone, plus what a browser tab can't do:

- **It keeps running in the tray** (the menu bar on a Mac) after you close its window, so it keeps hearing from your machines. The tray shows how many things need you, and its menu has Open, Needs you, Start at login and Quit.
- **System notifications** when something needs you and the window isn't in front. Clicking one opens Needs you. The dock shows the count on a Mac (the taskbar a dot on Windows).
- **Start at login**, from Settings or the tray. It starts hidden in the tray.
- **`afterhours://pair` links** open the app on pairing. A QR code scanned with a phone doesn't need this, but a link clicked on the computer does.
- **The device's key in the system keychain**: the macOS Keychain, Windows' protected storage, or the Linux keyring. On Linux without a keyring, Settings says the key is stored unencrypted.

## Security

- Nothing remote is loaded. The web build is served from inside the app, on its own `app://afterhours/` scheme.
- The page is isolated: context isolation, the sandbox, no Node. It reaches the rest of the app through a few calls, and each one checks what it's given.
- A strict content security policy: code, fonts and images come only from the app, with no eval, frames or plugins. Connections go only to relays.
- The window stays on the app. Web links open in your browser; anything else is refused. Permissions: notifications and the clipboard only.
- Electron's fuses are set: no running as plain Node, no `NODE_OPTIONS` or `--inspect`, and only the app's own integrity-checked archive loads.

## Run it

You need Node 22 and Bun, and the app's packages (`cd ../app && npm install`).

```sh
npm install           # downloads Electron
npm start             # exports the web build, bundles, opens the app
```

## Build the installers

```sh
npm run dist:mac      # release/Afterhours-<version>-arm64.dmg (Apple Silicon) and Afterhours-<version>.dmg (Intel), and zips
npm run dist:win      # release/Afterhours Setup <version>.exe
npm run dist:linux    # release/Afterhours-<version>.AppImage (x64) and -arm64.AppImage
```

All three build on a Mac; no wine or Docker is needed. They're unsigned until there's an Apple Developer ID and a Windows certificate:

- **Mac:** the first time, right-click the app and choose Open. Or, after copying it to Applications: `xattr -dr com.apple.quarantine /Applications/Afterhours.app`. After installing a new version, macOS asks once whether Afterhours may use its Keychain entry ("Afterhours Safe Storage"): choose Always Allow. Each unsigned build looks like a different app to the Keychain; signed builds won't ask.
- **Windows:** SmartScreen warns about an unknown publisher: More info → Run anyway.
- **Linux:** `chmod +x Afterhours-*.AppImage`, then run it.

The Linux `.deb` needs a project homepage, which doesn't exist yet. Set `homepage` in `package.json`, then add `deb` to the Linux targets in `electron-builder.yml`.

Auto-update needs signed builds and a place to publish them, so it comes with signing.

## Where things are

| | Mac | Windows | Linux |
| --- | --- | --- | --- |
| Data (paired machines, settings) | `~/Library/Application Support/Afterhours` | `%APPDATA%\Afterhours` | `~/.config/Afterhours` |
| The key | `secrets.json` there, encrypted with the Keychain's "Afterhours Safe Storage" | encrypted with DPAPI | encrypted with the keyring |
| Start at login | Login Items | the Run registry key | `~/.config/autostart/dev.afterhours.app.desktop` |

## Tests

```sh
bun test test                        # the rules: what loads, what opens, links, inputs, the key store
npm run typecheck
npm run build && npm run e2e         # the app end to end (below)
```

The end-to-end run starts the app in **test mode** (`AFTERHOURS_TEST=1`, never in an installed build). It uses its own data folder, and notifications, browser links and login items are recorded instead of done. The run drives the app through its debugging port against scripted machines through a real relay:

- pairing;
- the key in the encrypted file;
- closing to the tray, then a notification that opens Needs you;
- a second launch handing over a pairing link;
- the content security policy;
- start at login;
- a relay on the local network.

Against an installed build, the steps that need no test hooks run instead. On a Mac it uses Chromium's test keychain, never yours (`E2E_REAL_KEYCHAIN=1` uses the real one):

```sh
ELECTRON_APP=release/mac-arm64/Afterhours.app/Contents/MacOS/Afterhours bun e2e/desktop.e2e.ts
```

The Linux build, in a container with a virtual screen: see the comment at the top of `e2e/linux.Dockerfile`.

## How it's built

- `src/main.ts`:
  - the window and the `app://` scheme (files from `web/`, with the policy headers);
  - tray, notifications, login item, links;
  - what the page may ask, and the hardening.
- `src/preload.ts`: the bridge the page sees, `window.afterhoursDesktop`. The app's side is in `../app/src/desktop.ts`.
- `src/security.ts`, `links.ts`, `inputs.ts`, `secrets.ts`, `autostart.ts`: the rules, kept apart from Electron so they're tested without it.
- `npm run build` exports the app's web build (`../app`), copies it to `web/`, and bundles `src/` into `dist/` with Bun.
- `electron-builder.yml`: the installers, the `afterhours://` scheme, the fuses.
