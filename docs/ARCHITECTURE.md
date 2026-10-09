# Koode architecture

Koode is a private, invite-only messaging and calling app for family and friends. This
document records the system design and the decisions behind it. Sections marked
**(planned)** describe phases that have not been built yet; they are commitments to
validate, not descriptions of working code.

## System overview

```
                       ┌──────────────────────── Cloudflare ─────────────────────────┐
┌──────────────┐ HTTPS │  ┌──────────────┐        ┌──────────────────────────────┐  │
│  Koode app   │──────►│  │    Worker    │──────► │ D1: identity, conversations, │  │
│ (Expo / RN)  │       │  │  (Hono API)  │        │ message index, receipts      │  │
│              │  WSS  │  │              │        └──────────────────────────────┘  │
│  SQLite      │──────►│  │              │──────► Durable Object per conversation   │
│  SecureStore │       │  │              │        (WebSocket fan-out, typing,      │
│              │       │  │              │         ordering, presence)              │
│              │       │  │              │──────► R2 (private bucket, media)        │
│              │       │  └──────┬───────┘                                          │
└──────┬───────┘       └─────────┼──────────────────────────────────────────────────┘
       │ WebRTC                  │ mints short-lived tokens; sends pushes
       ▼                         ▼
┌──────────────┐        ┌──────────────────────┐
│ LiveKit SFU  │        │ APNs (alert + VoIP)  │
│ (voice/video)│        │ FCM (Android)        │
└──────────────┘        └──────────────────────┘
```

## Repository layout

| Path              | Purpose                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `apps/mobile`     | Expo SDK 57 app (iOS + Android), Expo Router, NativeWind, Zustand    |
| `apps/server`     | Cloudflare Worker (Hono), Durable Objects, D1 migrations, R2 binding |
| `packages/shared` | Wire-protocol types and Zod schemas used by both app and server      |
| `docs/`           | Architecture, setup and release documentation                        |

pnpm workspaces with `nodeLinker: hoisted`. React Native native-module autolinking
and several RN libraries still assume a flat `node_modules`.

## Mobile app

- **Routing:** Expo Router, file-based, under `apps/mobile/src/app`. Only route files
  live there; components, hooks and logic live elsewhere in `src/`.
- **Styling:** NativeWind v4 (Tailwind v3). All colours are semantic tokens defined
  once in `src/theme/tokens.ts`. Tailwind reads them as CSS variables, and
  `ThemeProvider` swaps the variable set for light or dark mode. Components use
  `bg-surface` or `text-text-secondary`, never raw hex values. A unit test enforces WCAG
  contrast ratios for every foreground/background pairing.
- **State:**
  - Zustand for UI and session state.
  - Expo SQLite as the local message store and offline source of truth (Phase 4).
  - `expo-sqlite/kv-store` for non-sensitive preferences.
  - `expo-secure-store` (Keychain / Android Keystore) for anything secret:
    refresh tokens and device private keys.
- **Networking:** `src/lib/api.ts` is the only HTTP entry point. It applies timeouts,
  validates every response with a Zod schema from `@koode/shared` and normalises
  failures into `ApiClientError` with a stable `code`.
- **Animated views and styling:** never put `className` on Reanimated's
  `Animated.View`. NativeWind drops its static styles once an animated style is
  attached. Use `MotionView` / `MotionPressable` from `components/ui/MotionView`,
  which take the animated style in a separate `animatedStyle` prop.
- **Native code:** Continuous Native Generation. `ios/` and `android/` are generated
  by `expo prebuild` and are never committed. Native behaviour comes from config
  plugins. LiveKit, CallKit and PushKit need a **development build**; Expo Go cannot
  run this app once Phase 5 lands.
- **Build variants:** `APP_VARIANT` (development / preview / production) selects the
  app name and bundle identifier, so all three install side by side.

## Backend

- **Worker (Hono):**
  - Versioned REST API under `/v1`; `/health` is unversioned for probes.
  - Middleware: request IDs, security headers, `Cache-Control: no-store`, and
    structured logs that record the path only (never query strings, headers or bodies).
  - Errors always use the shared `ApiErrorBody` shape. Internal error details are
    logged but never returned.
- **D1:** relational data. Migrations live in `apps/server/migrations`, are numbered,
  and are applied with `wrangler d1 migrations apply`. Conventions:
  - IDs are opaque server-generated strings.
  - Timestamps are epoch milliseconds.
  - Secrets (invite codes, refresh tokens, recovery keys) are stored only as SHA-256
    hashes. These are high-entropy random values, so a fast hash is appropriate.
- **Durable Objects:** one `ConversationRoom` per conversation (SQLite-backed, using
  the WebSocket Hibernation API). It is the single writer for a conversation's message
  sequence, so ordering is strict without cross-request locking.
- **R2:** one private bucket. Clients never receive bucket credentials. Uploads and
  downloads go through Worker routes that check membership first, either streaming
  the object or issuing short-lived signed URLs.

## Identity and authentication (implemented, Phase 3)

No email address, phone number or password is collected. The API is documented in
[API.md](API.md).

1. **Invites:**
   - A member creates an invite; the server returns a 12-character Crockford base32
     code (60 bits) once and stores only its SHA-256 hash.
   - Each code is single use and expires within 1–30 days (default 7). A person can
     have at most 10 open invites.
   - The bootstrap invite comes from `invite:create`; its account becomes `admin`.
2. **Device keys:**
   - On sign-up or recovery, the phone generates an Ed25519 key pair with
     `@noble/curves` (audited), seeded from `expo-crypto`.
   - The private key stays in SecureStore (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`, never
     backed up). The server stores only the public key.
3. **Proof of key possession:**
   - Every register, login and recover request signs a server-issued challenge.
   - Challenges are single use (consumed atomically in D1), expire after 2 minutes,
     and are bound to their purpose and subject. The signed text is
     `koode-auth-v1\n<purpose>\n<nonce>\n<public key or device id>`.
   - The Worker verifies signatures with WebCrypto Ed25519.
4. **Sessions:**
   - A 15-minute HS256 access token (algorithm pinned on verify).
   - A rotating 256-bit refresh token, stored hashed, with a 30-day idle and 180-day
     absolute lifetime.
   - One live session per device.
   - The auth middleware re-checks session, device and account state on every
     request, so revocation is immediate.
   - Presenting an already-rotated refresh token revokes the session. The app then
     signs in again silently with its device key.
5. **Recovery:**
   - The 120-bit recovery key is generated on the phone and stored server-side as a
     hash.
   - Username plus key enrols a new device. Wrong-key and unknown-user responses are
     identical, and attempts are rate-limited per IP and per username.
   - Recovery can't restore end-to-end-encrypted history (once that exists).
   - The key can be rotated in Settings.
6. **Devices:**
   - List, rename and remove your own devices. Other accounts' devices return 404.
   - **Signing out removes the device**: its key can't sign in again without the
     recovery key.
7. **Abuse protection:**
   - Auth and preview routes are rate-limited with fixed windows in D1, keyed by an
     HMAC of the client IP (raw IPs are never stored).
   - All bodies are validated by the shared Zod schemas, and error messages never
     echo input.
   - Names reject control and bidi-override characters.
8. **Audit:** registrations, logins, recoveries, refresh-token reuse, device and
   invite changes are recorded without any secrets.
9. **Planned:** linking a new device from an existing one (QR).

## Messaging (implemented, Phase 4)

```
app ──HTTP POST /messages──► Worker ──RPC──► ConversationRoom DO ──► D1 (messages, last_seq)
                                                   │ fan-out (RPC)
app ◄──WebSocket events──── UserSocket DO ◄────────┘   (one per user; all their devices)
```

- **Durable Objects:**
  - **`ConversationRoom`** (one per conversation) is the single writer for the
    conversation's `seq`. The counter is incremented synchronously in memory, so
    concurrent sends can't collide. It persists to D1 and fans out messages, receipts
    and typing.
  - **`UserSocket`** (one per user) holds every device's WebSocket using the
    Hibernation API. Heartbeats are auto-answered without waking it. When a device
    signs out or is removed, its socket is closed (code 4001).
- **Sending:**
  - Sends go over HTTP (`POST /v1/conversations/:id/messages`), so the response is the
    acknowledgement.
  - The client-generated UUID makes retries idempotent; reusing an id elsewhere returns 409.
- **Receiving:** live events (`message`, `receipt`, `typing`, `conversation`) arrive
  over `GET /v1/realtime`. The upgrade authenticates with the normal
  `Authorization: Bearer` header (React Native supports headers on WebSockets), so no
  token is ever put in a URL. This replaced the planned single-use tickets.
- **Receipts:**
  - `delivered` and `read` positions per member only move forward and are capped at the
    last message.
  - With **Read Receipts** off, your real read position still drives unread counts, but
    the one shown to others (`shared_read_seq`) stops advancing.
  - The setting is reciprocal: with yours off, you don't see others' read ticks either.
- **App engine (`features/messaging`):**
  - SQLite cache, so chats open instantly and are readable offline.
  - Offline outbox: sends are shown immediately and delivered in order once connected.
    Permanent rejections show as failed; tap to retry.
  - Reconnection with exponential backoff (1 s → 30 s, with jitter).
  - A 25 s heartbeat with a 10 s pong timeout catches silently dead connections, such
    as after a network switch. Foregrounding the app reconnects immediately.
  - After reconnecting it catches up: the conversation list, then `after=<max seq>`
    per chat.
  - History: the newest 50 messages for a new chat, then older pages on scroll.
  - Delivered and read receipts are batched (400 ms); typing sends are throttled (3 s),
    and incoming typing indicators expire after 5 s.
- **Directory:** `GET /v1/users` lists every active member of the instance (it's
  invite-only), with public profile fields only.
- **Not yet server-side (Phase 7):** reactions, deleting messages, pin and mute (kept
  on the device), media, and group administration. Groups can already be created and
  used for messaging.
- **End-to-end encryption (Phase 8):** message bodies are plaintext in D1 and the cache
  today. Each message row carries an `encryption` column, and Phase 8 adds per-device
  ciphertext envelopes. Until then, the server can read messages.

## Calling (implemented, Phase 5)

One-to-one voice and video calls. Group calls are not in scope yet.

- **Call records:** D1 `calls` (migration 0004). The call id is also the LiveKit room
  name. States: `ringing → active → ended`, or `declined`, `cancelled`, `missed`.
  A ringing call that nobody answers within `RING_TIMEOUT_MS` (45 s) becomes `missed`.
  Expiry is lazy: it is applied whenever calls are read or started, so no cron is
  needed.
- **Who may do what:**
  - Only the callee can accept or decline.
  - Either participant can end.
  - Busy users (with another ringing or active call) get `409`.
  - Non-participants get `404`.
  - All transitions are conditional `UPDATE … WHERE state IN (…)`, so races (accept
    vs. cancel) resolve to exactly one outcome.
- **Tokens:**
  - `lib/livekit.ts` mints a LiveKit access token on the Worker only when a call is
    started, accepted or rejoined.
  - The token is scoped to that one room and the user's own identity, and is valid
    for 10 minutes (only for joining).
  - It may publish only the microphone and camera; data messages and metadata changes
    are disabled.
  - `LIVEKIT_API_SECRET` never leaves the Worker. The app receives `{url, token}`.
- **Signalling:** every state change is pushed to both users' devices over the
  existing WebSocket as `{type:'call', call}`. There is no separate signalling server.
  Background and killed-app delivery needs PushKit/CallKit and FCM (Phase 6). Until
  then, **incoming calls only ring while the app is open.**
- **App:**
  - `features/calls/controller.ts` is a framework-free state machine:
    `idle → outgoing | incoming → connecting → connected ⇄ reconnecting → ended`.
  - It is driven by API results, realtime events and a `MediaSession`.
  - `media.ts` implements `MediaSession` with `livekit-client` + `@livekit/react-native`
    (WebRTC), including iOS/Android audio routing.
  - Tests use a fake session.
  - The caller joins the room while ringing, so media starts as soon as the callee
    joins.
  - A second incoming call while busy is declined automatically.
  - `CallRouter` (root layout) opens the incoming-call screen.
- **Native:**
  - Config plugins `@livekit/react-native-expo-plugin` and
    `@config-plugins/react-native-webrtc` add camera and microphone usage strings.
  - `UIBackgroundModes: audio` keeps a call's audio alive in the background.
- **Encryption:** media is protected by DTLS-SRTP between each device and the LiveKit
  server, **not end to end**: the LiveKit server can access the media. Phase 8 adds
  LiveKit E2EE (frame encryption through `RNE2EEManager`) with the room key
  distributed over the E2EE messaging channel, never in the token.
- **Hosting:** development uses a local `livekit-server --dev` (no account, no cost).
  LiveKit Cloud or a self-hosted server for real use is **pending your approval**.

## Notifications (planned, Phase 6)

Ordinary push notifications **cannot** reliably deliver incoming calls in the
background.

- **iOS:**
  - Calls use PushKit VoIP pushes. The app must report every VoIP push to CallKit
    immediately, or iOS will terminate it and stop delivering VoIP pushes.
  - Messages use standard APNs alerts. Once encryption lands, a Notification Service
    Extension either decrypts the preview or shows a generic "New message".
- **Android:** FCM high-priority data messages, plus a self-managed `ConnectionService`
  or a full-screen-intent notification for incoming calls.
- **Native modules:** both platforms need native modules and config plugins, so this
  work requires development builds and a paid Apple Developer account.
- **Open risk:** APNs requires HTTP/2. Whether Worker `fetch` reaches APNs reliably is
  unverified. Fallback: a tiny push relay. Test this first in Phase 6.

## End-to-end encryption (planned, Phase 8)

**Rules:**

- Never invent cryptography.
- Use an established, reviewed protocol and library.
- Do not claim E2EE until messages, attachments and call media have been verified.
- **Until Phase 8 is complete, traffic is protected by TLS only. The server can read
  message contents, so do not use the app for sensitive conversations.**

| Candidate          | Protocol        | Licence    | RN integration                                        | Notes                                                                 |
| ------------------ | --------------- | ---------- | ----------------------------------------------------- | --------------------------------------------------------------------- |
| vodozemac (Matrix) | Olm / Megolm    | Apache-2.0 | Custom Expo module over its Swift/Kotlin bindings     | Audited (2022); used in production by Element X                       |
| libsignal          | Signal protocol | AGPL-3.0   | Custom Expo module over official Swift/Java libraries | Gold-standard protocol; maintainers do not support use outside Signal |
| OpenMLS            | MLS (RFC 9420)  | MIT        | Custom Expo module via UniFFI                         | Best fit for groups; least mature mobile tooling                      |

Phase 8 starts with a time-boxed spike that builds a minimal native module around the
leading candidate. Evaluation criteria:

- audit status
- licence compatibility
- binding maintenance burden
- group support
- multi-device support

Attachments will be encrypted client-side with a random per-file key; that key travels
inside the E2EE message, and R2 stores only ciphertext. Call media uses LiveKit E2EE
with keys distributed over the encrypted channel.

Even with E2EE, the server will still see metadata: who talks to whom, when, and how
much.

## Security baseline

Implemented in Phase 1:

- No CORS. Browsers on other origins are denied by the same-origin policy.
- Security headers (HSTS, `nosniff` and others) and `no-store` on every response.
- Logs record the path only, never query strings, headers or bodies.
- Typed errors that never leak internals to the client.
- Release builds reject a non-HTTPS API URL.
- Secrets are never placed in `EXPO_PUBLIC_*` variables, because those are embedded in
  the app bundle.
- Secret files (`.env*`, `.dev.vars*`, signing keys, Firebase configs) are gitignored.

Planned:

- Zod validation of every request body.
- Per-user and per-IP rate limiting (Durable Object counters or the Workers Rate
  Limiting binding).
- Authorization checks on every conversation and media route.
- An audit log of security events (never message content).
- Session expiry and remote device revocation.

## Privacy

- No ads, analytics SDKs or third-party trackers.
- No email or phone number required.
- Only the data needed to deliver messages is kept.
- Expo's own SDK does not collect analytics in app builds.

## Services and cost (nothing is deployed without approval)

| Service                      | Needed for                     | Cost notes                                                                   |
| ---------------------------- | ------------------------------ | ---------------------------------------------------------------------------- |
| Cloudflare Workers / D1 / DO | API, real-time, storage        | Local development is free (Miniflare). Free plan likely enough for a family. |
| Cloudflare R2                | Media                          | Free tier; enabling R2 requires a payment method on the account              |
| Apple Developer Program      | Push, VoIP, TestFlight         | US$99/year; required from Phase 6                                            |
| Expo EAS Build               | Android APK, iOS device builds | Free tier has a monthly build quota                                          |
| Firebase Cloud Messaging     | Android push                   | Free                                                                         |
| LiveKit Cloud (or self-host) | Voice and video                | Free tier available; self-hosting needs a server. Local dev server is free.  |

## Known risks

1. **Seven-day target:** 10 phases including real E2EE in seven days is very
   aggressive. E2EE (Phase 8) is the most likely to overrun and must not be rushed.
2. **No Android hardware or emulator:** Android can only be verified through EAS
   cloud builds plus a device you borrow. Android behaviour will be marked untested
   until then.
3. **VoIP on iOS:** needs a paid developer account, a real device (the Simulator has
   no PushKit) and correct CallKit handling.
4. **APNs from Workers:** HTTP/2 reachability is unverified (see Notifications).
5. **iOS 27 scene life cycle:** Expo SDK 57's template doesn't adopt UIScene, which
   iOS 27 requires. A local config plugin (`plugins/withSceneLifecycle.js`) adopts it
   using Expo's own `ExpoAppSceneDelegate`. It is verified on the iOS 27 Simulator.
   Remove it when upgrading to Expo SDK 58.
