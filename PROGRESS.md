# Progress

| Phase | Scope                    | Status                                                     |
| ----- | ------------------------ | ---------------------------------------------------------- |
| 1     | Project foundation       | ✅ Complete; Simulator launch not yet verified (see below) |
| 2     | Premium UI/UX            | ⏳ Awaiting approval                                       |
| 3     | Authentication           | —                                                          |
| 4     | Real-time messaging      | —                                                          |
| 5     | Voice and video calling  | —                                                          |
| 6     | Notifications            | —                                                          |
| 7     | Media and group features | —                                                          |
| 8     | Security and E2EE        | —                                                          |
| 9     | Performance and testing  | —                                                          |
| 10    | Builds and distribution  | —                                                          |

**E2EE status: not implemented.** Traffic is protected by TLS only.

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

- **App launch in the iOS Simulator:** blocked because the Xcode licence has not been
  accepted (needs `sudo`; see SETUP.md). The app has not yet been run on any device or
  Simulator, so on-screen rendering, theming and the health row are unverified.
- **EAS cloud builds (iOS or Android):** need your Expo account (`eas init`). The
  `pnpm 11.16.0` and `node 24.11.0` image settings in `eas.json` have not been tested
  on EAS.
- **Physical iPhone:** not attempted.

### Known issues and limitations

- `xcode-select` points at the Command Line Tools, not Xcode.
- CocoaPods is not installed. `expo run:ios` may ask for it.
- Bundle ID base `com.navoasis.koode` is a placeholder. Change it before the first EAS
  build.
- D1 `database_id` in `wrangler.jsonc` is a placeholder for local development.
- Version pins forced by compatibility:
  - ESLint stays on 9 because `eslint-plugin-react` does not support ESLint 10.
  - Vitest stays on 4.1 because the installed `@cloudflare/vitest-plugin` 1.3.7
    requires it.
  - NativeWind stays on 4.2.7 (stable). v5 is still a release candidate.

### Manual configuration required

1. `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer && sudo xcodebuild -license accept`
2. Then `pnpm ios` to confirm the Simulator launch (Phase 1's last open check).
3. Later, when ready: create an Expo account and run `eas init`; choose a bundle ID;
   decide on the Apple Developer Program (needed from Phase 6).
