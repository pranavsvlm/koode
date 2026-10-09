import type { Context } from 'hono';
import type { z } from 'zod';
import { ApiError } from './errors';

const MAX_BODY_BYTES = 16 * 1024;

/** Parse and validate a JSON body. Errors never echo the submitted values. */
export async function parseJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  const length = Number(c.req.header('content-length') ?? 0);
  if (length > MAX_BODY_BYTES) throw new ApiError('bad_request', 'Request body too large');
  let raw: unknown;
  try {
    raw = await c.req.json();
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
