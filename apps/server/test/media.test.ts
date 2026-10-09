import { createExecutionContext, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import {
  ConversationSummary,
  Message,
  MessagePage,
  StoredAttachment,
  type AuthSession,
} from '@koode/shared';
import { describe, expect, it } from 'vitest';
import worker from '../src';
import { cleanupUnsent, contentKey, UNSENT_TTL_MS } from '../src/media/storage';
import { api, opened, openSocket, sendMessage, twoUsers } from './helpers';

const bytes = (n: number, fill = 7) => new Uint8Array(new ArrayBuffer(n)).fill(fill);

/** A direct chat between two people (whose devices have published keys). */
async function chat() {
  const { maya, dan } = await twoUsers();
  const id = (
    await api('/conversations', {
      body: { kind: 'direct', userId: dan.user.id },
      token: maya.accessToken,
    })
  ).json.id as string;
  return { maya, dan, id };
}

const create = (s: AuthSession, conversationId: string, body: unknown) =>
  api(`/conversations/${conversationId}/attachments`, { body, token: s.accessToken });

async function put(
  s: AuthSession,
  path: string,
  data: Uint8Array<ArrayBuffer>,
  type = 'application/octet-stream',
) {
  const res = await SELF.fetch(`https://api.test/v1/attachments/${path}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${s.accessToken}`,
      'content-type': type,
      'content-length': String(data.byteLength),
    },
    body: data,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const get = (s: AuthSession, path: string, headers: Record<string, string> = {}) =>
  SELF.fetch(`https://api.test/v1/attachments/${path}`, {
    headers: { authorization: `Bearer ${s.accessToken}`, ...headers },
  });

/** Uploaded (as ciphertext) and ready to send. */
async function uploaded(s: AuthSession, conversationId: string, size = 1000) {
  const meta = StoredAttachment.parse((await create(s, conversationId, { sizeBytes: size })).json);
  expect((await put(s, `${meta.id}/content`, bytes(size))).status).toBe(200);
  return meta;
}

const sendFile = (s: AuthSession, conversationId: string, attachmentId: string) =>
  sendMessage(s, conversationId, 'file', { attachmentId });

describe('encrypted uploads', () => {
  it('accept only a ciphertext size: no type, name or dimensions', async () => {
    const { maya, id } = await chat();
    expect((await create(maya, id, { sizeBytes: 0 })).status).toBe(400);
    expect((await create(maya, id, { sizeBytes: 101 * 1024 * 1024 })).status).toBe(400);
    // The pre-encryption request shape leaks metadata: refused.
    expect(
      (
        await create(maya, id, {
          kind: 'image',
          mimeType: 'image/jpeg',
          sizeBytes: 10,
          width: 1,
          height: 1,
        })
      ).status,
    ).toBe(400);
    expect((await create(maya, 'cnv_not_mine', { sizeBytes: 10 })).status).toBe(404);
    const meta = StoredAttachment.parse((await create(maya, id, { sizeBytes: 10 })).json);
    expect(meta).toMatchObject({ kind: 'encrypted', mimeType: 'application/octet-stream' });
  });

  it('stores exactly the declared bytes, only for the uploader', async () => {
    const { maya, dan, id } = await chat();
    const meta = StoredAttachment.parse((await create(maya, id, { sizeBytes: 100 })).json);
    expect((await put(maya, `${meta.id}/content`, bytes(99))).status).toBe(400);
    expect((await put(dan, `${meta.id}/content`, bytes(100))).status).toBe(404);
    expect((await put(maya, `${meta.id}/content`, bytes(100))).status).toBe(200);
    expect((await env.MEDIA.get(contentKey(id, meta.id)))?.size).toBe(100);
  });

  it('are private until sent, then readable by members only, as opaque downloads', async () => {
    const { maya, dan, id } = await chat();
    const meta = await uploaded(maya, id, 500);
    expect((await get(maya, `${meta.id}/content`)).status).toBe(200);
    expect((await get(dan, `${meta.id}/content`)).status).toBe(404);

    const sent = await sendFile(maya, id, meta.id);
    expect(sent.status).toBe(201);
    expect(Message.parse(sent.json)).toMatchObject({
      kind: 'attachment',
      attachment: { id: meta.id, kind: 'encrypted', width: null, preview: null },
    });

    const res = await get(dan, `${meta.id}/content`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await res.arrayBuffer()).byteLength).toBe(500);
    expect((await SELF.fetch(`https://api.test/v1/attachments/${meta.id}/content`)).status).toBe(
      401,
    );
  });

  it('serve byte ranges', async () => {
    const { maya, dan, id } = await chat();
    const meta = await uploaded(maya, id, 1000);
    await sendFile(maya, id, meta.id);
    const res = await get(dan, `${meta.id}/content`, { range: 'bytes=100-199' });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 100-199/1000');
    expect((await res.arrayBuffer()).byteLength).toBe(100);
  });

  it('take an encrypted poster', async () => {
    const { maya, dan, id } = await chat();
    const meta = await uploaded(maya, id, 50);
    expect((await put(maya, `${meta.id}/thumbnail`, bytes(30), 'image/jpeg')).status).toBe(400);
    expect((await put(maya, `${meta.id}/thumbnail`, bytes(30))).status).toBe(200);
    const sent = Message.parse((await sendFile(maya, id, meta.id)).json);
    expect(sent.attachment).toMatchObject({ hasThumbnail: true });
    const poster = await get(dan, `${meta.id}/thumbnail`);
    expect(poster.status).toBe(200);
    expect(poster.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('are sent once, only by the uploader, only where uploaded', async () => {
    const { maya, dan, id } = await chat();
    const meta = await uploaded(maya, id);
    expect((await sendFile(dan, id, meta.id)).status).toBe(400); // not Dan's
    expect((await sendFile(maya, id, meta.id)).status).toBe(201);
    expect((await sendFile(maya, id, meta.id)).status).toBe(409);
    const unfinished = StoredAttachment.parse((await create(maya, id, { sizeBytes: 10 })).json);
    expect((await sendFile(maya, id, unfinished.id)).status).toBe(400);
  });

  it('are removed if never sent', async () => {
    const { maya, id } = await chat();
    const sent = await uploaded(maya, id);
    await sendFile(maya, id, sent.id);
    const abandoned = await uploaded(maya, id);

    const ctx = createExecutionContext();
    await worker.scheduled!(
      { cron: '17 * * * *', scheduledTime: Date.now(), noRetry() {} } as ScheduledController,
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(await env.MEDIA.head(contentKey(id, abandoned.id))).not.toBeNull(); // still fresh

    expect(await cleanupUnsent(env, Date.now() + UNSENT_TTL_MS + 1)).toBe(1);
    expect(await env.MEDIA.head(contentKey(id, abandoned.id))).toBeNull();
    expect(await env.MEDIA.head(contentKey(id, sent.id))).not.toBeNull();
  });
});

describe('reactions (encrypted messages)', () => {
  it('reach everyone without counting as activity', async () => {
    const { maya, dan, id } = await chat();
    const m = Message.parse((await sendMessage(maya, id, 'hi')).json);
    const mayaSocket = await openSocket(maya.accessToken);
    await mayaSocket.next('ready');

    const r = await sendMessage(dan, id, '👍', { targetId: m.id });
    expect(r.status).toBe(201);
    expect(Message.parse(r.json)).toMatchObject({ kind: 'reaction', targetId: m.id, body: '' });
    const event = (await mayaSocket.next('message'))?.message as Message;
    expect(event).toMatchObject({ kind: 'reaction', targetId: m.id });
    expect(opened(event)).toBe('👍'); // only devices can read which emoji

    const summary = ConversationSummary.parse(
      (await api(`/conversations/${id}`, { token: maya.accessToken })).json,
    );
    expect(summary.lastMessage?.id).toBe(m.id);
    expect(summary.unreadCount).toBe(0);
  });

  it('need a real target', async () => {
    const { maya, dan, id } = await chat();
    const m = Message.parse((await sendMessage(maya, id, 'hi')).json);
    const reaction = Message.parse((await sendMessage(dan, id, '👍', { targetId: m.id })).json);
    const react = (targetId: string) => sendMessage(dan, id, '❤️', { targetId });
    expect((await react(crypto.randomUUID())).status).toBe(400);
    expect((await react(reaction.id)).status).toBe(400); // not to a reaction
    const created = await api('/conversations', {
      body: { kind: 'group', title: 'G', memberIds: [dan.user.id] },
      token: maya.accessToken,
    });
    const g = ConversationSummary.parse(created.json);
    const system = g.lastMessage!;
    expect((await sendMessage(dan, g.id, '👍', { targetId: system.id })).status).toBe(400);
  });
});

describe('deleting messages', () => {
  it('erases ciphertext, the file and reactions to it, for everyone', async () => {
    const { maya, dan, id } = await chat();
    const meta = await uploaded(maya, id);
    const m = Message.parse((await sendFile(maya, id, meta.id)).json);
    const reaction = Message.parse((await sendMessage(dan, id, '😂', { targetId: m.id })).json);

    const del = (s: AuthSession, messageId: string) =>
      api(`/conversations/${id}/messages/${messageId}`, { method: 'DELETE', token: s.accessToken });
    expect((await del(dan, m.id)).status).toBe(403);
    expect((await del(dan, reaction.id)).status).toBe(400); // reactions are replaced, not deleted
    const res = await del(maya, m.id);
    expect(Message.parse(res.json)).toMatchObject({
      attachment: null,
      envelopes: [],
      deletedAt: expect.any(Number),
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(await env.MEDIA.head(contentKey(id, meta.id))).toBeNull();
    expect((await get(dan, `${meta.id}/content`)).status).toBe(404);
    const left = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM message_envelopes WHERE message_id IN (?, ?)',
    )
      .bind(m.id, reaction.id)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
    expect((await sendMessage(dan, id, '👍', { targetId: m.id })).status).toBe(400);

    const page = MessagePage.parse(
      (await api(`/conversations/${id}/messages`, { token: maya.accessToken })).json,
    );
    expect(page.messages.find((x) => x.id === reaction.id)?.deletedAt).toEqual(expect.any(Number));
  });

  it('reports changes after a revision so devices catch up', async () => {
    const { maya, dan, id } = await chat();
    const a = Message.parse((await sendMessage(maya, id, 'one')).json);
    const b = Message.parse((await sendMessage(maya, id, 'two')).json);
    const before = (await api(`/conversations/${id}`, { token: dan.accessToken })).json.lastRev;
    expect(before).toBe(b.rev);

    const r = Message.parse((await sendMessage(dan, id, '👍', { targetId: a.id })).json);
    const c = Message.parse((await sendMessage(maya, id, 'three')).json);
    await api(`/conversations/${id}/messages/${b.id}`, {
      method: 'DELETE',
      token: maya.accessToken,
    });

    const page = MessagePage.parse(
      (
        await api(`/conversations/${id}/messages?changedSince=${before}`, {
          token: dan.accessToken,
        })
      ).json,
    );
    expect(page.messages.map((m) => [m.id, m.deletedAt !== null])).toEqual([
      [r.id, false],
      [c.id, false],
      [b.id, true],
    ]);
    expect(opened(page.messages[1]!)).toBe('three');
    const summary = (await api(`/conversations/${id}`, { token: dan.accessToken })).json;
    expect(summary.lastRev).toBe(page.messages.at(-1)!.rev);
  });
});
