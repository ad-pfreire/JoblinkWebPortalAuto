# Job Link Web Portal — Automated QA Suite

Automated Playwright test suite for the Job Link web portal (Fieldpiece pre-staging environment: `https://joblink-portal.prestg.fieldpiece.com`, app version observed in the footer: `v1.4.0`). It runs against the **real pre-staging backend — no mocks** — registering real disposable accounts, sending real emails, and in some tests deleting real accounts.

This README doubles as a living map of the portal: which areas are automated today, and which aren't yet. Update the [Portal Coverage Map](#portal-coverage-map) whenever new test coverage lands, so it always reflects reality — the goal is for this file to be the one place that answers "is X tested?" without having to read every spec file.

## Portal Coverage Map

Legend: ✅ automated · 🟡 partially automated · ❌ not automated yet

Once logged in, the portal has two top-level tabs: **Company** (the landing page) and **Teams**. Everything below is organized to match that actual navigation — live-verified against pre-staging, not assumed.

### Auth & account

| Area | What's there | Status | Tests |
|---|---|---|---|
| **Login** | Username/email + password, validation messages, password visibility toggle, Enter-to-submit, redirect-when-authenticated | ✅ | `tests/login-cases.spec.ts` |
| **Account Registration** | Register form + validation, email verification (real link over IMAP), Complete Profile (name, phone, tools/market/role dropdowns) | ✅ | `tests/account-registration.spec.ts` |
| **Forgot / Reset Password** | Email request page, reset-password page (code + new password, strength checklist), real end-to-end reset with a real emailed code | ✅ | `tests/forgot-password.spec.ts` |
| **Account Deletion** | Profile → "Delete Account" confirmation dialog and real deletion, including its cascade to a real Stripe subscription (active, scheduled-to-cancel, already-lapsed, and different plans) and to MongoDB (including an invited member's own delegated access), plus what happens when a MEMBER rather than the owner deletes themselves | ✅ | `tests/forgot-password.spec.ts`, `tests/account-deletion-billing.spec.ts` |
| **Profile Settings** (`/profile`) | First/Last name edit + Save, Photo upload/crop, Phone edit, Change Password (modal), Delete Account | ✅ | `tests/profile-settings.spec.ts`, `tests/forgot-password.spec.ts` (real deletion) |

### Company (`/company`) — first tab, the landing page after login

Six cards on one page: Company Details and Logo Upload on their own, then Integrations, Payments, and Subscription as summary cards that link out to their own full page/modal, then a Payment History table spanning the bottom.

| Card | What's there | Status | Tests |
|---|---|---|---|
| **Company Details** | Read-only view of Company Name, Location, Email, Phone Number, Contractor License, with an "Edit" link (`/company?edit=true`) — the edit form has 13 fields, 8 more than the read view shows | ✅ | `tests/company-details.spec.ts` |
| **Logo Upload** | "Upload" button; stated limit "at least 150x150 px and no more than 500KB" | ✅ | `tests/logo-upload.spec.ts` |
| **Integrations** | Lists QuickBooks and Calendar; "Manage integrations" button opens an in-page modal with a Connect/Manage table, a Status column, and a note that only one work-order tool can be linked at a time | ❌ | — |
| **Payments** (summary card) | Shows "No Payment Method" when unset; "Manage Payments" link goes to the full **`/payments`** page — Stripe-hosted Billing Address + Card form, "Redeem Coupon" | ✅ | `tests/payments.spec.ts` |
| **Subscription** (summary card) | Shows current plan name + trial end date; "Manage Subscription" link goes to the full **`/subscription`** page — Free / Job Link Pro / Job Link Pro + Invoicing plan comparison, each listing feature bullets like "Add New Jobs", "Inspection Checklists", "Photos and Notes", "Customer and Equipment History" (marketing copy on the comparison card, not a real in-app "Jobs" section); covers plan selection, Monthly/Yearly toggle, first purchase via real Stripe Checkout, in-app upgrade/downgrade, cancel/resume, and edge cases | ✅ (24/25 — 1 known flaky, see below) | `tests/subscription.spec.ts` |
| **Payment History** | Table: Status / Date / Title / Amount / Billing ID / Invoice; "No Payment History" placeholder when empty; sortable-*looking* headers that don't actually sort (likely bug); cursor-based pagination; cross-verified against Stripe's own API and real downloaded invoice PDF content | ✅ | `tests/payment-history.spec.ts` |

### Teams (`/teams`) — second tab

| Area | What's there | Status | Tests |
|---|---|---|---|
| **Teams** | Sub-tabs "For you" / "Teams" / "Members", a "Select Teams & People" search box, "+ Create Team" and "Invite Member" buttons, team cards (`/teams/list`) and member list (`/teams/members`), full invite → real email → accept flow | ✅ | `tests/teams.spec.ts` |

**Subscription's one known-flaky test**: scenario 8.3 in `tests/subscription.spec.ts` ("toggling Monthly/Yearly alone can leave 'Continue' non-functional until the plan card is explicitly re-clicked") is marked `test.fixme()` — live-verified across 30+ full-suite runs, this specific interaction is genuinely inconsistent even with a 100s retry budget and deliberate settle pauses (the same fix that made the adjacent Resume Subscription tests rock solid). Most likely a low-probability race in the app itself, not something test-side retrying can fully eliminate. See the comment on that test and `specs/subscription-test-plan.md` finding 26 before re-enabling it.

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

### If you're a second person picking this up: use your own seed account

`TEST_USERNAME`/`TEST_LOGIN_PASSWORD` don't have to point at the maintainer's `pfautomation` account — the suite discovers that account's current name/phone/etc. at runtime rather than assuming fixed values (see `discoverSeedBaseline()` in `tests/profile-settings.spec.ts`), so it works against **any** seed account's existing state, sight unseen.

What it can't do is coordinate across two different people's machines. `profile-settings.spec.ts` and `logo-upload.spec.ts` mutate their seed account's real state mid-test (name, phone, logo) before restoring it — if two people ran these files against the **same** account credentials at the same time, both from their own laptops, they'd race on that shared state with no way for either side to know the other is running (this is different from the parallel-workers race those files already guard against internally with `mode: 'serial'` + chromium-only, and different from two *CI* runs racing, which the `concurrency` group in `.github/workflows/playwright.yml` already serializes). So: **register your own separate test account** on pre-staging and put its credentials in your own `.env`, rather than reusing someone else's `TEST_USERNAME`. CI's shared secrets are a special case already handled by that `concurrency` group — this only matters for two humans running locally.

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
  profile-settings.spec.ts      Profile page: name/phone edit, photo upload, Change Password, delete-cancel
  logo-upload.spec.ts           Company page Logo Upload card: valid upload/replace, size/dimension validation, error dialog behavior
  company-details.spec.ts       Company page Company Details card: read view, edit form, validation, save/persistence, cancel/discard
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

### Why `profile-settings.spec.ts`, `logo-upload.spec.ts`, and `company-details.spec.ts` run serial and chromium-only

Unlike every other spec file, most of `profile-settings.spec.ts` reads and mutates the ONE shared seed account (`pfautomation`) that this whole suite also logs in with — Email and Username are read-only on that page, so there's no way to spin up a disposable account for most of its scenarios the way registration/forgot-password do. Running those tests across 3 parallel browser projects (and multiple local workers) would race on that single account's First Name/Phone/Save state and could leave it corrupted for every other spec file. So its `Profile Settings` describe block is `test.describe.configure({ mode: 'serial' })` plus chromium-only (`test.skip(browserName !== 'chromium', ...)`), mirroring the same trade-off `forgot-password.spec.ts` already makes for its own backend-mutating describes, just applied to the whole file instead of one block. The real end-to-end password-change test (5.10) is the one exception — it uses a fresh disposable account like the other files' e2e tests, so it's a separate top-level describe outside the serial block.

`logo-upload.spec.ts` follows the identical pattern for the same reason: the same seed account's one company logo is shared, mutable, order-dependent state (test 2.2, for example, explicitly depends on test 2.1's upload already being saved) — there's no per-scenario disposable-company escape hatch here either.

`company-details.spec.ts` follows the same pattern too, for the same shared-account reason. One additional wrinkle worth knowing: Company Details' required fields (Company Name, Contractor License, Country, Address, Address 2, City, Zip Code, Email, Mobile Phone Number) can never be cleared back to empty and saved — that's normal required-field validation, not a bug — so unlike Logo Upload's logo, there is no path to restore this card to its original blank "-" placeholder state once any field has held a real value. The seed account's Company Details now permanently show harmless, clearly-labeled QA test values (Company Name "QA Automation Test Co", etc.) instead of "-" — a one-time, accepted, permanent side effect of this area's exploration, mirroring the same trade-off already accepted for Logo Upload.

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
