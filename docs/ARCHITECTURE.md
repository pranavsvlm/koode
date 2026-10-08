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

## Identity and authentication (planned, Phase 3)

The design collects no email address or phone number.

1. **Invites:**
   - An existing member creates an invite. The server returns a random code once and
     stores only its hash, an expiry and a use limit.
   - The very first account uses a bootstrap invite created with a CLI script.
2. **Device keys:**
   - On registration, the device generates an Ed25519 signing key pair with an audited
     library (`@noble/curves`).
   - The private key goes into SecureStore; the server stores only the public key.
3. **Login:** challenge–response. The server issues a nonce, the device signs it, and
   the server verifies the signature with WebCrypto Ed25519. No passwords exist to phish
   or reuse.
4. **Sessions:**
   - Short-lived access token: a 15-minute HMAC-signed JWT.
   - Rotating opaque refresh token: hashed in D1, 30-day expiry.
   - Presenting an already-rotated refresh token revokes the whole session (reuse
     detection).
5. **Recovery:**
   - Registration shows a high-entropy recovery key once. It lets the user enrol a new
     device and revoke lost ones.
   - Like Signal, recovering an account cannot recover end-to-end-encrypted history.
6. **Device management:** list devices, rename them, and revoke any device (which
   revokes its sessions).
7. **WebSocket auth:** the app exchanges its access token for a single-use, 30-second
   connection ticket. The token never appears in a URL, because URLs can end up in
   platform request logs.

## Messaging (planned, Phase 4)

- **Message IDs:** the client generates a ULID for each message, which makes retries
  idempotent. The conversation's Durable Object assigns a monotonically increasing
  `seq`.
- **Delivery states:** `sending → sent` (server ack with `seq`), then `delivered` and
  `read` from recipient receipts. Typing indicators are ephemeral and never persisted.
- **Sync:** on (re)connect the client sends its last `seq` per conversation, and the
  server replays newer messages. History pagination is keyset-based on `seq`.
- **Reconnects:** exponential backoff with jitter. Network-change and foreground events
  trigger an immediate reconnect.
- **E2EE readiness:** messages are stored and relayed as opaque envelopes with an
  `encryption` field (`none` until Phase 8) and are addressed per recipient device.
  Phase 8 can then add encryption without redesigning the delivery path.

## Calling (planned, Phase 5)

- **Media:** LiveKit carries voice and video over WebRTC. Each call is a LiveKit room.
- **Tokens:** the Worker mints a room-scoped access token, valid for a few minutes and
  only for call participants. The LiveKit API secret stays on the Worker.
- **Signalling:** ring, accept, decline and end travel over the existing WebSocket
  plus push (Phase 6).
- **Encryption:** LiveKit supports E2EE on React Native through its `RNE2EEManager`.
  In Phase 8 the room key is distributed over the E2EE messaging channel rather than
  in the token.
- **Hosting:** LiveKit Cloud (has a free tier; needs your approval) or self-hosted.
  This decision is pending.

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
| LiveKit Cloud (or self-host) | Voice and video                | Free tier available; self-hosting needs a server                             |

## Known risks

1. **Seven-day target:** 10 phases including real E2EE in seven days is very
   aggressive. E2EE (Phase 8) is the most likely to overrun and must not be rushed.
2. **No Android hardware or emulator:** Android can only be verified through EAS
   cloud builds plus a device you borrow. Android behaviour will be marked untested
   until then.
3. **VoIP on iOS:** needs a paid developer account, a real device (the Simulator has
   no PushKit) and correct CallKit handling.
4. **APNs from Workers:** HTTP/2 reachability is unverified (see Notifications).
