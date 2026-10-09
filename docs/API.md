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
