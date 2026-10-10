import { env, SELF } from 'cloudflare:test';
import { ConversationSummary, Message, MessagePage, StoredAttachment } from '@koode/shared';
import { describe, expect, it } from 'vitest';
import { api, registerUser, seedInvite, sendMessage, twoUsers } from './helpers';

describe('deleting an account', () => {
  it('needs a typed confirmation, then erases the account and what it sent', async () => {
    const { maya, dan } = await twoUsers();
    const direct = (
      await api('/conversations', {
        body: { kind: 'direct', userId: dan.user.id },
        token: maya.accessToken,
      })
    ).json.id as string;
    const group = ConversationSummary.parse(
      (
        await api('/conversations', {
          body: { kind: 'group', title: 'Family', memberIds: [dan.user.id] },
          token: maya.accessToken,
        })
      ).json,
    );
    const hello = Message.parse((await sendMessage(maya, direct, 'hello')).json);
    await sendMessage(maya, group.id, 'hi all');
    const meta = StoredAttachment.parse(
      (
        await api(`/conversations/${direct}/attachments`, {
          body: { sizeBytes: 4 },
          token: maya.accessToken,
        })
      ).json,
    );
    await SELF.fetch(`https://api.test/v1/attachments/${meta.id}/content`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${maya.accessToken}`, 'content-length': '4' },
      body: new Uint8Array(new ArrayBuffer(4)),
    });
    await sendMessage(maya, direct, 'file', { attachmentId: meta.id });
    const reply = Message.parse((await sendMessage(dan, direct, 'hi Maya')).json);

    expect((await api('/me', { method: 'DELETE', body: {}, token: maya.accessToken })).status).toBe(
      400,
    );
    expect(
      (await api('/me', { method: 'DELETE', body: { confirm: 'DELETE' }, token: maya.accessToken }))
        .status,
    ).toBe(200);

    // Signed out everywhere.
    expect((await api('/me', { token: maya.accessToken })).status).toBe(401);

    // Dan: Maya's messages are deleted for everyone; his own stay.
    const page = MessagePage.parse(
      (await api(`/conversations/${direct}/messages`, { token: dan.accessToken })).json,
    );
    const mine = page.messages.filter((m) => m.senderId === maya.user.id);
    expect(mine.length).toBe(2);
    expect(
      mine.every((m) => m.deletedAt !== null && m.envelopes.length === 0 && !m.attachment),
    ).toBe(true);
    expect(page.messages.find((m) => m.id === hello.id)?.deletedAt).not.toBeNull();
    expect(page.messages.find((m) => m.id === reply.id)?.deletedAt).toBeNull(); // Dan's own stay
    expect(
      (
        await SELF.fetch(`https://api.test/v1/attachments/${meta.id}/content`, {
          headers: { authorization: `Bearer ${dan.accessToken}` },
        })
      ).status,
    ).toBe(404);

    // She left the group (recorded) and Dan became its admin.
    const g = ConversationSummary.parse(
      (await api(`/conversations/${group.id}`, { token: dan.accessToken })).json,
    );
    expect(g.members.map((m) => [m.userId, m.role])).toEqual([[dan.user.id, 'admin']]);
    const groupPage = MessagePage.parse(
      (await api(`/conversations/${group.id}/messages`, { token: dan.accessToken })).json,
    );
    expect(
      groupPage.messages.filter((m) => m.kind === 'system').map((m) => m.system?.action),
    ).toEqual(['created', 'left', 'promoted']);

    // Gone from the directory and the key directory; the username is free again.
    expect((await api('/users', { token: dan.accessToken })).json.users).toEqual([]);
    expect(
      (await api(`/keys/devices?userIds=${maya.user.id}`, { token: dan.accessToken })).json.devices,
    ).toEqual([]);
    await seedInvite('NEWMAYA00001');
    expect((await registerUser({ inviteCode: 'NEWMAYA00001', username: 'maya' })).status).toBe(201);

    const row = await env.DB.prepare(
      'SELECT display_name, recovery_key_hash, status FROM users WHERE id = ?',
    )
      .bind(maya.user.id)
      .first();
    expect(row).toEqual({
      display_name: 'Deleted account',
      recovery_key_hash: null,
      status: 'disabled',
    });
    const audit = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_events WHERE event = 'account_deleted'",
    ).first<{
      n: number;
    }>();
    expect(audit?.n).toBe(1);
  });
});
