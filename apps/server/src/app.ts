import { Hono } from 'hono';
import { requestId, type RequestIdVariables } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { API_PREFIX } from '@koode/shared';
import { ApiError, errorBody } from './lib/errors';
import { requestLogger } from './lib/logger';
import { health } from './routes/health';

export type AppEnv = { Bindings: Env; Variables: RequestIdVariables };

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use(requestId());
  app.use(requestLogger());
  app.use(secureHeaders());
  // API responses are per-user and must never be cached by intermediaries.
  app.use(async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  // No CORS middleware: the API is only for the native app, so browsers on
  // other origins are deliberately denied by the same-origin policy.

  app.route('/health', health);
  app.route(`${API_PREFIX}/health`, health);

  app.notFound((c) => c.json(errorBody('not_found', 'Route not found', c.get('requestId')), 404));

  app.onError((err, c) => {
    const id = c.get('requestId');
    if (err instanceof ApiError) {
      return c.json(errorBody(err.code, err.message, id), err.status);
    }
    // Log the error class and message only; never echo internals to the client.
    console.error(
      JSON.stringify({ type: 'error', requestId: id, name: err.name, message: err.message }),
    );
    return c.json(errorBody('internal', 'Internal server error', id), 500);
  });

  return app;
}
