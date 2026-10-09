import { z } from 'zod';

export const ApiErrorCode = z.enum([
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'not_implemented',
  'internal',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

/** Every non-2xx JSON response from the server has this shape. */
export const ApiErrorBody = z.object({
  error: z.object({
    code: ApiErrorCode,
    message: z.string(),
    requestId: z.string().optional(),
    /** Machine-readable specifics (e.g. which devices a send missed). */
    details: z.unknown().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;
