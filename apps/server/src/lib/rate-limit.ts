import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../app';
import { hmacSha256Hex } from './crypto';
import { ApiError } from './errors';

export type RateRule = { name: string; limit: number; windowSec: number };

/**
 * Fixed-window counter in D1. Returns false once `limit` is exceeded within
 * the current window. `subject` is hashed with a server secret, so the table
 * never holds raw IPs or usernames.
 */
export async function hit(env: Env, rule: RateRule, subject: string): Promise<boolean> {
  const windowMs = rule.windowSec * 1000;
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  const key = `${rule.name}:${(await hmacSha256Hex(env.AUTH_TOKEN_SECRET, `rl:${subject}`)).slice(0, 32)}`;
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END,
       window_start = excluded.window_start
     RETURNING count`,
  )
    .bind(key, windowStart)
    .first<{ count: number }>();
  return (row?.count ?? 0) <= rule.limit;
}

export function clientIp(headers: { header: (name: string) => string | undefined }): string {
  return headers.header('cf-connecting-ip') ?? 'unknown';
}

/** Per-user rate limit (the caller must be authenticated). */
export async function limitUser(env: Env, rule: RateRule, userId: string): Promise<void> {
  if (!(await hit(env, rule, `user:${userId}`)))
    throw new ApiError('rate_limited', 'Too many requests. Try again later.');
}

/** Per-client-IP rate limit for a route. */
export const rateLimit =
  (rule: RateRule): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    if (!(await hit(c.env, rule, clientIp(c.req)))) {
      throw new ApiError('rate_limited', 'Too many requests. Try again later.');
    }
    await next();
  };

export const RULES = {
  challenge: { name: 'challenge', limit: 30, windowSec: 60 },
  register: { name: 'register', limit: 5, windowSec: 3600 },
  login: { name: 'login', limit: 30, windowSec: 60 },
  recover: { name: 'recover', limit: 5, windowSec: 3600 },
  recoverUser: { name: 'recover-user', limit: 10, windowSec: 86400 },
  refresh: { name: 'refresh', limit: 60, windowSec: 60 },
  invitePreview: { name: 'invite-preview', limit: 20, windowSec: 60 },
  usernameCheck: { name: 'username-check', limit: 30, windowSec: 60 },
  /** Per user: each bundle fetch uses up one-time keys. */
  keyBundles: { name: 'key-bundles', limit: 600, windowSec: 3600 },
  /** Per user (messages and reactions; generous for real use, stops floods). */
  sendMessage: { name: 'send-message', limit: 120, windowSec: 60 },
  createAttachment: { name: 'create-attachment', limit: 60, windowSec: 60 },
  startCall: { name: 'start-call', limit: 20, windowSec: 600 },
} satisfies Record<string, RateRule>;
