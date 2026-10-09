import { z } from 'zod';

/** Crockford base32: no I, L, O, U, so codes survive being read aloud or retyped. */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const crockford = /^[0-9A-HJKMNP-TV-Z]+$/;

export const RESERVED_USERNAMES = new Set([
  'admin',
  'administrator',
  'koode',
  'support',
  'help',
  'root',
  'system',
  'security',
  'me',
  'you',
]);

/** 3–24 chars: lowercase letters, digits, dots, underscores; no leading/trailing punctuation. */
export const Username = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._]{1,22}[a-z0-9]$/, 'Invalid username')
  .refine((u) => !RESERVED_USERNAMES.has(u), 'This username is reserved');

// Printable text only: reject control characters (incl. bidi overrides) in names.
const noControlChars = (s: string) => !/[\p{Cc}\p{Cf}]/u.test(s);

export const DisplayName = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(48)
  .refine(noControlChars, 'Name contains invalid characters');

export const About = z.string().trim().max(120).refine(noControlChars, 'Invalid characters');

const Base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/, 'Expected base64url');
/** Raw 32-byte Ed25519 public key, base64url without padding (43 chars). */
export const PublicKey = Base64Url.length(43);
/** Raw 64-byte Ed25519 signature, base64url without padding (86 chars). */
export const Signature = Base64Url.length(86);
export const Nonce = Base64Url.min(22).max(64);

/** Accepts "K7QM-4XRT-9PWD" or "k7qm4xrt9pwd"; normalises to 12 uppercase chars. */
export const InviteCode = z
  .string()
  .transform((s) => s.toUpperCase().replace(/[\s-]/g, ''))
  .pipe(z.string().length(12).regex(crockford, 'Invalid invite code'));

/** 24 Crockford base32 chars (120 bits); spaces ignored. */
export const RecoveryKey = z
  .string()
  .transform((s) => s.toUpperCase().replace(/\s/g, ''))
  .pipe(z.string().length(24).regex(crockford, 'Invalid recovery key'));

export const Platform = z.enum(['ios', 'android']);

export const DeviceRegistration = z.object({
  name: z.string().trim().min(1).max(64).refine(noControlChars),
  platform: Platform,
  signingPublicKey: PublicKey,
});
export type DeviceRegistration = z.infer<typeof DeviceRegistration>;

export const ChallengePurpose = z.enum(['register', 'login', 'recover']);
export type ChallengePurpose = z.infer<typeof ChallengePurpose>;

export const ChallengeRequest = z.object({ purpose: ChallengePurpose });
export const ChallengeResponse = z.object({ nonce: Nonce, expiresAt: z.number().int() });
export type ChallengeResponse = z.infer<typeof ChallengeResponse>;

/**
 * The exact bytes a device signs to prove key possession. `subject` binds the
 * signature to its context: the new public key (register/recover) or the
 * device id (login). Changing this format is a breaking protocol change.
 */
export function authSigningMessage(
  purpose: ChallengePurpose,
  nonce: string,
  subject: string,
): string {
  return `koode-auth-v1\n${purpose}\n${nonce}\n${subject}`;
}

export const RegisterRequest = z.object({
  inviteCode: InviteCode,
  username: Username,
  displayName: DisplayName,
  recoveryKey: RecoveryKey,
  device: DeviceRegistration,
  nonce: Nonce,
  signature: Signature,
});
export type RegisterRequest = z.input<typeof RegisterRequest>;

export const LoginRequest = z.object({
  deviceId: z.string().min(1).max(64),
  nonce: Nonce,
  signature: Signature,
});
export type LoginRequest = z.input<typeof LoginRequest>;

export const RecoverRequest = z.object({
  username: Username,
  recoveryKey: RecoveryKey,
  device: DeviceRegistration,
  nonce: Nonce,
  signature: Signature,
});
export type RecoverRequest = z.input<typeof RecoverRequest>;

export const RefreshRequest = z.object({ refreshToken: z.string().min(20).max(128) });

export const User = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  about: z.string(),
  createdAt: z.number().int(),
});
export type User = z.infer<typeof User>;

export const AuthSession = z.object({
  user: User,
  deviceId: z.string(),
  accessToken: z.string(),
  accessTokenExpiresAt: z.number().int(),
  refreshToken: z.string(),
});
export type AuthSession = z.infer<typeof AuthSession>;

export const TokenPair = AuthSession.pick({
  accessToken: true,
  accessTokenExpiresAt: true,
  refreshToken: true,
});
export type TokenPair = z.infer<typeof TokenPair>;

export const UsernameAvailability = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
});

export const UpdateProfileRequest = z
  .object({ displayName: DisplayName.optional(), about: About.optional() })
  .refine((v) => v.displayName !== undefined || v.about !== undefined, 'Nothing to update');

export const RotateRecoveryKeyRequest = z.object({ recoveryKey: RecoveryKey });

export const Device = z.object({
  id: z.string(),
  name: z.string(),
  platform: Platform,
  createdAt: z.number().int(),
  lastSeenAt: z.number().int().nullable(),
  current: z.boolean(),
});
export type Device = z.infer<typeof Device>;
export const DeviceList = z.object({ devices: z.array(Device) });
export const RenameDeviceRequest = z.object({ name: DeviceRegistration.shape.name });

export const Invite = z.object({
  id: z.string(),
  maxUses: z.number().int(),
  useCount: z.number().int(),
  expiresAt: z.number().int(),
  createdAt: z.number().int(),
});
export type Invite = z.infer<typeof Invite>;
export const CreatedInvite = Invite.extend({ code: z.string() });
export type CreatedInvite = z.infer<typeof CreatedInvite>;
export const InviteList = z.object({ invites: z.array(Invite) });
export const CreateInviteRequest = z.object({
  expiresInDays: z.number().int().min(1).max(30).default(7),
});
export const InvitePreview = z.object({
  inviterName: z.string().nullable(),
  expiresAt: z.number().int(),
});
export type InvitePreview = z.infer<typeof InvitePreview>;

export const OkResponse = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponse>;

/** Format a 12-char invite code as XXXX-XXXX-XXXX for display. */
export function formatInviteCode(code: string): string {
  return code.match(/.{1,4}/g)?.join('-') ?? code;
}
