import type { PublicUser } from '@koode/shared';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAuth } from '../auth/middleware';

/**
 * Everyone on a Koode instance joined by invite, so the directory is all
 * active members (minus yourself). Only public profile fields are returned.
 */
export const users = new Hono<AppEnv>().use(requireAuth).get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, username, display_name, about FROM users WHERE status = 'active' AND id != ? ORDER BY display_name COLLATE NOCASE`,
  )
    .bind(c.get('auth').userId)
    .all<{ id: string; username: string; display_name: string; about: string }>();
  return c.json<{ users: PublicUser[] }>({
    users: results.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      about: u.about,
    })),
  });
});
