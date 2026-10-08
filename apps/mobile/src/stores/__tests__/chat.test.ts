import { useDevSettings } from '@/dev/settings';
import { ME } from '@/domain/types';
import { messagePreview, summarizeConversations, useChat } from '../chat';

const initial = useChat.getState();

beforeEach(async () => {
  jest.useRealTimers();
  useChat.setState(initial, true);
  useDevSettings.setState({ slowLoading: false, emptyData: false, simulateReplies: false });
  await useChat.getState().load();
});

const lastMessage = (conversationId: string) => {
  const list = useChat.getState().messages[conversationId]!;
  return list[list.length - 1]!;
};

describe('chat store', () => {
  it('loads fixtures sorted oldest to newest', () => {
    const list = useChat.getState().messages['c-maya']!;
    expect(list.length).toBeGreaterThan(3);
    for (let i = 1; i < list.length; i++) {
      expect(list[i]!.createdAt).toBeGreaterThanOrEqual(list[i - 1]!.createdAt);
    }
  });

  it('can start empty for reviewing empty states', async () => {
    useChat.setState(initial, true);
    useDevSettings.setState({ emptyData: true });
    await useChat.getState().load();
    expect(Object.keys(useChat.getState().conversations)).toHaveLength(0);
  });

  it('progresses sent messages through delivery states', () => {
    jest.useFakeTimers();
    useChat.getState().send('c-maya', { text: '  hello  ' });
    expect(lastMessage('c-maya')).toMatchObject({ text: 'hello', senderId: ME, status: 'sending' });
    jest.advanceTimersByTime(400);
    expect(lastMessage('c-maya').status).toBe('sent');
    jest.advanceTimersByTime(800);
    expect(lastMessage('c-maya').status).toBe('delivered');
    jest.advanceTimersByTime(1100);
    expect(lastMessage('c-maya').status).toBe('read');
  });

  it('simulates a typing indicator then a reply when enabled', () => {
    jest.useFakeTimers();
    useDevSettings.setState({ simulateReplies: true });
    useChat.getState().send('c-maya', { text: 'hi' });
    jest.advanceTimersByTime(2700);
    expect(useChat.getState().conversations['c-maya']!.typingUserIds).toEqual(['maya']);
    jest.advanceTimersByTime(2200);
    expect(useChat.getState().conversations['c-maya']!.typingUserIds).toEqual([]);
    expect(lastMessage('c-maya').senderId).toBe('maya');
  });

  it('keeps one reaction per person and toggles it off', () => {
    const { send, toggleReaction } = useChat.getState();
    send('c-daniel', { text: 'x' });
    const id = lastMessage('c-daniel').id;
    toggleReaction('c-daniel', id, '👍');
    toggleReaction('c-daniel', id, '❤️');
    expect(lastMessage('c-daniel').reactions).toEqual([{ emoji: '❤️', userIds: [ME] }]);
    toggleReaction('c-daniel', id, '❤️');
    expect(lastMessage('c-daniel').reactions).toEqual([]);
  });

  it('deletes message content but keeps a tombstone', () => {
    const id = lastMessage('c-maya').id;
    useChat.getState().deleteMessage('c-maya', id);
    expect(lastMessage('c-maya')).toMatchObject({ deleted: true, text: undefined });
    expect(messagePreview(lastMessage('c-maya'))).toBe('Message deleted');
  });

  it('reuses an existing direct conversation', () => {
    expect(useChat.getState().createConversation(['maya'])).toBe('c-maya');
    const group = useChat.getState().createConversation(['maya', 'leo'], 'Trip');
    expect(useChat.getState().conversations[group]).toMatchObject({ kind: 'group', title: 'Trip' });
  });

  it('marks conversations read', () => {
    useChat.getState().markRead('c-family');
    expect(useChat.getState().conversations['c-family']!.unreadCount).toBe(0);
  });
});

describe('summarizeConversations', () => {
  it('puts pinned chats first, then most recent', () => {
    const { conversations, messages, contacts } = useChat.getState();
    const list = summarizeConversations(conversations, messages, contacts);
    const firstUnpinned = list.findIndex((s) => !s.conversation.pinned);
    expect(list.slice(0, firstUnpinned).every((s) => s.conversation.pinned)).toBe(true);
    const rest = list.slice(firstUnpinned);
    for (let i = 1; i < rest.length; i++) {
      expect(rest[i]!.lastActivity).toBeLessThanOrEqual(rest[i - 1]!.lastActivity);
    }
    expect(list.find((s) => s.conversation.id === 'c-maya')!.title).toBe('Maya Chen');
  });
});

describe('messagePreview', () => {
  it('describes attachments', () => {
    const base = {
      id: 'x',
      conversationId: 'c',
      senderId: ME,
      createdAt: 0,
      status: 'sent' as const,
      reactions: [],
    };
    expect(
      messagePreview({ ...base, attachment: { kind: 'voice', durationSec: 3, waveform: [] } }),
    ).toBe('🎤 Voice message');
    expect(
      messagePreview({
        ...base,
        attachment: { kind: 'document', name: 'a.pdf', sizeBytes: 1, mimeType: 'application/pdf' },
      }),
    ).toBe('📄 a.pdf');
  });
});
