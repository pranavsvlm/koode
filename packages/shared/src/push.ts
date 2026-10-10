import { z } from 'zod';
import { CallKind } from './calls';

/** Per-device notification preferences, enforced by the server when it sends pushes. */
export const PushSettings = z.object({
  directMessages: z.boolean(),
  groupMessages: z.boolean(),
  calls: z.boolean(),
  /** Message text in notifications (otherwise "New message"). The phone's lock-screen
   * settings still decide what shows while locked. */
  previews: z.boolean(),
});
export type PushSettings = z.infer<typeof PushSettings>;

/** APNs device / PushKit tokens are hex; FCM registration tokens are URL-safe text. */
const ApnsToken = z.string().regex(/^[0-9a-f]{64,200}$/i);
const FcmToken = z.string().regex(/^[\w:-]{20,4096}$/);

/**
 * Registers this device for pushes (replaces any earlier registration).
 * `appId` is the iOS bundle id / Android package: the APNs topic.
 */
export const PushRegistration = z.discriminatedUnion('platform', [
  z.object({
    platform: z.literal('ios'),
    appId: z.string().regex(/^[A-Za-z0-9.-]{3,155}$/),
    environment: z.enum(['sandbox', 'production']),
    /** Alert notifications (messages, missed calls). */
    alertToken: ApnsToken.nullable(),
    /** PushKit: incoming calls, reported to CallKit. */
    voipToken: ApnsToken.nullable(),
    settings: PushSettings,
  }),
  z.object({
    platform: z.literal('android'),
    appId: z.string().regex(/^[A-Za-z0-9._]{3,155}$/),
    alertToken: FcmToken.nullable(),
    settings: PushSettings,
  }),
]);
export type PushRegistration = z.infer<typeof PushRegistration>;

/**
 * Custom data carried by every Koode push (`content.data` in the app). Never
 * contains message text: that is only in the visible title/body.
 */
export const PushData = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message'),
    conversationId: z.string(),
    messageId: z.string(),
    /** Lets the phone confirm delivery (✓✓) straight from the push. Older servers omit it. */
    seq: z.number().int().optional(),
  }),
  z.object({
    type: z.literal('call'),
    callId: z.string(),
    callerId: z.string(),
    callerName: z.string(),
    kind: CallKind,
  }),
  /** The call stopped ringing on this device (answered elsewhere, cancelled, declined). */
  z.object({ type: z.literal('call-ended'), callId: z.string() }),
  z.object({ type: z.literal('missed-call'), callId: z.string(), callerId: z.string() }),
]);
export type PushData = z.infer<typeof PushData>;
