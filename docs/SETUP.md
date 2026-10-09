# Development setup

## Prerequisites

| Tool      | Version       | Notes                                                           |
| --------- | ------------- | --------------------------------------------------------------- |
| macOS     | Apple Silicon |                                                                 |
| Node.js   | 22 or newer   | 24 LTS recommended                                              |
| pnpm      | 11.x          | `corepack enable` picks up the version pinned in `package.json` |
| Xcode     | 27 or newer   | Simulator runtimes are a separate download (below)              |
| CocoaPods | latest        | Required for iOS builds: `brew install cocoapods`               |

### One-time Xcode setup

Run these in a terminal. They need your password.

```sh
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -license accept
xcodebuild -runFirstLaunch
```

Xcode 27 does not include a Simulator runtime. Download one (about 8 GB) from the
command line, or in Xcode → Settings → Components:

```sh
xcodebuild -downloadPlatform iOS -architectureVariant arm64   # latest (iOS 27)
xcrun simctl list runtimes                                    # confirm it is installed
```

Xcode 27 has no `Simulator.app`; it was replaced by **Device Hub**. Open it with
`open -b com.apple.dt.Devices`.

> **iOS 27 note.** iOS 27 terminates apps that don't use the UIScene life cycle.
> Expo SDK 57's native template doesn't, so the app includes a small config plugin,
> `apps/mobile/plugins/withSceneLifecycle.js`, that switches it to Expo's own
> `ExpoAppSceneDelegate`. Expo SDK 58 does this itself; remove the plugin when
> upgrading.

## 1. Install dependencies

```sh
pnpm install
```

## 2. Run the backend locally

Everything runs on your Mac through Miniflare. No Cloudflare account is needed and
nothing is billed.

```sh
cp apps/server/.dev.vars.example apps/server/.dev.vars
# set AUTH_TOKEN_SECRET in .dev.vars to a random value:
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
pnpm --filter @koode/server db:migrate:local
pnpm dev:server
```

Check it: `curl http://localhost:8787/health` should return `{"status":"ok",…}`.

### Create the first account

Koode is invite-only, so the very first invite comes from a script:

```sh
pnpm --filter @koode/server invite:create        # prints e.g. CTPV-TBEW-78WW
```

In the app, choose **I have an invite** and enter the code. The account created
with this bootstrap invite becomes the instance admin. Everyone else joins through
invites created in the app (Settings → Invite Family & Friends, or the Contacts
tab).

To start over locally, delete `apps/server/.wrangler/` and run the migrations
again.

## 3. Run the app on the iOS Simulator

```sh
cp apps/mobile/.env.example apps/mobile/.env.local
pnpm ios
```

`pnpm ios` runs `expo run:ios`, which:

1. generates the native project,
2. compiles a development build (the first build takes several minutes),
3. installs it on the Simulator, and
4. starts Metro.

Later sessions only need `pnpm dev:mobile`, unless you add a native dependency; then
run `pnpm ios` again.

This build uses sample data and has no real sign-in yet. Go through onboarding with
any 12-character invite code, or choose "I already have an account" and enter any
24 characters. **Settings → Developer** shows whether the app can reach your local
server, and has switches for slow loading, empty data, simulated replies and
simulated incoming calls.

### Reviewing every screen without tapping

On iOS 27 Simulators, every `xcrun simctl openurl` asks for confirmation, so deep
links can't drive automated checks. Instead, the development build has a screen
tour:

```sh
CODE=$(pnpm --silent --filter @koode/server invite:create | grep -oE '[0-9A-Z]{4}(-[0-9A-Z]{4}){2}')
cd apps/mobile
EXPO_PUBLIC_DEV_TOUR=light EXPO_PUBLIC_DEV_TOUR_INVITE=$CODE npx expo start --dev-client   # or =dark, or =1 to keep your theme
```

Relaunch the app. **The tour signs out first, which removes the current device from
its account on your local server.** It then registers a fresh account with the
invite, which doubles as an on-device end-to-end check of sign-up. It signs out, walks through every screen roughly every 3.5 seconds,
and logs `[tour] <n> <screen>` in Metro so each step can be screenshotted with
`xcrun simctl io booted screenshot`. Your appearance settings are restored at the
end. Restart Metro without the variable to stop the tour.

### On your iPhone

1. Connect the phone by USB and enable Developer Mode on it.
2. In `apps/mobile/.env.local`, set `EXPO_PUBLIC_API_URL=http://<your-Mac-LAN-IP>:8787`.
3. Start the server listening on the LAN: `pnpm --filter @koode/server dev --ip 0.0.0.0`.
4. Build and install: `pnpm --filter @koode/mobile exec expo run:ios --device`. Xcode
   asks you to choose a signing team. A free Apple ID works for local installs. Push,
   VoIP and TestFlight need the paid Developer Program.

## 4. Android (cloud builds through EAS)

There is no Android device or emulator here, so Android builds run on Expo's servers.
The free tier has a monthly build quota.

```sh
cd apps/mobile
npx eas-cli@latest login
npx eas-cli@latest init        # prints a project ID
```

1. Paste the project ID into `EAS_PROJECT_ID` in `apps/mobile/app.config.ts`.
2. Change `BUNDLE_ID_BASE` in the same file to an identifier you own.
3. Build the APK:

   ```sh
   npx eas-cli@latest build --platform android --profile development   # dev-client APK
   npx eas-cli@latest build --platform android --profile preview       # standalone APK
   ```

4. Set `EXPO_PUBLIC_API_URL` for the `preview` and `production` environments on the EAS
   dashboard (Project → Environment variables). Release builds refuse to start
   without an `https://` URL.

### Build profiles (`apps/mobile/eas.json`)

| Profile                 | Output                                    | Variant / bundle ID       |
| ----------------------- | ----------------------------------------- | ------------------------- |
| `development`           | Dev client: iOS device build, Android APK | `…koode.dev`, "Koode Dev" |
| `development-simulator` | Dev client for the iOS Simulator          | `…koode.dev`              |
| `preview`               | Internal-distribution app, Android APK    | `…koode.preview`          |
| `production`            | Store build (submission needs approval)   | `…koode`                  |

## 5. Quality checks

Run from the repo root:

```sh
pnpm check      # typecheck, lint, format check and tests across all packages
pnpm test       # tests only
pnpm format     # apply Prettier
```

- **Mobile:** Jest (`jest-expo`) and React Native Testing Library.
- **Server:** Vitest inside the real Workers runtime (`@cloudflare/vitest-plugin`),
  with D1 migrations applied before each run.

## Environment and secrets

| Where                        | What                                                 | Committed?           |
| ---------------------------- | ---------------------------------------------------- | -------------------- |
| `apps/mobile/.env.local`     | `EXPO_PUBLIC_*` values (public, embedded in the app) | No                   |
| `apps/server/.dev.vars`      | Server secrets for local development                 | No                   |
| `wrangler secret put …`      | Server secrets for deployed Workers                  | Stored by Cloudflare |
| `apps/server/wrangler.jsonc` | Non-secret bindings and variables                    | Yes                  |

Never put a secret in an `EXPO_PUBLIC_*` variable. Anything in the app bundle can be
extracted.

## Database migrations

```sh
pnpm --filter @koode/server db:migrations:new <name>   # create a new numbered migration
pnpm --filter @koode/server db:migrate:local            # apply it locally
```

Until the first remote deploy, `0001_identity.sql` may still be edited (then delete
`apps/server/.wrangler` to reset local state). After that, only add new migrations.

After changing bindings in `wrangler.jsonc`, regenerate the types:

```sh
pnpm --filter @koode/server cf-typegen
```

## Troubleshooting

- **Metro shows stale styles or routes:** `pnpm --filter @koode/mobile start --clear`.
- **A pnpm install hangs:** an interactive prompt is waiting. The workspace sets
  `confirmModulesPurge: false` to prevent this. If a new dependency needs a build
  script, add it to `allowBuilds` in `pnpm-workspace.yaml`.
- **`xcrun: unable to find utility "simctl"`:** `xcode-select` points at the Command
  Line Tools instead of Xcode. Run the one-time Xcode setup above.
- **App quits at launch with `UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`
  in the crash report:** the native project was generated without the scene life
  cycle plugin. Run `npx expo prebuild --platform ios --clean` from `apps/mobile`,
  then `pod install` in `ios/` and rebuild.
- **"Open in Koode Dev?" keeps appearing:** iOS 27 asks for confirmation on every URL
  sent with `simctl openurl`, even when the app is open. Tap Open, or use the screen
  tour above.
- **Fast Refresh stops updating after a syntax error:** fix the error, then relaunch
  the app. The dev client reopens the last Metro server automatically.
