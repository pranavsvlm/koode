import { describe, expect, it } from 'vitest';
import {
  ClientFrame,
  CreateConversationRequest,
  MessageId,
  ReceiptRequest,
  SendMessageRequest,
  ServerEvent,
} from './messaging';

const id = '3f2b8c1e-9a4d-4c2b-8e7f-1a2b3c4d5e6f';

describe('SendMessageRequest', () => {
  it('trims bodies and requires a UUID v4 id', () => {
    expect(SendMessageRequest.parse({ id, body: '  hi  ' }).body).toBe('hi');
    expect(SendMessageRequest.safeParse({ id: 'not-a-uuid', body: 'hi' }).success).toBe(false);
    expect(MessageId.safeParse(id.toUpperCase()).success).toBe(false);
  });
  it('rejects empty and oversized messages', () => {
    expect(SendMessageRequest.safeParse({ id, body: '   ' }).success).toBe(false);
    expect(SendMessageRequest.safeParse({ id, body: 'x'.repeat(4001) }).success).toBe(false);
    expect(SendMessageRequest.safeParse({ id, body: 'x'.repeat(4000) }).success).toBe(true);
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
