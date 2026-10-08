# Working on Koode

- Read docs/ARCHITECTURE.md before designing anything; update it when a decision changes.
- Work proceeds in numbered phases (see PROGRESS.md). Finish, verify, commit and update
  PROGRESS.md for one phase, then stop and wait for approval before the next.
- Never claim untested behaviour works. List anything unverified explicitly.
- Never deploy remote infrastructure or start paid services without explicit approval.
  Local `wrangler dev` and Miniflare are fine.
- Never invent cryptography. Do not describe the app as end-to-end encrypted until
  Phase 8 is verified.
- Mobile: follow apps/mobile/AGENTS.md (Expo changes fast; check the versioned docs).
  Add dependencies with `npx expo install` from apps/mobile.
- Run `pnpm check` before declaring work done.
- Use semantic colour tokens (`bg-surface`, `text-text-secondary`), never raw hex in
  components.
- Never use `className` on Reanimated's `Animated.View`; use `MotionView` /
  `MotionPressable` (components/ui/MotionView) with `animatedStyle`.
- Review UI on the Simulator with the dev screen tour (`EXPO_PUBLIC_DEV_TOUR`, see
  docs/SETUP.md). Type checks alone don't catch NativeWind styling failures.
