import { describe, expect, it } from 'vitest';
import {
  authSigningMessage,
  DisplayName,
  formatInviteCode,
  InviteCode,
  RecoveryKey,
  RegisterRequest,
  Username,
} from './auth';

describe('Username', () => {
  it.each(['maya', 'dan.okafor', 'a_b', 'abc', 'x1y2z3'])('accepts %s', (u) => {
    expect(Username.safeParse(u).success).toBe(true);
  });
  it.each(['ab', 'Maya', '.maya', 'maya.', 'ma ya', 'a'.repeat(25), 'admin', 'koode', 'maya!'])(
    'rejects %s',
    (u) => {
      expect(Username.safeParse(u).success).toBe(false);
    },
  );
});

describe('DisplayName', () => {
  it('trims and accepts unicode names', () => {
    expect(DisplayName.parse('  Chloé Dubois  ')).toBe('Chloé Dubois');
  });
  it('rejects empty names and control or bidi-override characters', () => {
    expect(DisplayName.safeParse('   ').success).toBe(false);
    expect(DisplayName.safeParse('evil‮eman').success).toBe(false);
    expect(DisplayName.safeParse('tab\there').success).toBe(false);
  });
});

describe('InviteCode', () => {
  it('normalises formatting', () => {
    expect(InviteCode.parse('k7qm-4xrt-9pwd')).toBe('K7QM4XRT9PWD');
  });
  it('rejects ambiguous characters and wrong lengths', () => {
    expect(InviteCode.safeParse('K7QM-4XRT-9PWO').success).toBe(false);
    expect(InviteCode.safeParse('K7QM-4XRT').success).toBe(false);
  });
  it('formats for display', () => {
    expect(formatInviteCode('K7QM4XRT9PWD')).toBe('K7QM-4XRT-9PWD');
  });
});

describe('RecoveryKey', () => {
  it('ignores spaces and case', () => {
    expect(RecoveryKey.parse('p4y9 8rjr k0xw tx0y kb7t v8dc')).toBe('P4Y98RJRK0XWTX0YKB7TV8DC');
  });
  it('requires 24 characters', () => {
    expect(RecoveryKey.safeParse('P4Y9 8RJR').success).toBe(false);
  });
});

describe('authSigningMessage', () => {
  it('is stable (changing it breaks existing clients)', () => {
    expect(authSigningMessage('login', 'abc', 'dev_1')).toBe('koode-auth-v1\nlogin\nabc\ndev_1');
  });
});

describe('RegisterRequest', () => {
  it('rejects malformed keys and signatures', () => {
    const result = RegisterRequest.safeParse({
      inviteCode: 'K7QM4XRT9PWD',
      username: 'maya',
      displayName: 'Maya',
      recoveryKey: 'P4Y98RJRK0XWTX0YKB7TV8DC',
      device: { name: 'iPhone', platform: 'ios', signingPublicKey: 'short' },
      nonce: 'n'.repeat(32),
      signature: 's'.repeat(86),
    });
    expect(result.success).toBe(false);
  });
});
