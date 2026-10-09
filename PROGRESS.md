# Progress

| Phase | Scope                    | Status                                                 |
| ----- | ------------------------ | ------------------------------------------------------ |
| 1     | Project foundation       | ✅ Complete (Simulator launch verified during Phase 2) |
| 2     | Premium UI/UX            | ✅ Complete; verified on the iOS 27 Simulator          |
| 3     | Authentication           | ✅ Complete; verified on the iOS 27 Simulator          |
| 4     | Real-time messaging      | ✅ Complete; two-party test on the iOS 27 Simulator    |
| 5     | Voice and video calling  | ⏳ Awaiting approval                                   |
| 6     | Notifications            | —                                                      |
| 7     | Media and group features | —                                                      |
| 8     | Security and E2EE        | —                                                      |
| 9     | Performance and testing  | —                                                      |
| 10    | Builds and distribution  | —                                                      |

**E2EE status: not implemented.** Traffic is protected by TLS only.

---

## Phase 4: Real-time messaging (2026-10-09)

Chats are **real**: messages go through the local Worker, D1 and Durable Objects, and
are cached on the phone. Calls and the call history are still simulated (Phase 5).
Reactions, deletion, pin and mute are still device-only (Phase 7).
**Message contents are not end-to-end encrypted yet (Phase 8).**

### Delivered

- **Server:**
  - Migration `0003` (conversations, members with delivered/read/shared-read
    positions, messages).
  - `ConversationRoom` DO: single writer for `seq`, idempotent sends, reply
    validation, receipt handling, typing relay, fan-out.
  - `UserSocket` DO: hibernating WebSockets for every device, auto-answered
    heartbeats, closes the socket when a device signs out or is removed.
  - Routes: user directory, conversations (direct dedupe, groups), history paging
    (`before` / `after`), send, receipts, and an authenticated WebSocket upgrade (header
    auth, no URL tokens).
- **Shared:** message, conversation and receipt schemas, plus the realtime protocol.
- **App:**
  - `MessagingEngine`: SQLite cache, offline outbox with in-order delivery and
    retry-on-tap.
  - Reconnection with backoff and jitter, heartbeat dead-connection detection,
    resume on foreground.
  - Catch-up sync, history paging, batched receipts, throttled and expiring typing.
  - The chat store maps engine data into the existing UI. Ticks come from members'
    receipt positions, with read-receipt privacy and reciprocity.
  - The Chats title shows "Connecting…" / "Waiting for network…".
  - Header subtitle shows `@username` (no fake presence).
  - Sample data moves behind a Developer switch.
- **Dev tooling:** `scripts/peer.mjs` (a second account in Node) and a messaging mode
  for the screen tour.

### Verification

| Check                                                                                                                                                                                                                                                                     | Result                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| TypeScript, ESLint, Prettier (all packages)                                                                                                                                                                                                                               | ✅ Pass                 |
| Shared schema tests                                                                                                                                                                                                                                                       | ✅ 31/31                |
| Server tests in the Workers runtime                                                                                                                                                                                                                                       | ✅ 48/48                |
| Server messaging coverage: direct-chat dedupe, groups, ordering, idempotency, id hijack (409), non-member access (404), replies, body limits, paging both ways, unread counts, receipt monotonicity, read-receipt privacy                                                 | ✅                      |
| Server WebSocket coverage: unauthenticated upgrades rejected, live delivery to all devices, receipts, typing to others only, heartbeat, malformed frames ignored, socket closed on sign-out                                                                               | ✅                      |
| Mobile tests (incl. 17 engine tests with fake clock/socket/server: outbox ordering offline, failed+retry, backoff 1→30 s cap and reset, heartbeat timeout, catch-up `after=`, paging, typing TTL/throttle, receipts batching and privacy, cache restore, signed-out stop) | ✅ 126/126              |
| **Two accounts on the iOS 27 Simulator + a Node peer, against the local server**                                                                                                                                                                                          | ✅                      |
| Peer's chat arrived live with an unread badge; the app's reply reached the peer (seq 2); the peer's read receipt turned the app's ticks to read; the peer's typing showed live; the peer's reply arrived live                                                             | ✅ Screenshots and logs |
| Offline: server stopped, app relaunched, chats load from the SQLite cache with "Waiting for network…"; server restarted, app reconnected by itself                                                                                                                        | ✅                      |

Bugs found by these tests and fixed:

- An outbox flush could leave a stale promise, so messages waited until the next
  reconnect.
- Overlapping SQLite transactions failed ("transaction within a transaction"); cache
  operations are now serialized.
- A cache failure no longer stops messaging.

### Not verified

- **Typing and tapping by hand:** the on-device steps were scripted (the store's
  `send`), not typed on the keyboard. Retry-on-tap, scrolling to load older history
  and the outbox were exercised in tests, not by hand.
- **Real network switches** (Wi-Fi ↔ cellular) and long backgrounding: covered by
  heartbeat and resume logic plus tests, not by a real handover.
- **Two real phones, Android, and a deployed server.**
- **Large histories** and performance (Phase 9). Start-up loads at most 300 cached
  messages per chat.

### Known issues and limitations

- Not end-to-end encrypted: the server and the local cache hold plaintext.
- No presence or "last seen" yet. The header shows `@username`.
- Local rate limits are shared by all local clients (see SETUP → Troubleshooting).
- The sample-data switch clears the local message cache; it re-syncs from the server.

### Manual configuration required

None beyond Phase 3. Applying migration 0003 locally (`db:migrate:local`) and
restarting `wrangler dev` (for the new Durable Object) are done on this Mac.

---

## Phase 3: Authentication (2026-10-09)

Accounts, sign-in, devices, invites and recovery are **real** and backed by the local
Worker and D1. Chats, calls and contacts still use the sample data from Phase 2 until
Phase 4.

### Delivered

- **Server** (see [API.md](docs/API.md) and ARCHITECTURE → Identity):
  - Invite-only registration.
  - Ed25519 device-key challenge–response, with single-use, purpose-bound challenges.
  - Login with the device key.
  - HS256 access tokens (algorithm pinned).
  - Rotating, hashed refresh tokens with reuse detection.
  - Recovery key: hashed; same answer for unknown users; rotatable.
  - Profile get and update.
  - Devices: list, rename, remove. Sign-out removes the device.
  - Invites: create, list, cancel, public preview; 60-bit codes, hashed, single use,
    10 open per person.
  - D1-backed rate limiting keyed by HMAC'd IP.
  - Zod validation shared with the app, and an audit trail with no secrets.
  - Migration `0002_auth.sql`.
  - `invite:create` script for the bootstrap invite.
- **App:**
  - `authClient`:
    - Ed25519 via `@noble/curves`, keys in SecureStore (this device only, never
      backed up).
    - Single-flight token renewal, with a silent fallback to device-key login.
    - Automatic sign-out when the device is revoked; stays signed in while offline.
  - Session store bootstraps from the keystore before the first frame.
  - Onboarding wired to the API:
    - Invite: live inviter preview.
    - Profile: live username availability.
    - Recovery key: Create Account registers the device.
    - Sign in: recovery with username and key.
  - New Settings screens: Invitations, Devices, Recovery Key. Profile saves to the
    server. The Contacts invite sheet creates real invites.
  - Dev client falls back to `localhost:8081` when the last Metro address is gone
    (e.g. after the Mac's IP changes).

### Verification

| Check                                                                                                                                                                                                                                            | Result                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| TypeScript, ESLint, Prettier (all packages)                                                                                                                                                                                                      | ✅ Pass                      |
| Shared schema tests                                                                                                                                                                                                                              | ✅ 26/26                     |
| Server tests in the Workers runtime (registration, invites, signatures, replay, login, refresh rotation and reuse, forged/`alg:none` tokens, logout, recovery, profile, devices incl. cross-account access, rate limits, hashed rate-limit keys) | ✅ 29/29                     |
| Mobile tests (incl. auth client against a fake server that verifies real signatures: renew, fallback login, revoked device, offline, single-flight, logout)                                                                                      | ✅ 105/105                   |
| HTTP smoke test against `wrangler dev` (preview → register → me → refresh → logout)                                                                                                                                                              | ✅                           |
| Request logs contain no tokens or keys                                                                                                                                                                                                           | ✅ Checked                   |
| **On the iOS 27 Simulator: real registration through the app** (device key generation, signing, Keychain, API)                                                                                                                                   | ✅ `@tour648241` registered  |
| Server state after on-device sign-up (admin role, hashed recovery key, public key only, 1 live session, audit events)                                                                                                                            | ✅ Checked in D1             |
| Session restored from the Keychain after relaunch                                                                                                                                                                                                | ✅ Opens directly into Chats |
| Auth screens reviewed on the Simulator (invite preview, profile, recovery key, sign-in, settings, invitations, devices, recovery key rotation)                                                                                                   | ✅                           |

### Not verified

- **Tapped by hand:** Create Account, Restore Account, removing another device,
  rotating the recovery key, and sharing an invite. These were exercised by API
  tests and the scripted on-device registration, not by tapping on the device.
- **Two real devices** (e.g. revoking one from the other): covered only by server and
  unit tests.
- **Android** (Keystore behaviour), **physical iPhone**, and any **deployed** server.
  Nothing has been deployed.
- **Remote rate limiting:** D1 latency under real load is unmeasured.

### Known issues and limitations

- Linking a new device from an existing one (QR) isn't built. Recovery uses the
  recovery key.
- Recovery doesn't notify your other devices yet (needs push, Phase 6).
- Sign-out on a phone you still hold removes it from the account. This is deliberate
  (no passwords), and you need the recovery key to come back.
- The dev tour signs out (removes) the current local device before registering a new
  account.

### Manual configuration required

- Local: put a random `AUTH_TOKEN_SECRET` in `apps/server/.dev.vars` (done on this
  Mac). Create invites with `pnpm --filter @koode/server invite:create`.
- Deployment (not done; needs your approval): `wrangler d1 create`, update
  `database_id`, `wrangler secret put AUTH_TOKEN_SECRET`, then apply migrations
  remotely.

---

## Phase 2: Premium UI/UX (2026-10-09)

All screens run on **sample data held in memory**. No real messages, calls,
accounts or network traffic exist yet (apart from the server health check). Real
behaviour arrives in the phases noted on each screen.

### Delivered

- **Design system** (`src/components/ui`, documented in [DESIGN.md](docs/DESIGN.md)):
  - Primitives: Text, Button, IconButton, Icon (SF Symbols / Material Symbols),
    TextField, Avatar (gradient monograms), Badge, grouped List rows,
    SegmentedControl, Sheet (bottom sheet), Dialog (promise-based), Toast,
    GlassSurface, Skeleton, EmptyState, PressableScale, MotionView.
  - Glass: Liquid Glass on iOS 26+, blur on older iOS, tinted surfaces on Android.
  - Tokens: five selectable accents, a fixed dark call palette, and contrast tests for
    every scheme × accent combination (10 combinations).
- **Screens** (all 20 requested, plus recovery key):

  | #   | Requested screen         | Route                                                                                      |
  | --- | ------------------------ | ------------------------------------------------------------------------------------------ |
  | 1   | Splash                   | native splash plus an animated hand-off (`AnimatedSplash`)                                 |
  | 2   | Welcome and onboarding   | `(auth)/welcome`, a three-page pager with parallax                                         |
  | 3   | Registration and login   | `(auth)/create-profile`, `(auth)/recovery-key`, `(auth)/sign-in`                           |
  | 4   | Invitation acceptance    | `(auth)/invite` (deep-link `?code=` prefill)                                               |
  | 5   | Chats list               | `(tabs)/chats`: large title, search, pinned and muted chats, unread badges, typing preview |
  | 6   | Individual conversation  | `chat/[id]` (see conversation features below)                                              |
  | 7   | Group conversation       | `chat/[id]` with sender names and avatars, plus `chat/[id]/info`                           |
  | 8   | Voice calling            | `call/[id]?kind=voice` (see call features below)                                           |
  | 9   | Video calling            | `call/[id]?kind=video` (see call features below)                                           |
  | 10  | Incoming call            | `incoming-call`                                                                            |
  | 11  | Call history             | `(tabs)/calls`, with an All / Missed filter                                                |
  | 12  | Contacts                 | `(tabs)/contacts`: alphabetical sections, search, invite sheet                             |
  | 13  | New conversation         | `new-chat`: direct message, multi-select group with naming, or start a call                |
  | 14  | Profile                  | `settings/profile` (own) and `contact/[id]` (others)                                       |
  | 15  | Settings                 | `(tabs)/settings`, including a Developer section                                           |
  | 16  | Privacy and security     | `settings/privacy`, with an honest "E2EE not on yet" banner                                |
  | 17  | Notification preferences | `settings/notifications`                                                                   |
  | 18  | Appearance settings      | `settings/appearance`: theme, accent, chat text size, live preview                         |
  | 19  | Media viewer             | `media/[id]`: pinch and double-tap zoom, swipe to dismiss                                  |
  | 20  | Attachment picker        | `attach` (native form sheet)                                                               |
  - **Conversation features:**
    - Grouped bubbles and day dividers.
    - Replies (also by swiping a message), reactions, a long-press action sheet
      (react, reply, copy, delete) and deleted-message tombstones.
    - Photo, video, voice-note and document bubbles; read ticks; typing indicator.
    - Keyboard-synchronised composer.
  - **Call features:**
    - Voice: pulsing rings while ringing, a running timer, and speaker, mute and
      switch-to-video controls.
    - Video: a draggable self view that snaps to corners, flip and camera controls,
      and controls that auto-hide.

- **Navigation:** native tabs (the iOS 26+ Liquid Glass tab bar, badges), native stacks
  with large titles and search, form sheets and full-screen modals. Onboarding and app
  routes are separated with `Stack.Protected`.
- **Dev data and simulation** (`src/dev`):
  - Realistic family and friends fixtures, plus locally generated sample photos
    (`scripts/generate_assets.py`; no third-party images).
  - Simulated sending → delivered → read, typing and replies.
  - Developer switches for slow loading, empty data and incoming calls.
  - A screen tour for automated review.
- **Brand:** placeholder app icon, splash mark and adaptive Android icon (to be refined
  in Phase 10).
- **iOS 27 support:** `plugins/withSceneLifecycle.js` adopts the UIScene life cycle
  that iOS 27 requires (Expo SDK 57 doesn't). It has its own unit tests.

### Verification

| Check                                                                                                                           | Result            |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| TypeScript, ESLint, Prettier (all packages)                                                                                     | ✅ Pass           |
| Mobile unit and component tests (tokens and contrast, format, chat store, grouping, auth helpers, UI components, config plugin) | ✅ 88/88          |
| Server / shared tests                                                                                                           | ✅ 8/8, 3/3       |
| `expo-doctor`                                                                                                                   | ✅ 21/21          |
| iOS native build (Xcode 27, iOS 27 SDK)                                                                                         | ✅ Builds         |
| **Launch and render on the iOS 27 Simulator (iPhone 17 Pro)**                                                                   | ✅ Verified       |
| Every screen reviewed on the Simulator via the screen tour, in light (Blue) and dark (Rose)                                     | ✅ 28 screenshots |
| Loading skeletons and empty states reviewed on the Simulator                                                                    | ✅                |
| Android JS bundle (`expo export`)                                                                                               | ✅ Bundles        |

Bugs found on the Simulator and fixed in this phase:

- The app crashed at launch on iOS 27 (no UIScene adoption).
- Animated views lost all their Tailwind styles: the invisible primary button and
  page dots. Root cause: NativeWind's interop on `Animated.View`. Fixed with
  `MotionView` / `MotionPressable`.
- Contact action buttons collapsed (the pressable wrapper wasn't the flex child).
- `SafeAreaView` styles were ignored.
- The media-viewer header sat under the status bar.
- Group avatar initials showed "A(".
- The recovery key wrapped unevenly.

### Not verified

- **Interactions by hand.** Screens were reviewed through scripted navigation, not
  manual taps. Not exercised on device:
  - typing and sending
  - swipe-to-reply, long-press sheets, reactions
  - pinch-zoom and dragging the self view
  - keyboard behaviour
  - haptics

  Their logic is unit-tested where possible. Please try them in Device Hub.

- **Android rendering.** No device or emulator. Only the JS bundle is verified;
  native tabs, Material Symbols and the tinted glass fallback are unverified on
  Android.
- **VoiceOver and Dynamic Type.** Labels, roles and contrast are implemented and
  partly unit-tested, but no screen-reader pass has been done.
- **Physical iPhone** and **EAS builds:** not attempted.

### Known issues and limitations

- Everything is sample data. Sign-in accepts any code or key and stores nothing
  server-side.
- Voice notes, attachment pickers, downloads, sharing, profile photos, blocking, group
  administration and device linking show a toast naming the phase that delivers them.
- In development builds, Expo's floating "Tools" button overlaps header buttons.
  Release builds don't have it.
- The iOS 26.5 Simulator runtime was also downloaded but not used for testing.

### Manual configuration required

None for Phase 2. To run it yourself: `pnpm dev:server`, then `pnpm ios` (see
[SETUP.md](docs/SETUP.md)).

---

## Phase 1: Project foundation (2026-10-09)

### Delivered

- **Monorepo:** pnpm workspaces with `apps/mobile`, `apps/server` and `packages/shared`,
  plus shared Prettier, ESLint and EditorConfig settings.
- **Mobile (Expo SDK 57, React Native 0.86, TypeScript strict):**
  - Expo Router (`src/app`), NativeWind 4 with Tailwind 3, Reanimated 4 and Worklets,
    Gesture Handler, Zustand, Expo SQLite, SecureStore, dev client.
  - Design-token system: semantic light and dark palette, Apple-style type ramp,
    radii and spring presets. A test enforces WCAG contrast ratios on the palette.
  - `ThemeProvider` (system, light or dark) with the preference persisted through the
    SQLite key-value store. The splash screen stays up until preferences load, so the
    first frame never shows the wrong theme.
  - Typed API client (timeouts, Zod validation, normalised errors) and environment
    validation (release builds require HTTPS).
  - UI primitives `Text` and `Screen`, and a foundation screen showing live server
    health and a theme switcher.
  - `app.config.ts` with development, preview and production variants that install
    side by side, and `eas.json` with development, simulator, preview (APK) and
    production profiles.
- **Server (Cloudflare Worker, Hono):**
  - `/health` and `/v1/health`, request IDs, security headers, `no-store`, path-only
    structured logging, and typed JSON errors.
  - D1 migration `0001_identity.sql` (users, devices, sessions, invites,
    audit_events), an R2 binding and a `ConversationRoom` Durable Object skeleton
    (SQLite-backed).
- **Shared:** protocol constants plus the `HealthResponse` and `ApiErrorBody` Zod
  schemas.
- **Docs:** [ARCHITECTURE.md](docs/ARCHITECTURE.md) (full system plan, E2EE options,
  risks, costs) and [SETUP.md](docs/SETUP.md).

### Verification

| Check                                                                                         | Result              |
| --------------------------------------------------------------------------------------------- | ------------------- |
| TypeScript, all 3 packages                                                                    | ✅ Pass             |
| ESLint, all 3 packages                                                                        | ✅ Pass             |
| Prettier check                                                                                | ✅ Pass             |
| Shared unit tests (Vitest)                                                                    | ✅ 3/3              |
| Server tests in the Workers runtime (health, headers, 404, D1 schema and constraints, DO, R2) | ✅ 8/8              |
| Mobile unit tests (env, API client, tokens and contrast, Text, preferences)                   | ✅ 21/21            |
| `expo export` iOS and Android bundles (Hermes)                                                | ✅ Both bundle      |
| `expo-doctor`                                                                                 | ✅ 21/21 checks     |
| App config resolves for all three variants                                                    | ✅                  |
| `eas.json` parsed with `@expo/eas-json`, all profiles × platforms                             | ✅                  |
| `wrangler dev` with local D1 migration, curl `/health` and 404                                | ✅                  |
| Secrets in query strings stay out of logs                                                     | ✅ Verified locally |

### Not verified

- ~~App launch in the iOS Simulator~~: verified during Phase 2.
- **EAS cloud builds (iOS or Android):** need your Expo account (`eas init`). The
  `pnpm 11.16.0` and `node 24.11.0` image settings in `eas.json` have not been tested
  on EAS.
- **Physical iPhone:** not attempted.

### Known issues and limitations

- Bundle ID base `com.navoasis.koode` is a placeholder. Change it before the first EAS
  build.
- D1 `database_id` in `wrangler.jsonc` is a placeholder for local development.
- Version pins forced by compatibility:
  - ESLint stays on 9 because `eslint-plugin-react` does not support ESLint 10.
  - Vitest stays on 4.1 because the installed `@cloudflare/vitest-plugin` 1.3.7
    requires it.
  - NativeWind stays on 4.2.7 (stable). v5 is still a release candidate.

### Manual configuration required

1. ~~Accept the Xcode licence and select Xcode~~ (done 2026-10-09).
2. Later, when ready: create an Expo account and run `eas init`; choose a bundle ID;
   decide on the Apple Developer Program (needed from Phase 6).
