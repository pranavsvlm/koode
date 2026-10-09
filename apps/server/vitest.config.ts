import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// A throwaway Google service account for FCM tests (the private key never leaves this run).
const fcmKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const FCM_SERVICE_ACCOUNT = JSON.stringify({
  project_id: 'koode-test',
  client_email: 'push@koode-test.iam.gserviceaccount.com',
  private_key: fcmKey.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
});

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // Test-only binding so the setup file can apply D1 migrations.
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, 'migrations')),
          // Test credentials, so tests never depend on a developer's .dev.vars.
          AUTH_TOKEN_SECRET: 'test-secret-not-for-production-0123456789',
          LIVEKIT_URL: 'wss://livekit.test',
          LIVEKIT_API_KEY: 'test-key',
          LIVEKIT_API_SECRET: 'test-livekit-secret-0123456789abcdef',
          PUSH_RELAY_URL: 'https://relay.test',
          PUSH_RELAY_SECRET: 'test-relay-secret-0123456789abcdefghij',
          FCM_SERVICE_ACCOUNT,
          // Public half, so tests can verify the OAuth assertion's signature.
          TEST_FCM_PUBLIC_KEY: fcmKey.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        },
      },
    })),
  ],
  test: {
    setupFiles: ['./test/apply-migrations.ts'],
  },
});
