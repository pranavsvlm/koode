# Releasing Koode

How to build Koode for testers and, later, the stores. **Nothing here is done
automatically:**

- **Paid accounts:** Apple Developer Program, Google Play Console, an Expo account
  for cloud builds.
- **Infrastructure:** deploying the server, LiveKit or the push relay.
- **Distribution:** uploading to TestFlight, Play testing tracks or the stores.

Each needs the owner's explicit decision.

## Before any release: open decisions

| Decision                                               | Why it matters                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AGPL and the App Store** (legal review **required**) | Koode includes libsignal (AGPL-3.0), whose copyright belongs to Signal. Apple's App Store terms add usage restrictions that the AGPL forbids (§10), a known conflict; GPL-licensed apps have been removed from the App Store over it. Signal can ship its own code there; a third party may not be able to. Get legal advice (or written permission from Signal) **before TestFlight external testing or App Store submission**. Google Play and direct APKs don't have this conflict.                                                                  |
| **Koode's licence and source offer**                   | AGPL §6 and §13 mean Koode's source (app and server) must be offered to its users. Choose a licence (AGPL-3.0-or-later is the natural fit), add a `LICENSE` file, publish the repository, and set `KOODE_SOURCE_URL` so the app links to it (Settings → Source Code & Licences).                                                                                                                                                                                                                                                                        |
| **Export compliance (encryption)**                     | Koode uses standard encryption (TLS; the Signal Protocol, AES-256-GCM) to protect user content, so it doesn't use only "exempt" encryption. App Store Connect asks about this at upload (`ITSAppUsesNonExemptEncryption`). Mass-market apps with standard cryptography usually qualify for an exemption that requires filing a self-classification report with the U.S. BIS. Confirm with counsel, then set `ITSAppUsesNonExemptEncryption` in `app.config.ts` (`ios.infoPlist`) accordingly. Some countries (e.g. France) have their own declarations. |
| **Bundle identifiers**                                 | `com.navoasis.koode` (production), `.preview` and `.dev`. Change `BUNDLE_ID_BASE` in `app.config.ts` before the first store build if NavOasis doesn't own that name.                                                                                                                                                                                                                                                                                                                                                                                    |
| **Hosting**                                            | Cloudflare (Workers, D1, Durable Objects, R2), LiveKit (Cloud or self-hosted), the push relay (an always-on Node host), APNs key, Firebase project. See `docs/SETUP.md` and `docs/ARCHITECTURE.md` → Services and cost.                                                                                                                                                                                                                                                                                                                                 |
| **Privacy policy and support URL**                     | Required by both stores. Content is outlined below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## Build variants

| Variant     | `APP_VARIANT` | Name          | Identifier                   | Use                           |
| ----------- | ------------- | ------------- | ---------------------------- | ----------------------------- |
| Development | `development` | Koode Dev     | `com.navoasis.koode.dev`     | Dev client (Metro), dev tours |
| Preview     | `preview`     | Koode Preview | `com.navoasis.koode.preview` | Internal testers              |
| Production  | `production`  | Koode         | `com.navoasis.koode`         | Stores                        |

All three install side by side. Development builds use the APNs sandbox; preview and
production use production APNs. Preview and production block the
`SYSTEM_ALERT_WINDOW` permission that the WebRTC plugin adds.

**Versioning:**

- The user-visible version is `version` in `app.config.ts` (currently 0.1.0).
- Build numbers come from EAS (`"appVersionSource": "remote"`, auto-incremented
  for production). For local builds, set `ios.buildNumber` / `android.versionCode`.

## Pre-release checklist

1. `pnpm check` passes.
2. The device suites pass on the release candidate (`docs/SETUP.md` → Device test
   peers): messaging, calls, push, media, e2ee and resilience.
3. Server migrations are applied to the target database (`wrangler d1 migrations
apply DB --remote`, with approval).
4. **Secrets are set as Worker secrets, never in the app:** `AUTH_TOKEN_SECRET`,
   `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`, `PUSH_RELAY_SECRET`, FCM service
   account, APNs key (on the relay).
5. `EXPO_PUBLIC_API_URL` points at the deployed API for the variant (an EAS
   environment variable).
6. The open decisions above are settled for the distribution channel used.
7. Icons and the splash are regenerated if the brand changed
   (`python3 apps/mobile/scripts/generate-icons.py`).
8. PROGRESS.md lists what's verified and what isn't for this build.

## iOS

### Development build

- **Simulator builds are arm64 only** (Apple-silicon Macs): libsignal's prebuilt
  library has no Intel-Simulator slice, so `withLibSignal` excludes x86_64.
- **Simulator, locally:**
  `cd apps/mobile && npx expo run:ios`. Or `npx expo prebuild -p ios`, then build
  `ios/KoodeDev.xcworkspace` in Xcode. The libsignal pod downloads a prebuilt,
  checksum-verified library (`plugins/withLibSignal.js`).
- **Device:** needs a paid Apple Developer account for signing. Use EAS
  (`eas build -p ios --profile development`) or Xcode with your team selected.

### TestFlight (configuration ready; uploading needs approval)

1. Apple Developer Program membership and an App Store Connect app record for
   `com.navoasis.koode` (name "Koode", primary language English, category Social
   Networking).
2. `npx eas-cli@latest init`, then put the printed project id in `EAS_PROJECT_ID`
   (`app.config.ts`).
3. `npx eas-cli build -p ios --profile production`: EAS creates the distribution
   certificate and profile (with Push and VoIP).
4. `npx eas-cli submit -p ios --profile production`: needs `ascAppId` and the
   Apple Team id. Add them under `submit.production.ios` in `eas.json`.
5. **Internal testing** (up to 100 team members) works without review. **External
   testing** needs Beta App Review, and is subject to the AGPL question above.
6. **Answers App Store Connect will ask for:** export compliance (above); the App
   Privacy questionnaire (below); a demo account for review (Koode is
   invite-only: provide an invite code and a test account).

## Android

### Local APK (no account needed)

```sh
cd apps/mobile
APP_VARIANT=preview npx expo prebuild -p android
cd android && ./gradlew assembleRelease     # app/build/outputs/apk/release/app-release.apk
```

**Toolchain:**

- JDK 17;
- Android SDK 36, build-tools 36.0.0, NDK 27.1.12297006 and CMake 3.22.1;
- `ANDROID_HOME` set (see `docs/SETUP.md` → Android).

**Signing:**

- Release APKs from the Expo template are signed with the **debug key**: fine for
  testers, never for the Play Store.
- For a real release, create an upload key and keep it out of the repository:

  ```sh
  keytool -genkeypair -v -keystore koode-upload.jks -alias koode -keyalg RSA -keysize 4096 -validity 10000
  ```

  Then let EAS manage it (`eas credentials`), or add a `signingConfigs.release` that
  reads it from environment variables.

### Size and ABIs

The local release APK is about **312 MB**, because it holds all four ABIs (arm64-v8a,
armeabi-v7a, x86, x86_64), each with WebRTC and libsignal. For testers, build an
arm64-only APK (`./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a`).
The Play Store gets an App Bundle, which delivers one ABI per device.

### Play policy declarations (before a Play upload)

The merged manifest of the preview APK (`aapt2 dump permissions`) includes
permissions Play reviews. Each needs a declaration or removal, tested on a device:

- **`READ_MEDIA_IMAGES` / `READ_MEDIA_VIDEO` / `READ_MEDIA_VISUAL_USER_SELECTED`**,
  from `expo-media-library`, which Koode uses only to save a photo or video
  (`saveToPhotos`). Attaching uses the system photo picker. Play's Photo and Video
  Permissions policy allows broad access only for a core need, so try blocking
  these (`android.blockedPermissions`) and confirm saving still works. Otherwise,
  declare them in the Play Console.
- **`FOREGROUND_SERVICE_MEDIA_PLAYBACK`**, from the WebRTC and audio stack:
  declare the foreground-service use (calls) in the Play Console.
- **`com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE`**, from
  `expo-application`. Koode never reads the install referrer; block it or mention it
  in Data safety.
- `SYSTEM_ALERT_WINDOW` is already blocked outside development builds.

### EAS

- `preview` builds an installable APK for internal distribution.
- `production` builds an App Bundle (AAB) for Google Play (Play Console account,
  app record, internal testing track first). Submitting needs approval.
- **Firebase:** put `google-services.json` in an EAS file variable
  (`GOOGLE_SERVICES_JSON`); FCM push won't work without it.

## Store metadata (draft)

- **Name:** Koode
- **Subtitle (iOS, 30 chars):** Private messages for family
- **Short description (Play, 80 chars):** Invite-only, end-to-end encrypted
  messaging and calls for family and friends.
- **Description:**

  > Koode is a private place for the people closest to you. It's invite-only: you join
  > when someone you know invites you, so there are no strangers, no ads and no
  > trackers.
  >
  > • End-to-end encrypted messages, photos, videos, files and voice messages
  > • Encrypted voice and video calls
  > • Group chats with admins
  > • Safety numbers to verify who you're talking to
  > • Read receipts and typing indicators you control
  > • Works offline: messages send when you're back
  >
  > Encryption uses the Signal Protocol (Signal's libsignal). Koode's servers relay
  > encrypted data they can't read.

- **Keywords (iOS):** private, messenger, family, encrypted, chat, calls, secure,
  invite
- **Category:** Social Networking (iOS) / Communication (Play)
- **Age rating:** 12+ / Teen (unrestricted messaging between users); answer the
  questionnaires accordingly.
- **Screenshots:** generate from the dev tours (`EXPO_PUBLIC_DEV_TOUR=light` / `dark`)
  on the required device sizes (6.9" and 6.5" iPhone; phone for Play).

### App Privacy (iOS) / Data safety (Play)

Matches the privacy manifest in `app.config.ts`:

- **Collected, linked to the user, for app functionality:**
  - name (display name);
  - user ID;
  - the username, account recovery data (a hash), device information (device
    names, push tokens).
- **Not readable by Koode, so not "collected":** message content, photos, videos,
  files, audio and call media. All are end-to-end encrypted.
- **No tracking, no advertising, no analytics, no data sold or shared.**
- Data is encrypted in transit (TLS).
- Users can delete messages for everyone, remove devices, and **delete their
  account** in the app (Settings → Privacy & Security → Delete Account), as both
  stores require. That signs out every device, erases keys, push registrations and
  the profile, and deletes everything the account sent for everyone.

### Privacy policy (outline)

1. **What the server stores:**
   - account profile;
   - devices and public keys;
   - encrypted messages and files, and their metadata (who, when, sizes, group
     membership);
   - call records;
   - push tokens;
   - security logs without content.
2. **What it can't read:** message, file and call contents.
3. **Retention:**
   - encrypted messages until deleted;
   - unsent uploads deleted after 24 hours;
   - sessions expire after 30 days idle (180 days at most).
4. **Third parties:** Cloudflare (hosting), LiveKit (call relay, which forwards
   encrypted media), Apple, and Google (push delivery: alerts without message text).
5. **Contact.** The source code offer (AGPL).
