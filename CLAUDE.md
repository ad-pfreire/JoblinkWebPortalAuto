# CLAUDE.md

Stable project conventions — loaded automatically every session. For "where did we leave off," see `handoff.md` instead (dynamic, rewritten each session).

## What this is

Playwright QA suite for the Job Link web portal (Fieldpiece pre-staging: `https://joblink-portal.prestg.fieldpiece.com`). Runs against the **real pre-staging backend — no mocks**. See `README.md` for the full portal coverage map (what's automated vs. not) — keep that map updated whenever coverage changes.

## Hard safety rules (never break these)

- **`pfautomation`** (email `paul.freire+automation@crifa.com`, from `TEST_USERNAME`/`TEST_LOGIN_PASSWORD` in `.env`) is the **shared seed account** every spec file logs in with. Its real password must **never** actually be changed, and it must **never** actually be deleted, by any test.
- Tests that need to register, verify-by-email, change a password for real, or delete an account for real must use a **fresh, disposable, run-unique account** (`generateUniqueEmailAlias()` / `registerNewAccount()` / `completeProfile()` in `tests/utils/account.ts`) — never the seed account.
- Any test that mutates one of the seed account's persistent fields (First/Last Name, Phone) **must restore it before the test ends**, and must verify the restore actually persisted via a real reload/response check — not just a success-toast check (see "Known gotcha" below).
- `.env` holds real credentials and is gitignored — never commit it, never print its contents in a way that gets committed.

## Known gotcha: don't trust the toast for a second save in the same test

If a test does two real saves close together (dirty a field → save → restore → save again), the first save's success toast can still be on screen when the second one fires. Asserting on toast **text** alone can pass without the second save having actually completed, and an immediate `page.goto()` reload can race the still-in-flight request. Fix: wait for the real network response (see `saveAndWaitForSuccess()` in `tests/profile-settings.spec.ts`), not just toast visibility, whenever a cleanup save follows another real save in the same test.

## Why `profile-settings.spec.ts` runs serial + chromium-only

Unlike the other spec files (which register a fresh disposable account per test), most of Profile Settings reads/writes the one shared seed account — Email and Username are read-only there, so there's no disposable-account escape hatch for most scenarios. Running those tests across 3 parallel browser projects would race on that one account's state. So that file's main `describe` uses `test.describe.configure({ mode: 'serial' })` + `test.skip(browserName !== 'chromium', ...)`. Follow the same pattern for any new spec file that similarly can't avoid touching shared account state.

## Conventions for new spec files

- Locators: `page.locator('input[name="..."]')` for form fields, `page.getByRole(...)` for buttons/dialogs/roles, `page.locator('text=...')` for inline messages/toasts.
- One `test()` per test-plan scenario number, not one test per assertion — bundle related assertions with numbered-step comments matching the plan's steps.
- Tag any test that depends on the real pre-staging email pipeline (`/forgot-password` submission, reading a verification/reset email, etc.) with a trailing ` @real-email` in its title.
- Every automated area starts as a live-verified plan in `specs/<area>-test-plan.md` (gitignored — contains real credentials in plain text, ask the maintainer for a copy or regenerate with the `playwright-test-planner` agent) before it becomes a spec file.
- When generating tests with the `playwright-test-generator` agent for a file that (like Profile Settings) touches shared account state, invoke it **sequentially per section, never in parallel** — parallel agent sessions would race on the same live account.
- After generating, actually run the tests against the real backend (`npx playwright test <file> --project=chromium`) before considering the work done — "it compiles" is not "it passes" in a suite with no mocks. Expect to find and fix real timing/race bugs, not just typos.
- Update the Portal Coverage Map in `README.md` when a new area's status changes.

## Git / commits

- Never add a `Co-Authored-By: Claude` trailer to commits in this repo — the user wants sole authorship on GitHub. Only commit when explicitly asked.
- Never run destructive git operations (force-push, reset --hard, etc.) without explicit confirmation.

## Running tests

```bash
npm test                                    # full suite, all browsers
npm run test:chromium                       # chromium only (fastest for local iteration)
npx playwright test <file> --project=chromium
npx playwright test --grep-invert @real-email   # skip real-email-dependent tests (what CI's blocking "core" step runs)
npx playwright test --grep @real-email          # only the real-email-dependent tests
```

CI (`.github/workflows/playwright.yml`) runs `@real-email` tests in a separate step with `continue-on-error: true` — known pre-staging infra flakiness (email delivery timing, occasional hangs), not a merge blocker.
