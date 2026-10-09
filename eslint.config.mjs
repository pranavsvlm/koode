// Lint config for the server and shared packages. The mobile app has its own
// config (apps/mobile/eslint.config.js) based on eslint-config-expo.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules', '**/.wrangler', '**/worker-configuration.d.ts', 'apps/mobile/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node CLI scripts (e.g. apps/server/scripts/create-invite.mjs).
    files: ['**/scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        Buffer: 'readonly',
        WebSocket: 'readonly',
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
