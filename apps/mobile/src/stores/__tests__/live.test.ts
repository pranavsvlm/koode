import type { ConversationSummary } from '@koode/shared';
import { ME } from '@/domain/types';
import type { LocalMessage, Snapshot } from '@/features/messaging';
import { normalizeMessage } from '@/features/messaging/types';
import { deriveLive, liveAttachment, messageStatus, systemText } from '../chat';

const me = 'usr_me';
const conv = (members: [string, number, number][]): ConversationSummary => ({
  id: 'c1',
  kind: members.length > 2 ? 'group' : 'direct',
  title: null,
  createdAt: 0,
  lastSeq: 5,
  lastRev: 5,
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
): LocalMessage =>
  normalizeMessage({
    id: `m${seq}`,
    conversationId: 'c1',
    seq,
    rev: seq,
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
      messages: {
        c1: [
          msg(1),
          {
            ...msg(2, 'sent', 'usr_b'),
            reactions: [
              { userId: me, emoji: '❤️' },
              { userId: 'usr_b', emoji: '❤️' },
            ],
          },
          { ...msg(3, 'sent', 'usr_b'), body: '', deletedAt: 9 },
          // Reactions are encrypted messages of their own; never shown as bubbles.
          { ...msg(4, 'sent', 'usr_b'), kind: 'reaction', targetId: 'm2', body: '❤️' },
          { ...msg(5, 'sent', 'usr_b'), body: '', undecryptable: 'identity' },
        ],
      },
      users: { usr_b: { id: 'usr_b', username: 'b', displayName: 'Bee', about: '' } },
      typing: { c1: ['usr_b', me] },
      hasMore: { c1: true },
      progress: {},
    };
    const out = deriveLive(
      snap,
      me,
      {
        reactions: {},
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
      reactions: [{ emoji: '❤️', userIds: [ME, 'usr_b'] }],
    });
    // Deleted for everyone on the server.
    expect(out.messages.c1![2]).toMatchObject({ deleted: true, text: undefined, reactions: [] });
    expect(out.messages.c1).toHaveLength(4);
    expect(out.messages.c1![3]).toMatchObject({ undecryptable: 'identity', text: undefined });
    expect(out.contacts.usr_b).toMatchObject({ displayName: 'Bee', username: 'b' });
    expect(out.hasMore.c1).toBe(true);
  });
});

describe('attachments and group changes', () => {
  it('shows a file being sent from the device, with progress', () => {
    const m: LocalMessage = {
      ...msg(null, 'pending'),
      kind: 'attachment',
      body: '',
      upload: {
        uri: 'file:///outbox/a.jpg',
        posterUri: null,
        request: {
          kind: 'image',
          mimeType: 'image/jpeg',
          sizeBytes: 5,
          width: 4,
          height: 3,
          preview: 'AAA',
        },
        attachmentId: null,
        posterUploaded: false,
        uploaded: false,
      },
    };
    expect(liveAttachment(m, 0.4)).toEqual({
      kind: 'image',
      width: 4,
      height: 3,
      attachmentId: undefined,
      mimeType: 'image/jpeg',
      localUri: 'file:///outbox/a.jpg',
      localPosterUri: undefined,
      preview: 'AAA',
      hasPoster: false,
      progress: 0.4,
    });
  });

  it('maps a server attachment to a downloadable one', () => {
    const m: LocalMessage = {
      ...msg(4),
      kind: 'attachment',
      attachment: {
        id: 'att_1',
        kind: 'voice',
        mimeType: 'audio/mp4',
        sizeBytes: 900,
        name: null,
        width: null,
        height: null,
        durationMs: 4200,
        waveform: [0.1, 0.9],
        preview: null,
        hasThumbnail: false,
        secret: { content: { key: 'k', digest: 'd' }, thumbnail: null },
      },
    };
    expect(liveAttachment(m)).toMatchObject({
      secret: { content: { key: 'k', digest: 'd' }, thumbnail: null },
      kind: 'voice',
      attachmentId: 'att_1',
      durationSec: 4.2,
      waveform: [0.1, 0.9],
      localUri: undefined,
      progress: undefined,
    });
  });

  it('describes group changes from my point of view', () => {
    const name = (id: string, start: boolean) =>
      id === me
        ? start
          ? 'You'
          : 'you'
        : ({ a: 'Maya', b: 'Dan', c: 'Sam' } as Record<string, string>)[id]!;
    const e = (action: string, actorId: string, targetIds: string[], title: string | null = null) =>
      systemText({ action: action as never, actorId, targetIds, title }, name);
    expect(e('created', 'a', ['b'], 'Family')).toBe('Maya created the group “Family”');
    expect(e('added', me, ['b', 'c'])).toBe('You added Dan and Sam');
    expect(e('removed', 'a', [me])).toBe('Maya removed you');
    expect(e('left', 'b', [])).toBe('Dan left');
    expect(e('promoted', 'a', ['b', 'c', me])).toBe('Maya made Dan, Sam and you an admin');
    expect(e('renamed', 'a', [], 'Cousins')).toBe('Maya renamed the group to “Cousins”');
  });
});

describe('deriveLive memoization', () => {
  const snapshot = (messages: LocalMessage[]): Snapshot => ({
    connection: 'online',
    conversations: [
      conv([
        [me, 5, 5],
        ['usr_b', 5, 5],
      ]),
    ],
    messages: { c1: messages },
    users: {},
    typing: {},
    hasMore: {},
    progress: {},
  });
  const overlay = { reactions: {}, deleted: {}, pinned: {}, muted: {} };

  it('keeps unchanged chats and messages as the same objects', () => {
    const list = [msg(1), msg(2, 'sent', 'usr_b')];
    const snap = snapshot(list);
    const a = deriveLive(snap, me, overlay, true);
    // A typing event: nothing about the messages changed.
    const b = deriveLive({ ...snap, typing: { c1: ['usr_b'] } }, me, overlay, true);
    expect(b.messages.c1).toBe(a.messages.c1);
    expect(b.messages).toBe(a.messages);
    expect(b.contacts).toBe(a.contacts);
    // A new message: the chat changes, but existing bubbles keep their objects.
    const c = deriveLive(
      { ...snap, messages: { c1: [...list, msg(3, 'sent', 'usr_b')] } },
      me,
      overlay,
      true,
    );
    expect(c.messages.c1).not.toBe(a.messages.c1);
    expect(c.messages.c1![0]).toBe(a.messages.c1![0]);
    expect(c.messages.c1![1]).toBe(a.messages.c1![1]);
  });

  it('updates a message whose status changed', () => {
    const list = [msg(1)];
    const a = deriveLive(snapshot(list), me, overlay, true);
    const read = snapshot(list);
    read.conversations[0]!.members[1]!.lastReadSeq = 1;
    read.conversations[0]!.members[1]!.lastDeliveredSeq = 1;
    const b = deriveLive(read, me, overlay, true);
    expect(a.messages.c1![0]!.status).toBe('read'); // conv() starts everyone at 5
    expect(b.messages.c1![0]).toBe(a.messages.c1![0]);
    const unread = snapshot(list);
    unread.conversations[0]!.members[1]!.lastReadSeq = 0;
    expect(deriveLive(unread, me, overlay, true).messages.c1![0]!.status).toBe('delivered');
  });
});
