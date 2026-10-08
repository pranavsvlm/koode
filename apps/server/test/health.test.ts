import { SELF } from 'cloudflare:test';
import { ApiErrorBody, HealthResponse, PROTOCOL_VERSION } from '@koode/shared';
import { describe, expect, it } from 'vitest';

describe('GET /health', () => {
  it('returns a valid health payload', async () => {
    const res = await SELF.fetch('https://api.test/health');
    expect(res.status).toBe(200);
    const body = HealthResponse.parse(await res.json());
    expect(body.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(body.environment).toBe('development');
  });

  it('is also served under the versioned prefix', async () => {
    const res = await SELF.fetch('https://api.test/v1/health');
    expect(res.status).toBe(200);
  });

  it('sets security and caching headers', async () => {
    const res = await SELF.fetch('https://api.test/health');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('strict-transport-security')).toBeTruthy();
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-request-id')).toBeTruthy();
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('unknown routes', () => {
  it('return a typed 404 error body', async () => {
    const res = await SELF.fetch('https://api.test/v1/nope');
    expect(res.status).toBe(404);
    const body = ApiErrorBody.parse(await res.json());
    expect(body.error.code).toBe('not_found');
    expect(body.error.requestId).toBe(res.headers.get('x-request-id'));
  });
});
