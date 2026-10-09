import {
  Call,
  callIdFor,
  CallJoin,
  CallList,
  DeviceMismatch,
  Payload,
  type CallKind,
} from '@koode/shared';
import * as Crypto from 'expo-crypto';
import { useSyncExternalStore } from 'react';
import { authClient } from '@/features/auth';
import { deviceCrypto, randomKey } from '@/features/crypto';
import { ApiClientError } from '@/lib/api';
import { CallController, type CallApi } from './controller';
import { liveKitSession } from './media';

const id = (s: string) => encodeURIComponent(s);

const signedIn = () => {
  if (!me) throw new Error('Not signed in');
  return deviceCrypto(me);
};

/**
 * Calls are end-to-end encrypted: the caller makes a random media key and
 * sends it to each of the callee's devices as a Signal message, with the call
 * request. The server never has it.
 */
export const callApi: CallApi & { list: () => Promise<Call[]> } = {
  async start(userId, kind) {
    const crypto = signedIn();
    const uuid = Crypto.randomUUID();
    const mediaKey = await randomKey();
    const plain = JSON.stringify({ v: 1, t: 'call', callId: callIdFor(uuid), key: mediaKey });
    for (let attempt = 1; ; attempt++) {
      const envelopes = await crypto.encrypt([userId], plain);
      try {
        const join = await authClient.request('/v1/calls', CallJoin, {
          method: 'POST',
          body: { id: uuid, userId, kind, envelopes },
        });
        return { ...join, mediaKey };
      } catch (e) {
        // Their devices changed since we last looked: encrypt again.
        const mismatch =
          e instanceof ApiClientError && e.code === 'conflict'
            ? DeviceMismatch.safeParse(e.details)
            : null;
        if (!mismatch?.success || attempt >= 3) throw e;
        await crypto.refresh(mismatch.data, [userId]);
      }
    }
  },
  async accept(callId) {
    const join = await authClient.request(`/v1/calls/${id(callId)}/accept`, CallJoin, {
      method: 'POST',
      body: {},
    });
    if (!join.key) throw new Error('This call has no key for this device');
    const text = await signedIn().decrypt(
      join.call.callerId,
      join.key.senderDevice,
      join.key.envelope,
    );
    const payload = Payload.parse(JSON.parse(text));
    // The key must name this call (the server can't swap keys between calls).
    if (payload.t !== 'call' || payload.callId !== join.call.id)
      throw new Error('Call key doesn’t match this call');
    return { ...join, mediaKey: payload.key };
  },
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
