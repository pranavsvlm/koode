import { z } from 'zod';

/**
 * End-to-end encryption (libsignal). The server is a directory of public keys
 * and a mailbox for ciphertext; it never sees private keys or plaintext.
 * Binary values are standard base64.
 */

const Base64 = (max: number) =>
  z
    .string()
    .min(4)
    .max(max)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Must be base64');

/** Signal device number: small and per account (1, 2, 3 …). */
export const SignalDeviceId = z.number().int().min(1).max(127);
const KeyId = z.number().int().min(1).max(0xffffff);

/** Serialized public keys: EC (33 bytes), Kyber-1024 (1569 bytes); signatures 64 bytes. */
const EcKey = Base64(64);
const KyberKey = Base64(2200);
const Signature = Base64(128);

export const SignedPreKey = z.object({ keyId: KeyId, publicKey: EcKey, signature: Signature });
export const KyberPreKey = z.object({ keyId: KeyId, publicKey: KyberKey, signature: Signature });
export const OneTimePreKey = z.object({ keyId: KeyId, publicKey: EcKey });
export type SignedPreKey = z.infer<typeof SignedPreKey>;
export type KyberPreKey = z.infer<typeof KyberPreKey>;
export type OneTimePreKey = z.infer<typeof OneTimePreKey>;

/** Most one-time keys of each kind a device may hold on the server. */
export const MAX_ONE_TIME_KEYS = 200;
/** Uploads per request. */
export const MAX_KEYS_PER_UPLOAD = 100;

/**
 * Publish this device's keys. The identity key is fixed for the device's
 * lifetime (a different one is refused); prekeys may rotate.
 */
export const PublishKeysRequest = z.object({
  registrationId: z.number().int().min(1).max(16380),
  identityKey: EcKey,
  signedPreKey: SignedPreKey,
  /** Last-resort Kyber prekey, used when one-time ones run out. */
  kyberPreKey: KyberPreKey,
  preKeys: z.array(OneTimePreKey).max(MAX_KEYS_PER_UPLOAD).default([]),
  kyberPreKeys: z.array(KyberPreKey).max(MAX_KEYS_PER_UPLOAD).default([]),
});
export type PublishKeysRequest = z.input<typeof PublishKeysRequest>;

export const UploadOneTimeKeysRequest = z.object({
  preKeys: z.array(OneTimePreKey).max(MAX_KEYS_PER_UPLOAD).default([]),
  kyberPreKeys: z.array(KyberPreKey).max(MAX_KEYS_PER_UPLOAD).default([]),
});
export type UploadOneTimeKeysRequest = z.input<typeof UploadOneTimeKeysRequest>;

export const KeyStatus = z.object({
  /** This device's Signal device number. */
  deviceId: SignalDeviceId,
  published: z.boolean(),
  /** Identity key on file, if published (to detect a mismatch after reinstall). */
  identityKey: z.string().nullable(),
  preKeys: z.number().int(),
  kyberPreKeys: z.number().int(),
});
export type KeyStatus = z.infer<typeof KeyStatus>;

/** A person's devices that can receive encrypted messages. */
export const KeyDevice = z.object({
  userId: z.string(),
  deviceId: SignalDeviceId,
  identityKey: z.string(),
});
export type KeyDevice = z.infer<typeof KeyDevice>;
export const KeyDeviceList = z.object({ devices: z.array(KeyDevice) });
export type KeyDeviceList = z.infer<typeof KeyDeviceList>;

/** What a sender needs to start a session with one device (consumes a one-time key). */
export const PreKeyBundle = z.object({
  userId: z.string(),
  deviceId: SignalDeviceId,
  registrationId: z.number().int(),
  identityKey: z.string(),
  signedPreKey: SignedPreKey,
  kyberPreKey: KyberPreKey,
  preKey: OneTimePreKey.nullable(),
});
export type PreKeyBundle = z.infer<typeof PreKeyBundle>;
export const PreKeyBundleList = z.object({ bundles: z.array(PreKeyBundle) });

// ——— Ciphertext ———

/** libsignal CiphertextMessageType: 2 = whisper (session), 3 = prekey (session setup). */
export const EnvelopeType = z.union([z.literal(2), z.literal(3)]);
/** Base64 ciphertext cap per device (text, metadata and a tiny preview fit easily). */
export const MAX_ENVELOPE_CHARS = 64 * 1024;

/** A ciphertext for one device, as sent. */
export const OutgoingEnvelope = z.object({
  userId: z.string().min(1).max(64),
  deviceId: SignalDeviceId,
  type: EnvelopeType,
  body: Base64(MAX_ENVELOPE_CHARS),
});
export type OutgoingEnvelope = z.infer<typeof OutgoingEnvelope>;

/** A ciphertext as received: only the envelopes for the reader's own devices are included. */
export const Envelope = z.object({
  deviceId: SignalDeviceId,
  type: EnvelopeType,
  body: z.string(),
});
export type Envelope = z.infer<typeof Envelope>;

/** 409 details when a send didn't address exactly the current devices. */
export const DeviceMismatch = z.object({
  missing: z.array(z.object({ userId: z.string(), deviceId: z.number().int() })),
  extra: z.array(z.object({ userId: z.string(), deviceId: z.number().int() })),
  /** Members with no device that can receive encrypted messages (yet). */
  unkeyed: z.array(z.string()).default([]),
});
export type DeviceMismatch = z.infer<typeof DeviceMismatch>;

// ——— Plaintext inside the envelopes (never seen by the server) ———

const Text = z.string().max(4000);
const Id = z.string().min(1).max(64);

/** The file key and SHA-256 of the ciphertext, for an encrypted file. */
export const FileSecret = z.object({ key: Base64(64), digest: Base64(64) });
export type FileSecret = z.infer<typeof FileSecret>;

export const EncryptedAttachment = z.object({
  kind: z.enum(['image', 'video', 'document', 'voice']),
  mimeType: z.string().max(127),
  /** Plaintext size. */
  sizeBytes: z.number().int().nonnegative(),
  name: z.string().max(255).nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  waveform: z.array(z.number()).max(64).nullable(),
  preview: z.string().max(6000).nullable(),
  content: FileSecret,
  /** Video poster, encrypted with its own key. */
  thumbnail: FileSecret.nullable(),
});
export type EncryptedAttachment = z.infer<typeof EncryptedAttachment>;

/** An uploaded (encrypted) profile photo. */
export const AvatarId = z.string().regex(/^av_[A-Za-z0-9_-]{16,64}$/);

/**
 * The sender's profile photo and the key to it, carried by every message (as
 * Signal shares profile keys), so whoever the sender writes to can show it and
 * the server can't. `avatar: null`: no photo.
 */
export const ProfileSecret = z.object({
  avatar: z.object({ id: AvatarId, content: FileSecret }).nullable(),
});
export type ProfileSecret = z.infer<typeof ProfileSecret>;

/**
 * Every message payload names its own message and conversation, and a
 * reaction names its target, so the server can't move ciphertext between
 * messages or chats undetected (receivers check them against the envelope's
 * message). `profile` is optional: older apps don't send it.
 */
const Bound = {
  v: z.literal(1),
  id: Id,
  conversationId: Id,
  // A profile this version can't read is ignored; the message still opens.
  profile: ProfileSecret.optional().catch(undefined),
};

export const Payload = z.discriminatedUnion('t', [
  z.object({ ...Bound, t: z.literal('text'), body: Text, replyToId: Id.nullable() }),
  z.object({
    ...Bound,
    t: z.literal('attachment'),
    body: Text,
    replyToId: Id.nullable(),
    attachment: EncryptedAttachment,
  }),
  /** My reaction to `targetId`; null removes it. */
  z.object({
    ...Bound,
    t: z.literal('reaction'),
    targetId: Id,
    emoji: z.string().max(16).nullable(),
  }),
  /** Media key for a call (frame encryption in LiveKit). */
  z.object({ v: z.literal(1), t: z.literal('call'), callId: Id, key: Base64(64) }),
]);
export type Payload = z.infer<typeof Payload>;
