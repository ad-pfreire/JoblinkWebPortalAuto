# Job Link Web Portal — Automated QA Suite

Automated Playwright test suite for the Job Link web portal (Fieldpiece pre-staging environment: `https://joblink-portal.prestg.fieldpiece.com`, app version observed in the footer: `v1.4.0`). It runs against the **real pre-staging backend — no mocks** — registering real disposable accounts, sending real emails, and in some tests deleting real accounts.

This README doubles as a living map of the portal: which areas are automated today, and which aren't yet. Update the [Portal Coverage Map](#portal-coverage-map) whenever new test coverage lands, so it always reflects reality — the goal is for this file to be the one place that answers "is X tested?" without having to read every spec file.

## Portal Coverage Map

Legend: ✅ automated · 🟡 partially automated · ❌ not automated yet · ❓ exists but not yet explored/located

| Area | What's there | Status | Tests |
|---|---|---|---|
| **Login** | Username/email + password, validation messages, password visibility toggle, Enter-to-submit, redirect-when-authenticated | ✅ | `tests/login-cases.spec.ts` |
| **Account Registration** | Register form + validation, email verification (real link over IMAP), Complete Profile (name, phone, tools/market/role dropdowns) | ✅ | `tests/account-registration.spec.ts` |
| **Forgot / Reset Password** | Email request page, reset-password page (code + new password, strength checklist), real end-to-end reset with a real emailed code | ✅ | `tests/forgot-password.spec.ts` |
| **Account Deletion** | Profile → "Delete Account" confirmation dialog and real deletion | ✅ | `tests/forgot-password.spec.ts` |
| **Company** (`/company`) | Company Details (name, location, email, phone, license) view + edit, Logo upload, Integrations summary card, Payments summary card, Subscription summary card, Payment History table | ❌ | — |
| **Teams** (`/teams`, `/teams/list`, `/teams/members`) | "For you" / "Teams" / "Members" sub-tabs, Create Team, Invite Member, team member cards | ❌ | — |
| **Profile Settings** (`/profile`) | First/Last name edit, Phone edit, Change Password, Save | 🟡 (only Delete Account is covered; editing profile fields isn't) | `tests/forgot-password.spec.ts` (deletion only) |
| **Payments** (`/payments`) | Stripe-hosted Billing Address + Card form, "Redeem Coupon" | ❌ | — |
| **Subscription** (`/subscription`) | Plan comparison (Free / Job Link Pro / Job Link Pro + Invoicing), Monthly/Yearly toggle, plan change | ❌ | — |
| **Integrations** | QuickBooks and Calendar, via "Manage integrations" modal on the Company page | ❌ | — |
| **Jobs** | Referenced as a Pro-plan feature ("Add New Jobs", "Inspection Checklists", "Photos and Notes", "Customer and Equipment History") | ❓ Entry point not yet located in the nav — needs investigating before it can even be planned | — |

When picking up new coverage: use the `playwright-test-planner` agent (or manual exploration) to write a plan in `specs/<area>-test-plan.md` first (see [Test plans](#test-plans-specs), then generate/write the spec file, then flip that row's status here.

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

Run only the tests that don't depend on real email delivery (what CI's blocking "core" step runs — see [CI](#ci-github-actions)):
```bash
npx playwright test --grep-invert @real-email
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
  copilot-setup-steps.yml       Environment setup steps for GitHub Copilot coding agent
.claude/agents/, .github/agents/
  playwright-test-planner       Explores the live app and writes a specs/*.md test plan
  playwright-test-generator     Turns a plan item into a Playwright spec file
  playwright-test-healer        Debugs and fixes failing Playwright tests
playwright.config.ts            Runs on chromium, firefox, and webkit
```

## Test plans (`specs/`)

Every automated area starts as a detailed, live-verified Markdown test plan in `specs/` (e.g. `login-test-cases.md`, `account-registration-test-plan.md`, `forgot-password-test-plan.md`) before it becomes a spec file — each one documents exact UI text, error messages, and edge cases as actually observed on pre-staging, not assumed.

**These files exist locally but are intentionally not committed** (`specs/` is gitignored) — they document real pre-staging credentials in plain text for readability, and this repo is public. Ask whoever maintains this repo for a copy if you need them, or regenerate one for a new area with the `playwright-test-planner` agent.

## CI (GitHub Actions)

`.github/workflows/playwright.yml` runs on every push and pull request to `main`, in two steps:

1. **`Run Playwright tests (core)`** — everything except tests tagged `@real-email`. **This must pass**; a failure here is a real regression.
2. **`Run Playwright tests (real email, known flaky)`** — every test that submits `/forgot-password` or reads a verification/reset email. It runs with `continue-on-error: true`, so it's visible in the log and as a separate uploaded report (`playwright-report-real-email`), but it **never blocks the "core" step or a PR merge**. Live investigation confirmed (in a fully serial, zero-concurrency run) that the real pre-staging backend intermittently hangs on this specific request — unrelated to the app or test code being wrong — so treating it as blocking would make merges depend on infrastructure outside anyone's control.

Both steps need the real test credentials, read from **GitHub Actions repository secrets** (repo Settings → Secrets and variables → Actions) — same variable names as `.env`: `BASE_URL`, `TEST_EMAIL_USER`, `TEST_EMAIL_DOMAIN`, `TEST_USERNAME`, `TEST_LOGIN_PASSWORD`, `TEST_REGISTER_PASSWORD`, `GMAIL_IMAP_USER`, `GMAIL_IMAP_APP_PASSWORD`. Without these configured, CI fails immediately (the same `requireEnv()` guard used locally).

Pull requests from forks never receive these secrets (a GitHub security default for public repos), so a fork's CI run fails on missing env vars rather than exposing credentials.

### Tagging convention

Any new test that depends on the real pre-staging email pipeline (submitting `/forgot-password`, reading a verification/reset email, etc.) should have ` @real-email` appended to its title, so it's automatically picked up by the "known flaky" step instead of "core".

## Known environment issues

Worth knowing before debugging a "failure" that isn't one:

- **Email delivery timing.** Mandrill/SES → Gmail delivery has been observed anywhere from ~20s to several minutes, and occasionally not arriving at all for an extended period. `getVerificationLink()` / `getPasswordResetCode()` (`tests/utils/email.ts`) poll for up to 150s before giving up.
- **`/forgot-password` submission itself can hang**, independent of email delivery — confirmed live and in isolated, fully serial test runs (zero concurrency involved). It's suspected to share the same backend pipeline as the email-delivery slowness above. Every test that submits that form is tagged `@real-email` for this reason, even ones that never read an email themselves.
- Both are pre-staging infrastructure issues, not application bugs or test defects — if they start blocking real work, it's worth flagging to whoever owns the pre-staging environment.

## How to extend this suite

1. Explore the target area on pre-staging (manually or with the `playwright-test-planner` agent) and write/update a plan in `specs/<area>-test-plan.md`, following the existing plans' style: exact steps, exact expected text, "live-verified" only — never assumed.
2. Generate or hand-write the spec file in `tests/`, reusing helpers from `tests/utils/` where they fit (add new shared helpers there instead of duplicating logic across spec files).
3. Tag any test that depends on real email delivery or the `/forgot-password` submission with ` @real-email`.
4. Run it locally (`npx playwright test <file>`) against the real backend before committing — this suite has no mocks to fall back on, so "it compiles" isn't the same as "it passes."
5. Update the [Portal Coverage Map](#portal-coverage-map) above to reflect the new coverage.
