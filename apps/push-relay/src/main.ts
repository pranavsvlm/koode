import { readFileSync } from 'node:fs';
import { createRelay } from './relay.ts';

/*
 * Configuration (environment):
 *   RELAY_SECRET      shared with the Worker's PUSH_RELAY_SECRET (≥32 chars)
 *   PORT, HOST        default 8790 on 127.0.0.1
 *   APNS_MODE         "apns" (default) or "simulator"
 *   APNS_KEY_ID, APNS_TEAM_ID, APNS_KEY_FILE   for "apns" mode (AuthKey_XXXX.p8)
 *   SIMULATOR         simctl device for "simulator" mode (default "booted")
 */
const env = process.env;
const mode = env.APNS_MODE === 'simulator' ? 'simulator' : 'apns';
const port = Number(env.PORT ?? 8790);
const host = env.HOST ?? '127.0.0.1';

const server = createRelay({
  secret: env.RELAY_SECRET ?? '',
  mode,
  apns:
    mode === 'apns'
      ? {
          keyId: env.APNS_KEY_ID ?? '',
          teamId: env.APNS_TEAM_ID ?? '',
          key: env.APNS_KEY_FILE ? readFileSync(env.APNS_KEY_FILE, 'utf8') : '',
        }
      : undefined,
  simulator: env.SIMULATOR ?? 'booted',
});

server.listen(port, host, () => console.log(JSON.stringify({ type: 'ready', mode, host, port })));
