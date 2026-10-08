import { Hono } from 'hono';
import { PROTOCOL_VERSION, SERVICE_NAME, type HealthResponse } from '@koode/shared';
import type { AppEnv } from '../app';

export const health = new Hono<AppEnv>().get('/', (c) =>
  c.json<HealthResponse>({
    status: 'ok',
    service: SERVICE_NAME,
    environment: c.env.ENVIRONMENT,
    protocolVersion: PROTOCOL_VERSION,
    time: new Date().toISOString(),
  }),
);
