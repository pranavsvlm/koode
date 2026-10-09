import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

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
        },
      },
    })),
  ],
  test: {
    setupFiles: ['./test/apply-migrations.ts'],
  },
});
