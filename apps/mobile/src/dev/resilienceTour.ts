import * as Crypto from 'expo-crypto';
import { File, Paths } from 'expo-file-system';
import { router } from 'expo-router';
import { AppState } from 'react-native';
import { ME } from '@/domain/types';
import { generateRecoveryKey } from '@/features/auth/validation';
import { deviceCrypto } from '@/features/crypto';
import { MediaActionError, saveToPhotos } from '@/features/media/actions';
import { prepareImage } from '@/features/media/process';
import { useChat } from '@/stores/chat';
import { useSession } from '@/stores/session';
import { useDevSettings } from './settings';

/**
 * Resilience check (EXPO_PUBLIC_DEV_TOUR=resilience) with
 * scripts/resilience-peer.mjs as "Maya" and a runner that stops and restarts
 * the local server and backgrounds the app when asked (`[tour-res] …` lines):
 *
 *  1. sends a text and a photo while the server is unreachable; they wait in
 *     the outbox and go out by themselves once it's back;
 *  2. catches up on a message that arrived while the app was in the
 *     background;
 *  3. reports a denied permission (Photos) as a clear error;
 *  4. signs out (keys erased) and recovers the account with the recovery key
 *     as a new device: new messages decrypt, older ones can't on this device.
 */
const log = (label: string, value?: unknown) =>
  console.log(`[tour-res] ${label}${value === undefined ? '' : ` ${JSON.stringify(value)}`}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(
  what: string,
  check: () => T | undefined | null | false,
  timeoutMs = 120_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await sleep(250);
  }
}

const chatWithMaya = () => {
  const { contacts, conversations } = useChat.getState();
  return Object.values(conversations).find(
    (c) =>
      c.kind === 'direct' &&
      c.memberIds.some((m) => m !== ME && contacts[m]?.displayName === 'Maya Chen'),
  )?.id;
};
const messages = () => useChat.getState().messages[chatWithMaya() ?? ''] ?? [];
const theirTexts = () => messages().filter((m) => m.senderId !== ME);

export async function runResilience() {
  await sleep(2500);
  useDevSettings.getState().set({ sampleData: false });
  const username = `res${Math.floor(Math.random() * 1e6)}`;
  const recoveryKey = generateRecoveryKey(Crypto.getRandomBytes);
  await useSession.getState().register({
    inviteCode: (process.env.EXPO_PUBLIC_DEV_TOUR_INVITE ?? '').replace(/-/g, ''),
    username,
    displayName: 'Alex Rivera',
    recoveryKey,
  });
  const me = useSession.getState().user!.id;
  console.log(`[tour-auth] registered @${username} id=${me}`);
  log('ready', { device: await deviceCrypto(me).deviceId() });

  // 1. Offline outbox.
  const chat = await until('Maya’s chat and first message', () =>
    chatWithMaya() && theirTexts().some((m) => m.text === 'one') ? chatWithMaya() : undefined,
  );
  router.navigate(`/chat/${chat}`);
  log('go-offline');
  await until('the connection to drop', () => useChat.getState().connection !== 'online', 60_000);
  useChat.getState().send(chat, { text: 'queued while offline' });
  useChat.getState().send(chat, {
    upload: await prepareImage({
      uri: new File(Paths.document, 'e2e', 'gps.jpg').uri,
      width: 1600,
      height: 1200,
    }),
  });
  await sleep(3000);
  const mine = () => messages().filter((m) => m.senderId === ME);
  log('queued', {
    connection: useChat.getState().connection,
    states: mine().map((m) => m.status),
  });
  const offlineAt = Date.now();
  log('go-online');
  await until(
    'the queued messages to go out',
    () =>
      mine().length === 2 && mine().every((m) => m.status !== 'sending' && m.status !== 'failed'),
    180_000,
  );
  log('delivered', {
    seconds: Math.round((Date.now() - offlineAt) / 1000),
    states: mine().map((m) => m.status),
  });

  // 2. Background (long enough to disconnect), then back: catch up.
  log('background-now');
  await until('the app to go to the background', () => AppState.currentState === 'background');
  await until('the app to come back', () => AppState.currentState === 'active', 180_000);
  await until('the message sent while away', () =>
    theirTexts().some((m) => m.text === 'while you were away'),
  );
  log('caught-up', { texts: theirTexts().map((m) => m.text) });

  // 3. A denied permission (the runner denied Photos before launch).
  const photo = theirTexts().find((m) => m.attachment?.kind === 'image');
  try {
    if (photo?.attachment) await saveToPhotos(photo.attachment);
    log('photos', { saved: true });
  } catch (e) {
    log('photos', {
      saved: false,
      friendly: e instanceof MediaActionError,
      message: e instanceof Error ? e.message : String(e),
    });
  }

  // 4. Sign out, then recover the account on this phone as a new device.
  await useSession.getState().signOut();
  await until('signed out', () => useSession.getState().status === 'signedOut');
  log('signed-out', { cachedChats: Object.keys(useChat.getState().conversations).length });
  await useSession.getState().recover({ username, recoveryKey });
  await until('signed in again', () => useSession.getState().status === 'signedIn');
  const device = await deviceCrypto(useSession.getState().user!.id).deviceId();
  log('recovered', { device });
  await until('Maya’s message to the new device', () =>
    theirTexts().some((m) => m.text === 'hello, new device'),
  );
  const chat2 = chatWithMaya()!;
  // Scroll back (as the chat screen does): history from before this device.
  for (let i = 0; i < 3; i++) await useChat.getState().loadOlder(chat2);
  useChat.getState().send(chat2, { text: 'sent from my new device' });
  await until('it to go out', () =>
    messages().some(
      (m) => m.senderId === ME && m.text === 'sent from my new device' && m.status !== 'sending',
    ),
  );
  log('after-recovery', {
    texts: theirTexts().map((m) => m.text ?? null),
    unavailable: theirTexts().filter((m) => m.undecryptable === 'missing').length,
  });

  // 5. Delete the account (once Maya has read the last message).
  await until('Maya’s acknowledgement', () => theirTexts().some((m) => m.text === 'got it, bye'));
  await useSession.getState().deleteAccount();
  log('deleted', {
    status: useSession.getState().status,
    cachedChats: Object.keys(useChat.getState().conversations).length,
  });
  console.log('[tour] 1 done');
}
