import { CROCKFORD_ALPHABET } from '@koode/shared';
import { fromBase64Url, toBase64Url, utf8 } from './encoding';

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** URL-safe random token with `bytes` of entropy. */
export function randomToken(bytes = 32): string {
  return toBase64Url(randomBytes(bytes));
}

/** Opaque, unguessable id such as "usr_4fQ…". */
export function newId(prefix: 'usr' | 'dev' | 'ses' | 'inv'): string {
  return `${prefix}_${randomToken(12)}`;
}

/** Random Crockford base32 string. 32 divides 256, so there is no modulo bias. */
export function randomCrockford(length: number): string {
  return Array.from(randomBytes(length), (b) => CROCKFORD_ALPHABET[b % 32]).join('');
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', utf8(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hmacSha256Hex(secret: string, input: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    utf8(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, utf8(input));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time comparison of two equal-length hex/ASCII strings. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Verify a raw Ed25519 signature with the Workers WebCrypto implementation. */
export async function verifyEd25519(
  publicKeyB64: string,
  message: string,
  signatureB64: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      fromBase64Url(publicKeyB64),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify('Ed25519', key, fromBase64Url(signatureB64), utf8(message));
  } catch {
    return false;
  }
}
