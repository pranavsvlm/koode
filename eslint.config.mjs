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
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
