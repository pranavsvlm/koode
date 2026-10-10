# Koode

Private, invite-only messaging and calling for family and friends. Ad-free,
tracker-free, built with Expo (iOS and Android) and Cloudflare.

> **Status: early development.** Messages, files and calls are end-to-end
> encrypted with Signal's libsignal. On Android, messages and files are verified
> (emulator) but encrypted calls aren't yet. The implementation hasn't been
> independently reviewed, so don't use Koode for highly sensitive conversations
> yet. See [PROGRESS.md](PROGRESS.md) and [docs/RELEASE.md](docs/RELEASE.md).
>
> **Licence note:** libsignal is AGPL-3.0, so Koode's source must be offered to
> its users.

## Quick start

```sh
pnpm install
pnpm --filter @koode/server db:migrate:local
pnpm dev:server          # API on http://localhost:8787
pnpm ios                 # build and launch the app on the iOS Simulator
```

The full instructions, including the one-time Xcode setup and Android builds through
EAS, are in [docs/SETUP.md](docs/SETUP.md).

## Repository

| Path              | What                                                                  |
| ----------------- | --------------------------------------------------------------------- |
| `apps/mobile`     | Expo SDK 57 app: Expo Router, NativeWind, Reanimated, Zustand, SQLite |
| `apps/server`     | Cloudflare Worker (Hono), Durable Objects, D1 migrations, R2          |
| `packages/shared` | Wire-protocol types and Zod schemas shared by app and server          |
| `docs/`           | [Architecture](docs/ARCHITECTURE.md), [setup](docs/SETUP.md)          |

## Scripts (repo root)

| Command           | Does                                                  |
| ----------------- | ----------------------------------------------------- |
| `pnpm check`      | Typecheck, lint, format check and tests, all packages |
| `pnpm dev:server` | Local Worker with local D1, R2 and Durable Objects    |
| `pnpm dev:mobile` | Metro dev server for an installed development build   |
| `pnpm ios`        | Build and run the iOS development build               |
