# Job Link Web Portal — Automated QA Suite

Automated Playwright test suite for the Job Link web portal (Fieldpiece pre-staging environment: `joblink-portal.prestg.fieldpiece.com`). It runs against the real pre-staging backend — no mocks — covering login, account registration, and the full password-recovery flow (forgot password → reset password → account deletion).

## Prerequisites

- Node.js (LTS)
- A Gmail account with 2-Step Verification enabled, used to read real verification/reset emails over IMAP during the tests that depend on real email delivery

## Setup

1. Install dependencies:
   ```bash
   npm install
   npx playwright install --with-deps
   ```
2. Copy `.env.example` to `.env` and fill in real values:
   ```bash
   cp .env.example .env
   ```
   - `BASE_URL`, `TEST_USERNAME`, `TEST_LOGIN_PASSWORD`, `TEST_REGISTER_PASSWORD`, `TEST_EMAIL_USER`, `TEST_EMAIL_DOMAIN` — the pre-staging URL and a seed test account's credentials.
   - `GMAIL_IMAP_USER` / `GMAIL_IMAP_APP_PASSWORD` — a Gmail **App Password** (not your normal Gmail password), generated at https://myaccount.google.com/apppasswords. Used only to read verification/reset emails over IMAP.
   - **`.env` is gitignored and must never be committed.**

## Running tests

```bash
npm test               # run the full suite, all browsers
npm run test:chromium  # chromium only (fastest for local iteration)
npm run test:headed    # watch the browser while it runs
npm run test:ui        # Playwright's interactive UI mode
npm run report         # open the last HTML report
```

Run a single file or test by path:
```bash
npx playwright test tests/login-cases.spec.ts
npx playwright test tests/forgot-password.spec.ts:141
```

## Project structure

```
tests/
  login-cases.spec.ts           Login page: valid/invalid login, validation, visibility toggle, etc.
  account-registration.spec.ts  Registration, email verification, Complete Profile
  forgot-password.spec.ts       Forgot/reset password, account deletion
  utils/
    env.ts                      requireEnv() — fails fast with a clear message if .env is missing a value
    account.ts                  Shared account lifecycle helpers (register, complete profile) reused across spec files
    email.ts                    Reads real verification links / reset codes over IMAP
.github/workflows/
  playwright.yml                CI: runs the suite on push/PR to main (see "CI" below)
playwright.config.ts            Runs on chromium, firefox, and webkit
```

Test plans (`specs/*.md`) exist locally but are **intentionally not committed** — they document real staging credentials in plain text for readability, so they're gitignored to keep this repo safe to be public. Ask whoever maintains this repo for a copy if you need them.

## CI (GitHub Actions)

`.github/workflows/playwright.yml` runs the suite automatically on every push and pull request to `main`. Since the tests need real credentials, the workflow reads them from **GitHub Actions repository secrets** (Settings → Secrets and variables → Actions in GitHub) — the same variable names as `.env`: `BASE_URL`, `TEST_EMAIL_USER`, `TEST_EMAIL_DOMAIN`, `TEST_USERNAME`, `TEST_LOGIN_PASSWORD`, `TEST_REGISTER_PASSWORD`, `GMAIL_IMAP_USER`, `GMAIL_IMAP_APP_PASSWORD`. Without these configured in the repo, CI runs will fail immediately (by design — it's the same `requireEnv()` guard used locally).

Note: pull requests from forks never receive these secrets (a GitHub security default for public repos), so a fork's CI run will fail on missing env vars rather than exposing credentials.

## Real-backend caveats

This suite mutates real state on a real backend (it registers real disposable accounts, sends real emails, and in some tests deletes real accounts) — it never mocks the API. A few tests depend on real email delivery timing (Mandrill/SES → Gmail over IMAP) and are retried once automatically to absorb normal delivery delay; if delivery itself is degraded, those specific tests will fail even though the app and the test logic are both correct.
