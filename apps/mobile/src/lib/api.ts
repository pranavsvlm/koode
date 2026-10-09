import { ApiErrorBody, type ApiErrorCode } from '@koode/shared';
import type { z } from 'zod';
import { env } from './env';

export type ApiClientErrorCode = ApiErrorCode | 'network' | 'timeout' | 'invalid_response';

export class ApiClientError extends Error {
  readonly code: ApiClientErrorCode;
  readonly status: number | undefined;

  constructor(code: ApiClientErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.status = status;
  }
}

export type ApiRequestOptions = Omit<RequestInit, 'body'> & {
  body?: unknown;
  /** Bearer access token. */
  token?: string;
  timeoutMs?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Typed JSON request against the Koode API. Every response is validated with
 * `schema`, and every failure surfaces as an ApiClientError with a stable code.
 */
export async function apiRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  {
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    baseUrl = env.apiUrl,
    fetchImpl = fetch,
    signal,
    headers,
    token,
    ...init
  }: ApiRequestOptions = {},
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = () => controller.abort();
  signal?.addEventListener('abort', onCallerAbort);

  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...(token && { Authorization: `Bearer ${token}` }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    if (timedOut) throw new ApiClientError('timeout', 'The request timed out');
    throw new ApiClientError('network', err instanceof Error ? err.message : 'Network error');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
  }

  const json: unknown = await res.json().catch(() => undefined);

  if (!res.ok) {
    const parsed = ApiErrorBody.safeParse(json);
    if (parsed.success) {
      throw new ApiClientError(parsed.data.error.code, parsed.data.error.message, res.status);
    }
    throw new ApiClientError('invalid_response', `Unexpected ${res.status} response`, res.status);
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiClientError('invalid_response', 'Response did not match the expected shape');
  }
  return parsed.data;
}
