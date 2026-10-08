import { calendarDaysBetween, formatDayDivider } from '@/lib/format';
import type { Message } from '@/domain/types';

/** Consecutive messages from one sender within this window render as one group. */
export const GROUP_WINDOW_MS = 3 * 60_000;

export type GroupPosition = 'single' | 'first' | 'middle' | 'last';

export type ChatItem =
  | {
      type: 'message';
      key: string;
      message: Message;
      position: GroupPosition;
      /** Groups: show sender name above the first bubble of a run. */
      showSender: boolean;
      /** Groups: show sender avatar beside the last bubble of a run. */
      showAvatar: boolean;
    }
  | { type: 'day'; key: string; label: string };

function sameGroup(a: Message | undefined, b: Message | undefined): boolean {
  return (
    !!a &&
    !!b &&
    a.senderId === b.senderId &&
    Math.abs(b.createdAt - a.createdAt) <= GROUP_WINDOW_MS &&
    calendarDaysBetween(a.createdAt, b.createdAt) === 0
  );
}

/**
 * Turn an oldest→newest message list into render items for an *inverted*
 * list (newest first), with grouping and day dividers resolved.
 */
export function buildChatItems(
  messages: Message[],
  isGroup: boolean,
  now = Date.now(),
): ChatItem[] {
  const items: ChatItem[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    const prev = messages[i - 1];
    const next = messages[i + 1];
    const joinsPrev = sameGroup(prev, message);
    const joinsNext = sameGroup(message, next);
    const position: GroupPosition =
      joinsPrev && joinsNext ? 'middle' : joinsPrev ? 'last' : joinsNext ? 'first' : 'single';

    items.push({
      type: 'message',
      key: message.id,
      message,
      position,
      showSender: isGroup && !joinsPrev,
      showAvatar: isGroup && !joinsNext,
    });

    // Inverted list: the divider for a day goes *after* that day's oldest message.
    if (!prev || calendarDaysBetween(prev.createdAt, message.createdAt) !== 0) {
      items.push({
        type: 'day',
        key: `day-${message.id}`,
        label: formatDayDivider(message.createdAt, now),
      });
    }
  }
  return items;
}
