import type { MiddlewareHandler } from 'hono';

/**
 * Structured request log. Logs the path only — never the query string,
 * headers or body, which may carry tokens or message payloads.
 */
export const requestLogger = (): MiddlewareHandler => async (c, next) => {
  const start = Date.now();
  await next();
  console.log(
    JSON.stringify({
      type: 'request',
      requestId: c.get('requestId'),
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Date.now() - start,
    }),
  );
};
