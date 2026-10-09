import { createExecutionContext, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { AttachmentMeta, Message, type AuthSession } from '@koode/shared';
import { describe, expect, it } from 'vitest';
import worker from '../src';
import { cleanupUnsent, contentKey, UNSENT_TTL_MS } from '../src/media/storage';
import { api, openSocket, twoUsers, uuid } from './helpers';

const bytes = (n: number, fill = 7) => new Uint8Array(new ArrayBuffer(n)).fill(fill);

async function chat(a: AuthSession, b: AuthSession) {
  return (
    await api('/conversations', {
      body: { kind: 'direct', userId: b.user.id },
      token: a.accessToken,
    })
  ).json.id as string;
}

const image = (size: number) => ({
  kind: 'image',
  mimeType: 'image/jpeg',
  sizeBytes: size,
  width: 640,
  height: 480,
  preview: 'AAAA',
});

async function create(s: AuthSession, conversationId: string, body: unknown) {
  return api(`/conversations/${conversationId}/attachments`, { body, token: s.accessToken });
}

async function put(
  s: AuthSession,
  path: string,
  data: Uint8Array<ArrayBuffer>,
  type = 'image/jpeg',
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

/** Uploaded and ready to send. */
async function uploaded(s: AuthSession, conversationId: string, size = 1000) {
  const meta = AttachmentMeta.parse((await create(s, conversationId, image(size))).json);
  expect((await put(s, `${meta.id}/content`, bytes(size))).status).toBe(200);
  return meta;
}

const send = (s: AuthSession, conversationId: string, body: Record<string, unknown>) =>
  api(`/conversations/${conversationId}/messages`, {
    body: { id: uuid(), ...body },
    token: s.accessToken,
  });

describe('uploads', () => {
  it('validates type, size and file names before accepting an upload', async () => {
    const { maya, dan } = await twoUsers();
    const id = await chat(maya, dan);
    expect((await create(maya, id, { ...image(10), mimeType: 'image/svg+xml' })).status).toBe(400);
    expect((await create(maya, id, image(21 * 1024 * 1024))).status).toBe(400);
    expect(
      (
        await create(maya, id, {
          kind: 'document',
          mimeType: 'application/pdf',
          sizeBytes: 10,
          name: '../../etc/passwd',
        })
      ).status,
    ).toBe(400);
    expect((await create(maya, 'cnv_not_mine', image(10))).status).toBe(404);
  });

  it('stores exactly the declared bytes, only for the uploader', async () => {
    const { maya, dan } = await twoUsers();
    const id = await chat(maya, dan);
    const meta = AttachmentMeta.parse((await create(maya, id, image(100))).json);
    expect((await put(maya, `${meta.id}/content`, bytes(99))).status).toBe(400);
    expect((await put(dan, `${meta.id}/content`, bytes(100))).status).toBe(404);
    expect((await put(maya, `${meta.id}/content`, bytes(100))).status).toBe(200);
    const object = await env.MEDIA.get(contentKey(id, meta.id));
    expect(object?.size).toBe(100);
  });

  it('is private until sent, then readable by members only', async () => {
    const { maya, dan } = await twoUsers();
    const id = await chat(maya, dan);
    const meta = await uploaded(maya, id, 500);
    expect((await get(maya, `${meta.id}/content`)).status).toBe(200);
    expect((await get(dan, `${meta.id}/content`)).status).toBe(404);

    const sent = await send(maya, id, { attachmentId: meta.id });
    expect(sent.status).toBe(201);
    expect(Message.parse(sent.json)).toMatchObject({
      kind: 'attachment',
      body: '',
      attachment: { id: meta.id, kind: 'image', width: 640, height: 480, preview: 'AAAA' },
    });

    const res = await get(dan, `${meta.id}/content`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await res.arrayBuffer()).byteLength).toBe(500);
    expect((await SELF.fetch(`https://api.test/v1/attachments/${meta.id}/content`)).status).toBe(
      401,
    );
  });

  it('serves byte ranges (video players need them)', async () => {
    const { maya, dan } = await twoUsers();
    const id = await chat(maya, dan);
    const meta = await uploaded(maya, id, 1000);
    await send(maya, id, { attachmentId: meta.id });
    const res = await get(dan, `${meta.id}/content`, { range: 'bytes=100-199' });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 100-199/1000');
    expect((await res.arrayBuffer()).byteLength).toBe(100);
  });

  it('serves documents as downloads, never inline', async () => {
    const { maya, dan } = await twoUsers();
    const id = await chat(maya, dan);
    const meta = AttachmentMeta.parse(
      (
        await create(maya, id, {
          kind: 'document',
          mimeType: 'text/html',
          sizeBytes: 20,
          name: 'notes v2.html',
        })
      ).json,
    );
    await put(maya, `${meta.id}/content`, bytes(20), 'text/html');
    await send(maya, id, { body: 'Notes', attachmentId: meta.id });
    const res = await get(dan, `${meta.id}/content`);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toBe(
      "attachment; filename*=UTF-8''notes%20v2.html",
    );
  });

  it('takes a JPEG poster for videos only', async () => {
    const { maya, dan } = await twoUsers();
    const id = await chat(maya, dan);
    const video = AttachmentMeta.parse(
      (
        await create(maya, id, {
          kind: 'video',
          mimeType: 'video/mp4',
          sizeBytes: 50,
          width: 1920,
          height: 1080,
          durationMs: 3000,
        })
      ).json,
    );
    await put(maya, `${video.id}/content`, bytes(50), 'video/mp4');
    expect((await put(maya, `${video.id}/thumbnail`, bytes(30), 'image/png')).status).toBe(400);
    expect((await put(maya, `${video.id}/thumbnail`, bytes(30))).status).toBe(200);
    const sent = Message.parse((await send(maya, id, { attachmentId: video.id })).json);
    expect(sent.attachment).toMatchObject({ kind: 'video', durationMs: 3000, hasThumbnail: true });
    expect((await get(dan, `${video.id}/thumbnail`)).status).toBe(200);

    const photo = await uploaded(maya, id);
    expect((await put(maya, `${photo.id}/thumbnail`, bytes(30))).status).toBe(400);
  });

  it('sends each upload once, only by its uploader, only where it was uploaded', async () => {
    const { maya, dan } = await twoUsers();
    const id = await chat(maya, dan);
    const meta = await uploaded(maya, id);
    expect((await send(dan, id, { attachmentId: meta.id })).status).toBe(400); // not Dan's
    expect((await send(maya, id, { attachmentId: meta.id })).status).toBe(201);
    expect((await send(maya, id, { attachmentId: meta.id })).status).toBe(409);
    const unfinished = AttachmentMeta.parse((await create(maya, id, image(10))).json);
    expect((await send(maya, id, { attachmentId: unfinished.id })).status).toBe(400);
    expect((await send(maya, id, { body: '' })).status).toBe(400); // nothing to send
  });

  it('removes uploads that were never sent', async () => {
    const { maya, dan } = await twoUsers();
    const id = await chat(maya, dan);
    const sent = await uploaded(maya, id);
    await send(maya, id, { attachmentId: sent.id });
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

describe('reactions', () => {
  it('keeps one reaction per person and tells everyone', async () => {
    const { maya, dan } = await twoUsers();
    const id = await chat(maya, dan);
    const m = Message.parse((await send(maya, id, { body: 'hi' })).json);
    const mayaSocket = await openSocket(maya.accessToken);
    await mayaSocket.next('ready');
    const react = (emoji: string | null, s = dan) =>
      api(`/conversations/${id}/messages/${m.id}/reaction`, {
        method: 'PUT',
        body: { emoji },
        token: s.accessToken,
      });

    expect(Message.parse((await react('👍')).json).reactions).toEqual([
      { userId: dan.user.id, emoji: '👍' },
    ]);
    expect(Message.parse((await react('❤️')).json).reactions).toEqual([
      { userId: dan.user.id, emoji: '❤️' },
    ]);
    const event = await mayaSocket.next('message');
    expect((event?.message as Message).reactions).toHaveLength(1);
    expect(Message.parse((await react(null)).json).reactions).toEqual([]);
    expect((await react('hello')).status).toBe(400);
    expect((await react('1')).status).toBe(400);
  });
});

describe('deleting messages', () => {
  it('lets the sender delete for everyone: content, file and reactions go', async () => {
    const { maya, dan } = await twoUsers();
    const id = await chat(maya, dan);
    const meta = await uploaded(maya, id);
    const m = Message.parse((await send(maya, id, { body: 'oops', attachmentId: meta.id })).json);
    await api(`/conversations/${id}/messages/${m.id}/reaction`, {
      method: 'PUT',
      body: { emoji: '😂' },
      token: dan.accessToken,
    });

    expect(
      (
        await api(`/conversations/${id}/messages/${m.id}`, {
          method: 'DELETE',
          token: dan.accessToken,
        })
      ).status,
    ).toBe(403);
    const res = await api(`/conversations/${id}/messages/${m.id}`, {
      method: 'DELETE',
      token: maya.accessToken,
    });
    expect(Message.parse(res.json)).toMatchObject({
      body: '',
      attachment: null,
      reactions: [],
      deletedAt: expect.any(Number),
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(await env.MEDIA.head(contentKey(id, meta.id))).toBeNull();
    expect((await get(dan, `${meta.id}/content`)).status).toBe(404);
    expect(
      (
        await api(`/conversations/${id}/messages/${m.id}/reaction`, {
          method: 'PUT',
          body: { emoji: '👍' },
          token: dan.accessToken,
        })
      ).status,
    ).toBe(400);
  });

  it('reports changes after a revision so devices catch up on edits', async () => {
    const { maya, dan } = await twoUsers();
    const id = await chat(maya, dan);
    const a = Message.parse((await send(maya, id, { body: 'one' })).json);
    const b = Message.parse((await send(maya, id, { body: 'two' })).json);
    const before = (await api(`/conversations/${id}`, { token: dan.accessToken })).json.lastRev;
    expect(before).toBe(b.rev);

    await api(`/conversations/${id}/messages/${a.id}/reaction`, {
      method: 'PUT',
      body: { emoji: '👍' },
      token: dan.accessToken,
    });
    const c = Message.parse((await send(maya, id, { body: 'three' })).json);
    await api(`/conversations/${id}/messages/${b.id}`, {
      method: 'DELETE',
      token: maya.accessToken,
    });

    const page = (
      await api(`/conversations/${id}/messages?changedSince=${before}`, { token: dan.accessToken })
    ).json;
    expect(page.messages.map((m: Message) => [m.id, m.deletedAt !== null])).toEqual([
      [a.id, false],
      [c.id, false],
      [b.id, true],
    ]);
    expect(page.messages[0].reactions).toEqual([{ userId: dan.user.id, emoji: '👍' }]);
    const summary = (await api(`/conversations/${id}`, { token: dan.accessToken })).json;
    expect(summary.lastRev).toBe(page.messages.at(-1).rev);
  });
});
