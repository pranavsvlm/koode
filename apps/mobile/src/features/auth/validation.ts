/**
 * Pure helpers for the onboarding flow. Server-side validation (Phase 3)
 * must enforce the same rules — never trust the client alone.
 */

/** Invite codes are shown as XXXX-XXXX-XXXX (Crockford-style, no ambiguous chars). */
export function formatInviteCode(raw: string): string {
  const clean = raw
    .toUpperCase()
    .replace(/[^0-9A-HJKMNP-TV-Z]/g, '')
    .slice(0, 12);
  return clean.match(/.{1,4}/g)?.join('-') ?? '';
}

export function validateUsername(value: string): string | undefined {
  if (value.length === 0) return undefined;
  if (value.length < 3) return 'At least 3 characters';
  if (value.length > 24) return 'At most 24 characters';
  if (!/^[a-z0-9._]+$/.test(value)) return 'Use lowercase letters, numbers, dots and underscores';
  if (/^[._]|[._]$/.test(value)) return 'Can’t start or end with a dot or underscore';
  return undefined;
}

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

/** 120 random bits as 24 base32 characters in groups of four. */
export function generateRecoveryKey(randomBytes: (n: number) => Uint8Array): string {
  const bytes = randomBytes(15);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.match(/.{4}/g)!.join(' ');
}
