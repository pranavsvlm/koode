import type { Message } from '@/domain/types';
import { buildChatItems } from '../items';

const now = new Date(2026, 9, 9, 15, 0).getTime();
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
let n = 0;
const msg = (senderId: string, createdAt: number): Message => ({
  id: `m${++n}`,
  conversationId: 'c',
  senderId,
  createdAt,
  status: 'sent',
  reactions: [],
});

describe('buildChatItems', () => {
  it('returns newest first with a day divider after each day', () => {
    const items = buildChatItems([msg('a', at(8, 10)), msg('a', at(9, 10))], false, now);
    expect(items.map((i) => (i.type === 'day' ? i.label : 'msg'))).toEqual([
      'msg',
      'Today',
      'msg',
      'Yesterday',
    ]);
  });

  it('groups consecutive messages from one sender within the window', () => {
    const list = [
      msg('a', at(9, 10, 0)),
      msg('a', at(9, 10, 1)),
      msg('a', at(9, 10, 2)),
      msg('b', at(9, 10, 3)),
      msg('a', at(9, 10, 30)),
    ];
    const positions = buildChatItems(list, true, now)
      .filter((i) => i.type === 'message')
      .map((i) => (i.type === 'message' ? i.position : ''));
    // newest first: a(single) b(single) a(last) a(middle) a(first)
    expect(positions).toEqual(['single', 'single', 'last', 'middle', 'first']);
  });

  it('shows sender names on the first bubble and avatars on the last in groups', () => {
    const items = buildChatItems(
      [msg('a', at(9, 10, 0)), msg('a', at(9, 10, 1))],
      true,
      now,
    ).filter((i) => i.type === 'message');
    expect(items.map((i) => i.type === 'message' && [i.showSender, i.showAvatar])).toEqual([
      [false, true],
      [true, false],
    ]);
  });

  it('never shows sender details in direct chats', () => {
    const [item] = buildChatItems([msg('a', at(9, 10))], false, now);
    expect(item).toMatchObject({ showSender: false, showAvatar: false });
  });
});
