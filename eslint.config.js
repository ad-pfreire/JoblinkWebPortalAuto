// @ts-check
const tseslint = require('typescript-eslint');
const playwright = require('eslint-plugin-playwright');
const eslintConfigPrettier = require('eslint-config-prettier');

module.exports = tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
      'learning/**',
      // Template used by the playwright-test-generator agent (see
      // .claude/agents/playwright-test-generator.md) - deliberately empty,
      // not a real test.
      'tests/seed.spec.ts',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['tests/**/*.spec.ts'],
    ...playwright.configs['flat/recommended'],
    rules: {
      ...playwright.configs['flat/recommended'].rules,
      // This suite runs against a real, unmocked backend - many of these
      // rules flag patterns this project relies on deliberately (see
      // CLAUDE.md's "Known gotcha" entries for the live-verified reasoning
      // behind each one), so they'd be permanent false-positive noise here
      // rather than useful signal.
      'playwright/no-conditional-in-test': 'off', // e.g. the Cognito rate-limit either/or check in profile-settings.spec.ts
      'playwright/no-conditional-expect': 'off',
      'playwright/no-wait-for-timeout': 'off', // every instance ties to a documented timing gotcha (3DS button wiring, image-src settling, etc.)
      'playwright/no-skipped-test': 'off', // test.skip() is a deliberate technique here (browserName guards, Cognito-throttle skip), not an oversight
      // Every current instance captures a value for later comparison/reuse
      // (e.g. `before`/`after` snapshots, feeding a follow-up request) —
      // not a single assertion `toHaveText()` etc. could express.
      'playwright/prefer-web-first-assertions': 'off',
      // This project's real assertions frequently live inside helper
      // functions (registerNewAccount(), completeProfile(), etc.) that
      // this rule can't see into.
      'playwright/expect-expect': 'off',
    },
  },
  {
    rules: {
      // The suite intentionally reads real API/DB responses with loose
      // shapes (Stripe, Mongo, IMAP) - requiring explicit types everywhere
      // would fight that more than it would help.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // This file itself must stay CommonJS (package.json has no "type":
    // "module"), so its own require() calls are intentional, not a
    // TS-source violation.
    files: ['eslint.config.js'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  eslintConfigPrettier
);
