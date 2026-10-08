# Development setup

## Prerequisites

| Tool      | Version       | Notes                                                           |
| --------- | ------------- | --------------------------------------------------------------- |
| macOS     | Apple Silicon |                                                                 |
| Node.js   | 22 or newer   | 24 LTS recommended                                              |
| pnpm      | 11.x          | `corepack enable` picks up the version pinned in `package.json` |
| Xcode     | 27 or newer   | Includes the iOS Simulator                                      |
| CocoaPods | latest        | Only if `expo run:ios` asks for it: `brew install cocoapods`    |

### One-time Xcode setup

Run these in a terminal. They need your password.

```sh
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -license accept
xcodebuild -runFirstLaunch
```

Then open Xcode → Settings → Components and install an iOS Simulator runtime if none
is listed. To check:

```sh
xcrun simctl list devices available | grep iPhone
```

## 1. Install dependencies

```sh
pnpm install
```

## 2. Run the backend locally

Everything runs on your Mac through Miniflare. No Cloudflare account is needed and
nothing is billed.

```sh
cp apps/server/.dev.vars.example apps/server/.dev.vars
pnpm --filter @koode/server db:migrate:local
pnpm dev:server
```

Check it: `curl http://localhost:8787/health` should return `{"status":"ok",…}`.

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

The foundation screen shows a server status row. Green means the app reached
`/health`. Tap the row to check again.

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
