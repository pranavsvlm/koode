import type { PublicUser } from '@koode/shared';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAuth } from '../auth/middleware';
import { ApiError } from '../lib/errors';
import { avatarKey } from '../media/storage';

/**
 * Everyone on a Koode instance joined by invite, so the directory is all
 * active members (minus yourself). Only public profile fields are returned.
 */
export const users = new Hono<AppEnv>()
  .use(requireAuth)
  .get('/', async (c) => {
    const me = c.get('auth').userId;
    const db = c.env.DB;
    const mine = await db
      .prepare('SELECT last_seen_visibility FROM users WHERE id = ?')
      .bind(me)
      .first<{ last_seen_visibility: string }>();
    const { results } = await db
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.about, u.online, u.last_seen_at,
           u.last_seen_visibility = 'contacts' AND EXISTS (
             SELECT 1 FROM conversation_members a
             JOIN conversation_members b ON b.conversation_id = a.conversation_id
             WHERE a.user_id = ?1 AND b.user_id = u.id
           ) AS shares_presence
         FROM users u WHERE u.status = 'active' AND u.id != ?1
         ORDER BY u.display_name COLLATE NOCASE`,
      )
      .bind(me)
      .all<{
        id: string;
        username: string;
        display_name: string;
        about: string;
        online: number;
        last_seen_at: number | null;
        shares_presence: number;
      }>();
    // Presence goes both ways: if I hide mine, I see nobody's.
    const seePresence = mine?.last_seen_visibility === 'contacts';
    return c.json<{ users: PublicUser[] }>({
      users: results.map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.display_name,
        about: u.about,
        ...(seePresence && u.shares_presence
          ? { online: u.online === 1, lastSeenAt: u.last_seen_at }
          : {}),
      })),
    });
  })

  /**
   * Someone's current profile photo, as ciphertext. Any member may fetch it
   * (everyone on an instance can see the directory), but only people the owner
   * has written to have the key.
   */
  .get('/:id/avatar/:avatarId', async (c) => {
    const { id, avatarId } = c.req.param();
    const row = await c.env.DB.prepare(
      "SELECT avatar_key FROM users WHERE id = ? AND status = 'active'",
    )
      .bind(id)
      .first<{ avatar_key: string | null }>();
    // Only the current photo; old ones are deleted when replaced.
    if (!row || row.avatar_key !== avatarId) throw new ApiError('not_found', 'No such photo');
    const object = await c.env.MEDIA.get(avatarKey(id, avatarId));
    if (!object) throw new ApiError('not_found', 'No such photo');
    return new Response(object.body, {
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(object.size),
        'cache-control': 'private, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
      },
    });
  });
