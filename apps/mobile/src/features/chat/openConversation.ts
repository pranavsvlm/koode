import { router } from 'expo-router';
import { ME } from '@/domain/types';
import { useChat } from '@/stores/chat';

/**
 * Open the direct chat with `userId` (creating it on the server if needed),
 * or create a group. Throws if the server can't be reached.
 */
export async function openConversation(
  memberIds: string[],
  opts: { title?: string; replace?: boolean } = {},
) {
  const state = useChat.getState();
  const direct =
    memberIds.length === 1 && !opts.title
      ? Object.values(state.conversations).find(
          (c) =>
            c.kind === 'direct' && c.memberIds.includes(memberIds[0]!) && c.memberIds.includes(ME),
        )
      : undefined;
  const id = direct?.id ?? (await state.createConversation(memberIds, opts.title));
  if (opts.replace) router.replace(`/chat/${id}`);
  else router.push(`/chat/${id}`);
  return id;
}
