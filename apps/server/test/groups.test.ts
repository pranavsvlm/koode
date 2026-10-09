import { env, SELF } from 'cloudflare:test';
import {
  ConversationSummary,
  StoredAttachment,
  Message,
  type AuthSession,
  type SystemEvent,
} from '@koode/shared';
import { describe, expect, it } from 'vitest';
import { api, openSocket, registerUser, sendMessage, twoUsers } from './helpers';

async function threeUsers() {
  const { maya, dan } = await twoUsers();
  const invite = await api('/invites', { body: {}, token: maya.accessToken });
  const sam = (
    await registerUser({ inviteCode: invite.json.code, username: 'sam', displayName: 'Sam Lee' })
  ).session;
  return { maya, dan, sam };
}

async function group(owner: AuthSession, members: AuthSession[], title = 'Family') {
  const res = await api('/conversations', {
    body: { kind: 'group', title, memberIds: members.map((m) => m.user.id) },
    token: owner.accessToken,
  });
  return ConversationSummary.parse(res.json);
}

const history = async (s: AuthSession, id: string) =>
  (await api(`/conversations/${id}/messages`, { token: s.accessToken })).json.messages as Message[];
const systemEvents = async (s: AuthSession, id: string) =>
  (await history(s, id)).filter((m) => m.kind === 'system').map((m) => m.system as SystemEvent);
const summary = async (s: AuthSession, id: string) =>
  (await api(`/conversations/${id}`, { token: s.accessToken })).json as ConversationSummary;
const role = async (s: AuthSession, id: string, userId: string) =>
  (await summary(s, id)).members.find((m) => m.userId === userId)?.role;

describe('group administration', () => {
  it('records the creation; system messages are not unread', async () => {
    const { maya, dan } = await twoUsers();
    const g = await group(maya, [dan]);
    expect(await systemEvents(dan, g.id)).toEqual([
      { action: 'created', actorId: maya.user.id, targetIds: [dan.user.id], title: 'Family' },
    ]);
    expect((await summary(dan, g.id)).unreadCount).toBe(0);
  });

  it('lets admins rename; members and direct chats can’t', async () => {
    const { maya, dan } = await twoUsers();
    const g = await group(maya, [dan]);
    const rename = (s: AuthSession, id: string) =>
      api(`/conversations/${id}`, {
        method: 'PATCH',
        body: { title: 'Cousins' },
        token: s.accessToken,
      });
    expect((await rename(dan, g.id)).status).toBe(403);
    expect((await rename(maya, g.id)).json.title).toBe('Cousins');
    expect((await systemEvents(dan, g.id)).at(-1)).toMatchObject({
      action: 'renamed',
      title: 'Cousins',
    });
    const direct = (
      await api('/conversations', {
        body: { kind: 'direct', userId: dan.user.id },
        token: maya.accessToken,
      })
    ).json.id;
    expect((await rename(maya, direct)).status).toBe(400);
  });

  it('adds people, who see the group from now on', async () => {
    const { maya, dan, sam } = await threeUsers();
    const g = await group(maya, [dan]);
    await sendMessage(maya, g.id, 'before Sam');
    const samSocket = await openSocket(sam.accessToken);
    await samSocket.next('ready');

    const add = (s: AuthSession) =>
      api(`/conversations/${g.id}/members`, {
        body: { userIds: [sam.user.id] },
        token: s.accessToken,
      });
    expect((await add(dan)).status).toBe(403);
    expect((await add(maya)).status).toBe(200);
    expect(await samSocket.next('conversation')).toMatchObject({ conversationId: g.id });
    expect((await summary(sam, g.id)).unreadCount).toBe(0);
    expect((await systemEvents(sam, g.id)).at(-1)).toEqual({
      action: 'added',
      actorId: maya.user.id,
      targetIds: [sam.user.id],
      title: null,
    });
    expect(
      (
        await api(`/conversations/${g.id}/members`, {
          body: { userIds: ['usr_nobody'] },
          token: maya.accessToken,
        })
      ).status,
    ).toBe(404);
  });

  it('removes people, who then lose access to messages and files', async () => {
    const { maya, dan } = await twoUsers();
    const g = await group(maya, [dan]);
    const meta = StoredAttachment.parse(
      (
        await api(`/conversations/${g.id}/attachments`, {
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
    await sendMessage(maya, g.id, 'photo', { attachmentId: meta.id });
    const danSocket = await openSocket(dan.accessToken);
    await danSocket.next('ready');

    expect(
      (
        await api(`/conversations/${g.id}/members/${dan.user.id}`, {
          method: 'DELETE',
          token: maya.accessToken,
        })
      ).status,
    ).toBe(200);
    expect(await danSocket.next('conversation')).toMatchObject({ conversationId: g.id });
    expect((await api(`/conversations/${g.id}/messages`, { token: dan.accessToken })).status).toBe(
      404,
    );
    const file = await SELF.fetch(`https://api.test/v1/attachments/${meta.id}/content`, {
      headers: { authorization: `Bearer ${dan.accessToken}` },
    });
    expect(file.status).toBe(404);
    expect((await systemEvents(maya, g.id)).at(-1)).toMatchObject({
      action: 'removed',
      targetIds: [dan.user.id],
    });
  });

  it('keeps an admin when the last one leaves', async () => {
    const { maya, dan, sam } = await threeUsers();
    const g = await group(maya, [dan, sam]);
    expect(
      (
        await api(`/conversations/${g.id}/members/${maya.user.id}`, {
          method: 'DELETE',
          token: maya.accessToken,
        })
      ).status,
    ).toBe(200);
    const events = await systemEvents(dan, g.id);
    expect(events.slice(-2).map((e) => e.action)).toEqual(['left', 'promoted']);
    const promoted = events.at(-1)!.targetIds[0]!;
    expect(await role(dan, g.id, promoted)).toBe('admin');
    expect((await summary(dan, g.id)).members.map((m) => m.userId)).not.toContain(maya.user.id);
  });

  it('promotes and demotes, but never removes the last admin', async () => {
    const { maya, dan } = await twoUsers();
    const g = await group(maya, [dan]);
    const setRole = (s: AuthSession, userId: string, r: string) =>
      api(`/conversations/${g.id}/members/${userId}`, {
        method: 'PATCH',
        body: { role: r },
        token: s.accessToken,
      });
    expect((await setRole(dan, dan.user.id, 'admin')).status).toBe(403);
    expect((await setRole(maya, maya.user.id, 'member')).status).toBe(400); // only admin
    expect((await setRole(maya, dan.user.id, 'admin')).status).toBe(200);
    expect(await role(maya, g.id, dan.user.id)).toBe('admin');
    expect((await setRole(dan, maya.user.id, 'member')).status).toBe(200);
    expect((await systemEvents(maya, g.id)).slice(-2).map((e) => e.action)).toEqual([
      'promoted',
      'demoted',
    ]);
  });

  it('lets group admins delete anyone’s message', async () => {
    const { maya, dan } = await twoUsers();
    const g = await group(maya, [dan]);
    const m = Message.parse((await sendMessage(dan, g.id, 'spam')).json);
    const res = await api(`/conversations/${g.id}/messages/${m.id}`, {
      method: 'DELETE',
      token: maya.accessToken,
    });
    expect(res.status).toBe(200);
    expect(res.json.deletedAt).not.toBeNull();

    // Moderation and membership changes are audited — who and where, never content.
    const { results } = await env.DB.prepare(
      'SELECT event, user_id, metadata FROM audit_events WHERE event IN (?, ?) ORDER BY id',
    )
      .bind('group_changed', 'message_deleted')
      .all<{ event: string; user_id: string; metadata: string }>();
    expect(results.map((r) => [r.event, r.user_id])).toEqual([
      ['group_changed', maya.user.id],
      ['message_deleted', maya.user.id],
    ]);
    expect(JSON.parse(results[1]!.metadata)).toEqual({
      conversationId: g.id,
      senderId: dan.user.id,
    });
    expect(results.map((r) => r.metadata).join()).not.toContain('spam');
  });

  it('lets anyone leave a group but not a direct chat', async () => {
    const { maya, dan } = await twoUsers();
    const direct = (
      await api('/conversations', {
        body: { kind: 'direct', userId: dan.user.id },
        token: maya.accessToken,
      })
    ).json.id;
    expect(
      (
        await api(`/conversations/${direct}/members/${dan.user.id}`, {
          method: 'DELETE',
          token: dan.accessToken,
        })
      ).status,
    ).toBe(400);
  });
});
