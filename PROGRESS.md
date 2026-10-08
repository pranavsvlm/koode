# Progress

| Phase | Scope                    | Status                                                 |
| ----- | ------------------------ | ------------------------------------------------------ |
| 1     | Project foundation       | ✅ Complete (Simulator launch verified during Phase 2) |
| 2     | Premium UI/UX            | ✅ Complete; verified on the iOS 27 Simulator          |
| 3     | Authentication           | ⏳ Awaiting approval                                   |
| 4     | Real-time messaging      | —                                                      |
| 5     | Voice and video calling  | —                                                      |
| 6     | Notifications            | —                                                      |
| 7     | Media and group features | —                                                      |
| 8     | Security and E2EE        | —                                                      |
| 9     | Performance and testing  | —                                                      |
| 10    | Builds and distribution  | —                                                      |

**E2EE status: not implemented.** Traffic is protected by TLS only.

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
