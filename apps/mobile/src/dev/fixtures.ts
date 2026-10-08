import { ME, type CallRecord, type Contact, type Conversation, type Message } from '@/domain/types';
import { devImages } from './images';

/**
 * Realistic development data. Timestamps are relative to `now` so the UI
 * always shows "today", "yesterday" and older groupings.
 */
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const contacts: Contact[] = [
  {
    id: 'maya',
    displayName: 'Maya Chen',
    username: 'maya',
    about: 'Probably hiking 🏔️',
    online: true,
  },
  { id: 'daniel', displayName: 'Daniel Okafor', username: 'dan.okafor', about: 'Coffee first.' },
  {
    id: 'priya',
    displayName: 'Priya Raman',
    username: 'priya',
    about: 'Bake. Read. Repeat.',
    online: true,
  },
  { id: 'grandma', displayName: 'Grandma Rose', username: 'rose', about: 'Call me on Sundays ☎️' },
  { id: 'leo', displayName: 'Leo Martins', username: 'leo.m' },
  { id: 'sofia', displayName: 'Sofia Rossi', username: 'sofia', about: 'In Lisbon until May' },
  { id: 'aiko', displayName: 'Aiko Tanaka', username: 'aiko', online: true },
  { id: 'omar', displayName: 'Omar Haddad', username: 'omar.h', about: 'Ask me about bikes 🚲' },
  { id: 'elena', displayName: 'Elena Petrova', username: 'elena.p' },
  { id: 'sam', displayName: 'Sam Patel', username: 'sam' },
  { id: 'chloe', displayName: 'Chloé Dubois', username: 'chloe' },
  { id: 'noah', displayName: 'Noah Williams', username: 'noah.w', about: 'Dad jokes, on request' },
];

export function buildFixtures(now = Date.now()) {
  const ago = (ms: number) => now - ms;
  const lastSeen: Record<string, number> = {
    daniel: ago(12 * MIN),
    grandma: ago(3 * HOUR),
    leo: ago(26 * HOUR),
    sofia: ago(40 * MIN),
    omar: ago(5 * HOUR),
    elena: ago(2 * DAY),
    sam: ago(20 * HOUR),
    chloe: ago(3 * DAY),
    noah: ago(9 * HOUR),
  };
  const people = contacts.map((c) => ({ ...c, lastSeenAt: c.online ? undefined : lastSeen[c.id] }));

  const conversations: Conversation[] = [];
  const messages: Message[] = [];
  let seq = 0;

  const convo = (
    c: Omit<Conversation, 'typingUserIds' | 'adminIds' | 'createdAt'> & Partial<Conversation>,
  ) => {
    conversations.push({ typingUserIds: [], adminIds: [], createdAt: ago(60 * DAY), ...c });
    return c.id;
  };
  const msg = (
    conversationId: string,
    senderId: string,
    at: number,
    body: Partial<Message> = {},
  ): string => {
    const id = `m${++seq}`;
    messages.push({
      id,
      conversationId,
      senderId,
      createdAt: at,
      status: senderId === ME ? 'read' : 'delivered',
      reactions: [],
      ...body,
    });
    return id;
  };

  // — Maya: rich direct chat (photos, reply, reaction, voice) —
  const maya = convo({
    id: 'c-maya',
    kind: 'direct',
    memberIds: [ME, 'maya'],
    pinned: true,
    muted: false,
    unreadCount: 2,
  });
  msg(maya, 'maya', ago(2 * DAY + 3 * HOUR), {
    text: 'Are we still on for the trail this weekend?',
  });
  msg(maya, ME, ago(2 * DAY + 2.9 * HOUR), { text: 'Absolutely. Saturday, 7am start?' });
  msg(maya, 'maya', ago(2 * DAY + 2.8 * HOUR), { text: 'Perfect. I’ll bring snacks 🥨' });
  msg(maya, ME, ago(DAY + 5 * HOUR), { text: 'Weather looks clear all day ☀️' });
  const plan = msg(maya, 'maya', ago(DAY + 4.9 * HOUR), {
    text: 'Then let’s do the long loop past the lake.',
  });
  msg(maya, ME, ago(DAY + 4.8 * HOUR), { text: 'Deal. I’ll map it tonight.', replyToId: plan });
  msg(maya, 'maya', ago(48 * MIN), {
    attachment: { kind: 'image', ...devImages.lake },
    reactions: [{ emoji: '❤️', userIds: [ME] }],
  });
  msg(maya, 'maya', ago(47 * MIN), { text: 'Scouted it this morning. Worth the early start!' });
  msg(maya, ME, ago(30 * MIN), { text: 'That view though 😍' });
  msg(maya, ME, ago(29 * MIN), {
    attachment: { kind: 'voice', durationSec: 14, waveform: wave(1) },
  });
  msg(maya, 'maya', ago(6 * MIN), { text: 'Haha yes. Bringing the good camera.' });
  msg(maya, 'maya', ago(5 * MIN), { text: 'See you at the trailhead 👋' });

  // — Family group —
  const family = convo({
    id: 'c-family',
    kind: 'group',
    title: 'Family',
    memberIds: [ME, 'grandma', 'priya', 'noah', 'sam'],
    adminIds: [ME, 'priya'],
    pinned: true,
    muted: false,
    unreadCount: 4,
  });
  msg(family, 'grandma', ago(DAY + 9 * HOUR), { text: 'Good morning everyone 🌸' });
  msg(family, 'priya', ago(DAY + 8.5 * HOUR), { text: 'Morning Grandma! 💛' });
  msg(family, 'noah', ago(DAY + 8 * HOUR), {
    attachment: {
      kind: 'document',
      name: 'Thanksgiving plan.pdf',
      sizeBytes: 482_000,
      mimeType: 'application/pdf',
    },
  });
  msg(family, ME, ago(DAY + 7.5 * HOUR), { text: 'I can bring dessert and the folding chairs.' });
  const pie = msg(family, 'priya', ago(2 * HOUR), {
    attachment: { kind: 'image', ...devImages.sunset },
    text: 'Practice round for the pie 🥧',
    reactions: [
      { emoji: '😮', userIds: ['noah', ME] },
      { emoji: '❤️', userIds: ['grandma'] },
    ],
  });
  msg(family, 'grandma', ago(90 * MIN), { text: 'Looks just like mine used to!', replyToId: pie });
  msg(family, 'sam', ago(40 * MIN), {
    attachment: {
      kind: 'video',
      poster: devImages.ocean.source,
      width: 1200,
      height: 900,
      durationSec: 37,
    },
  });
  msg(family, 'noah', ago(18 * MIN), { text: 'Who’s picking up Grandma on Thursday?' });
  msg(family, 'priya', ago(12 * MIN), { text: 'I can, around 4.' });

  // — Daniel: last message from me, delivered not read —
  const dan = convo({
    id: 'c-daniel',
    kind: 'direct',
    memberIds: [ME, 'daniel'],
    pinned: false,
    muted: false,
    unreadCount: 0,
  });
  msg(dan, 'daniel', ago(3 * HOUR), { text: 'Did you see the game last night?' });
  msg(dan, ME, ago(2.5 * HOUR), { text: 'Only the last ten minutes. Unreal finish.' });
  msg(dan, ME, ago(2.4 * HOUR), { text: 'Lunch Thursday?', status: 'delivered' });

  // — Weekend Hike group (muted) —
  const hike = convo({
    id: 'c-hike',
    kind: 'group',
    title: 'Weekend Hike',
    memberIds: [ME, 'maya', 'leo', 'aiko', 'omar'],
    adminIds: ['maya'],
    pinned: false,
    muted: true,
    unreadCount: 11,
  });
  msg(hike, 'leo', ago(5 * HOUR), { text: 'Carpool list?' });
  msg(hike, 'aiko', ago(4 * HOUR), { attachment: { kind: 'image', ...devImages.mountains } });
  msg(hike, 'omar', ago(3.5 * HOUR), { text: 'I have room for 3 🚙' });

  // — Grandma: voice-heavy —
  const gran = convo({
    id: 'c-grandma',
    kind: 'direct',
    memberIds: [ME, 'grandma'],
    pinned: false,
    muted: false,
    unreadCount: 0,
  });
  msg(gran, 'grandma', ago(DAY + 2 * HOUR), {
    attachment: { kind: 'voice', durationSec: 42, waveform: wave(2) },
  });
  msg(gran, ME, ago(DAY + HOUR), { text: 'Love you too Grandma. Call you Sunday ❤️' });

  // — Older chats —
  const sofia = convo({
    id: 'c-sofia',
    kind: 'direct',
    memberIds: [ME, 'sofia'],
    pinned: false,
    muted: false,
    unreadCount: 0,
  });
  msg(sofia, 'sofia', ago(3 * DAY), {
    attachment: { kind: 'image', ...devImages.city },
    text: 'Lisbon at night ✨',
  });
  msg(sofia, ME, ago(3 * DAY - 10 * MIN), { text: 'Jealous! Have the best time.' });

  const book = convo({
    id: 'c-book',
    kind: 'group',
    title: 'Book Club',
    memberIds: [ME, 'elena', 'chloe', 'priya'],
    adminIds: ['elena'],
    pinned: false,
    muted: false,
    unreadCount: 0,
  });
  msg(book, 'elena', ago(9 * DAY), { text: 'Next pick: “The Remains of the Day”. Thoughts?' });
  msg(book, 'chloe', ago(9 * DAY - HOUR), { text: 'Yes!! Been meaning to read it.' });

  const aiko = convo({
    id: 'c-aiko',
    kind: 'direct',
    memberIds: [ME, 'aiko'],
    pinned: false,
    muted: false,
    unreadCount: 0,
  });
  msg(aiko, ME, ago(12 * DAY), { text: 'Thanks for the recipe — it was a hit!' });
  msg(aiko, 'aiko', ago(12 * DAY - 2 * HOUR), { text: 'Yay! So glad 🍜' });

  const calls: CallRecord[] = [
    {
      id: 'k1',
      contactId: 'grandma',
      kind: 'video',
      direction: 'incoming',
      outcome: 'answered',
      startedAt: ago(70 * MIN),
      durationSec: 1460,
    },
    {
      id: 'k2',
      contactId: 'daniel',
      kind: 'voice',
      direction: 'incoming',
      outcome: 'missed',
      startedAt: ago(3.2 * HOUR),
      durationSec: 0,
    },
    {
      id: 'k3',
      contactId: 'maya',
      kind: 'voice',
      direction: 'outgoing',
      outcome: 'answered',
      startedAt: ago(7 * HOUR),
      durationSec: 312,
    },
    {
      id: 'k4',
      contactId: 'priya',
      kind: 'video',
      direction: 'outgoing',
      outcome: 'cancelled',
      startedAt: ago(DAY + HOUR),
      durationSec: 0,
    },
    {
      id: 'k5',
      contactId: 'noah',
      kind: 'voice',
      direction: 'incoming',
      outcome: 'missed',
      startedAt: ago(DAY + 6 * HOUR),
      durationSec: 0,
    },
    {
      id: 'k6',
      contactId: 'sofia',
      kind: 'video',
      direction: 'incoming',
      outcome: 'answered',
      startedAt: ago(3 * DAY),
      durationSec: 2710,
    },
    {
      id: 'k7',
      contactId: 'omar',
      kind: 'voice',
      direction: 'outgoing',
      outcome: 'answered',
      startedAt: ago(5 * DAY),
      durationSec: 95,
    },
    {
      id: 'k8',
      contactId: 'grandma',
      kind: 'voice',
      direction: 'incoming',
      outcome: 'declined',
      startedAt: ago(6 * DAY),
      durationSec: 0,
    },
  ];

  return { contacts: people, conversations, messages, calls };
}

/** Deterministic pseudo-random voice waveform (0–1 amplitudes). */
export function wave(seed: number, bars = 32): number[] {
  let x = seed * 9301 + 49297;
  return Array.from({ length: bars }, (_, i) => {
    x = (x * 9301 + 49297) % 233280;
    const envelope = Math.sin((i / (bars - 1)) * Math.PI) * 0.6 + 0.35;
    return Math.min(1, 0.15 + (x / 233280) * envelope);
  });
}

export const CANNED_REPLIES = [
  'Sounds good!',
  'Haha 😄',
  'On my way',
  'Love that ❤️',
  'Let me check and get back to you.',
  'Yes, definitely.',
];
