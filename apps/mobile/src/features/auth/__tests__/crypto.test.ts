import {
  fromBase64Url,
  generateDeviceKey,
  signMessage,
  toBase64Url,
  verifyMessage,
} from '../crypto';

describe('base64url', () => {
  it.each([[[]], [[0]], [[255, 254]], [[1, 2, 3]], [[0, 0, 0, 0]]])('round-trips %j', (bytes) => {
    const u = Uint8Array.from(bytes);
    expect(Array.from(fromBase64Url(toBase64Url(u)))).toEqual(bytes);
  });
  it('matches the standard alphabet without padding', () => {
    expect(toBase64Url(Uint8Array.from([251, 255]))).toBe('-_8');
  });
});

describe('device keys', () => {
  const rng = (n: number) => Uint8Array.from({ length: n }, (_, i) => i + 1);

  it('produce 32-byte keys encoded as 43 base64url chars', () => {
    const key = generateDeviceKey(rng);
    expect(key.publicKey).toHaveLength(43);
    expect(key.secretKey).toHaveLength(43);
  });

  it('sign and verify (RFC 8032 Ed25519 via @noble/curves)', () => {
    const key = generateDeviceKey(rng);
    const sig = signMessage(key.secretKey, 'hello');
    expect(sig).toHaveLength(86);
    expect(verifyMessage(key.publicKey, 'hello', sig)).toBe(true);
    expect(verifyMessage(key.publicKey, 'hellO', sig)).toBe(false);
  });

  it('rejects a short random source', () => {
    expect(() => generateDeviceKey((n) => new Uint8Array(n - 1))).toThrow();
  });
});
