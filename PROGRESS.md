# Progress

| Phase | Scope                    | Status                                                                     |
| ----- | ------------------------ | -------------------------------------------------------------------------- |
| 1     | Project foundation       | ✅ Complete (Simulator launch verified during Phase 2)                     |
| 2     | Premium UI/UX            | ✅ Complete; verified on the iOS 27 Simulator                              |
| 3     | Authentication           | ✅ Complete; verified on the iOS 27 Simulator                              |
| 4     | Real-time messaging      | ✅ Complete; two-party test on the iOS 27 Simulator                        |
| 5     | Voice and video calling  | ✅ Complete; two-party test on the iOS 27 Simulator                        |
| 6     | Notifications            | ✅ Complete; push E2E on the iOS 27 Simulator                              |
| 7     | Media and group features | ✅ Complete; media E2E on the iOS 27 Simulator                             |
| 8     | Security and E2EE        | ✅ Complete on iOS; interop E2E on the Simulator; Android E2EE not written |
| 9     | Performance and testing  | ⏳ Awaiting approval                                                       |
| 10    | Builds and distribution  | —                                                                          |

**E2EE status:** messages, attachments, reactions and calls are end-to-end encrypted
with libsignal on **iOS**, verified against Signal's Node implementation. Not
independently reviewed. **Android has no E2EE module yet**, so it can't send.

---

## Phase 8: Security and end-to-end encryption (2026-10-09)

Koode now uses the Signal Protocol through **libsignal v0.103.0** (Signal's own
library, AGPL-3.0; the project owner chose it, knowing Koode's source must be
offered to its users):

- **Key agreement and sessions:** PQXDH (X25519 + ML-KEM) and the Double Ratchet.
- **What's encrypted:**
  - **Messages** (text, replies, attachment metadata), as a separate ciphertext for
    every device of every member;
  - **Reactions**, sent as their own encrypted messages;
  - **Files and video posters**, with AES-256-GCM and a fresh key each;
  - **Calls**, with LiveKit frame encryption whose key travels only in Signal
    envelopes.
- **What the server keeps:** a public-key directory and ciphertext.

**Scope:** iOS. The Android native module isn't written (there's no Android SDK or
JDK on this machine to build or test it). On Android the app reports that
encryption is unavailable and sends nothing.

### Delivered

- **Shared** (`packages/shared/src/keys.ts`):
  - the key directory, envelope and device-mismatch schemas;
  - the versioned `Payload`: message payloads name their message id and
    conversation, a reaction names its target, and a call key names its call;
  - encrypted send, upload and call schemas.
- **Server:**
  - **Migration `0007`:**
    - `signal_device_id` per account (backfilled; never reused);
    - key tables;
    - `message_envelopes` and `call_envelopes`;
    - `messages` rebuilt (adds `reaction`, `signal`, `sender_device`, `target_id`);
    - attachments of kind `encrypted`;
    - the plaintext `reactions` table removed.
  - **`/v1/keys`:**
    - publish: the identity is fixed per device; a refused change is audited;
    - top up: ≤ 200 of each key;
    - status;
    - device list;
    - bundles: one-time keys handed out once, then last-resort; rate-limited per
      user.
  - **Sends:** ciphertext only. The server requires exactly one envelope per
    current device of every member, except the sender's device; otherwise it
    answers 409 with `{missing, extra}`. Errors now carry `details`.
  - **Delivery:**
    - each member's realtime event carries only their devices' envelopes;
    - history carries only the reading device's;
    - summaries carry none.
  - **Reactions:** never unread, never the last message, never pushed.
  - **Deletion** erases envelopes, the file and reactions to the message.
  - **Uploads:** accept only `{sizeBytes}` (strict) and are served as opaque
    downloads; encrypted posters are supported.
  - **Calls:** caller-chosen ids; the media key in envelopes for exactly the
    callee's devices; the answering device gets its own from `accept`. Calls to
    people without keys are refused.
  - **Pushes:** "New message" only.
  - **Hardening:**
    - JSON size limits are enforced on bytes actually read (a chunked body could
      skip them before), with per-route limits for key and envelope payloads;
    - per-user rate limits on sends, uploads, calls and key bundles;
    - audit events for key publication, refused identity changes, group changes
      and moderator deletions (never content).
- **App:**
  - **Native `koode-signal` (Swift):**
    - protocol stores in the Keychain (after first unlock, this device only);
    - TOFU, so a changed identity is refused;
    - one-time Kyber keys deleted after use; last-resort base-key replay
      rejected;
    - safety numbers;
    - file encryption with digest checks;
    - `forgetIdentity` to accept a changed key.
  - **Build plugin `withLibSignal`:** the pod from the release tag with its
    checksum-verified prebuilt FFI, and the linker search path (`post_integrate`).
  - **`features/crypto`:**
    - key bootstrap: a fresh identity per server device; "keys lost" detection;
    - prekey top-ups, with key ids never reused;
    - monthly signed-prekey rotation;
    - sessions only where needed;
    - device cache refreshed after a 409;
    - verification state;
    - reset at sign-out.
  - **Engine:**
    - **Receiving:** an ordered, decrypt-once inbox (memory, then cache, then
      ratchet). It never overwrites opened content and checks binding.
      Unreadable messages show "couldn't be decrypted" or "not available on this
      device".
    - **Sending:** an encrypted outbox with 409 refresh-and-retry; a changed
      safety number fails the send.
    - **Reactions:** encrypted reaction messages, aggregated per person (latest
      wins) and applied to older messages as they load.
    - **Uploads:** files and posters are encrypted before upload; the server
      learns only the ciphertext size.
  - **Media cache:** downloads are digest-checked and decrypted; a partial or
    altered file is never cached.
  - **Calls:** the key is generated, encrypted, decrypted and bound to its call.
    LiveKit E2EE (`RNE2EEManager`) is on before connecting, with no unencrypted
    fallback. The call screen shows "End-to-end encrypted".
  - **New screens and texts:**
    - a **Safety Number** screen (60 digits per device, Mark as Verified,
      "safety number changed");
    - the contact screen's security row;
    - Privacy: "End-to-end encrypted, pending review";
    - Notifications: the sender only.
  - **Directory:** new members are now looked up, so names appear.
- **Dev tooling:**
  - the `e2ee` tour;
  - `scripts/e2ee-peer.mjs`, playing "Maya" with `@signalapp/libsignal-client` and
    `@livekit/rtc-node` (dev dependencies).

### Verification

| Check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Result         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `pnpm check` (types, lint, Prettier, all tests)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | ✅ Pass        |
| Shared schema tests (payload binding, envelope validation, kind rules)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | ✅ 33/33       |
| Push relay tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | ✅ 6/6         |
| Server tests: 12 new in `e2ee.test.ts`, plus every earlier test migrated to ciphertext sends. They cover:<br>• device numbering (never reused);<br>• identity immutability (audited);<br>• one-time keys handed out once, then last-resort;<br>• caps; real-size key uploads; oversized bodies refused;<br>• the device list skipping revoked and keyless devices;<br>• exact coverage (missing, extra, duplicate, unknown);<br>• removed members dropped at once;<br>• per-device envelopes in history and realtime;<br>• call-key routing; no keys → refused; call ids not reusable;<br>• message flood → 429;<br>• no text or ciphertext in pushes;<br>• encrypted reactions and deletion | ✅ 102/102     |
| Mobile tests: 15 new. They cover:<br>• decrypt-once (socket and catch-up, cache after restart);<br>• the 409 retry;<br>• safety-number failure;<br>• binding checks;<br>• undecryptable and missing messages;<br>• legacy plaintext;<br>• encrypted uploads;<br>• reactions;<br>• device crypto (bootstrap, keys lost, top-up and rotation, sessions, identity change, verification, reset);<br>• the call key passed to media;<br>• the UI mapping                                                                                                                                                                                                                                          | ✅ 191/191     |
| Native iOS build with libsignal (pod with checksum-verified FFI)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | ✅             |
| Migration `0007` on the existing local data (62 devices numbered, no duplicates, 107 legacy messages intact)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | ✅             |
| `expo export` iOS and Android bundles                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | ✅             |
| **Interop E2E on the Simulator: app (Swift libsignal) ↔ Signal's Node libsignal ↔ local Worker and LiveKit**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | ✅ **17/17**   |
| Node → app: text and photo decrypted (digest checked, exact size, dimensions); nothing undecryptable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | ✅             |
| App → Node: text, photo (digest, size, JPEG) and reaction decrypted with real PQXDH sessions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | ✅             |
| Server stored only ciphertext; the photo's type, size and dimensions never reached it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | ✅             |
| Safety numbers identical on both sides (computed independently)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | ✅             |
| Reactions both ways, encrypted and bound to their targets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | ✅             |
| Call key decrypted by the callee's device and bound to the call                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | ✅             |
| **Call media:**<br>• the app decrypted and decoded the peer's encrypted audio (energy > 0 in its WebRTC stats);<br>• a Node listener with the key heard it;<br>• one with a wrong key heard nothing;<br>• LiveKit reports every published track GCM-encrypted                                                                                                                                                                                                                                                                                                                                                                                                                                | ✅             |
| Screens: chat (decrypted text, photo, reactions), Safety Number, encrypted call chip, Privacy, Notifications, contact security row                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | ✅ Screenshots |

Bugs found by these tests and fixed:

- **Key publish too large:** the first key publish exceeded the global 16 KB body
  limit (100 Kyber-1024 keys are about 220 KB). Groups' first messages would have
  too.
- **Unknown names:** a new contact's chat had no name, because the user directory
  wasn't refreshed for unknown members.
- **Encryption indicator:** the call screen's flag relied on an event the RN SDK
  never sends for remote participants. It now comes from track encryption
  metadata.

### Not verified

- **App → peer call audio:** the Simulator's microphone produced silence, so the
  direction "app encrypts, peer decrypts" was only confirmed through metadata (the
  SFU reports the app's track as GCM). The opposite direction was confirmed by
  decoded audio.
- **Video frame encryption:** the Simulator has no camera.
- **Android:** no E2EE module (see above), and nothing Android ran.
- **Real conditions:** two physical iPhones; a sender with several devices of
  their own; key top-ups after many sessions; signed-prekey rotation after 30
  days. The last two are unit-tested only.
- **Independent review:** no security review or audit of the integration.

### Known issues and limitations

- **No Android E2EE.** Writing the Kotlin module needs a JDK and the Android SDK
  (both free) to build and test.
- **History on new devices:** a new device (recovery, reinstall) can't read
  messages sent before it existed; they show "Not available on this device". This
  is the same as Signal.
- **Decrypt once:** if the app is killed between decrypting a message and saving
  it, that message is lost on this device.
- **Notifications** say only "New message". Text would need a Notification Service
  Extension.
- **Memory:** files are encrypted and decrypted in memory, so videos near 100 MB
  use that much RAM.
- **Still visible to the server:** metadata (who, when, sizes, membership, which
  message a reaction targets); see ARCHITECTURE.md. Ciphertext is kept until a
  message is deleted for everyone.
- **Legacy plaintext:** messages from before Phase 8 remain plaintext on the
  development server.
- **Trust model:** TOFU per device. A verified contact's new device shows "safety
  number changed", but sending isn't blocked.
- **Session expiry** is unchanged from Phase 3: 15-minute access tokens, refresh
  tokens expiring after 30 days idle or 180 days absolute, revocation on every
  request, and sockets closed at sign-out.
- **AGPL:** how and where Koode's source is offered is your decision, for Phase 10.

### Manual configuration required

- **Migration:** `pnpm --filter @koode/server db:migrate:local` (and remotely,
  with approval, before any deploy).
- **Rebuild the iOS app:** the new native module and pod need it
  (`npx expo run:ios` or `expo prebuild` plus Xcode).

---

## Phase 7: Media and group features (2026-10-09)

Photos, videos, documents and voice messages work end to end. They are stored in a
**private R2 bucket** (local Miniflare R2 in development: no account, no cost) behind
authorized upload and download routes. Reactions, replies and "delete for everyone"
are server-backed and sync across devices, and groups can be administered.
**Files and messages are not end-to-end encrypted yet (Phase 8).**

### Delivered

- **Server:**
  - **Migration `0006`:** rebuilds `messages` (kinds `text`/`attachment`/`system`,
    revisions, tombstones), and adds `attachments` and `reactions`.
  - **Attachments:**
    - per-kind type and size limits;
    - uploads streamed to R2 with an exact `Content-Length` check;
    - video posters;
    - members-only reads with `Range` support;
    - documents always served as downloads (`octet-stream`, `nosniff`, sandbox CSP);
    - single use per upload, by its uploader, in its conversation;
    - hourly cron cleanup of unsent uploads; files deleted with their message.
  - **Reactions:** one per person per message.
  - **Delete for everyone:** by the sender or a group admin. Text, file and reactions
    are erased, leaving a marker.
  - **Revisions:** every change bumps the message's revision; `changedSince`
    catch-up returns new and changed messages.
  - **Group administration:** rename, add (≤ 64 members), remove, promote/demote,
    leave. A group always keeps an admin. Each change is a system message, not unread
    and never pushed.
  - **Notifications:** attachment pushes say "📷 Photo" and the like.
- **App:**
  - **Pickers:** the attach sheet has the real camera, photo library (multi-select,
    up to 10; HEIC arrives as JPEG) and document picker.
  - **Processing:** photos are re-encoded (≤ 2048 px, **EXIF/GPS removed**); videos
    get a poster; photos and posters get tiny inline previews.
  - **Outbox:** upload-aware and resumable (create → poster → upload → send; each step
    persisted), with progress in the bubble. An expired upload restarts; a refused
    file can be cancelled.
  - **Media cache:** authenticated downloads cached by attachment id, deduplicated;
    the sender's copy is reused. Cleared at sign-out.
  - **Bubbles:**
    - photos and video posters with placeholders;
    - document cards with the real file type;
    - voice messages with real playback (expo-audio).
  - **Media viewer:** plays videos (expo-video); Save to Photos (add-only access);
    Share.
  - **Documents:** they open through the share sheet ("Open in…", "Save to Files").
  - **Voice recording:** in the composer: tap to record (mono AAC, live level,
    waveform), then send or cancel. It can't start during a call.
  - **Message actions:** Reply, Copy, Save to Photos, Share, Delete for Everyone
    (sender or group admin), Delete for Me / Cancel Sending.
  - **Sync:** reactions and deletion are server-backed with instant feedback, and
    catch-up includes edits.
  - **Group info:** rename, add members, member actions (make or remove admin,
    remove), and leave. Removed or leaving users' devices drop the chat. System notes
    appear in the chat ("You added Sam Lee").
- **Dev tooling:**
  - the `media` tour mode and `scripts/media-peer.mjs`;
  - development handles so the tour drives the composer's own record and send
    handlers.

### Verification

| Check                                                                                                                                                                                                                                                                                                                   | Result                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| TypeScript, ESLint, Prettier (all packages)                                                                                                                                                                                                                                                                             | ✅ Pass                 |
| Shared schema tests                                                                                                                                                                                                                                                                                                     | ✅ 31/31                |
| Push relay tests                                                                                                                                                                                                                                                                                                        | ✅ 6/6                  |
| Server tests (19 new: upload validation, exact-size storage, private-until-sent, members-only reads, Range, documents as downloads, video posters, send-once rules, cron cleanup, reactions, delete-for-everyone erasing files, revision catch-up, group create/rename/add/remove/leave/promote/demote, admin deletion) | ✅ 90/90                |
| A deliberately removed admin check makes 3 group tests fail                                                                                                                                                                                                                                                             | ✅                      |
| Mobile tests (engine: edit catch-up, gap-free skipping, upload pipeline with resume/expiry/refusal, optimistic reactions, stale-copy protection, leaving; store: attachment mapping, grouped reactions, system text)                                                                                                    | ✅ 176/176              |
| Native iOS build with the media modules                                                                                                                                                                                                                                                                                 | ✅                      |
| **Media and group E2E on the Simulator: app + two peer accounts, local Worker and R2** (repeated runs)                                                                                                                                                                                                                  | ✅ Logs and screenshots |
| Maya's photo, video (with poster), PDF and voice arrive, render and download byte-for-byte                                                                                                                                                                                                                              | ✅                      |
| The app sends a photo, video, PDF and voice file through the real pipeline; all reach "sent"                                                                                                                                                                                                                            | ✅                      |
| The photo the app sent: JPEG, **GPS position and camera make removed**, inline preview present                                                                                                                                                                                                                          | ✅                      |
| The video the app sent: poster uploaded and served; documents served as `octet-stream` downloads under their real name                                                                                                                                                                                                  | ✅                      |
| **Voice recorded through the composer** (Simulator microphone): 3.2 s AAC (`ftyp`), 28-point waveform                                                                                                                                                                                                                   | ✅                      |
| Reactions both ways; delete-for-everyone → marker in the app, file 404 for the other person                                                                                                                                                                                                                             | ✅                      |
| Save to Photos (add-only access) succeeds; the viewer shows the photo and plays the video                                                                                                                                                                                                                               | ✅                      |
| Group: create, add Sam, make admin, rename, remove Maya → system notes in the chat, Maya gets 404, Sam is admin                                                                                                                                                                                                         | ✅                      |

Bugs found by these tests and fixed:

- **Sender's own media:** a bubble's download raced with the sender's own file
  moving into the cache; the move failed, leaving a stale partial file and a blank
  bubble.
- **Voice duration:** voice bubbles showed the player's rounded-down duration.
- **Test identities:** the E2E tour picked an old test account by display name; it
  now identifies people by its own conversations.

### Not verified

- **Tapping the pickers:** the camera, photo library and document picker UIs were
  not driven (the Simulator can't be tapped, and has no camera). Files entered the
  same pipeline right after the picker.
- **The share sheet:** Share / "Open in…" opening, and choosing another app.
- **Hearing playback:** voice and video sound, and voice playback controls, were not
  exercised.
- **Large and slow transfers:** files near the 100 MB limit, slow or flaky
  networks, and resuming an interrupted upload on a real network (the resume logic
  is unit-tested).
- **Real phones and Android:** real photos (HEIC, Live Photos), Android pickers and
  storage permissions, and a deployed R2 bucket.

### Known issues and limitations

- **Not end-to-end encrypted:** files are encrypted in transit only; the server and
  the device caches hold plaintext.
- **Video sending:**
  - videos are sent at the picker's export quality, with no extra compression;
  - the viewer downloads the whole video before playing (no streaming yet, although
    the server supports ranges).
- **Device-only:** pin, mute and "delete for me".
- **Not yet supported:** editing messages, forwarding, group photos and
  descriptions.
- **Media and removed members:** when someone is removed from a group, the files
  already downloaded to their device stay there.
- **Android permissions:** `@config-plugins/react-native-webrtc` and expo-media-library
  add storage permissions; review them in Phase 10.

### Manual configuration required

- **Development (done on this Mac):**
  - migration 0006 is applied;
  - the native app has been rebuilt;
  - `ffmpeg` is used only to generate test files.
- **Before real use (your approval):** a Cloudflare R2 bucket (`koode-media`).
  Enabling R2 requires a payment method on the Cloudflare account.

---

## Phase 6: Notifications (2026-10-09)

Push notifications are **real** for messages, incoming calls and missed calls:

- iOS goes through APNs via a new push relay;
- Android goes through FCM;
- iOS incoming calls ring through **PushKit + CallKit**.

Everything ran locally. The relay was in Simulator mode, so no Apple or Firebase
account was used and nothing was billed. **Real APNs delivery, CallKit answering
and all of Android are untested** (they need a paid Apple account, a real iPhone,
and an Android device or a Firebase project; see below).
**Notification text is not end-to-end encrypted yet (Phase 8).**

### Delivered

- **Investigation:** APNs requires HTTP/2, and Worker `fetch` can't negotiate it.
  Verified: local workerd fails with "Network connection lost", while
  `curl --http2` gets APNs' normal 403.
- **Push relay** (`apps/push-relay`, Node):
  - holds the APNs .p8 key and signs ES256 provider tokens with `jose`;
  - keeps HTTP/2 connections to APNs and maps APNs errors back to the Worker;
  - authenticates the Worker with a bearer secret and logs no tokens or payloads;
  - **simulator mode** delivers alert pushes to a booted Simulator via
    `xcrun simctl push`.
- **Server:**
  - Migration `0005_push`, and `PUT/DELETE /v1/push`. Apps are allow-listed, the
    platform must match the device, and a token moves to the newest device that
    registers it.
  - Registrations are deleted on sign-out and device removal; dead tokens are
    forgotten.
  - Dispatch rules for messages (sender or group name, text only if previews are
    on, unread badge) and calls (ring, stop ringing, missed). Per-device settings
    are enforced.
  - FCM HTTP v1 client (service-account OAuth, RS256 via `jose`).
  - `CallTimer` Durable Object: an alarm marks unanswered calls missed and sends the
    missed-call push, even if the caller vanished.
- **iOS native module** (`modules/koode-calls`, Swift):
  - PushKit is registered at launch.
  - Every VoIP push is reported to CallKit before returning (an Apple requirement);
    stale pushes are reported and ended.
  - CallKit answer, end and mute are queued until JavaScript listens.
  - The CallKit audio session is handed to WebRTC.
  - Calls stay out of Recents; a 50 s local ring safety timeout.
- **App:**
  - **Push:** expo-notifications with raw APNs/FCM tokens (not Expo's push
    service). The permission prompt is asked once, and registration stays in sync
    with tokens and settings.
  - **Taps:** they open the chat, the Calls tab, or the incoming call; Answer,
    Decline and Call Back actions; also when the tap launched the app.
  - **Foreground:** no banner for the chat on screen; ringing is shown in-app.
  - **Badge:** the badge shows unread messages; a chat's notifications clear when
    it's opened.
  - **Android:** channels (messages, calls, missed calls) and a headless background
    task for Decline and "stop ringing".
  - **CallKit bridge:** connects CallKit to the call controller; the in-app ringing
    screen gives CallKit 1.5 s to claim a call.
  - **Settings → Notifications:** real permission status (Turn On / Open Settings),
    and a "Show Message Text" switch replacing the three-way preview option (the
    phone's lock-screen setting decides what shows while locked).
- **Keychain:**
  - Auth secrets are now "after first unlock, this device only", so a call can be
    answered from the lock screen.
  - Items are migrated once, and never synced or restored to another device.
- **Dev tooling:** the `push` tour mode, `scripts/push-peer.mjs`, and route logging
  during tours.

### Verification

| Check                                                                                                                                                                                                                                                                                           | Result                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| TypeScript, ESLint, Prettier (all packages)                                                                                                                                                                                                                                                     | ✅ Pass                 |
| Shared schema tests                                                                                                                                                                                                                                                                             | ✅ 31/31                |
| Push relay tests against a local HTTP/2 APNs stand-in (ES256 token verified with the public key, headers, token reuse, 410 pass-through, auth, size and format rejection, simulator mode)                                                                                                       | ✅ 6/6                  |
| Server tests (15 new: registration rules, token moves, sign-out cleanup, message payloads, previews off, muted types, group naming, FCM payload + signed OAuth assertion, dead-token cleanup, VoIP ring, alert fallback, stop + missed, answered device skipped, alarm → missed, calls setting) | ✅ 71/71                |
| A deliberately broken previews rule makes the server tests fail                                                                                                                                                                                                                                 | ✅                      |
| Mobile tests (19 new: notification policy, registrar, keystore migration, CallKit bridge with a fake native module)                                                                                                                                                                             | ✅ 163/163              |
| iOS native build with the PushKit/CallKit module                                                                                                                                                                                                                                                | ✅                      |
| **Push E2E on the Simulator: two accounts, local Worker, relay in simulator mode** (repeated runs)                                                                                                                                                                                              | ✅ Logs and screenshots |
| App open: the message notification is received with the right data                                                                                                                                                                                                                              | ✅                      |
| App in the background: message, missed call and "Incoming video call" all delivered                                                                                                                                                                                                             | ✅                      |
| "Answer" on the incoming-call notification → the call screen opens and the server shows the call `active`                                                                                                                                                                                       | ✅                      |
| Tapping the message notification opens the chat and clears its notifications; the missed-call tap opens Calls (history: "Missed voice call")                                                                                                                                                    | ✅                      |
| App closed: the message is delivered and listed when the app reopens                                                                                                                                                                                                                            | ✅                      |
| The native VoIP handler reports to CallKit ("reported incoming: ok"); the system's end action reaches the app, which declines on the server                                                                                                                                                     | ✅                      |
| Phase 5 call test re-run after the call-screen changes                                                                                                                                                                                                                                          | ✅                      |

Bugs found by these tests and fixed:

- **Missed calls:** a lazy expiry could beat the missed-call push. The alarm now
  sends it, and the sweep has a grace period.
- **Category id:** Expo forbids `-` in notification category ids (`missed_call`).
- **Swift DSL:** the module used `.runOnQueue` on plain `Function`s; it now
  dispatches to main explicitly.
- **Relay 413:** an oversized request closed the socket before the 413 was sent.
- **Notification dismissal:** when a call stopped ringing, its missed-call
  notification was removed too.
- **Stacked call screens:** answering from a notification stacked the call screen on
  the ringing screen. Closing both left a black screen, or a stale ringing screen
  for an earlier call. The call screen now replaces the ringing screen, screens
  close themselves (not "whatever is on top"), and only one ringing screen exists
  at a time.
- **Sign-out:** notifications and the badge from a signed-out account weren't
  always cleared.
- **Simulator VoIP token:** PushKit hands out a token on the Simulator, but CallKit
  can't ring there. PushKit is now skipped on the Simulator, so calls fall back to
  an alert.

### Not verified

- **Real APNs** (needs the paid Apple Developer account and an APNs key):
  - real alert and VoIP delivery;
  - production vs. sandbox;
  - the relay's HTTP/2 path against Apple itself (it is tested against a local
    HTTP/2 stand-in).
- **CallKit on a real iPhone:**
  - the system incoming-call screen, answering or declining from the lock screen;
  - audio hand-off to WebRTC, mute sync, Bluetooth;
  - launch from a killed state. The Simulator ends CallKit calls immediately (it
    has no in-call UI).
- **Banners and sounds:** the Simulator can't tap "Allow", so tests used
  _provisional_ permission, which delivers quietly to Notification Center. Banner
  presentation with full permission wasn't seen.
- **Real taps on notifications and action buttons:** the tour fed delivered
  notifications through the same handler.
- **All of Android:** FCM delivery, channels, action buttons, the headless
  background task, badges. There's no device, emulator or Firebase project; only the
  server's FCM requests are tested.
- Badge counts on a real home screen; Focus / Do Not Disturb behaviour.

### Known issues and limitations

- **Not end-to-end encrypted:** with previews on, message text passes through
  Apple's or Google's push service.
- **Lock-screen previews:** "Show Message Text" is on/off only; the phone's own
  setting decides what shows on the lock screen.
- **Android:** no full-screen incoming-call UI; incoming calls are a high-priority
  notification with Answer/Decline.
- **Outgoing calls** aren't reported to CallKit (no system call UI or Bluetooth
  routing for them yet).
- **Keychain:** "after first unlock" makes secrets readable while the phone is
  locked (needed to answer calls); still device-only.
- **Background modes:** iOS lists `audio`, `voip` and `fetch`. `fetch` comes from a
  plugin; review it in Phase 10.
- **Repeat notifications:** each message replaces the conversation's Android
  notification (tag); iOS groups them by thread.

### Manual configuration required

- **Development (done on this Mac):**
  - Migration 0005 is applied.
  - `.dev.vars` has `PUSH_RELAY_URL` and `PUSH_RELAY_SECRET`.
  - The relay runs with `APNS_MODE=simulator`; the native app has been rebuilt.
- **Before real use (your decision and approval):**
  - **Apple Developer Program** (US$99/year): push capability for each app id, and
    an APNs auth key (.p8) for the relay.
  - **Host the push relay** (any small always-on Node host); it holds the .p8 key.
  - **Firebase:** a project, `google-services.json` (EAS file env var
    `GOOGLE_SERVICES_JSON`), and a service account in the Worker secret
    `FCM_SERVICE_ACCOUNT`.

---

## Phase 5: Voice and video calling (2026-10-09)

One-to-one voice and video calls are **real**. They are signalled through the Worker
and WebSocket, with media through LiveKit (WebRTC). Development uses a **local**
`livekit-server --dev`, so no account is involved and nothing is billed. Incoming calls
**only ring while the app is open** until PushKit/CallKit and FCM land (Phase 6).
**Call media is not end-to-end encrypted yet (Phase 8).**

### Delivered

- **Server:**
  - Migration `0004_calls`.
  - Call routes: start, accept, decline, end, rejoin, history and lookup. The state
    machine covers ringing → active → ended, plus declined, cancelled and missed.
  - Conditional transitions resolve races (for example accept vs. cancel) to one
    outcome.
  - A 45 s ring timeout with lazy expiry, busy detection (409), and participant-only
    access.
  - LiveKit tokens minted on the Worker: one room, own identity, 10 minutes,
    microphone and camera only, no data or metadata.
  - Every change is pushed to both users as a `call` realtime event.
  - Hardening: the token-signing secret and the LiveKit settings are checked at use.
    A missing or short secret fails closed.
- **Shared:** call schemas and the `call` server event.
- **App:**
  - `CallController`, a tested state machine. It auto-declines a second call while
    busy, cancels after the ring timeout, ends on media loss, and shows reconnecting
    and connection quality.
  - `MediaSession` with a LiveKit implementation: audio session, speaker/earpiece
    routing, mic, camera, flip.
  - Incoming calls open the incoming-call screen through `CallRouter`.
  - The call screen shows live remote video full screen and the self-view. It has a
    "weak connection" status and a "Camera unavailable" notice, and closes itself
    after the call ends.
  - Every call button (chat header, contact, new-call sheet, Calls tab) starts a real
    call.
  - The Calls tab shows server history (answered with duration, missed, declined,
    cancelled).
  - Native: LiveKit and WebRTC config plugins, camera and microphone usage strings,
    background audio mode.
- **Dev tooling:**
  - The `calls` mode of the screen tour, with LiveKit info logs.
  - `scripts/call-peer.mjs`, a second account that uses the LiveKit CLI as its media
    client.

### Verification

| Check                                                                                                                                                                                                          | Result                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| TypeScript, ESLint, Prettier (all packages)                                                                                                                                                                    | ✅ Pass                 |
| Shared schema tests                                                                                                                                                                                            | ✅ 31/31                |
| Server tests in the Workers runtime (8 new call tests: ringing + token claims verified with the secret, self/unknown, busy, callee-only accept, outcomes, notifications, timeout → missed, history and access) | ✅ 56/56                |
| Mobile tests (18 new controller tests with fake media and clock)                                                                                                                                               | ✅ 144/144              |
| Native iOS build with LiveKit WebRTC; installed on the iOS 27 Simulator                                                                                                                                        | ✅                      |
| **Two accounts on the Simulator + a Node peer, local Worker and local LiveKit**                                                                                                                                | ✅ Screenshots and logs |
| Peer video-calls → incoming screen in the app → accept → both identities ACTIVE in the room, 1 published track each (`lk room participants list`)                                                              | ✅                      |
| The app receives the peer's video (LiveKit demo video shown full screen); mute reaches the controller; the peer hangs up → app returns to Chats; history "Incoming video · 14 sec"                             | ✅                      |
| App calls the peer → "Ringing…" → peer declines → app shows it, history "Declined voice call"; the server shows the same two calls                                                                             | ✅                      |
| The app's media session leaves the room when a call ends (LiveKit server log: `CLIENT_REQUEST_LEAVE` at hang-up/decline)                                                                                       | ✅                      |

Bugs found by these tests and fixed:

- The app crashed at launch: `useSyncExternalStore` called the controller's
  `subscribe` without `this`. It is now an arrow property, with a regression test.
- Jest couldn't load screens that import LiveKit; the packages are stubbed in
  `jest.setup.ts`.
- The server test config had never applied its secret bindings (tests only passed
  with a local `.dev.vars`). The bindings are now in place, and the suite passes with
  or without the file.
- The call timer called `Date.now()` during render; the controller now records
  `connectedAt`.

### Not verified

- **Tapping by hand:** Accept, Mute and the call buttons were driven by the tour,
  calling the same handlers as the buttons, not by taps.
- **Hearing audio:** tracks were published and subscribed, but nobody listened. The
  Simulator's microphone and speaker are not a real test. Echo, speaker/earpiece
  switching, Bluetooth and interruptions (a phone call, Siri) need a real phone.
- **The camera:** the Simulator's camera sends black frames, so the self-view, Flip
  and the app's outgoing video have not been seen working. Real phone needed.
- **Real networks:** Wi-Fi ↔ cellular handover and reconnection, poor-network quality
  indicators, TURN/relay traversal (the local server is on the same Mac).
- **Background, lock screen and killed app:** not supported until Phase 6.
- **Two phones, Android, LiveKit Cloud or a self-hosted server.**

### Known issues and limitations

- **Not end-to-end encrypted:** media is encrypted between each device and the
  LiveKit server (DTLS-SRTP), and the LiveKit server can access it.
- Incoming calls ring only while the app is in the foreground (Phase 6).
- **An outgoing call dropped once:** in one of four runs, the app left the LiveKit
  room about 1 s into an outgoing call, while it still showed "Ringing…". This was not
  reproduced in two later runs, including one built to recreate the timing. The calls
  tour now logs LiveKit's info output so it can be diagnosed if it happens again.
- After a call, LiveKit logs a harmless "ping timeout" warning for the closed room.
  The library ignores it once the room is closed, and a later call is unaffected
  (verified).
- In development, LiveKit's "could not determine track dimensions" error (from the
  Simulator's camera) shows the red LogBox banner.
- `POST /calls/:id/rejoin` exists, but the app doesn't use it yet. If the app
  restarts mid-call, the call is not resumed.
- One-to-one only; no group calls.
- Android: `@config-plugins/react-native-webrtc` adds storage and overlay
  permissions; review them in Phase 10.

### Manual configuration required

- **Development (done on this Mac):**
  - `brew install livekit livekit-cli`; run `livekit-server --dev --bind 0.0.0.0`.
  - The `LIVEKIT_*` values are in `apps/server/.dev.vars`.
  - Migration 0004 applied locally; native app rebuilt.
- **Before real use (needs your decision and approval):**
  - Choose LiveKit Cloud (free tier, external service) or a self-hosted LiveKit
    server.
  - Set `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` as Worker secrets.

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
