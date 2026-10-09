import type { ConversationSummary } from '@koode/shared';
import { ME } from '@/domain/types';
import type { LocalMessage, Snapshot } from '@/features/messaging';
import { deriveLive, messageStatus } from '../chat';

const me = 'usr_me';
const conv = (members: [string, number, number][]): ConversationSummary => ({
  id: 'c1',
  kind: members.length > 2 ? 'group' : 'direct',
  title: null,
  createdAt: 0,
  lastSeq: 5,
  lastMessage: null,
  unreadCount: 0,
  members: members.map(([userId, lastDeliveredSeq, lastReadSeq]) => ({
    userId,
    role: 'member',
    lastDeliveredSeq,
    lastReadSeq,
  })),
});
const msg = (
  seq: number | null,
  state: LocalMessage['state'] = 'sent',
  senderId = me,
): LocalMessage => ({
  id: `m${seq}`,
  conversationId: 'c1',
  seq,
  senderId,
  body: 'x',
  replyToId: null,
  createdAt: 0,
  state,
});

describe('messageStatus', () => {
  it('follows the outbox state first', () => {
    expect(
      messageStatus(
        msg(null, 'pending'),
        conv([
          [me, 0, 0],
          ['b', 9, 9],
        ]),
        me,
        true,
      ),
    ).toBe('sending');
    expect(
      messageStatus(
        msg(null, 'failed'),
        conv([
          [me, 0, 0],
          ['b', 9, 9],
        ]),
        me,
        true,
      ),
    ).toBe('failed');
  });

  it('is read/delivered only when every other member has reached it', () => {
    const group = conv([
      [me, 5, 5],
      ['b', 5, 5],
      ['c', 3, 2],
    ]);
    expect(messageStatus(msg(2), group, me, true)).toBe('read');
    expect(messageStatus(msg(3), group, me, true)).toBe('delivered');
    expect(messageStatus(msg(4), group, me, true)).toBe('sent');
  });

  it('hides read state when I have turned read receipts off (reciprocity)', () => {
    expect(
      messageStatus(
        msg(1),
        conv([
          [me, 5, 5],
          ['b', 5, 5],
        ]),
        me,
        false,
      ),
    ).toBe('delivered');
  });
});

describe('deriveLive', () => {
  it('maps my user id to ME and applies local overlays', () => {
    const snap: Snapshot = {
      connection: 'online',
      conversations: [
        conv([
          [me, 1, 1],
          ['usr_b', 1, 1],
        ]),
      ],
      messages: { c1: [msg(1), msg(2, 'sent', 'usr_b')] },
      users: { usr_b: { id: 'usr_b', username: 'b', displayName: 'Bee', about: '' } },
      typing: { c1: ['usr_b', me] },
      hasMore: { c1: true },
    };
    const out = deriveLive(
      snap,
      me,
      {
        reactions: { m2: [{ emoji: '❤️', userIds: [ME] }] },
        deleted: { m1: true },
        pinned: { c1: true },
        muted: {},
      },
      true,
    );
    expect(out.conversations.c1).toMatchObject({
      memberIds: [ME, 'usr_b'],
      pinned: true,
      typingUserIds: ['usr_b'],
    });
    expect(out.messages.c1![0]).toMatchObject({
      senderId: ME,
      deleted: true,
      text: undefined,
      status: 'read',
    });
    expect(out.messages.c1![1]).toMatchObject({
      senderId: 'usr_b',
      text: 'x',
      reactions: [{ emoji: '❤️', userIds: [ME] }],
    });
    expect(out.contacts.usr_b).toMatchObject({ displayName: 'Bee', username: 'b' });
    expect(out.hasMore.c1).toBe(true);
  });
});
