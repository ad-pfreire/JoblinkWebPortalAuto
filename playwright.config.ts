import { defineConfig, devices } from '@playwright/test';

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '.env') });

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './tests',
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: 'html',
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('')`. */
    // baseURL: 'http://localhost:3000',

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      // subscription.spec.ts and teams-plan-gating.spec.ts each run under
      // their own dedicated project below instead (chromium-only files
      // needing Chromium-specific launch args - see those projects' own
      // comments for why this can't just be handled inside the files
      // themselves).
      testIgnore: [/subscription\.spec\.ts/, /teams-plan-gating\.spec\.ts/, /account-deletion-billing\.spec\.ts/, /payment-history\.spec\.ts/],
      use: { ...devices['Desktop Chrome'] },
    },

    // subscription.spec.ts's own dedicated project. This file is
    // chromium-only (it test.skip()s itself on other browsers via its own
    // beforeAll/beforeEach, matching payments.spec.ts/teams.spec.ts's
    // pattern), and its CI-only launchOptions (forcing Chromium onto a
    // software-rendering path - see CLAUDE.md's GPU/hCaptcha gotcha) are
    // Chromium-specific flags. Live-verified the hard way why this can't
    // just be a file-level test.use() call instead: CI runs
    // `npx playwright test --grep @real-email` with no --project filter,
    // so a file-level test.use({ launchOptions }) gets applied across
    // EVERY project that attempts this file, not just chromium - webkit's
    // browser crashed outright ("Cannot parse arguments: Unknown option
    // --use-gl=angle") because it doesn't understand Chromium flags. A
    // dedicated project scoped to only this file, combined with
    // testIgnore-ing the file out of chromium/firefox/webkit below, keeps
    // the special flags contained to exactly the file and the browser
    // engine that both need them.
    {
      name: 'chromium-subscription',
      testMatch: /subscription\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: process.env.CI
          ? { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }
          : {},
      },
    },

    // teams-plan-gating.spec.ts's own dedicated project - same reasoning
    // as chromium-subscription above (this file also does a real Stripe
    // Checkout purchase in its own beforeAll, hitting the identical
    // GPU/hCaptcha issue on GitHub Actions).
    {
      name: 'chromium-teams-plan-gating',
      testMatch: /teams-plan-gating\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: process.env.CI
          ? { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }
          : {},
      },
    },

    // account-deletion-billing.spec.ts's own dedicated project - same
    // reasoning as chromium-subscription/chromium-teams-plan-gating above
    // (this file does several real Stripe Checkout purchases across its
    // suites, hitting the identical GPU/hCaptcha issue on GitHub Actions).
    {
      name: 'chromium-account-deletion-billing',
      testMatch: /account-deletion-billing\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: process.env.CI
          ? { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }
          : {},
      },
    },

    // payment-history.spec.ts's own dedicated project - same reasoning as
    // chromium-subscription/chromium-teams-plan-gating/
    // chromium-account-deletion-billing above (this file's own beforeAll
    // does a real Stripe Checkout purchase, hitting the identical
    // GPU/hCaptcha issue on GitHub Actions).
    {
      name: 'chromium-payment-history',
      testMatch: /payment-history\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: process.env.CI
          ? { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }
          : {},
      },
    },

    {
      name: 'firefox',
      testIgnore: [/subscription\.spec\.ts/, /teams-plan-gating\.spec\.ts/, /account-deletion-billing\.spec\.ts/, /payment-history\.spec\.ts/],
      use: { ...devices['Desktop Firefox'] },
    },

    {
      name: 'webkit',
      testIgnore: [/subscription\.spec\.ts/, /teams-plan-gating\.spec\.ts/, /account-deletion-billing\.spec\.ts/, /payment-history\.spec\.ts/],
      use: { ...devices['Desktop Safari'] },
    },

    /* Test against mobile viewports. */
    // {
    //   name: 'Mobile Chrome',
    //   use: { ...devices['Pixel 5'] },
    // },
    // {
    //   name: 'Mobile Safari',
    //   use: { ...devices['iPhone 12'] },
    // },

    /* Test against branded browsers. */
    // {
    //   name: 'Microsoft Edge',
    //   use: { ...devices['Desktop Edge'], channel: 'msedge' },
    // },
    // {
    //   name: 'Google Chrome',
    //   use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    // },
  ],

  /* Run your local dev server before starting the tests */
  // webServer: {
  //   command: 'npm run start',
  //   url: 'http://localhost:3000',
  //   reuseExistingServer: !process.env.CI,
  // },
});
