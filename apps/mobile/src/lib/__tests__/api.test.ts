import { z } from 'zod';
import { apiRequest, ApiClientError } from '../api';

const Schema = z.object({ ok: z.boolean() });
const base = { baseUrl: 'https://api.test' };

function fakeFetch(status: number, body: unknown): typeof fetch {
  return jest.fn(async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

async function errorOf(promise: Promise<unknown>): Promise<ApiClientError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ApiClientError) return err;
    throw err;
  }
  throw new Error('expected request to fail');
}

describe('apiRequest', () => {
  it('returns validated data on success', async () => {
    const fetchImpl = fakeFetch(200, { ok: true });
    await expect(apiRequest('/x', Schema, { ...base, fetchImpl })).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith('https://api.test/x', expect.anything());
  });

  it('serializes JSON bodies with a content type', async () => {
    const fetchImpl = fakeFetch(200, { ok: true });
    await apiRequest('/x', Schema, { ...base, fetchImpl, method: 'POST', body: { a: 1 } });
    const init = (fetchImpl as jest.Mock).mock.calls[0][1] as RequestInit;
    expect(init.body).toBe('{"a":1}');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
  });

  it('maps typed server errors', async () => {
    const fetchImpl = fakeFetch(404, { error: { code: 'not_found', message: 'nope' } });
    const err = await errorOf(apiRequest('/x', Schema, { ...base, fetchImpl }));
    expect(err.code).toBe('not_found');
    expect(err.status).toBe(404);
  });

  it('rejects responses that do not match the schema', async () => {
    const fetchImpl = fakeFetch(200, { ok: 'yes' });
    expect((await errorOf(apiRequest('/x', Schema, { ...base, fetchImpl }))).code).toBe(
      'invalid_response',
    );
  });

  it('rejects untyped error responses', async () => {
    const fetchImpl = fakeFetch(502, { message: 'bad gateway' });
    expect((await errorOf(apiRequest('/x', Schema, { ...base, fetchImpl }))).code).toBe(
      'invalid_response',
    );
  });

  it('reports network failures', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new TypeError('Network request failed');
    }) as typeof fetch;
    expect((await errorOf(apiRequest('/x', Schema, { ...base, fetchImpl }))).code).toBe('network');
  });

  it('times out slow requests', async () => {
    const fetchImpl = jest.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    ) as typeof fetch;
    const err = await errorOf(apiRequest('/x', Schema, { ...base, fetchImpl, timeoutMs: 10 }));
    expect(err.code).toBe('timeout');
  });
});
