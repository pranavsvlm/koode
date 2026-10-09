import { z } from 'zod';

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

export const StartCallRequest = z.object({ userId: z.string().min(1).max(64), kind: CallKind });
export type StartCallRequest = z.infer<typeof StartCallRequest>;

/** Credentials to join the call's media room. Never contains server secrets. */
export const MediaJoin = z.object({ url: z.string(), token: z.string() });
export const CallJoin = z.object({ call: Call, media: MediaJoin });
export type CallJoin = z.infer<typeof CallJoin>;

export const CallList = z.object({ calls: z.array(Call) });

export const isTerminal = (s: CallState) => s !== 'ringing' && s !== 'active';
