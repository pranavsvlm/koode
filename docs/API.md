# Koode API (v1)

Base URL: the Worker, for example `http://localhost:8787` in development.

- **Format:** all bodies are JSON. Schemas live in `packages/shared/src/auth.ts` and
  are used by both the app and the server.
- **Errors:** every error has the shape
  `{ "error": { "code", "message", "requestId" } }`. Codes: `bad_request`,
  `unauthorized`, `forbidden`, `not_found`, `conflict`, `rate_limited`, `internal`.
- **Auth column:** 🔒 means the route needs `Authorization: Bearer <access token>`.

## Auth

| Method | Path                          | Auth | Purpose                                                                               |
| ------ | ----------------------------- | ---- | ------------------------------------------------------------------------------------- |
| POST   | `/v1/auth/challenge`          |      | `{purpose}` → `{nonce, expiresAt}` (single use, 2 min)                                |
| GET    | `/v1/auth/username/:username` |      | `{available, reason?}`                                                                |
| POST   | `/v1/auth/register`           |      | Invite + profile + recovery key + device public key + signature → `AuthSession` (201) |
| POST   | `/v1/auth/login`              |      | `{deviceId, nonce, signature}` → `AuthSession`                                        |
| POST   | `/v1/auth/recover`            |      | Username + recovery key + new device key + signature → `AuthSession` (201)            |
| POST   | `/v1/auth/refresh`            |      | `{refreshToken}` → new `{accessToken, accessTokenExpiresAt, refreshToken}`            |
| POST   | `/v1/auth/logout`             | 🔒   | Removes this device and its session                                                   |

The signed message is
`koode-auth-v1\n<purpose>\n<nonce>\n<subject>`, where the subject is:

- the new public key, for `register` and `recover`;
- the device id, for `login`.

## Account

| Method | Path                  | Auth | Purpose                                    |
| ------ | --------------------- | ---- | ------------------------------------------ |
| GET    | `/v1/me`              | 🔒   | Your profile                               |
| PATCH  | `/v1/me`              | 🔒   | `{displayName?, about?}`                   |
| PUT    | `/v1/me/recovery-key` | 🔒   | `{recoveryKey}`: replaces the recovery key |
| GET    | `/v1/devices`         | 🔒   | Your active devices (with `current`)       |
| PATCH  | `/v1/devices/:id`     | 🔒   | `{name}`                                   |
| DELETE | `/v1/devices/:id`     | 🔒   | Remove a device (signs it out immediately) |

## Invites

| Method | Path                        | Auth | Purpose                                                                  |
| ------ | --------------------------- | ---- | ------------------------------------------------------------------------ |
| GET    | `/v1/invites/preview?code=` |      | `{inviterName, expiresAt}`, or 404 for any invalid, used or expired code |
| POST   | `/v1/invites`               | 🔒   | `{expiresInDays?}` → invite including `code` (shown once)                |
| GET    | `/v1/invites`               | 🔒   | Your open invites (codes are not retrievable)                            |
| DELETE | `/v1/invites/:id`           | 🔒   | Cancel an invite                                                         |

## Messaging

| Method | Path                                        | Auth | Purpose                                                                                                                                                                                                                                                                                                                           |
| ------ | ------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/users`                                 | 🔒   | Directory of other active members: `{id, username, displayName, about}`                                                                                                                                                                                                                                                           |
| GET    | `/v1/conversations`                         | 🔒   | Your conversations: members, receipt positions, last message, unread count                                                                                                                                                                                                                                                        |
| POST   | `/v1/conversations`                         | 🔒   | `{kind: 'direct', userId}` (returns the existing chat if there is one) or `{kind: 'group', title, memberIds}`                                                                                                                                                                                                                     |
| GET    | `/v1/conversations/:id`                     | 🔒   | One conversation (404 if you're not a member)                                                                                                                                                                                                                                                                                     |
| GET    | `/v1/conversations/:id/messages`            | 🔒   | `?before=<seq>` (default: newest), `?after=<seq>` or `?changedSince=<rev>` (new _and_ changed messages, by revision), plus `limit` (≤100) → `{messages, hasMore}`                                                                                                                                                                 |
| POST   | `/v1/conversations/:id/messages`            | 🔒   | `{id: <uuid v4>, kind: text \| attachment \| reaction, envelopes: [{userId, deviceId, type, body}], attachmentId?, targetId?}` → message (201). Ciphertext only; exactly one envelope per current device of every member except the sending one, else 409 with `details: {missing, extra}`. Idempotent per id. 120 / min per user |
| DELETE | `/v1/conversations/:id/messages/:messageId` | 🔒   | Delete for everyone (sender, or a group admin) → message with `deletedAt`, empty body, no attachment                                                                                                                                                                                                                              |
| PATCH  | `/v1/conversations/:id`                     | 🔒   | `{title}`: rename a group (admins)                                                                                                                                                                                                                                                                                                |
| POST   | `/v1/conversations/:id/members`             | 🔒   | `{userIds}`: add people (admins; up to 64 members)                                                                                                                                                                                                                                                                                |
| PATCH  | `/v1/conversations/:id/members/:userId`     | 🔒   | `{role: 'admin' \| 'member'}` (admins; never the last admin)                                                                                                                                                                                                                                                                      |
| DELETE | `/v1/conversations/:id/members/:userId`     | 🔒   | Remove someone (admins), or your own id to leave                                                                                                                                                                                                                                                                                  |
| POST   | `/v1/conversations/:id/receipts`            | 🔒   | `{delivered?, read?, shareRead = true}`                                                                                                                                                                                                                                                                                           |
| GET    | `/v1/realtime`                              | 🔒   | WebSocket upgrade (the bearer token goes in the `Authorization` header)                                                                                                                                                                                                                                                           |

A **message** is `{id, conversationId, encryption: 'signal' | 'none', seq, rev, senderId,
senderDevice, kind: 'text' | 'attachment' | 'reaction' | 'system', body, replyToId,
attachment, system, targetId, envelopes: [{deviceId, type, body}], deletedAt, createdAt}`.

- **Encrypted messages** (`encryption: 'signal'`) have an empty `body` and `replyToId`;
  their content is a `Payload` (see `packages/shared/src/keys.ts`) inside the
  envelopes. History returns only the reading device's envelope; realtime events
  carry the envelopes for all of the recipient's devices; summaries carry none.
- **Reactions** are encrypted messages of kind `reaction` with a `targetId`; they
  don't count as unread or as the last message, and aren't pushed.
- **Deletion** erases the envelopes, the file and reactions to it, leaving a marker.
- **Legacy:** messages from before Phase 8 have `encryption: 'none'` and plaintext
  `body`.
- `system` messages (`{action, actorId, targetIds, title}`) record group changes:
  `created`, `renamed`, `added`, `removed`, `left`, `promoted`, `demoted`.

## Keys (end-to-end encryption)

| Method | Path                          | Auth | Purpose                                                                                                                                                   |
| ------ | ----------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PUT    | `/v1/keys`                    | 🔒   | Publish this device's keys: `{registrationId, identityKey, signedPreKey, kyberPreKey (last resort), preKeys?, kyberPreKeys?}`. A different identity → 409 |
| POST   | `/v1/keys/one-time`           | 🔒   | Add one-time keys `{preKeys?, kyberPreKeys?}` (≤ 100 per call, ≤ 200 held of each)                                                                        |
| GET    | `/v1/keys/status`             | 🔒   | `{deviceId (Signal number), published, identityKey, preKeys, kyberPreKeys}`                                                                               |
| GET    | `/v1/keys/devices?userIds=…`  | 🔒   | Active devices with keys of up to 64 people → `{devices: [{userId, deviceId, identityKey}]}` (uses up nothing)                                            |
| GET    | `/v1/keys/:userId/:deviceId?` | 🔒   | Bundles for one or all of someone's devices; each takes one one-time EC and Kyber key (last-resort Kyber when none are left). 600 / hour per user         |

Keys are base64. Device numbers are 1, 2, 3 … per account and never reused.

## Attachments

| Method | Path                                | Auth | Purpose                                                                                                                              |
| ------ | ----------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------ |
| POST   | `/v1/conversations/:id/attachments` | 🔒   | Start an encrypted upload (members): exactly `{sizeBytes}` of the ciphertext → `{id, kind: 'encrypted', …}` (201). 60 / min per user |
| PUT    | `/v1/attachments/:id/content`       | 🔒   | The ciphertext (uploader, until sent). `Content-Length` must equal `sizeBytes`                                                       |
| PUT    | `/v1/attachments/:id/thumbnail`     | 🔒   | Encrypted video poster, `application/octet-stream` (uploader, until sent)                                                            |
| GET    | `/v1/attachments/:id/content`       | 🔒   | The ciphertext (members once sent, uploader before), always as an `octet-stream` download. `Range` supported                         |
| GET    | `/v1/attachments/:id/thumbnail`     | 🔒   | The encrypted poster                                                                                                                 |

Files are encrypted on the device (AES-256-GCM, libsignal's `nonce ‖ ciphertext ‖ tag`
layout). The key, the SHA-256 digest of the ciphertext and everything about the file
(type, name, size, dimensions, duration, waveform, preview) travel inside the
message's envelopes. The device validates files against the per-kind limits before
encrypting: image 20 MB, video and document 100 MB, voice 15 MB. Unsent uploads are
deleted after 24 hours.

## Calls

One-to-one calls. `media` is `{url, token}`: a LiveKit server URL and an access token
for that call's room only (10 minutes; may publish microphone and camera only).

| Method | Path                    | Auth | Purpose                                                                                                                                                                                                                                                                                                                 |
| ------ | ----------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/calls`             | 🔒   | Your last 100 calls, newest first → `{calls}`                                                                                                                                                                                                                                                                           |
| POST   | `/v1/calls`             | 🔒   | `{id: <uuid v4>, userId, kind: 'voice' \| 'video', envelopes}` → `{call (id cal_<uuid>), media, key: null}` (201). The envelopes carry the media key to exactly the callee's devices (409 with `{missing, extra}` otherwise). 400 calling yourself or someone without keys, 404 unknown, 409 busy. 20 / 10 min per user |
| GET    | `/v1/calls/:id`         | 🔒   | One call (404 unless you're a participant)                                                                                                                                                                                                                                                                              |
| POST   | `/v1/calls/:id/accept`  | 🔒   | Callee only (403 otherwise); ringing → active → `{call, media, key: {senderDevice, envelope}}` (the media key for this device). 409 if no longer ringing                                                                                                                                                                |
| POST   | `/v1/calls/:id/decline` | 🔒   | Callee only; ringing → declined                                                                                                                                                                                                                                                                                         |
| POST   | `/v1/calls/:id/end`     | 🔒   | Caller while ringing → cancelled (missed after the timeout); callee while ringing → declined; active → ended. Idempotent                                                                                                                                                                                                |
| POST   | `/v1/calls/:id/rejoin`  | 🔒   | New `media` for an active call you're in (e.g. after the app restarts)                                                                                                                                                                                                                                                  |

States: `ringing`, `active`, `ended`, `declined`, `cancelled`, `missed`. Unanswered
calls become `missed` after 45 seconds.

## Push notifications

| Method | Path       | Auth | Purpose                                                    |
| ------ | ---------- | ---- | ---------------------------------------------------------- |
| PUT    | `/v1/push` | 🔒   | Register this device for pushes (replaces any earlier one) |
| DELETE | `/v1/push` | 🔒   | Stop all pushes to this device                             |

`PUT` body:

```jsonc
// iOS
{ "platform": "ios", "appId": "com.navoasis.koode.dev", "environment": "sandbox",
  "alertToken": "<APNs hex> | null", "voipToken": "<PushKit hex> | null",
  "settings": { "directMessages": true, "groupMessages": true, "calls": true, "previews": true } }
// Android
{ "platform": "android", "appId": "com.navoasis.koode.dev", "alertToken": "<FCM token> | null",
  "settings": { … } }
```

- **Validation:** `appId` must be in the server's `PUSH_APP_IDS`, and `platform`
  must match the device.
- **Token ownership:** registering a token removes it from any other device.
- **Removal:** sign-out and device removal delete the registration.
- **Push data:** every push carries data (`content.data` in the app) of one of these
  shapes:
  - `{type:'message', conversationId, messageId}`
  - `{type:'call', callId, callerId, callerName, kind}`
  - `{type:'call-ended', callId}`
  - `{type:'missed-call', callId, callerId}`
- **No message text:** neither in data nor in the alert. Messages are end-to-end
  encrypted, so alerts say "New message" (`previews` no longer changes anything).

### Realtime protocol (JSON text frames)

**Server → client:**

- `{type:'ready'}`
- `{type:'pong'}`
- `{type:'message', message}`
- `{type:'receipt', conversationId, userId, deliveredSeq, readSeq}`
- `{type:'typing', conversationId, userId}`
- `{type:'conversation', conversationId}`: re-fetch that conversation.
- `{type:'call', call}`: a call you're in was started or changed state (sent to all of
  both participants' devices).

**Client → server:**

- `{"type":"ping"}`: send exactly this string; it's answered without waking the
  Durable Object.
- `{type:'typing', conversationId}`

Close code `4001` means this device was signed out or removed.

## Rate limits (per client IP unless noted)

| Rule           | Limit                                      |
| -------------- | ------------------------------------------ |
| challenge      | 30 / min                                   |
| register       | 5 / hour                                   |
| login          | 30 / min                                   |
| recover        | 5 / hour per IP, and 10 / day per username |
| refresh        | 60 / min                                   |
| invite preview | 20 / min                                   |
| username check | 30 / min                                   |
| send message   | 120 / min per user                         |
| create upload  | 60 / min per user                          |
| start call     | 20 / 10 min per user                       |
| key bundles    | 600 / hour per user                        |

Request bodies: 16 KB, except key uploads (512 KB), message sends (4 MB) and call
starts (256 KB).
