# Koode design system

Koode should feel calm, personal and native, closer to Messages and FaceTime than to a
dashboard. This page is the reference for building any screen.

## Principles

- **Content first.** Bubbles, faces and photos carry the colour. Chrome stays neutral.
- **Few boundaries.** Use spacing and surface tone instead of borders. The only lines
  are inset hairlines between list rows.
- **Native behaviour.** Native headers, tab bar, sheets, large titles, search bars and
  swipe-back. Use custom UI only where the platform has nothing equivalent.
- **Felt, not seen, motion.** Springs for direct manipulation, short fades for state
  changes. Every looping animation stops when Reduce Motion is on.
- **Accessible by default.** Tests enforce colour contrast. Every control has a role and
  a label. Text scales with Dynamic Type.

## Tokens (`apps/mobile/src/theme/tokens.ts`)

All colours are semantic tokens with light and dark values. Components use Tailwind
classes such as `bg-surface`, `text-text-secondary` and `bg-accent/10`, never raw hex.

| Token                                     | Use                                                 |
| ----------------------------------------- | --------------------------------------------------- |
| `background`                              | Screen background                                   |
| `surface` / `surface-raised`              | Grouped lists, cards / sheets and dialogs           |
| `fill`                                    | Inputs, secondary buttons, pressed rows             |
| `text`, `text-secondary`, `text-tertiary` | Primary copy, supporting copy, timestamps and hints |
| `separator`                               | Inset hairlines only                                |
| `accent`, `accent-foreground`             | Interactive elements; text on accent fills          |
| `bubble-*`                                | Outgoing and incoming message bubbles               |
| `success`, `warning`, `danger`            | Status                                              |
| `scrim`                                   | Modal backdrops (always used with opacity)          |

- **Accent:** five user-selectable accents (Blue, Indigo, Teal, Rose, Graphite) change
  `accent` and the outgoing bubble colour.
- **Contrast:** `tokens.test.ts` checks every scheme × accent combination against WCAG:
  - 7:1 for primary text
  - 4.5:1 for secondary text and text on accent fills
  - 3:1 for tertiary text and accent-as-text
- **Call screens:** always dark, using `callColors`, like FaceTime.
- **Type:** an Apple-HIG ramp (`text-large-title` … `text-caption`) set in the system
  font (SF Pro on iOS, Roboto on Android). Use the `<Text variant tone>` component.
- **Radii:** `sm 8`, `md 12`, `lg 16`, `xl 22`, `bubble 20`.
- **Motion:** `springs.snappy` for presses and toggles, `springs.gentle` for sheets and
  drags, `springs.bouncy` sparingly.

## Components (`apps/mobile/src/components/ui`)

| Component                        | Notes                                                                                                           |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `Text`                           | Variant and tone. Title variants are announced as headers.                                                      |
| `Button`                         | `primary`, `secondary`, `plain`, `destructive`; `md` / `lg`; loading state; haptic tap.                         |
| `IconButton`                     | Icon-only control. An accessibility label is required. Hit area ≥ 44 pt.                                        |
| `Icon`                           | Semantic names mapped to SF Symbols (iOS) and Material Symbols (Android).                                       |
| `TextField`                      | Filled field; label, hint, error, prefix, icon; accent focus ring.                                              |
| `Avatar`                         | Photo, or a deterministic gradient with initials; online dot; group glyph.                                      |
| `Badge`                          | Unread count. Muted conversations use a grey badge.                                                             |
| `ListSection` / `ListRow`        | Inset grouped lists with chevron, value, check and switch accessories.                                          |
| `SegmentedControl`               | Spring-animated selection thumb.                                                                                |
| `Sheet`                          | Content-sized bottom sheet; drag or tap the backdrop to dismiss.                                                |
| `DialogProvider` / `useDialog`   | `await dialog.confirm({...})`; destructive style.                                                               |
| `ToastProvider` / `useToast`     | Glass toast at the top, announced to screen readers.                                                            |
| `GlassSurface`                   | Liquid Glass on iOS 26+, blur on older iOS, tinted surface on Android.                                          |
| `Skeleton` / `SkeletonList`      | Pulsing placeholders matching row layouts.                                                                      |
| `EmptyState`                     | Icon, title, message and optional action.                                                                       |
| `PressableScale`                 | Base press feedback (scales to 0.97).                                                                           |
| `MotionView` / `MotionPressable` | Animated views that accept `className` plus an `animatedStyle` prop. Use for any animated element with classes. |

Feature components:

- `features/chat`: message bubble, composer, typing indicator, swipe to reply, action
  sheet.
- `features/call`: call controls, pulse rings, draggable self view, backdrop.

## Patterns

- **Tab roots:** a large collapsing title, a native search bar, and
  `contentInsetAdjustmentBehavior="automatic"` on the scroll view.
- **Grouping:** consecutive bubbles from one sender within 3 minutes join into a group.
  The corners on the joined side tighten from 20 to 6.
- **Loading:**
  - Lists use skeleton rows that match the real layout. No spinners for list content.
  - A spinner appears only inside buttons with a loading state.
- **Empty states:** say what will appear and offer one next step.
- **Honesty:** never imply a feature works before it does. Unfinished actions show a
  toast naming the phase that delivers them. The privacy screen states plainly that
  end-to-end encryption is not on yet.
