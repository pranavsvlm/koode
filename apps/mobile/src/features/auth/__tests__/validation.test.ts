import { formatInviteCode, generateRecoveryKey, validateUsername } from '../validation';

describe('formatInviteCode', () => {
  it('uppercases, strips separators and groups by four', () => {
    expect(formatInviteCode('ab12cd34ef56')).toBe('AB12-CD34-EF56');
    expect(formatInviteCode('ab12-cd')).toBe('AB12-CD');
  });
  it('drops ambiguous characters (I, L, O, U) and caps at 12', () => {
    expect(formatInviteCode('IIOOLLUU1234567890ABCDEF')).toBe('1234-5678-90AB');
  });
});

describe('validateUsername', () => {
  it.each([
    ['', undefined],
    ['ab', 'At least 3 characters'],
    ['maya.chen', undefined],
    ['Maya', 'Use lowercase letters, numbers, dots and underscores'],
    ['_maya', 'Can’t start or end with a dot or underscore'],
    ['a'.repeat(25), 'At most 24 characters'],
  ])('%s → %s', (input, expected) => {
    expect(validateUsername(input)).toBe(expected);
  });
});

describe('generateRecoveryKey', () => {
  it('encodes 120 bits as six groups of four base32 characters', () => {
    const key = generateRecoveryKey((n) => new Uint8Array(n).fill(0xff));
    expect(key).toBe('ZZZZ ZZZZ ZZZZ ZZZZ ZZZZ ZZZZ');
    const zero = generateRecoveryKey((n) => new Uint8Array(n));
    expect(zero).toBe('0000 0000 0000 0000 0000 0000');
  });
  it('requests exactly 15 random bytes', () => {
    const rng = jest.fn((n: number) => new Uint8Array(n));
    generateRecoveryKey(rng);
    expect(rng).toHaveBeenCalledWith(15);
  });
});
