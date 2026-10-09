import type { Context } from 'hono';
import type { z } from 'zod';
import { ApiError } from './errors';

/** Default request size; routes carrying ciphertext or key batches allow more. */
export const MAX_BODY_BYTES = 16 * 1024;
export const BODY_LIMITS = {
  /** 100 Kyber-1024 prekeys are ~220 KB of base64. */
  keys: 512 * 1024,
  /** One envelope per device of every member; a session's first ones carry PQXDH material. */
  message: 4 * 1024 * 1024,
  call: 256 * 1024,
} as const;

/**
 * Parse and validate a JSON body. The size limit applies to what is actually
 * read (not only the declared length). Errors never echo the submitted values.
 */
export async function parseJson<S extends z.ZodType>(
  c: Context,
  schema: S,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<z.output<S>> {
  const tooLarge = () => new ApiError('bad_request', 'Request body too large');
  if (Number(c.req.header('content-length') ?? 0) > maxBytes) throw tooLarge();
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength > maxBytes) throw tooLarge();
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw new ApiError('bad_request', 'Expected a JSON body');
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue?.path.join('.') || 'body';
    throw new ApiError('bad_request', `${field}: ${issue?.message ?? 'invalid'}`);
  }
  return result.data;
}
