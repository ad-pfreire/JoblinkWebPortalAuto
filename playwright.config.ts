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
      use: {
        ...devices['Desktop Chrome'],
        // CI-only: GitHub Actions' shared runner has no real GPU. Live-verified
        // via a downloaded trace (subscription.spec.ts test 4.2, 4/4 real CI
        // failures, never once locally) that Stripe Checkout's hosted page
        // hangs forever in a "Processing" state after a real, correctly-timed
        // click - the button's own JS DOES receive the click (confirmed via
        // the trace's After-snapshot showing "Processing"), but the actual
        // payment submission never reaches Stripe at all (confirmed via the
        // Stripe API itself: the Checkout Session stays status "open" with
        // payment_intent: null). The trace's own captured browser console
        // pinned the cause: hCaptcha's invisible verification iframe (which
        // Checkout's submit flow depends on for a token before it will
        // actually submit) logs "GPU stall due to ReadPixels" a few seconds
        // in, then the whole page goes completely silent - consistent with a
        // WebGL-dependent verification step hanging on a GPU-less runner.
        // --use-gl=angle + --use-angle=swiftshader forces Chromium onto its
        // own supported software-rendering path instead of whatever
        // passthrough/virtual GPU path was stalling.
        launchOptions: process.env.CI
          ? { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }
          : {},
      },
    },

    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },

    {
      name: 'webkit',
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
