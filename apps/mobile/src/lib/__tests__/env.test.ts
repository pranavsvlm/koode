import { parseEnv } from '../env';

describe('parseEnv', () => {
  it('falls back to localhost in development', () => {
    expect(parseEnv({ apiUrl: undefined }, true).apiUrl).toBe('http://localhost:8787');
  });

  it('requires an API URL in release builds', () => {
    expect(() => parseEnv({ apiUrl: undefined }, false)).toThrow();
  });

  it('rejects plain HTTP in release builds', () => {
    expect(() => parseEnv({ apiUrl: 'http://api.example.com' }, false)).toThrow(/https/);
  });

  it('accepts HTTPS and strips trailing slashes', () => {
    expect(parseEnv({ apiUrl: 'https://api.example.com//' }, false).apiUrl).toBe(
      'https://api.example.com',
    );
  });

  it('rejects malformed URLs', () => {
    expect(() => parseEnv({ apiUrl: 'not a url' }, true)).toThrow();
  });
});
