import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('D1 migrations', () => {
  it('create the identity tables', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(
      expect.arrayContaining([
        'audit_events',
        'auth_challenges',
        'devices',
        'invites',
        'rate_limits',
        'sessions',
        'users',
      ]),
    );
  });

  it('enforce constraints', async () => {
    const now = Date.now();
    await env.DB.prepare(
      'INSERT INTO users (id, username, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind('u1', 'Asha', 'Asha', now, now)
      .run();
    // usernames are unique case-insensitively
    await expect(
      env.DB.prepare(
        'INSERT INTO users (id, username, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
        .bind('u2', 'asha', 'Other', now, now)
        .run(),
    ).rejects.toThrow(/UNIQUE/);
    // invalid enum values are rejected
    await expect(
      env.DB.prepare(
        "INSERT INTO devices (id, user_id, name, platform, signing_public_key, created_at) VALUES ('d1', 'u1', 'x', 'windows', 'k', ?)",
      )
        .bind(now)
        .run(),
    ).rejects.toThrow(/CHECK/);
  });
});

describe('Durable Objects', () => {
  it('ConversationRoom answers RPC and refuses unknown conversations', async () => {
    const stub = env.CONVERSATION_ROOM.get(env.CONVERSATION_ROOM.idFromName('cnv_missing'));
    const res = await stub.typing({ conversationId: 'cnv_missing', userId: 'usr_x' });
    expect(res).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('UserSocket starts with no connections', async () => {
    const stub = env.USER_SOCKET.get(env.USER_SOCKET.idFromName('usr_x'));
    expect(await stub.connectionCount()).toBe(0);
  });
});

describe('R2 media bucket', () => {
  it('is bound', async () => {
    await env.MEDIA.put('probe', 'x');
    expect(await (await env.MEDIA.get('probe'))?.text()).toBe('x');
  });
});
