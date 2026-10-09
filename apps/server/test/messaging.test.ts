import { env } from 'cloudflare:test';
import { ConversationSummary, Message, MessagePage, UserDirectory } from '@koode/shared';
import { describe, expect, it } from 'vitest';
import { api, openSocket, registerUser, seedInvite, twoUsers, uuid } from './helpers';

const send = (
  token: string,
  conversationId: string,
  body: string,
  id = uuid(),
  replyToId?: string,
) => api(`/conversations/${conversationId}/messages`, { body: { id, body, replyToId }, token });

async function directChat() {
  const users = await twoUsers();
  const res = await api('/conversations', {
    body: { kind: 'direct', userId: users.dan.user.id },
    token: users.maya.accessToken,
  });
  return { ...users, conversation: ConversationSummary.parse(res.json), status: res.status };
}

describe('directory and conversations', () => {
  it('lists other active members only', async () => {
    const { maya } = await twoUsers();
    const { users } = UserDirectory.parse((await api('/users', { token: maya.accessToken })).json);
    expect(users.map((u) => u.username)).toEqual(['dan']);
    expect(Object.keys(users[0]!).sort()).toEqual(['about', 'displayName', 'id', 'username']);
  });

  it('creates one direct conversation per pair, whoever starts it', async () => {
    const { conversation, status, maya, dan } = await directChat();
    expect(status).toBe(201);
    expect(conversation.members.map((m) => m.userId).sort()).toEqual(
      [dan.user.id, maya.user.id].sort(),
    );
    const again = await api('/conversations', {
      body: { kind: 'direct', userId: maya.user.id },
      token: dan.accessToken,
    });
    expect(again.status).toBe(200);
    expect(again.json.id).toBe(conversation.id);
  });

  it('rejects chats with yourself or unknown users', async () => {
    const { maya } = await twoUsers();
    expect(
      (
        await api('/conversations', {
          body: { kind: 'direct', userId: maya.user.id },
          token: maya.accessToken,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api('/conversations', {
          body: { kind: 'direct', userId: 'usr_nope' },
          token: maya.accessToken,
        })
      ).status,
    ).toBe(404);
  });

  it('creates groups with the creator as admin', async () => {
    const { maya, dan } = await twoUsers();
    const res = await api('/conversations', {
      body: { kind: 'group', title: 'Family', memberIds: [dan.user.id] },
      token: maya.accessToken,
    });
    expect(res.status).toBe(201);
    const g = ConversationSummary.parse(res.json);
    expect(g).toMatchObject({ kind: 'group', title: 'Family' });
    expect(g.members.find((m) => m.userId === maya.user.id)?.role).toBe('admin');
  });
});

describe('messages', () => {
  it('assigns increasing sequence numbers and stores server timestamps', async () => {
    const { conversation: c, maya, dan } = await directChat();
    const a = Message.parse((await send(maya.accessToken, c.id, ' hello ')).json);
    const b = Message.parse((await send(dan.accessToken, c.id, 'hi!')).json);
    expect(a).toMatchObject({ seq: 1, body: 'hello', senderId: maya.user.id });
    expect(b.seq).toBe(2);
    expect(b.createdAt).toBeGreaterThanOrEqual(a.createdAt);
  });

  it('is idempotent on retry and refuses reusing an id elsewhere', async () => {
    const { conversation: c, maya, dan } = await directChat();
    const id = uuid();
    const first = await send(maya.accessToken, c.id, 'once', id);
    const retry = await send(maya.accessToken, c.id, 'once', id);
    expect(retry.json).toEqual(first.json);
    expect((await send(dan.accessToken, c.id, 'hijack', id)).status).toBe(409);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('only lets members read or write', async () => {
    const { conversation: c } = await directChat();
    await seedInvite('THRDPERS0N00');
    const eve = await registerUser({ inviteCode: 'THRDPERS0N00', username: 'eve' });
    expect((await send(eve.session.accessToken, c.id, 'hi')).status).toBe(404);
    expect(
      (await api(`/conversations/${c.id}/messages`, { token: eve.session.accessToken })).status,
    ).toBe(404);
    expect((await api(`/conversations/${c.id}`, { token: eve.session.accessToken })).status).toBe(
      404,
    );
    expect(
      (
        await api(`/conversations/${c.id}/receipts`, {
          body: { read: 1 },
          token: eve.session.accessToken,
        })
      ).status,
    ).toBe(404);
  });

  it('validates replies and bodies', async () => {
    const { conversation: c, maya } = await directChat();
    const parent = Message.parse((await send(maya.accessToken, c.id, 'parent')).json);
    expect((await send(maya.accessToken, c.id, 'reply', uuid(), parent.id)).json.replyToId).toBe(
      parent.id,
    );
    expect((await send(maya.accessToken, c.id, 'bad reply', uuid(), uuid())).status).toBe(400);
    expect((await send(maya.accessToken, c.id, '   ')).status).toBe(400);
    expect((await send(maya.accessToken, c.id, 'x'.repeat(4001))).status).toBe(400);
  });

  it('paginates backward from the newest and forward after a cursor', async () => {
    const { conversation: c, maya } = await directChat();
    for (let i = 1; i <= 7; i++) await send(maya.accessToken, c.id, `m${i}`);
    const latest = MessagePage.parse(
      (await api(`/conversations/${c.id}/messages?limit=3`, { token: maya.accessToken })).json,
    );
    expect(latest.messages.map((m) => m.body)).toEqual(['m5', 'm6', 'm7']);
    expect(latest.hasMore).toBe(true);
    const older = MessagePage.parse(
      (await api(`/conversations/${c.id}/messages?before=5&limit=3`, { token: maya.accessToken }))
        .json,
    );
    expect(older.messages.map((m) => m.seq)).toEqual([2, 3, 4]);
    const oldest = MessagePage.parse(
      (await api(`/conversations/${c.id}/messages?before=2&limit=3`, { token: maya.accessToken }))
        .json,
    );
    expect(oldest).toMatchObject({ hasMore: false });
    expect(oldest.messages.map((m) => m.seq)).toEqual([1]);
    const after = MessagePage.parse(
      (await api(`/conversations/${c.id}/messages?after=5`, { token: maya.accessToken })).json,
    );
    expect(after.messages.map((m) => m.seq)).toEqual([6, 7]);
    expect(
      (await api(`/conversations/${c.id}/messages?after=-1`, { token: maya.accessToken })).status,
    ).toBe(400);
  });
});

describe('receipts and unread counts', () => {
  const summaryFor = async (token: string, id: string) =>
    ConversationSummary.parse((await api(`/conversations/${id}`, { token })).json);

  it('tracks unread counts and delivered/read positions', async () => {
    const { conversation: c, maya, dan } = await directChat();
    await send(maya.accessToken, c.id, 'one');
    await send(maya.accessToken, c.id, 'two');
    expect((await summaryFor(dan.accessToken, c.id)).unreadCount).toBe(2);
    expect((await summaryFor(maya.accessToken, c.id)).unreadCount).toBe(0); // own messages

    await api(`/conversations/${c.id}/receipts`, {
      body: { delivered: 2 },
      token: dan.accessToken,
    });
    let danSeenByMaya = (await summaryFor(maya.accessToken, c.id)).members.find(
      (m) => m.userId === dan.user.id,
    )!;
    expect(danSeenByMaya).toMatchObject({ lastDeliveredSeq: 2, lastReadSeq: 0 });

    await api(`/conversations/${c.id}/receipts`, { body: { read: 1 }, token: dan.accessToken });
    expect((await summaryFor(dan.accessToken, c.id)).unreadCount).toBe(1);
    danSeenByMaya = (await summaryFor(maya.accessToken, c.id)).members.find(
      (m) => m.userId === dan.user.id,
    )!;
    expect(danSeenByMaya.lastReadSeq).toBe(1);
  });

  it('never moves backwards or beyond the last message', async () => {
    const { conversation: c, maya, dan } = await directChat();
    await send(maya.accessToken, c.id, 'one');
    await api(`/conversations/${c.id}/receipts`, { body: { read: 99 }, token: dan.accessToken });
    await api(`/conversations/${c.id}/receipts`, { body: { read: 0 }, token: dan.accessToken });
    const me = (await summaryFor(dan.accessToken, c.id)).members.find(
      (m) => m.userId === dan.user.id,
    )!;
    expect(me).toMatchObject({ lastReadSeq: 1, lastDeliveredSeq: 1 });
  });

  it('keeps read positions private when read receipts are off', async () => {
    const { conversation: c, maya, dan } = await directChat();
    await send(maya.accessToken, c.id, 'one');
    await api(`/conversations/${c.id}/receipts`, {
      body: { read: 1, shareRead: false },
      token: dan.accessToken,
    });
    expect((await summaryFor(dan.accessToken, c.id)).unreadCount).toBe(0);
    const danSeenByMaya = (await summaryFor(maya.accessToken, c.id)).members.find(
      (m) => m.userId === dan.user.id,
    )!;
    expect(danSeenByMaya).toMatchObject({ lastDeliveredSeq: 1, lastReadSeq: 0 });
  });

  it('lists conversations newest-activity first with the last message', async () => {
    const { conversation: c, maya, dan } = await directChat();
    await send(maya.accessToken, c.id, 'latest');
    const list = (await api('/conversations', { token: dan.accessToken })).json.conversations;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: c.id, lastSeq: 1, unreadCount: 1 });
    expect(list[0].lastMessage.body).toBe('latest');
  });
});

describe('realtime', () => {
  it('rejects unauthenticated upgrades', async () => {
    expect((await openSocket()).status).toBe(401);
    expect((await openSocket('bogus')).status).toBe(401);
  });

  it('delivers messages and receipts live to every device', async () => {
    const { conversation: c, maya, dan } = await directChat();
    const danSocket = await openSocket(dan.accessToken);
    const mayaSocket = await openSocket(maya.accessToken);
    expect(await danSocket.next('ready')).toBeTruthy();
    expect(await mayaSocket.next('ready')).toBeTruthy();

    await send(maya.accessToken, c.id, 'live!');
    const toDan = await danSocket.next('message');
    expect((toDan?.message as { body: string }).body).toBe('live!');
    // The sender's own devices get it too (multi-device sync).
    expect(await mayaSocket.next('message')).toBeTruthy();

    await api(`/conversations/${c.id}/receipts`, { body: { read: 1 }, token: dan.accessToken });
    expect(await mayaSocket.next('receipt')).toMatchObject({
      conversationId: c.id,
      userId: dan.user.id,
      readSeq: 1,
    });
  });

  it('relays typing to the other members only', async () => {
    const { conversation: c, maya, dan } = await directChat();
    const danSocket = await openSocket(dan.accessToken);
    const mayaSocket = await openSocket(maya.accessToken);
    await danSocket.next('ready');
    await mayaSocket.next('ready');
    mayaSocket.ws!.send(JSON.stringify({ type: 'typing', conversationId: c.id }));
    expect(await danSocket.next('typing')).toMatchObject({
      conversationId: c.id,
      userId: maya.user.id,
    });
    expect(await mayaSocket.next('typing', 300)).toBeNull();
  });

  it('answers heartbeats and ignores malformed frames', async () => {
    const { maya } = await twoUsers();
    const s = await openSocket(maya.accessToken);
    await s.next('ready');
    s.ws!.send('not json');
    s.ws!.send(JSON.stringify({ type: 'typing', conversationId: 'cnv_not_mine' }));
    s.ws!.send(JSON.stringify({ type: 'ping' }));
    expect(await s.next('pong')).toEqual({ type: 'pong' });
  });

  it('closes a device’s socket when it signs out', async () => {
    const { maya } = await twoUsers();
    const s = await openSocket(maya.accessToken);
    await s.next('ready');
    await api('/auth/logout', { body: {}, token: maya.accessToken });
    const deadline = Date.now() + 2000;
    while (!s.closed() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(s.closed()?.code).toBe(4001);
  });
});
