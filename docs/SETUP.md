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

### Calls: local LiveKit server

Voice and video need a LiveKit server. For development, run the free open-source
server locally. No account is needed.

```sh
brew install livekit livekit-cli
livekit-server --dev --bind 0.0.0.0     # ws://localhost:7880, key "devkey", secret "secret"
```

`.dev.vars.example` already points the Worker at it (`LIVEKIT_URL`,
`LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`). Restart `wrangler dev` after changing
`.dev.vars`. On a physical phone, set `LIVEKIT_URL` to your Mac's LAN address
(`ws://192.168.x.x:7880`) instead of `localhost`.

### Push notifications: local push relay

APNs needs HTTP/2, which the Worker can't speak, so pushes go through
`apps/push-relay`. Locally it runs in **simulator mode**: alert pushes are
delivered to the booted iOS Simulator with `xcrun simctl push`, no Apple account
needed. VoIP pushes are dropped, because the Simulator has no PushKit.

```sh
cd apps/push-relay
RELAY_SECRET=<same value as PUSH_RELAY_SECRET in apps/server/.dev.vars> \
  APNS_MODE=simulator SIMULATOR=booted node src/main.ts     # listens on 127.0.0.1:8790
```

`.dev.vars` needs `PUSH_RELAY_URL=http://localhost:8790` and a random
`PUSH_RELAY_SECRET` (at least 32 characters). Restart `wrangler dev` after changing it.

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

### Two-person messaging check

To see real messages flow between two accounts on one Mac:

1. Create two invites with `invite:create`: one for the app, one for the peer.
2. Start the app tour in messaging mode, then the peer:

```sh
cd apps/mobile
EXPO_PUBLIC_DEV_TOUR=messaging EXPO_PUBLIC_DEV_TOUR_INVITE=<app code> npx expo start --dev-client
node ../server/scripts/peer.mjs <peer code without dashes> <path to Metro's log>
```

The peer ("Maya", a Node client) starts a chat with the account the app registers,
reads the app's message, types and replies. The app logs the final conversation as
`[tour-msg] final …`.

### Two-person call check

With the local LiveKit server running:

```sh
cd apps/mobile
EXPO_PUBLIC_DEV_TOUR=calls EXPO_PUBLIC_DEV_TOUR_INVITE=<app code> npx expo start --dev-client
node ../server/scripts/call-peer.mjs <peer code without dashes> <path to Metro's log>
```

1. The peer ("Maya") video-calls the app. The tour accepts using the Accept button's
   handler.
2. The peer joins the room with `lk room join --publish-demo`, so the app shows a
   demo video, then lists the room's participants.
3. The peer hangs up.
4. The app then calls the peer, who declines.

The app logs `[tour-call] …` snapshots and the Calls history; the peer prints the
server's view. Grant the microphone first
(`xcrun simctl privacy booted grant microphone com.navoasis.koode.dev`), otherwise the
permission prompt stops the app from publishing audio. The Simulator's camera sends
black frames.

### Push notification check

With the relay running (above):

```sh
cd apps/mobile
EXPO_PUBLIC_DEV_TOUR=push EXPO_PUBLIC_DEV_TOUR_INVITE=<app code> npx expo start --dev-client
node ../server/scripts/push-peer.mjs <peer code without dashes> <path to Metro's log> <flag file>
```

- **Backgrounding and closing:** the tour logs `[tour-push] background-now`; send
  the app to the background then (e.g. `xcrun simctl launch booted
com.apple.Preferences`), and bring it back once the peer prints
  `background-done`. To test a closed app, terminate it and create the flag file;
  the peer then sends one more message.
- **Permission:** the Simulator can't tap "Allow", so the tour requests
  _provisional_ permission. Notifications then go quietly to Notification Center:
  check them in the log (`[tour-push] presented …`) rather than as banners.
- **What the peer does:**
  1. Sends a message while the app is open.
  2. While it's in the background, sends a message, then makes a call that gives up
     (missed call).
  3. Makes another call, which the app answers from its notification.
  4. Makes a call that the native VoIP handler reports to CallKit.

### Media and group check

Generate test files (needs `ffmpeg` and Python with Pillow), copy four of them into
the app's `Documents/e2e/`, and grant the permissions the Simulator can't tap:

```sh
mkdir -p /tmp/koode-media && cd /tmp/koode-media
ffmpeg -f lavfi -i testsrc=size=640x360:rate=25 -f lavfi -i sine=frequency=440 -t 3 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest clip.mp4
ffmpeg -i clip.mp4 -frames:v 1 poster.jpg
ffmpeg -f lavfi -i "sine=frequency=330:duration=2" -c:a aac -ac 1 voice.m4a
# notes.pdf: any small PDF. gps.jpg: a JPEG with GPS EXIF. photo.jpg: any JPEG.
DOCS="$(xcrun simctl get_app_container booted com.navoasis.koode.dev data)/Documents/e2e"
mkdir -p "$DOCS" && cp gps.jpg clip.mp4 notes.pdf voice.m4a "$DOCS/"
xcrun simctl privacy booted grant photos-add com.navoasis.koode.dev
xcrun simctl privacy booted grant microphone com.navoasis.koode.dev

cd apps/mobile
EXPO_PUBLIC_DEV_TOUR=media EXPO_PUBLIC_DEV_TOUR_INVITE=<app code> npx expo start --dev-client
node ../server/scripts/media-peer.mjs <maya code> <sam code> <path to Metro's log> /tmp/koode-media
```

1. "Maya" sends a photo, a video, a PDF and a voice message.
2. The app downloads them, then sends its own files through the real pipeline:
   processing, upload, send. It also records a voice message through the composer.
3. The app reacts to Maya's photo, deletes its PDF for everyone, and saves her photo
   to Photos.
4. The app creates a group, adds "Sam", makes him admin, renames the group and
   removes Maya.
5. The peer checks everything from the server's side: EXIF/GPS removed, video
   poster, documents served as downloads, reactions, deletion, and that Maya lost
   access.

### End-to-end encryption check (interoperability)

Tests the app's libsignal (Swift) against Signal's own Node library
(`@signalapp/libsignal-client`, a dev dependency of the server) and LiveKit's Node
SDK. Needs the local Worker (with migration `0007` applied), `livekit-server --dev`,
two invite codes, and the media files from the previous section (`photo.jpg` for the
peer, `gps.jpg` in the app's `Documents/e2e/`):

```sh
xcrun simctl privacy booted grant microphone com.navoasis.koode.dev
cd apps/mobile
EXPO_PUBLIC_DEV_TOUR=e2ee EXPO_PUBLIC_DEV_TOUR_INVITE=<app code> npx expo start --dev-client
node ../server/scripts/e2ee-peer.mjs <maya code> <path to Metro's log> /tmp/koode-media
```

The peer prints `PASS`/`FAIL` per check and exits non-zero on any failure:

- encrypted text, photo and reactions both ways (the server only ever holds
  ciphertext);
- the safety numbers on both sides match;
- the app's call key decrypts and names its call;
- the app decrypts the peer's encrypted audio (measured from its WebRTC stats);
- a listener with the right key hears it, and one with a wrong key hears nothing;
- LiveKit reports every track GCM-encrypted.

The Simulator's microphone is silent, so the app → peer audio direction can't be
judged there.

### Resilience check (offline, background, recovery)

```sh
cd apps/mobile
EXPO_PUBLIC_DEV_TOUR=resilience EXPO_PUBLIC_DEV_TOUR_INVITE=<app code> npx expo start --dev-client
node ../server/scripts/resilience-peer.mjs <maya code> <path to Metro's log> /tmp/koode-media
```

The tour logs `[tour-res] go-offline`, `go-online` and `background-now`; act on them
by hand or with a runner:

- stop the local Worker on `go-offline`, and restart it on `go-online`;
- send the app to the home screen for about 45 s on `background-now`
  (`xcrun simctl launch booted com.apple.Preferences`, then relaunch Koode).

Revoke Photos access first (`xcrun simctl privacy booted revoke photos-add
com.navoasis.koode.dev`).

The run covers:

- the offline outbox (a text and a photo);
- suspending in the background, then catching up on return;
- a denied permission;
- signing out, then recovering the account as a new device.

### Performance measurements

`EXPO_PUBLIC_DEV_TOUR=perf` runs on-device measurements and logs `[tour-perf] …`:

- the start-up cache read on a 100,000-message scratch database;
- the chat store's cost per typing event and per new message;
- encrypting and decrypting a 100 MB file.

Sample the app's memory meanwhile with `ps -o rss= -p $(pgrep -f
KoodeDev.app/KoodeDev)`.

### Device test peers

All peers share `apps/server/scripts/lib/peer.mjs`: a real account with Signal's Node
library for encryption, and LiveKit's Node SDK with frame encryption for calls. Each
prints `PASS`/`FAIL` lines and exits non-zero on any failure.

| Tour mode    | Peer                  | Covers                                                    |
| ------------ | --------------------- | --------------------------------------------------------- |
| `messaging`  | `peer.mjs`            | Encrypted chat both ways, receipts, typing                |
| `calls`      | `call-peer.mjs`       | Answering an encrypted call, decoded audio, mute, decline |
| `push`       | `push-peer.mjs`       | Notifications in the background and when closed, CallKit  |
| `media`      | `media-peer.mjs`      | Encrypted files both ways, EXIF removal, groups           |
| `e2ee`       | `e2ee-peer.mjs`       | Interoperability with Signal's implementation             |
| `resilience` | `resilience-peer.mjs` | Offline, background, permissions, account recovery        |

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

**Real push notifications and CallKit (paid Apple Developer account):**

1. In the Apple Developer portal, enable Push Notifications for the app ID
   (`com.navoasis.koode.dev`), and create an APNs **auth key** (.p8). Note its Key ID
   and your Team ID.
2. Run the relay in APNs mode where the Worker can reach it:

   ```sh
   RELAY_SECRET=… APNS_KEY_ID=… APNS_TEAM_ID=… APNS_KEY_FILE=/path/AuthKey_XXXX.p8 node src/main.ts
   ```

   Keep the .p8 file out of the repository. Hosting the relay for real use needs your
   approval (see ARCHITECTURE → Services and cost).

3. Development builds use the APNs sandbox; TestFlight builds use production. The app
   reports which one it uses.

## 4. Android

### Local builds and the emulator

A free, user-level toolchain (no sudo):

```sh
# JDK 17 (Temurin) into ~/Library/Java/JavaVirtualMachines
curl -L -o jdk17.tar.gz "https://api.adoptium.net/v3/binary/latest/17/ga/mac/aarch64/jdk/hotspot/normal/eclipse"
tar -xzf jdk17.tar.gz -C ~/Library/Java/JavaVirtualMachines
export JAVA_HOME=$(/usr/libexec/java_home -v 17)

# Android command-line tools into ~/Library/Android/sdk/cmdline-tools/latest, then:
export ANDROID_HOME=~/Library/Android/sdk
sdkmanager --licenses            # Google's SDK licence terms
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0" \
  "ndk;27.1.12297006" "cmake;3.22.1" "emulator" "system-images;android-36;google_apis;arm64-v8a"
avdmanager create avd -n koode -k "system-images;android-36;google_apis;arm64-v8a" -d pixel_6
emulator -avd koode -no-window -no-audio &      # or with a window
```

Build and run (the versions match React Native 0.86):

```sh
cd apps/mobile
APP_VARIANT=development npx expo prebuild -p android
echo "sdk.dir=$ANDROID_HOME" > android/local.properties
(cd android && ./gradlew assembleDebug)     # app/build/outputs/apk/debug/app-debug.apk
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8081 tcp:8081 && adb reverse tcp:8787 tcp:8787 && adb reverse tcp:7880 tcp:7880
```

`adb reverse` lets the emulator reach Metro, the Worker and LiveKit signalling on the
Mac as `localhost`. On a slow or unreliable network, raise Gradle's download timeouts
in `~/.gradle/gradle.properties` (`systemProp.org.gradle.internal.http.socketTimeout`
and `...repository.max.retries`).

Open the dev client on Metro directly, and grant what a test can't tap:

```sh
adb shell pm grant com.navoasis.koode.dev android.permission.POST_NOTIFICATIONS
adb shell pm grant com.navoasis.koode.dev android.permission.RECORD_AUDIO
adb shell am start -a android.intent.action.VIEW \
  -d "exp+koode://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081" com.navoasis.koode.dev
```

The device test tours and peers work the same as on iOS. Copy test files with
`adb push` + `run-as com.navoasis.koode.dev` into `files/e2e/`. **Calls can't connect
from the emulator to a local LiveKit:**

- the emulator can't route to the Mac's LAN address, which LiveKit advertises for
  media;
- `adb reverse` only forwards TCP.

Test Android calls on a real phone on the same network, or against a reachable
LiveKit server.

### Cloud builds through EAS

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
5. Push notifications (FCM):
   1. Create a Firebase project and add an Android app with the package name.
   2. Upload its `google-services.json` as an EAS **file** environment variable
      named `GOOGLE_SERVICES_JSON`; for local builds, set `GOOGLE_SERVICES_JSON` to
      its path. Don't commit it.
   3. Put the project's service-account JSON (one line) in the Worker secret
      `FCM_SERVICE_ACCOUNT`.

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
- **`429 Too many requests` while testing locally:** every local client shares one
  "unknown IP" rate-limit bucket (5 registrations per hour). Reset it with
  `pnpm --filter @koode/server exec wrangler d1 execute DB --local --command "DELETE FROM rate_limits"`.
- **Fast Refresh stops updating after a syntax error:** fix the error, then relaunch
  the app. The dev client reopens the last Metro server automatically.
