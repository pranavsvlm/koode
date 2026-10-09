import { router } from 'expo-router';
import type { CallKind } from '@koode/shared';
import { useChat } from '@/stores/chat';
import { callController } from './index';

/** Start a call from any call button and open the call screen. */
export function startCall(peerId: string, kind: CallKind) {
  if (useChat.getState().mode === 'live') void callController.start(peerId, kind);
  router.push({ pathname: '/call/[id]', params: { id: peerId, kind } });
}
