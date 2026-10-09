import {
  ConversationList,
  ConversationSummary,
  Message,
  MessagePage,
  UserDirectory,
} from '@koode/shared';
import * as Crypto from 'expo-crypto';
import { z } from 'zod';
import { authClient, SignedOutError } from '@/features/auth';
import { env } from '@/lib/env';
import { usePreferences } from '@/stores/preferences';
import { MessagingEngine, type MessagingApi, type SocketLike } from './engine';
import { sqliteStore } from './sqliteStore';

const Any = z.unknown();

const api: MessagingApi = {
  getAccessToken: authClient.getAccessToken,
  users: async () => (await authClient.request('/v1/users', UserDirectory)).users,
  conversations: async () =>
    (await authClient.request('/v1/conversations', ConversationList)).conversations,
  conversation: (id) =>
    authClient.request(`/v1/conversations/${encodeURIComponent(id)}`, ConversationSummary),
  messages: (id, { before, after, limit }) => {
    const q = new URLSearchParams();
    if (before !== undefined) q.set('before', String(before));
    if (after !== undefined) q.set('after', String(after));
    if (limit !== undefined) q.set('limit', String(limit));
    return authClient.request(
      `/v1/conversations/${encodeURIComponent(id)}/messages?${q}`,
      MessagePage,
    );
  },
  send: (id, body) =>
    authClient.request(`/v1/conversations/${encodeURIComponent(id)}/messages`, Message, {
      method: 'POST',
      body,
    }),
  receipts: (id, body) =>
    authClient.request(`/v1/conversations/${encodeURIComponent(id)}/receipts`, Any, {
      method: 'POST',
      body,
    }),
  createConversation: (body) =>
    authClient.request('/v1/conversations', ConversationSummary, { method: 'POST', body }),
};

/** React Native WebSocket, authenticated with a header (never a URL token). */
function connect(accessToken: string): SocketLike {
  const url = `${env.apiUrl.replace(/^http/, 'ws')}/v1/realtime`;
  // React Native accepts a third options argument with request headers.
  const RNWebSocket = WebSocket as unknown as new (
    url: string,
    protocols: string[] | undefined,
    options: { headers: Record<string, string> },
  ) => WebSocket;
  const ws = new RNWebSocket(url, undefined, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const socket: SocketLike = {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onopen: null,
    onmessage: null,
    onclose: null,
  };
  ws.onopen = () => socket.onopen?.();
  ws.onmessage = (e) => typeof e.data === 'string' && socket.onmessage?.(e.data);
  ws.onclose = (e) => socket.onclose?.(e.code);
  ws.onerror = () => {
    // An error is always followed by close; reconnection is handled there.
  };
  return socket;
}

const store = sqliteStore();

/** One engine per signed-in account. */
export function createMessagingEngine(me: string, onSignedOut: () => void): MessagingEngine {
  return new MessagingEngine({
    me,
    api,
    connect,
    store,
    uuid: () => Crypto.randomUUID(),
    prefs: () => {
      const p = usePreferences.getState();
      return { readReceipts: p.readReceipts, typingIndicators: p.typingIndicators };
    },
    onSignedOut,
    isSignedOutError: (e) => e instanceof SignedOutError,
  });
}

/** Erase cached messages (sign-out) even if no engine is running. */
export const clearMessageCache = () => store.clear();

export type { LocalMessage, Snapshot } from './types';
export { MessagingEngine } from './engine';
