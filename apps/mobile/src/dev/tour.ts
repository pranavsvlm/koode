import * as Crypto from 'expo-crypto';
import { router, type Href } from 'expo-router';
import { File, Paths } from 'expo-file-system';
import * as Notifications from 'expo-notifications';
import { setLogLevel } from 'livekit-client';
import { KoodeCalls } from '../../modules/koode-calls';
import { useEffect } from 'react';
import { useDevSettings } from '@/dev/settings';
import { callController } from '@/features/calls';
import { startCall } from '@/features/calls/startCall';
import { handleResponse, syncPushRegistration } from '@/features/notifications';
import { ACTION } from '@/features/notifications/policy';
import { download } from '@/features/media/files';
import {
  prepareDocument,
  prepareImage,
  prepareVideo,
  prepareVoice,
  type UploadDraft,
} from '@/features/media/process';
import { remoteOf } from '@/features/media/useMedia';
import { saveToPhotos } from '@/features/media/actions';
import { devHandles } from './handles';
import { ME } from '@/domain/types';
import { useChat } from '@/stores/chat';
import { usePreferences, type AppearancePreference } from '@/stores/preferences';
import { generateRecoveryKey } from '@/features/auth/validation';
import { useSession } from '@/stores/session';
import { deviceCrypto } from '@/features/crypto';
import {
  measureDerive,
  measureFileCrypto,
  measureStartupQueries,
  perfLog,
  seedCache,
} from './perfTour';
import { runResilience } from './resilienceTour';

/**
 * DEVELOPMENT ONLY: walks through every screen so the UI can be reviewed and
 * screenshotted without tapping (iOS 27 Simulators confirm every openurl).
 * Enable with `EXPO_PUBLIC_DEV_TOUR=1 npx expo start --dev-client`.
 * Each step logs `[tour] <n> <name>` to the Metro console.
 */
const STEP_MS = 3500;

/** `shotAtMs`: when to log the step (and so screenshot), default STEP_MS - 600. */
type Step = { name: string; run: () => void; shotAtMs?: number };

const go = (href: Href) => () => router.navigate(href);
const reloadChat = (patch: { slowLoading?: boolean; emptyData?: boolean }) => {
  useDevSettings.getState().set({ slowLoading: false, emptyData: false, ...patch });
  useChat.setState({ status: 'idle' });
  void useChat.getState().load();
};
const INVITE = process.env.EXPO_PUBLIC_DEV_TOUR_INVITE ?? '';

/**
 * Real registration against the local server (an end-to-end check of device
 * keys, signing, the keystore and the API on a real device/Simulator).
 * Needs an invite: `pnpm --filter @koode/server invite:create`.
 */
const signIn = () => {
  const username = `tour${Math.floor(Math.random() * 1e6)}`;
  useSession
    .getState()
    .register({
      inviteCode: INVITE.replace(/-/g, ''),
      username,
      displayName: 'Alex Rivera',
      recoveryKey: generateRecoveryKey(Crypto.getRandomBytes),
    })
    .then(
      () => console.log(`[tour-auth] registered @${username} id=${useSession.getState().user?.id}`),
      (e: unknown) =>
        console.log(`[tour-auth] FAILED ${e instanceof Error ? e.message : String(e)}`),
    );
};
export const TOUR: Step[] = [
  { name: 'welcome', run: go('/welcome') },
  { name: 'invite', run: go({ pathname: '/invite', params: { code: INVITE } }) },
  { name: 'create-profile', run: go({ pathname: '/create-profile', params: { code: INVITE } }) },
  {
    name: 'recovery-key',
    run: go({ pathname: '/recovery-key', params: { name: 'Alex Rivera', username: 'alex' } }),
  },
  { name: 'sign-in', run: go('/sign-in') },
  { name: 'chats', run: signIn },
  { name: 'chat-direct', run: go('/chat/c-maya') },
  { name: 'chat-group', run: go('/chat/c-family') },
  { name: 'group-info', run: go('/chat/c-family/info') },
  { name: 'contact', run: go('/contact/maya') },
  {
    name: 'media-viewer',
    run: go({ pathname: '/media/[id]', params: { id: 'm7', conversationId: 'c-maya' } }),
  },
  {
    name: 'attach',
    run: () => {
      router.back();
      setTimeout(
        () => router.navigate({ pathname: '/attach', params: { conversationId: 'c-maya' } }),
        400,
      );
    },
  },
  {
    name: 'calls',
    run: () => {
      router.back();
      setTimeout(go('/calls'), 400);
    },
  },
  { name: 'contacts', run: go('/contacts') },
  { name: 'new-chat', run: go('/new-chat') },
  {
    name: 'settings',
    run: () => {
      router.back();
      setTimeout(go('/settings'), 400);
    },
  },
  { name: 'profile', run: go('/settings/profile') },
  { name: 'invites', run: go('/settings/invites') },
  { name: 'devices', run: go('/settings/devices') },
  { name: 'recovery-key-settings', run: go('/settings/recovery-key') },
  { name: 'privacy', run: go('/settings/privacy') },
  { name: 'notifications', run: go('/settings/notifications') },
  { name: 'appearance', run: go('/settings/appearance') },
  { name: 'licenses', run: go('/settings/licenses') },
  {
    name: 'voice-call',
    run: go({ pathname: '/call/[id]', params: { id: 'maya', kind: 'voice' } }),
  },
  { name: 'voice-call-connected', run: () => {} },
  {
    name: 'video-call',
    run: () => {
      router.back();
      setTimeout(
        go({ pathname: '/call/[id]', params: { id: 'sofia', kind: 'video', accepted: '1' } }),
        800,
      );
    },
  },
  {
    name: 'incoming-call',
    run: () => {
      router.back();
      setTimeout(
        go({ pathname: '/incoming-call', params: { contactId: 'grandma', kind: 'voice' } }),
        800,
      );
    },
  },
  {
    name: 'chats-loading',
    shotAtMs: 1700,
    run: () => {
      router.back();
      setTimeout(() => {
        go('/chats')();
        reloadChat({ slowLoading: true });
      }, 800);
    },
  },
  { name: 'chats-empty', run: () => reloadChat({ emptyData: true }) },
  { name: 'calls-empty', run: go('/calls') },
  {
    name: 'done',
    run: () => {
      reloadChat({});
      go('/chats')();
    },
  },
];

/** `mode`: '1' keeps current appearance; 'light' / 'dark' force it (restored afterwards). */
const firstConversationId = () =>
  Object.values(useChat.getState().conversations).sort((x, y) => y.createdAt - x.createdAt)[0]?.id;

/**
 * Two-party messaging check against the real server. A peer script
 * (apps/server/scripts/peer.mjs) plays "Maya": it starts a chat with the
 * account registered here, replies, reads and types.
 */
export const MESSAGING_TOUR: Step[] = [
  {
    name: 'register',
    run: () => {
      useDevSettings.getState().set({ sampleData: false });
      signIn();
    },
  },
  { name: 'wait-for-peer', run: () => {} },
  { name: 'chats-live', run: go('/chats') },
  {
    name: 'chat-live',
    run: () => {
      const id = firstConversationId();
      console.log(`[tour-msg] conversation ${id ?? 'NONE'}`);
      if (id) router.navigate(`/chat/${id}`);
    },
  },
  {
    name: 'send',
    run: () => {
      const id = firstConversationId();
      if (id) useChat.getState().send(id, { text: 'Hello from the Simulator 👋' });
      console.log('[tour-msg] sent');
    },
  },
  { name: 'peer-typing', run: () => {} },
  { name: 'after-reply', run: () => {} },
  {
    name: 'done',
    run: () => {
      const id = firstConversationId();
      const list = (id && useChat.getState().messages[id]) || [];
      console.log(
        `[tour-msg] final ${JSON.stringify(list.map((m) => [m.senderId === 'me' ? 'me' : 'peer', m.text, m.status]))}`,
      );
    },
  },
];

/**
 * Two-party calling check against the real server and a local LiveKit. A peer
 * script (apps/server/scripts/call-peer.mjs) plays "Maya": it calls this
 * account (the media key end-to-end encrypted), joins the media room with
 * LiveKit's Node SDK and frame encryption, hangs up, then declines a call
 * from here. Steps invoke the same handlers as the on-screen buttons.
 */
let callPeer = '';
/** How the last call ended: the "ended" screen lingers only briefly, so steps can miss it. */
let lastEnded: string | null = null;
let unwatchEnd: (() => void) | null = null;
const watchEnd = () => {
  lastEnded = null;
  unwatchEnd?.();
  unwatchEnd = callController.subscribe(() => {
    const s = callController.getSnapshot();
    if (s.phase === 'ended') lastEnded = s.endReason;
  });
};
const callLog = (label: string) => {
  const s = callController.getSnapshot();
  console.log(
    `[tour-call] ${label} ${JSON.stringify({ phase: s.phase, endReason: s.endReason, lastEnded, call: s.call?.state, kind: s.kind, mic: s.micOn, remote: s.remotePresent })}`,
  );
};
const logCalls = () =>
  console.log(
    `[tour-call] history ${JSON.stringify(useChat.getState().calls.map((c) => [c.direction, c.kind, c.outcome, c.durationSec]))}`,
  );

export const CALL_TOUR: Step[] = [
  {
    name: 'register',
    run: () => {
      useDevSettings.getState().set({ sampleData: false });
      setLogLevel('info');
      signIn();
    },
  },
  { name: 'wait-for-peer', run: () => {} },
  { name: 'chats-live', run: () => (go('/chats')(), console.log('[tour-call] ready')) },
  { name: 'incoming', run: () => callLog('incoming') },
  {
    name: 'accept',
    run: () => {
      // Same as the Accept button on the incoming call screen.
      const s = callController.getSnapshot();
      callPeer = s.peerId ?? '';
      void callController.accept();
      router.replace({
        pathname: '/call/[id]',
        params: { id: callPeer, kind: s.kind, accepted: '1' },
      });
      console.log('[tour-call] accepted');
    },
  },
  { name: 'connecting', run: () => callLog('after-accept') },
  {
    name: 'connected',
    run: () => {
      callLog('connected');
      void callController
        .audioStats()
        .then((audio) =>
          console.log(
            `[tour-call] media ${JSON.stringify({ encrypted: callController.getSnapshot().encrypted, audio })}`,
          ),
        );
    },
  },
  {
    name: 'muted',
    run: () => void callController.toggleMic().then(() => callLog('muted')),
  },
  { name: 'peer-hangup', run: () => console.log('[tour-call] hangup-please') },
  { name: 'after-hangup', run: () => callLog('after-hangup') },
  { name: 'calls-tab', run: () => (go('/calls')(), setTimeout(logCalls, 1500)) },
  {
    name: 'outgoing',
    shotAtMs: 1500,
    run: () => {
      watchEnd();
      startCall(callPeer, 'voice');
      setTimeout(() => callLog('outgoing'), 1000);
    },
  },
  { name: 'ringing', run: () => callLog('ringing') },
  { name: 'still-ringing', run: () => callLog('still-ringing') },
  { name: 'declined', run: () => callLog('declined') },
  { name: 'calls-history', run: () => (go('/calls')(), setTimeout(logCalls, 1500)) },
  { name: 'done', run: () => (callLog('done'), unwatchEnd?.()) },
];

/**
 * Push notification check against the real server and the push relay in
 * simulator mode (apps/server/scripts/push-peer.mjs plays "Maya";
 * the runner script backgrounds and restores the app). The Simulator can't
 * tap "Allow", so this asks for provisional authorization: notifications are
 * delivered quietly to Notification Center instead of as banners.
 */
const pushLog = (label: string, value?: unknown) =>
  console.log(`[tour-push] ${label}${value === undefined ? '' : ` ${JSON.stringify(value)}`}`);
const presented = async () =>
  (await Notifications.getPresentedNotificationsAsync()).map((n) => ({
    title: n.request.content.title,
    body: n.request.content.body,
    data: n.request.content.data,
  }));
const tapPresented = async (
  type: string,
  action: string = Notifications.DEFAULT_ACTION_IDENTIFIER,
) => {
  const n = (await Notifications.getPresentedNotificationsAsync()).find(
    (x) => (x.request.content.data as { type?: string })?.type === type,
  );
  pushLog(`tap ${type}`, n ? n.request.content.title : 'NONE');
  if (n) await handleResponse({ notification: n, actionIdentifier: action });
};

export const PUSH_TOUR: Step[] = [
  {
    name: 'register',
    run: () => {
      useDevSettings.getState().set({ sampleData: false });
      usePreferences.getState().set('notificationsAsked', true);
      Notifications.addNotificationReceivedListener((n) =>
        pushLog('received', [
          n.request.content.title,
          n.request.content.body,
          n.request.content.data,
        ]),
      );
      void Notifications.requestPermissionsAsync({
        ios: { allowProvisional: true, allowAlert: true, allowBadge: true, allowSound: true },
      }).then((p) => {
        pushLog('permission', p.ios?.status);
        signIn();
      });
    },
  },
  {
    name: 'registered',
    run: () =>
      void (async () => {
        const token = await Notifications.getDevicePushTokenAsync().catch((e: unknown) =>
          String(e),
        );
        pushLog(
          'alert-token',
          typeof token === 'string' ? token : `${String(token.data).length} hex chars`,
        );
        await syncPushRegistration();
        pushLog('ready');
      })(),
  },
  { name: 'foreground-message', run: go('/chats') },
  { name: 'background', run: () => pushLog('background-now') },
  { name: 'returned', run: () => {} },
  { name: 'presented', run: () => void presented().then((p) => pushLog('presented', p)) },
  // "Answer" on the incoming-call notification that arrived in the background.
  {
    name: 'answer-from-notification',
    run: () => {
      const snap = () => {
        const s = callController.getSnapshot();
        return { phase: s.phase, call: s.call?.id, state: s.call?.state, reason: s.endReason };
      };
      pushLog('before-answer', snap());
      void tapPresented('call', ACTION.answer).then(() => pushLog('after-answer', snap()));
    },
  },
  { name: 'in-call', run: () => pushLog('call-state', callController.getSnapshot().phase) },
  { name: 'hangup', run: () => pushLog('hangup-please') },
  { name: 'tap-message', run: () => void tapPresented('message') },
  { name: 'after-tap', run: () => void presented().then((p) => pushLog('presented-after-tap', p)) },
  { name: 'tap-missed-call', run: () => void tapPresented('missed-call') },
  {
    // The native VoIP push handler (the Simulator has no PushKit). iOS reports
    // the call to CallKit, then ends it: the Simulator can't show the call UI.
    name: 'callkit-report',
    run: () => {
      pushLog('call-me');
      for (const e of ['reported', 'ignored', 'answer', 'end', 'mute'] as const)
        KoodeCalls?.addListener(e, (body: unknown) => pushLog(`native ${e}`, body));
      const unsub = callController.subscribe(() => {
        const s = callController.getSnapshot();
        if (s.phase !== 'incoming' || !s.call || !KoodeCalls) return;
        unsub();
        void KoodeCalls.simulateVoipPush({
          aps: {},
          body: {
            type: 'call',
            callId: s.call.id,
            callerId: s.call.callerId,
            callerName: 'Maya Chen',
            kind: s.call.kind,
          },
        });
      });
    },
  },
  {
    name: 'callkit-ended',
    run: () =>
      void (async () =>
        pushLog('callkit-ended', {
          phase: callController.getSnapshot().phase,
          callkit: await KoodeCalls?.activeCallIds(),
        }))(),
  },
  { name: 'done', run: go('/chats') },
];

/**
 * Media and group check against the real server (scripts/media-peer.mjs plays
 * "Maya" and "Sam"). The runner copies test files into Documents/e2e/; they go
 * through the same processing, upload and send path as picked files.
 */
const mediaLog = (label: string, value?: unknown) =>
  console.log(`[tour-media] ${label}${value === undefined ? '' : ` ${JSON.stringify(value)}`}`);
const e2eFile = (name: string) => new File(Paths.document, 'e2e', name).uri;
/** The person named `name` this (fresh) account has a direct chat with. */
const contactNamed = (name: string) => {
  const { contacts, conversations } = useChat.getState();
  for (const c of Object.values(conversations)) {
    if (c.kind !== 'direct') continue;
    const other = c.memberIds.find((m) => m !== ME);
    if (other && contacts[other]?.displayName === name) return other;
  }
  return '';
};
const directWith = (userId: string) =>
  Object.values(useChat.getState().conversations).find(
    (c) => c.kind === 'direct' && c.memberIds.includes(userId),
  )?.id ?? '';
const messagesIn = (id: string) => useChat.getState().messages[id] ?? [];
const fromMaya = (kind: string) =>
  messagesIn(directWith(contactNamed('Maya Chen'))).find(
    (m) => m.senderId !== ME && m.attachment?.kind === kind,
  );
let groupId = '';
const step = (name: string, run: () => Promise<unknown>) => ({
  name,
  run: () =>
    void run().catch((e: unknown) =>
      mediaLog(`${name} FAILED`, e instanceof Error ? e.message : String(e)),
    ),
});
const sendFile = (make: () => Promise<UploadDraft>) => async () => {
  const chat = directWith(contactNamed('Maya Chen'));
  useChat.getState().send(chat, { upload: await make() });
};

export const MEDIA_TOUR: Step[] = [
  {
    name: 'register',
    run: () => {
      useDevSettings.getState().set({ sampleData: false });
      signIn();
    },
  },
  { name: 'wait-for-peer', run: () => mediaLog('ready') },
  { name: 'wait-for-files', run: () => {} },
  step('open-chat', async () => {
    const st = useChat.getState();
    const chat = directWith(contactNamed('Maya Chen'));
    mediaLog('state', {
      contacts: Object.values(st.contacts).map((c) => c.displayName),
      conversations: Object.values(st.conversations).map((c) => [c.kind, c.memberIds.length]),
      chat,
    });
    if (chat) router.navigate(`/chat/${chat}`);
  }),
  step('received', async () => {
    const got: unknown[] = [];
    for (const kind of ['image', 'video', 'document', 'voice']) {
      const a = fromMaya(kind)?.attachment;
      const remote = remoteOf(a);
      if (!a || !remote) {
        got.push([kind, 'MISSING']);
        continue;
      }
      const uri = await download(remote);
      got.push([kind, new File(uri).size, 'sizeBytes' in a ? a.sizeBytes : null]);
    }
    mediaLog('downloaded', got);
  }),
  step(
    'send-photo',
    sendFile(() => prepareImage({ uri: e2eFile('gps.jpg'), width: 1600, height: 1200 })),
  ),
  step(
    'send-video',
    sendFile(() =>
      prepareVideo({
        uri: e2eFile('clip.mp4'),
        width: 640,
        height: 360,
        durationMs: 3000,
        fileName: 'clip.mp4',
      }),
    ),
  ),
  step(
    'send-document',
    sendFile(() =>
      prepareDocument({
        uri: e2eFile('notes.pdf'),
        name: 'Trip notes.pdf',
        mimeType: 'application/pdf',
      }),
    ),
  ),
  step(
    'send-voice',
    sendFile(() =>
      prepareVoice({
        uri: e2eFile('voice.m4a'),
        durationMs: 2000,
        levels: [0.1, 0.5, 0.9, 0.4, 0.2],
      }),
    ),
  ),
  step('sent', async () => {
    const mine = messagesIn(directWith(contactNamed('Maya Chen'))).filter((m) => m.senderId === ME);
    mediaLog(
      'sent',
      mine.map((m) => [m.attachment?.kind, m.status, !!m.attachment?.attachmentId]),
    );
  }),
  step('react', async () => {
    const photo = fromMaya('image')!;
    await useChat.getState().toggleReaction(photo.conversationId, photo.id, '👍');
    mediaLog('reacted');
  }),
  step('delete-for-everyone', async () => {
    const chat = directWith(contactNamed('Maya Chen'));
    const doc = messagesIn(chat).find(
      (m) => m.senderId === ME && m.attachment?.kind === 'document',
    );
    if (doc) await useChat.getState().deleteMessage(chat, doc.id, 'everyone');
    const after = messagesIn(chat).find((m) => m.id === doc?.id);
    mediaLog('deleted', { deleted: after?.deleted, attachment: !!after?.attachment });
  }),
  step('reaction-from-maya', async () => {
    const mine = messagesIn(directWith(contactNamed('Maya Chen'))).find(
      (m) => m.senderId === ME && m.attachment?.kind === 'image',
    );
    mediaLog('my-photo-reactions', mine?.reactions);
  }),
  step('record-voice', async () => {
    await devHandles.composer?.startRecording();
    mediaLog('recording', !!devHandles.composer);
  }),
  step('send-recording', async () => {
    await devHandles.composer?.sendRecording();
    mediaLog('recorded');
  }),
  step('save-photo', async () => {
    const photo = fromMaya('image')!;
    await saveToPhotos(photo.attachment!);
    mediaLog('saved-to-photos');
  }),
  step('viewer-photo', async () => {
    const photo = fromMaya('image')!;
    router.push({
      pathname: '/media/[id]',
      params: { id: photo.id, conversationId: photo.conversationId },
    });
  }),
  step('viewer-video', async () => {
    const video = fromMaya('video')!;
    router.back();
    setTimeout(
      () =>
        router.push({
          pathname: '/media/[id]',
          params: { id: video.id, conversationId: video.conversationId },
        }),
      400,
    );
  }),
  step('group-create', async () => {
    router.back();
    groupId = await useChat.getState().createConversation([contactNamed('Maya Chen')], 'Family');
    setTimeout(() => router.navigate(`/chat/${groupId}`), 400);
  }),
  step('group-add-sam', async () => {
    await useChat.getState().addMembers(groupId, [contactNamed('Sam Lee')]);
    await useChat.getState().setAdmin(groupId, contactNamed('Sam Lee'), true);
  }),
  step('group-rename', async () => {
    await useChat.getState().renameGroup(groupId, 'Cousins');
  }),
  step('group-remove-maya', async () => {
    await useChat.getState().removeMember(groupId, contactNamed('Maya Chen'));
    mediaLog('group-done', groupId);
  }),
  step('group-info', async () => {
    router.push(`/chat/${groupId}/info`);
  }),
  step('group-chat', async () => {
    router.back();
    const c = useChat.getState().conversations[groupId];
    mediaLog('group', {
      title: c?.title,
      members: c?.memberIds.length,
      admins: c?.adminIds.length,
      notes: messagesIn(groupId)
        .filter((m) => m.system)
        .map((m) => m.system),
    });
  }),
  { name: 'done', run: () => mediaLog('done') },
];

/**
 * End-to-end encryption check against a second, independent libsignal
 * implementation: scripts/e2ee-peer.mjs plays "Maya" with Signal's Node
 * library. Messages, a photo, reactions and safety numbers go both ways, then
 * an encrypted call (the peer checks LiveKit only ever forwards ciphertext).
 */
/** When the app logged its call status; the peer checks the SFU after that. */
let callCheckedAt = 0;
const e2eeLog = (label: string, value?: unknown) =>
  console.log(`[tour-e2ee] ${label}${value === undefined ? '' : ` ${JSON.stringify(value)}`}`);
const mayaChat = () => directWith(contactNamed('Maya Chen'));
const myCrypto = () => deviceCrypto(useSession.getState().user!.id);
const e2eeStep = (name: string, run: () => Promise<unknown>) => ({
  name,
  run: () =>
    void run().catch((e: unknown) =>
      e2eeLog(`${name} FAILED`, e instanceof Error ? e.message : String(e)),
    ),
});

export const E2EE_TOUR: Step[] = [
  {
    name: 'register',
    run: () => {
      useDevSettings.getState().set({ sampleData: false });
      signIn();
    },
  },
  e2eeStep('keys', async () => e2eeLog('ready', { device: await myCrypto().deviceId() })),
  { name: 'wait-for-peer', run: () => {} },
  { name: 'wait-for-messages', run: () => {} },
  e2eeStep('open-chat', async () => {
    const chat = mayaChat();
    e2eeLog('chat', { chat: !!chat });
    if (chat) router.navigate(`/chat/${chat}`);
  }),
  e2eeStep('received', async () => {
    const theirs = messagesIn(mayaChat()).filter((m) => m.senderId !== ME);
    const photo = theirs.find((m) => m.attachment?.kind === 'image')?.attachment;
    const remote = remoteOf(photo);
    const size = remote ? new File(await download(remote)).size : null;
    e2eeLog('received', {
      texts: theirs.filter((m) => m.text).map((m) => m.text),
      undecryptable: theirs.filter((m) => m.undecryptable).map((m) => m.undecryptable),
      photo: photo?.kind === 'image' ? { width: photo.width, height: photo.height, size } : null,
    });
  }),
  e2eeStep('send-text', async () => {
    useChat.getState().send(mayaChat(), { text: 'Hi Maya 👋 sent from the app over libsignal' });
  }),
  e2eeStep(
    'send-photo',
    sendFile(() => prepareImage({ uri: e2eFile('gps.jpg'), width: 1600, height: 1200 })),
  ),
  e2eeStep('react', async () => {
    const theirs = messagesIn(mayaChat()).find((m) => m.senderId !== ME && m.text);
    if (theirs) await useChat.getState().toggleReaction(mayaChat(), theirs.id, '👍');
  }),
  e2eeStep('safety-number', async () => {
    const maya = contactNamed('Maya Chen');
    router.push({ pathname: '/safety/[id]', params: { id: maya } });
    const devices = await myCrypto().devices(maya);
    const numbers = await Promise.all(
      devices.map(async (d) => (await myCrypto().safetyNumber(maya, d.identityKey)).displayable),
    );
    e2eeLog('safety', numbers);
  }),
  e2eeStep('verified', async () => {
    const maya = contactNamed('Maya Chen');
    await myCrypto().setVerified(maya, true);
    e2eeLog('verification', await myCrypto().verification(maya));
  }),
  { name: 'back-to-chat', run: () => router.back() },
  e2eeStep('reactions', async () => {
    const mine = messagesIn(mayaChat()).filter((m) => m.senderId === ME);
    e2eeLog(
      'mine',
      mine.map((m) => [m.text ?? m.attachment?.kind, m.status, m.reactions.map((r) => r.emoji)]),
    );
  }),
  e2eeStep('call', async () => startCall(contactNamed('Maya Chen'), 'voice')),
  { name: 'ringing', run: () => {} },
  { name: 'in-call', run: () => {} },
  { name: 'in-call-2', run: () => {}, shotAtMs: 1500 },
  e2eeStep('call-status', async () => {
    callCheckedAt = 0;
    // Media can take a while to connect (e.g. the Android emulator's network).
    for (let i = 0; i < 60 && callController.getSnapshot().phase !== 'connected'; i++)
      await new Promise((r) => setTimeout(r, 500));
    await new Promise((r) => setTimeout(r, 3000)); // let some audio arrive
    const s = callController.getSnapshot();
    const audio = await callController.audioStats();
    e2eeLog('call', { phase: s.phase, encrypted: s.encrypted, remote: s.remotePresent, audio });
    callCheckedAt = Date.now();
  }),
  { name: 'in-call-3', run: () => {} },
  e2eeStep('hang-up', async () => {
    // Stay in the call while the peer listens and inspects the SFU (about 5 s).
    for (let i = 0; i < 80 && (!callCheckedAt || Date.now() - callCheckedAt < 12_000); i++)
      await new Promise((r) => setTimeout(r, 500));
    await callController.hangUp();
  }),
  { name: 'done', run: () => e2eeLog('done') },
];

/** Measurements run one after another (each can take seconds). */
async function runPerf() {
  await new Promise((r) => setTimeout(r, 2500));
  for (const [name, run] of [
    ['seed', seedCache],
    ['startup-cache', measureStartupQueries],
    ['derive', async () => measureDerive()],
    ['file-crypto', measureFileCrypto],
  ] as const) {
    try {
      await run();
    } catch (e) {
      perfLog(`${name} FAILED`, e instanceof Error ? e.message : String(e));
    }
  }
  console.log('[tour] 1 done');
}

export function useDevTour(mode: string | undefined) {
  const enabled = !!mode;
  useEffect(() => {
    if (!__DEV__ || !enabled) return;
    if (mode === 'perf') {
      void runPerf();
      return;
    }
    if (mode === 'resilience') {
      void useSession
        .getState()
        .signOut()
        .then(runResilience)
        .catch((e: unknown) =>
          console.log(`[tour-res] FAILED ${e instanceof Error ? e.message : String(e)}`),
        );
      return;
    }
    // Start signed out so onboarding screens are reachable. NOTE: this removes
    // the current device from its account on the local server.
    void useSession.getState().signOut();
    const prefs = usePreferences.getState();
    const saved = { appearance: prefs.appearance, accent: prefs.accent };
    if (mode !== 'messaging' && mode !== 'calls')
      useDevSettings.getState().set({ sampleData: true });
    if (mode === 'light' || mode === 'dark') {
      prefs.set('appearance', mode as AppearancePreference);
      prefs.set('accent', 'blue');
    }
    const restore = () => {
      usePreferences.getState().set('appearance', saved.appearance);
      usePreferences.getState().set('accent', saved.accent);
    };
    const steps =
      mode === 'messaging'
        ? MESSAGING_TOUR
        : mode === 'calls'
          ? CALL_TOUR
          : mode === 'push'
            ? PUSH_TOUR
            : mode === 'media'
              ? MEDIA_TOUR
              : mode === 'e2ee'
                ? E2EE_TOUR
                : TOUR;
    let i = 0;
    const tick = () => {
      const step = steps[i];
      if (!step) return;
      step.run();
      // Log after navigation settles so screenshots match the step.
      setTimeout(
        () => {
          console.log(`[tour] ${i} ${step.name}`);
          if (step.name === 'done') restore();
        },
        step.shotAtMs ?? STEP_MS - 600,
      );
      i += 1;
      timer = setTimeout(tick, STEP_MS);
    };
    let timer = setTimeout(tick, 2500);
    return () => clearTimeout(timer);
  }, [enabled, mode]);
}
