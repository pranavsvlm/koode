import { z } from 'zod';
import { Envelope, OutgoingEnvelope } from './keys';

export const CallKind = z.enum(['voice', 'video']);
export type CallKind = z.infer<typeof CallKind>;

/**
 * ringing → active → ended
 * ringing → declined (callee) | cancelled (caller) | missed (no answer in time)
 */
export const CallState = z.enum(['ringing', 'active', 'ended', 'declined', 'cancelled', 'missed']);
export type CallState = z.infer<typeof CallState>;

export const RING_TIMEOUT_MS = 45_000;

export const Call = z.object({
  id: z.string(),
  kind: CallKind,
  callerId: z.string(),
  calleeId: z.string(),
  state: CallState,
  createdAt: z.number().int(),
  answeredAt: z.number().int().nullable(),
  endedAt: z.number().int().nullable(),
});
export type Call = z.infer<typeof Call>;

/** A call's id from the UUID the caller picks (so the media key can name its call). */
export const callIdFor = (uuid: string) => `cal_${uuid}`;

export const StartCallRequest = z.object({
  /** UUID v4 chosen by the caller; the call's id is `cal_<uuid>`. */
  id: z
    .string()
    .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      'Invalid call id',
    ),
  userId: z.string().min(1).max(64),
  kind: CallKind,
  /**
   * The call's media key, encrypted to each of the callee's devices (exactly
   * their current devices; 409 with a DeviceMismatch otherwise).
   */
  envelopes: z.array(OutgoingEnvelope).max(64),
});
export type StartCallRequest = z.infer<typeof StartCallRequest>;

/** Credentials to join the call's media room. Never contains server secrets. */
export const MediaJoin = z.object({ url: z.string(), token: z.string() });
export const CallJoin = z.object({
  call: Call,
  media: MediaJoin,
  /** For the callee: the media key, encrypted to the answering device. */
  key: z.object({ senderDevice: z.number().int(), envelope: Envelope }).nullable(),
});
export type CallJoin = z.infer<typeof CallJoin>;

export const CallList = z.object({ calls: z.array(Call) });

export const isTerminal = (s: CallState) => s !== 'ringing' && s !== 'active';
