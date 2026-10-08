import { describe, expect, it } from 'vitest';
import { ApiErrorBody, HealthResponse, PROTOCOL_VERSION } from './index';

describe('HealthResponse', () => {
  it('accepts a valid payload', () => {
    const parsed = HealthResponse.parse({
      status: 'ok',
      service: 'koode-server',
      environment: 'development',
      protocolVersion: PROTOCOL_VERSION,
      time: new Date().toISOString(),
    });
    expect(parsed.status).toBe('ok');
  });

  it('rejects a non-ok status', () => {
    const result = HealthResponse.safeParse({
      status: 'degraded',
      service: 'koode-server',
      environment: 'development',
      protocolVersion: 1,
      time: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });
});

describe('ApiErrorBody', () => {
  it('rejects unknown error codes', () => {
    expect(ApiErrorBody.safeParse({ error: { code: 'teapot', message: 'x' } }).success).toBe(false);
  });
});
