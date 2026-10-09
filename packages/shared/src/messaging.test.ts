import { describe, expect, it } from 'vitest';
import {
  ClientFrame,
  CreateConversationRequest,
  MessageId,
  ReceiptRequest,
  SendMessageRequest,
  ServerEvent,
} from './messaging';
import { Payload } from './keys';

const id = '3f2b8c1e-9a4d-4c2b-8e7f-1a2b3c4d5e6f';

const envelope = { userId: 'usr_1', deviceId: 1, type: 3, body: 'AAAA' };

describe('SendMessageRequest', () => {
  it('takes ciphertext only, with a UUID v4 id', () => {
    const ok = SendMessageRequest.parse({ id, kind: 'text', envelopes: [envelope], body: 'hi' });
    expect('body' in ok).toBe(false); // plaintext is dropped, never forwarded
    expect(SendMessageRequest.safeParse({ id: 'nope', kind: 'text', envelopes: [] }).success).toBe(
      false,
    );
    expect(MessageId.safeParse(id.toUpperCase()).success).toBe(false);
  });
  it('validates envelopes', () => {
    const send = (e: object) => SendMessageRequest.safeParse({ id, kind: 'text', envelopes: [e] });
    expect(send({ ...envelope, type: 1 }).success).toBe(false);
    expect(send({ ...envelope, deviceId: 0 }).success).toBe(false);
    expect(send({ ...envelope, body: 'not base64!' }).success).toBe(false);
  });
  it('ties attachments and reaction targets to their kinds', () => {
    const base = { id, envelopes: [] };
    expect(SendMessageRequest.safeParse({ ...base, kind: 'attachment' }).success).toBe(false);
    expect(
      SendMessageRequest.safeParse({ ...base, kind: 'attachment', attachmentId: 'att_1' }).success,
    ).toBe(true);
    expect(SendMessageRequest.safeParse({ ...base, kind: 'reaction' }).success).toBe(false);
    expect(SendMessageRequest.safeParse({ ...base, kind: 'reaction', targetId: id }).success).toBe(
      true,
    );
    expect(SendMessageRequest.safeParse({ ...base, kind: 'text', targetId: id }).success).toBe(
      false,
    );
  });
});

describe('Payload', () => {
  it('binds content to its message and conversation', () => {
    const text = { v: 1, t: 'text', id, conversationId: 'cnv_1', body: 'hi', replyToId: null };
    expect(Payload.safeParse(text).success).toBe(true);
    expect(Payload.safeParse({ ...text, id: undefined }).success).toBe(false);
    expect(Payload.safeParse({ ...text, v: 2 }).success).toBe(false);
  });
});

describe('CreateConversationRequest', () => {
  it('discriminates direct and group', () => {
    expect(CreateConversationRequest.parse({ kind: 'direct', userId: 'usr_1' }).kind).toBe(
      'direct',
    );
    expect(
      CreateConversationRequest.safeParse({ kind: 'group', title: ' ', memberIds: ['a'] }).success,
    ).toBe(false);
  });
});

describe('ReceiptRequest', () => {
  it('requires something to acknowledge and defaults to sharing', () => {
    expect(ReceiptRequest.safeParse({}).success).toBe(false);
    expect(ReceiptRequest.parse({ read: 3 }).shareRead).toBe(true);
  });
});

describe('realtime frames', () => {
  it('parse known frames and reject unknown ones', () => {
    expect(ServerEvent.parse({ type: 'typing', conversationId: 'c', userId: 'u' }).type).toBe(
      'typing',
    );
    expect(ServerEvent.safeParse({ type: 'nope' }).success).toBe(false);
    expect(ClientFrame.safeParse({ type: 'typing' }).success).toBe(false);
  });
});
