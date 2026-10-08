import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('D1 migrations', () => {
  it('create the identity tables', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(
      expect.arrayContaining(['audit_events', 'devices', 'invites', 'sessions', 'users']),
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

describe('ConversationRoom Durable Object', () => {
  it('is bound and reachable', async () => {
    const stub = env.CONVERSATION_ROOM.get(env.CONVERSATION_ROOM.idFromName('test'));
    const res = await stub.fetch('https://do/');
    expect(res.status).toBe(501);
  });
});

describe('R2 media bucket', () => {
  it('is bound', async () => {
    await env.MEDIA.put('probe', 'x');
    expect(await (await env.MEDIA.get('probe'))?.text()).toBe('x');
  });
});
