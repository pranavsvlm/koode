import { ed25519 } from '@noble/curves/ed25519.js';

/**
 * Device signing keys. Ed25519 via @noble/curves (audited, pure JS, works on
 * Hermes). Randomness is injected so callers use a CSPRNG (expo-crypto) and
 * tests can be deterministic. No custom cryptography lives here.
 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63]!;
    if (i + 2 < bytes.length) out += B64[n & 63]!;
  }
  return out;
}

export function fromBase64Url(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let j = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error('Invalid base64url');
    value = (value << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (value >> bits) & 255;
    }
  }
  return out;
}

const encoder = new TextEncoder();

export type DeviceKeyPair = { secretKey: string; publicKey: string };

export function generateDeviceKey(randomBytes: (n: number) => Uint8Array): DeviceKeyPair {
  const secret = randomBytes(32);
  if (secret.length !== 32) throw new Error('Expected 32 random bytes');
  return { secretKey: toBase64Url(secret), publicKey: toBase64Url(ed25519.getPublicKey(secret)) };
}

export function signMessage(secretKey: string, message: string): string {
  return toBase64Url(ed25519.sign(encoder.encode(message), fromBase64Url(secretKey)));
}

export function verifyMessage(publicKey: string, message: string, signature: string): boolean {
  return ed25519.verify(
    fromBase64Url(signature),
    encoder.encode(message),
    fromBase64Url(publicKey),
  );
}
