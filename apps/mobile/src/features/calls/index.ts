import { Call, CallJoin, CallList, type CallKind } from '@koode/shared';
import { useSyncExternalStore } from 'react';
import { authClient } from '@/features/auth';
import { CallController, type CallApi } from './controller';
import { liveKitSession } from './media';

const id = (s: string) => encodeURIComponent(s);

export const callApi: CallApi & { list: () => Promise<Call[]> } = {
  start: (userId, kind) =>
    authClient.request('/v1/calls', CallJoin, { method: 'POST', body: { userId, kind } }),
  accept: (callId) =>
    authClient.request(`/v1/calls/${id(callId)}/accept`, CallJoin, { method: 'POST', body: {} }),
  decline: (callId) =>
    authClient.request(`/v1/calls/${id(callId)}/decline`, Call, { method: 'POST', body: {} }),
  end: (callId) =>
    authClient.request(`/v1/calls/${id(callId)}/end`, Call, { method: 'POST', body: {} }),
  list: async () => (await authClient.request('/v1/calls', CallList)).calls,
};

let me: string | null = null;
/** Set by the chat store when a live session starts (avoids an import cycle). */
export const setCallIdentity = (userId: string | null) => {
  me = userId;
};

export const callController = new CallController({
  me: () => me,
  api: callApi,
  createMedia: liveKitSession,
});

export function useCall() {
  return useSyncExternalStore(callController.subscribe, callController.getSnapshot);
}

export type { CallKind };
export type { CallPhase, CallSnapshot, EndReason } from './controller';
