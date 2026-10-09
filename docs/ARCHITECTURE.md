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
│ LiveKit SFU  │        │ push relay ─► APNs   │
│ (voice/video)│        │ (alert + VoIP)       │
└──────────────┘        │ FCM (Android)        │
                        └──────────────────────┘
```

## Repository layout

| Path                              | Purpose                                                              |
| --------------------------------- | -------------------------------------------------------------------- |
| `apps/mobile`                     | Expo SDK 57 app (iOS + Android), Expo Router, NativeWind, Zustand    |
| `apps/server`                     | Cloudflare Worker (Hono), Durable Objects, D1 migrations, R2 binding |
| `apps/push-relay`                 | Node HTTP/2 relay to APNs (holds the APNs key; Worker fetch can't)   |
| `apps/mobile/modules/koode-calls` | Local Expo module (Swift): PushKit + CallKit for incoming calls      |
| `packages/shared`                 | Wire-protocol types and Zod schemas used by both app and server      |
| `docs/`                           | Architecture, setup and release documentation                        |

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
     HMAC of the client IP (raw IPs are never stored). Since Phase 8, sending
     messages, creating uploads, starting calls and fetching key bundles are also
     limited per user.
   - All bodies are validated by the shared Zod schemas, and error messages never
     echo input. JSON bodies are capped by what is actually read (16 KB by default;
     512 KB for key uploads, 4 MB for message sends, 256 KB for calls).
   - Names reject control and bidi-override characters.
8. **Audit:** registrations, logins, recoveries, refresh-token reuse, device and
   invite changes, key publication, refused identity-key changes, group changes and
   moderator deletions are recorded without any secrets or message content.
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
  - After reconnecting it catches up: the conversation list, then
    `changedSince=<max revision>` per chat, which returns new messages _and_ edits
    (reactions, deletions). See Media and groups.
  - History: the newest 50 messages for a new chat, then older pages on scroll.
  - Delivered and read receipts are batched (400 ms); typing sends are throttled (3 s),
    and incoming typing indicators expire after 5 s.
- **Directory:** `GET /v1/users` lists every active member of the instance (it's
  invite-only), with public profile fields only.
- **Device-only:** pin, mute and "delete for me".
- **End-to-end encryption:** since Phase 8 the server stores and relays only
  per-device ciphertext envelopes; see "End-to-end encryption" below. Rows from
  before Phase 8 keep `encryption = 'none'`.

## Media and groups (implemented, Phase 7)

### Attachments

```
app ── POST /conversations/:id/attachments {kind, type, size, …} ──► Worker: attachment row (unsent)
app ── PUT /attachments/:id/content (+ /thumbnail for videos) ─────► Worker ──stream──► R2 (private)
app ── POST /conversations/:id/messages {id, attachmentId} ────────► ConversationRoom: binds it
member ── GET /attachments/:id/content (Range) ◄────────────────── Worker ◄── R2
```

- **Storage:**
  - Files live in the **private** R2 bucket under `att/<conversation>/<attachment>`;
    nothing is public and there are no pre-signed URLs.
  - Every read and write goes through the Worker with the caller's access token.
  - A file is readable by the **current members** of its conversation once sent, and
    by its uploader before that. Everyone else gets 404, including people removed
    from the group.
- **Upload limits:**
  - Per kind (`ATTACHMENT_LIMITS`): photos 20 MB, videos and documents 100 MB (the
    Worker request limit), voice 15 MB. Video posters (JPEG) are 512 KB.
  - Allowed types: photos JPEG/PNG/HEIC/WebP/GIF; video MP4/QuickTime; voice
    AAC/M4A/MP3; documents any type.
  - Uploads must send `Content-Length` equal to the declared size; R2 confirms the
    stored size.
- **Serving:**
  - Documents (and anything not on the inline list) are served as
    `application/octet-stream` with `Content-Disposition: attachment`,
    `X-Content-Type-Options: nosniff` and a `sandbox` CSP, so a file can never render
    as a page.
  - Byte ranges are supported (video players need them).
- **Lifecycle:**
  - An attachment can be sent once, by its uploader, in its conversation.
  - Uploads never sent are deleted after 24 h by an hourly cron (`scheduled` handler).
  - Deleting a message deletes its files.
- **App, sending:**
  - Photos are re-encoded as JPEG (longest side ≤ 2048), which **drops EXIF metadata
    such as GPS location** (verified on the Simulator).
  - Videos get a poster (first frame) and posters/photos a tiny inline preview
    (≤ 6 KB base64), so bubbles have something to show immediately.
  - Files are copied into `Documents/outbox`. The outbox remembers each step (create
    → poster → upload → send) on the pending message, so a send resumes after a
    restart, and an upload that expired on the server starts again.
  - Upload progress shows in the bubble.
- **App, receiving:**
  - Files download with the user's token into `Caches/media/<attachment id>`, once
    (concurrent requests are deduplicated) and only when needed: images, posters and
    voice when shown; videos and documents when opened.
  - The sender's own copy moves from the outbox into the cache, so it's never
    downloaded again.
  - Sign-out deletes both directories.
- **Voice messages:** recorded with expo-audio (mono AAC, 64 kbps, up to 15 min) with
  a 64-point waveform from metering; played with expo-audio.
- **Opening and saving:**
  - Videos play in the full-screen viewer (expo-video) after downloading.
  - Documents open through the share sheet ("Open in…", "Save to Files") under their
    real name.
  - "Save to Photos" asks for add-only photo access.

### Reactions and deletion

- **Reactions:** one per person per message, set or removed through the
  `ConversationRoom`. They show at once in the app and are reverted if the server
  refuses.
- **Delete for everyone:** the sender, or a group admin. It erases the text, the
  file and the reactions, and the message stays as a "Message deleted" marker.
  "Delete for me" hides it on this device only.
- **Revisions:**
  - Every change to a message (sent, reacted to, deleted) gives it the
    conversation's next revision (`rev`), assigned by the `ConversationRoom` like
    `seq`.
  - Catch-up asks for `changedSince=<max rev>`, so devices that were offline get
    edits too.
  - Changes to old messages that aren't loaded are skipped (they arrive current when
    scrolled to), which keeps history gap-free.
  - A stale copy can never overwrite a newer one.

### Group administration

- **Who can do what:**
  - Admins can rename, add people (up to 64 members), remove people, and make or
    remove admins.
  - Anyone can leave.
  - A group always keeps an admin: if the last one leaves, the longest-standing
    member is promoted, and a group can't demote its last admin.
- **System messages:** each change is a `system` message ("Maya added Dan") in the
  conversation. It is not unread and never pushed.
- **People added:** they start reading from the current position (earlier history
  isn't marked unread).
- **People removed or leaving:** they get a `conversation` event; the app then gets
  404 and removes the chat and its messages from the device.

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
- **Encryption:** DTLS-SRTP to the LiveKit server, plus **end-to-end frame
  encryption** (Phase 8): every audio and video frame is encrypted with the call's
  media key, which travels only in Signal envelopes. The SFU forwards ciphertext. See
  "End-to-end encryption" below.
- **Hosting:** development uses a local `livekit-server --dev` (no account, no cost).
  LiveKit Cloud or a self-hosted server for real use is **pending your approval**.

## Notifications (implemented, Phase 6)

Ordinary push notifications **cannot** reliably ring incoming calls in the
background, so calls use the platforms' calling channels.

### Flow

```
Worker ──► push/dispatch.ts ──┬─► push relay (HTTP/2) ──► APNs ──► iPhone
  (messages: ConversationRoom)│     holds the .p8 key        alert pushes → Notification Center
  (calls: calls/events.ts,    │                              VoIP pushes  → PushKit → CallKit
   CallTimer alarm)           └─► FCM HTTP v1 ─────────────► Android (data messages)
```

- **Why a relay:**
  - APNs only accepts HTTP/2. Worker `fetch` doesn't negotiate it: from local
    workerd it fails with "Network connection lost", while `curl --http2` gets
    APNs' normal 403.
  - `apps/push-relay` is a small Node service. It holds the APNs signing key
    (ES256 provider tokens via `jose`, refreshed every 40 minutes) and keeps one
    HTTP/2 connection per APNs host.
  - The Worker authenticates to it with a shared bearer secret and never sees the
    Apple key.
  - In development the relay runs in **simulator mode**: alert pushes go to a booted
    Simulator through `xcrun simctl push`, and VoIP pushes are dropped (the
    Simulator has no PushKit).
- **FCM:** called directly from the Worker (HTTP/1.1 is fine). It authenticates with
  a Google service account (OAuth 2.0 JWT-bearer grant, RS256 via `jose`).
- **Registration:**
  - Each device registers with `PUT /v1/push`, sending its alert token (APNs/FCM),
    its PushKit token (iOS) and its notification settings.
  - The server enforces those settings when sending: direct messages, groups,
    calls. (`previews` is still accepted; the server can't read encrypted messages,
    so it no longer changes anything.)
  - A token belongs to one phone. Registering it moves it off any older device
    (e.g. a previous account on the same phone).
  - Sign-out and device removal delete the registration.
  - Tokens that APNs/FCM reject as dead (`410`, `BadDeviceToken`, `UNREGISTERED`)
    are forgotten.

### What is sent

| Event              | iOS                                                                                            | Android (data message, rendered by expo-notifications)       |
| ------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Message            | Alert: sender (or group), text or "New message", badge = unread, thread = conversation         | `messages` channel, tag = conversation                       |
| Call rings         | **VoIP push → CallKit**. Without a PushKit token (the Simulator), an alert with Answer/Decline | `calls` channel (max importance), Answer/Decline, tag = call |
| Call stops ringing | VoIP "call-ended" (CallKit ends it)                                                            | Silent data; the background task removes the notification    |
| Nobody answered    | Alert "Missed … call", Call Back                                                               | `missed-calls` channel, replaces the ringing notification    |

- **Missed calls:** a per-call `CallTimer` Durable Object alarm marks unanswered calls
  `missed` at the 45 s timeout and sends the missed-call push, even if the caller's
  app vanished. The lazy sweep stays as a backstop, with a 15 s grace period.
- **Payload privacy:** the custom data (`PushData`) never contains message text, only
  ids. Message alerts say "New message" from the sender or group: the server can't
  read encrypted messages, and reactions are never pushed. Showing text would need a
  Notification Service Extension that decrypts on the device (not built).

### iOS calling (PushKit + CallKit)

- **Native module:** the local Expo module `modules/koode-calls` (Swift).
  - An app-delegate subscriber registers PushKit at launch, so a VoIP push that
    wakes a killed app is handled before JavaScript exists.
  - Every VoIP push is reported to CallKit before the push callback returns (an
    Apple requirement). Unknown or stale pushes are reported and immediately
    ended.
  - A local 50 s safety timeout ends ringing calls whose "stop" push was lost.
  - Calls stay out of the Phone app's Recents.
- **Answering and ending:** CallKit actions (answer, end, mute) are queued until
  JavaScript listens, then drive the call controller (`features/calls/callkit.ts`).
  The controller's state ends or updates the CallKit call.
- **Audio:** CallKit activates the audio session; WebRTC is told through
  `LKRTCAudioSession.audioSessionDidActivate/Deactivate`.
- **In-app screen:** while the app is open, the in-app ringing screen gives CallKit
  1.5 s to claim the call before showing itself.
- **Keychain:** answering from the lock screen needs the session while the phone is
  locked. Keychain items are therefore "after first unlock, this device only"
  (migrated once from "when unlocked").
- **Outgoing calls:** not reported to CallKit yet (in-app only).
- **Simulator limitation:** the Simulator can't show CallKit's incoming-call UI; iOS
  ends such calls at once (`facetime://` launch fails). PushKit is therefore not
  registered on the Simulator, and the server falls back to an alert.

### Android

- **How it rings:** FCM high-priority data messages. expo-notifications renders them
  on our channels with Answer/Decline buttons.
- **Background task:** a headless task (defined at the app entry, `index.ts`) handles
  Decline and "stop ringing" while the app is closed.
- **Not yet built:**
  - A full-screen incoming-call UI (`CallStyle` / full-screen intent or a
    self-managed `ConnectionService`).
  - All Android push behaviour is untested (no device or emulator; see Known risks).

## End-to-end encryption (Phase 8)

**Rules:**

- Never invent cryptography.
- Do not call Koode end-to-end encrypted until messages, attachments and call media
  have been verified.

### Library

- **libsignal v0.103.0** (Signal's own implementation), chosen by the project owner:
  - Protocol: PQXDH key agreement (X25519 + ML-KEM/Kyber), Double Ratchet
    sessions, numeric safety-number fingerprints, and AES-256-GCM for attachments.
  - Licence: AGPL-3.0. Koode's source must be offered to its users.
  - Signal doesn't support use of libsignal outside its own apps; Koode pins a
    release and updates deliberately.
- **Packaging:**
  - iOS uses Signal's CocoaPod with its verified prebuilt FFI archive (no Rust
    toolchain).
  - Android uses Signal's Maven repository.
  - The test peer uses `@signalapp/libsignal-client` on Node, so interoperability
    is tested against a second implementation.

### Model

- **Addresses:** each device is its own Signal address: `(userId, deviceId)`, where
  `deviceId` is a small number per account. Each device has its own identity key,
  and private keys never leave the device. A new device (recovery) is a new address
  with a new identity.
- **Key directory (server):**
  - Each device publishes its identity key, registration id, a signed prekey, a
    last-resort Kyber prekey, and batches of one-time EC and Kyber prekeys.
  - Fetching a person's bundles hands out (and deletes) one one-time key per device.
  - An identity key can never change for a device.
- **Sessions:**
  - Messages are encrypted separately to every device of every member (pairwise
    "client fan-out", how Signal handled small groups), including the sender's own
    other devices.
  - Removing someone from a group therefore excludes them from the next message
    immediately; there are no group keys to rotate.
  - The server rejects a send that doesn't cover exactly the current devices (409
    with the missing/extra lists); the client refreshes and retries.
- **Encrypted payload:** text, reply reference, reactions (sent as their own
  encrypted messages) and all attachment metadata (type, name, size, dimensions,
  duration, waveform, preview) plus the file key and digest.
- **Attachments:** each file is encrypted on the device with a random 256-bit key
  (AES-256-GCM via libsignal), and the SHA-256 of the ciphertext is checked before
  decrypting. R2 holds only ciphertext, of kind `encrypted`. Video posters are
  encrypted with their own key.
- **Calls:** the caller picks a random 32-byte key per call and sends it to exactly
  the callee's devices as Signal envelopes with the call request (the caller
  chooses the call id, so the encrypted key can name its call). The answering
  device receives its envelope from `accept`. LiveKit end-to-end encryption (frame
  encryption with a shared key, PBKDF2-derived AES-GCM) uses it, so the SFU
  forwards ciphertext only. There's no unencrypted fallback: without a key, the
  call fails.
- **Notifications:** pushes can't contain message text any more; the server doesn't
  have it. They say "New message" from the sender or group.
- **Trust:**
  - Trust on first use per device.
  - A changed identity key on a known device is refused and shown as a warning
    (that should never happen legitimately).
  - Safety numbers (60 digits per device pair) can be compared in person and
    marked verified. A verified contact who adds a device or whose key changes gets
    a "safety number changed" notice.
- **Storage on the device:**
  - Identity, prekeys and sessions are in the Keychain (iOS: after first unlock,
    this device only).
  - Decrypted messages are cached in the app's SQLite database and files, under
    the platform's data protection.

### Implementation

- **Native module** (`modules/koode-signal`, iOS only for now): libsignal's stores
  live in the Keychain; protocol calls run on one serial queue; file encryption runs
  apart. The plaintext of a message crosses the bridge as UTF-8 text.
- **Device crypto** (`src/features/crypto`):
  - **Keys:** a new server device starts from a fresh identity; nothing from an
    earlier sign-in carries over, because Keychain items can survive reinstalls. It
    publishes a signed prekey, a last-resort Kyber key, and 100 one-time EC and
    Kyber prekeys each.
  - **Top-ups and rotation:** one-time keys are topped up below 25 (after PreKey
    messages arrive, and at start), with ids never reused. The signed prekey
    rotates monthly.
  - **Lost keys:** if the server has keys this Keychain doesn't, the app stops
    with "keys lost"; the only fix is signing out and in.
  - **Sessions and devices:** sessions start from bundles only where none exists.
    Device lists are cached for 10 minutes and dropped on a 409.
- **Payload** (`Payload` in `packages/shared/src/keys.ts`, versioned JSON):
  - Message payloads name their own message id and conversation, and a reaction
    names its target. Receivers check them, so the server can't move ciphertext
    between messages or chats.
  - The call key names its call.
- **Server:**
  - **Key directory:** `/v1/keys` publishes, tops up, gives status, lists devices,
    and hands out bundles (one-time keys are consumed atomically).
  - **Device numbers:** `devices.signal_device_id` is 1, 2, 3 … per account and
    never reused.
  - **Sends:** checked for exact device coverage (409 with `{missing, extra}`).
  - **Storage:** `message_envelopes` and `call_envelopes`.
  - **Who gets what:** each member's realtime event carries only their devices'
    envelopes; history returns only the reading device's; conversation summaries
    carry none.
- **Engine:**
  - **Decrypting once:** each message is decrypted at most once. It checks memory,
    then the SQLite cache, before the ratchet. Arrivals are opened in order, and
    content already opened is never replaced.
  - **Unreadable messages:** they show as "couldn't be decrypted" (or "not
    available on this device" for messages from before this device existed).
  - **Reactions:** latest per person wins, applied to targets as they load.
  - **Sending:** encrypted per attempt; a 409 refreshes devices and membership and
    retries (3 attempts). A changed safety number fails the send rather than
    retrying.
- **Attachments:**
  - The app encrypts the processed file (and video poster) into the outbox before
    creating the upload. The server learns only the ciphertext size.
  - Downloads are digest-checked and decrypted into the cache. A partial or altered
    file is never cached.
- **Trust UI:** a contact's "Verify Safety Number" screen shows one 60-digit number
  per device. Marking verified records the device set; any later difference shows
  "Safety number changed".

### Verification status (Phase 8)

Interoperability was tested against Signal's Node implementation
(`scripts/e2ee-peer.mjs`, 17/17 checks):

- messages, photos and reactions in both directions;
- identical safety numbers;
- the call key;
- the app decrypting a Node peer's encrypted audio;
- a wrong-key listener getting no audio;
- the SFU reporting every track GCM-encrypted.

**Not verified:**

- the app → peer audio direction, because the Simulator's microphone is silent;
- Android, where the module isn't written;
- two physical devices;
- any independent security review.

### Still visible to the server

Who talks to whom and when; message sizes; group membership and titles; display
names and profiles; call times and
durations; IP addresses; ciphertext sizes (so roughly how long a message or file
is); which message a reaction is for (not the emoji). Messages sent before Phase 8
stay plaintext on the server (development data only). Ciphertext is kept with its
message until the message is deleted for everyone. The Double Ratchet's keys are
gone from the devices by then, so stored ciphertext can't be decrypted later even
by the recipients.

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

| Service                      | Needed for                     | Cost notes                                                                                                  |
| ---------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Cloudflare Workers / D1 / DO | API, real-time, storage        | Local development is free (Miniflare). Free plan likely enough for a family.                                |
| Cloudflare R2                | Media                          | Local development uses Miniflare's R2 (free). Enabling R2 on a Cloudflare account requires a payment method |
| Apple Developer Program      | Push, VoIP, TestFlight         | US$99/year; required from Phase 6                                                                           |
| Expo EAS Build               | Android APK, iOS device builds | Free tier has a monthly build quota                                                                         |
| Firebase Cloud Messaging     | Android push                   | Free (needs a Firebase project)                                                                             |
| Push relay hosting           | APNs over HTTP/2               | Any small always-on Node host; free tiers exist. Runs locally in development                                |
| LiveKit Cloud (or self-host) | Voice and video                | Free tier available; self-hosting needs a server. Local dev server is free.                                 |

## Known risks

1. **Seven-day target:** 10 phases including real E2EE in seven days is very
   aggressive. E2EE (Phase 8) is the most likely to overrun and must not be rushed.
2. **No Android hardware or emulator:** Android can only be verified through EAS
   cloud builds plus a device you borrow. Android behaviour will be marked untested
   until then.
3. **VoIP on iOS:** needs a paid developer account and a real device. The Simulator
   can't show CallKit calls, so answering through CallKit and its audio hand-off are
   unverified until then.
4. **APNs from Workers:** Worker `fetch` can't speak HTTP/2 (verified locally), so
   APNs goes through the push relay, which needs hosting before real use.
5. **iOS 27 scene life cycle:** Expo SDK 57's template doesn't adopt UIScene, which
   iOS 27 requires. A local config plugin (`plugins/withSceneLifecycle.js`) adopts it
   using Expo's own `ExpoAppSceneDelegate`. It is verified on the iOS 27 Simulator.
   Remove it when upgrading to Expo SDK 58.
