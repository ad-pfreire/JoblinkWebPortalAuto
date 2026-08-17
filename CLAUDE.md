# CLAUDE.md

Stable project conventions — loaded automatically every session. For "where did we leave off," see `handoff.md` instead (dynamic, rewritten each session).

## What this is

Playwright QA suite for the Job Link web portal (Fieldpiece pre-staging: `https://joblink-portal.prestg.fieldpiece.com`). Runs against the **real pre-staging backend — no mocks**. See `README.md` for the full portal coverage map (what's automated vs. not) — keep that map updated whenever coverage changes.

## Hard safety rules (never break these)

- **The account behind `TEST_USERNAME`/`TEST_LOGIN_PASSWORD` in `.env`** (the maintainer's is `pfautomation`, email `paul.freire+automation@crifa.com`, but this is configurable per environment — see "Portability" below) is the **shared seed account** every spec file logs in with. Its real password must **never** actually be changed, and it must **never** actually be deleted, by any test.
- Tests that need to register, verify-by-email, change a password for real, or delete an account for real must use a **fresh, disposable, run-unique account** (`generateUniqueEmailAlias()` / `registerNewAccount()` / `completeProfile()` in `tests/utils/account.ts`) — never the seed account.
- Any test that mutates one of the seed account's persistent fields (First/Last Name, Phone) **must restore it before the test ends**, and must verify the restore actually persisted via a real reload/response check — not just a success-toast check (see "Known gotcha" below).
- `.env` holds real credentials and is gitignored — never commit it, never print its contents in a way that gets committed.

## Known gotcha: don't trust the toast for a second save in the same test

If a test does two real saves close together (dirty a field → save → restore → save again), the first save's success toast can still be on screen when the second one fires. Asserting on toast **text** alone can pass without the second save having actually completed, and an immediate `page.goto()` reload can race the still-in-flight request. Fix: wait for the real network response (see `saveAndWaitForSuccess()` in `tests/profile-settings.spec.ts`), not just toast visibility, whenever a cleanup save follows another real save in the same test.

## Known gotcha: an uploaded image's src/URL can keep changing for ~15-25s after a successful upload

On both Profile Photo and Company Logo Upload, the success toast and the immediate DOM update happen right away, but the saved file's URL is **not final yet** — the backend appears to asynchronously post-process the upload (likely generating an optimized/resized variant), and can swap the displayed `src` to a different URL more than once over the next ~15-25s, even with zero navigation. It does settle permanently after that window. Any test asserting an upload's "final" URL (e.g. across a reload) must poll for the src to stop changing first — capturing it immediately after the toast/response and comparing later will intermittently fail. See `waitForStableImageSrc()` in `tests/logo-upload.spec.ts` (polls for 3 consecutive matching reads, 1s apart, over up to 25s — 2 consecutive reads and/or a 10s budget were both empirically not long enough) and remember to `test.slow()` any test that calls it, since the wait alone can exceed the default 30s test timeout.

## Known gotcha: reading a POST response body can race the app's own client-side navigation

`await response.text()` after `page.waitForResponse(...)` can intermittently throw "Response body is not available for a response that was navigated away from" — even when read inside the very same `.then()` as the response resolving, with no explicit `page.goto()` in between. Seen on Logo Upload's WEBP-rejection case, where the app appears to trigger some internal client-side router activity shortly after that particular response resolves, discarding the buffered body before `.text()` can read it. Fix: intercept the request with `page.route()`, call `route.fetch()` yourself, read `.text()` on that response deterministically, then `route.fulfill({ response })` so the app still gets the real response and behaves normally — see the `page.route('**/company', ...)` block in test 3.4 of `tests/logo-upload.spec.ts`. Confirmed via 3 back-to-back full test-file runs that this fully eliminates the race (the plain `waitForResponse().then(r => r.text())` approach still failed intermittently even reading the body "eagerly").

## Known gotcha: `fill('')` and real keystrokes can trigger different validation timing

A form library's validation can behave differently for a raw `locator.fill('')` (value replaced in one DOM operation) versus a real user clearing a field character-by-character with Backspace. Confirmed on Company Details: an earlier live-exploration draft concluded that clearing a required field silently suppressed "The field is required" - re-verified with BOTH techniques and found `fill('')` and real Backspace keystrokes actually behaved the same in that specific case (the original finding was wrong for other reasons), but the discrepancy-hunting surfaced this as a real, general risk worth guarding against. When a test's whole point is validation-triggering (not just getting a field into some end value), prefer real keystrokes (`page.keyboard.press('Backspace')` in a loop, or `pressSequentially()`) over `fill()` - see `clearFieldWithBackspace()` in `tests/company-details.spec.ts`.

## Known gotcha: `getByRole('alert')` can match Next.js's own route-announcer, not just app messages

Next.js injects an always-present, empty, visually-hidden `<div role="alert" id="__next-route-announcer__">` into every page for screen-reader route-change announcements. A test asserting "no error alert appeared" via `getByRole('alert')).toHaveCount(0)` will fail against this element even when the app itself shows nothing - it's not a bug, just an unrelated a11y element that happens to share the `alert` role. Assert the alert's **text is empty** (`toHaveText('')`) instead of asserting zero count. See test 3.4 in `tests/company-details.spec.ts`.

## Known gotcha: `innerText` vs `textContent` can fabricate a false "missing space" bug

A read-only summary field rendering two values separated by a real `<br>` (e.g. Company Details' "Location": address on one line, city/state/zip on the next) is genuinely two clean lines to a real user. Reading it via `textContent` (which ignores `<br>`) or via an accessibility-tree name computation can make it look like the two values ran together with no separator ("...BroadwaySanta..."). Always verify a suspected string-concatenation bug with `locator.innerText()` (respects real rendering) and/or direct DOM inspection before reporting it as a defect - this exact false positive was caught and corrected in `specs/company-details-test-plan.md` section 4.3 after initially being reported as a real bug.

## Known gotcha: a live third-party API call can cascade-skip an entire `mode: 'serial'` file

Company Details' Address field uses a real (unmocked) Google Places Autocomplete API, which occasionally doesn't respond with suggestions inside a generous timeout - genuine external flakiness, not a bug. In `test.describe.configure({ mode: 'serial' })`, one failed test skips every remaining test in that file as "did not run", so a single flaky external call can silently zero out an entire spec file's results. Fix: add `retries: N` to the same `describe.configure({ mode: 'serial', retries: 2 })` call for any file with a real external dependency baked into a serial sequence - Playwright re-runs the failed test (and, in serial mode, everything from that point onward) rather than abandoning the rest of the file. Only safe when the flaky test doesn't leave residual mutated state on failure (Company Details' Address test never saves, only reloads to discard) - see `tests/company-details.spec.ts`.

## Why `profile-settings.spec.ts`, `logo-upload.spec.ts`, and `company-details.spec.ts` run serial + chromium-only

Unlike the other spec files (which register a fresh disposable account per test), most of Profile Settings and all of Logo Upload and Company Details read/write the one shared seed account — Email and Username are read-only there, so there's no disposable-account escape hatch for most scenarios (and Logo Upload's and Company Details' tests are explicitly order-dependent on each other for the same reason). Running those tests across 3 parallel browser projects would race on that one account's state. So each of those files' main `describe` uses `test.describe.configure({ mode: 'serial' })` + `test.skip(browserName !== 'chromium', ...)`. Follow the same pattern for any new spec file that similarly can't avoid touching shared account state.

Company Details adds one more wrinkle worth knowing generally: if an area's fields are all client-side **required**, there is no way to ever restore that area back to a blank/unset state once any field holds a real value (required-field validation correctly blocks saving an empty value - this is normal behavior, not a bug to route around). Plan for this the same way Logo Upload already does for its logo: accept it as a permanent, harmless, clearly-labeled side effect in the Application Overview, don't try to force a "restore to blank" step that the UI genuinely can't support.

## Portability: multiple people/environments running this suite

This suite is designed to work against **any** seed account configured via `TEST_USERNAME`/`TEST_LOGIN_PASSWORD`, not hardcoded to the maintainer's specific account:

- `tests/profile-settings.spec.ts` does NOT hardcode expected First Name/Last Name/Phone values. `discoverSeedBaseline()` (called once via `test.beforeAll`) logs in and reads whatever those fields currently are, using that as the "restore point" for the rest of the file. If you add a new spec file that needs a known baseline for some shared-account field, follow this same discover-don't-hardcode pattern rather than writing literal expected values.
- `.github/workflows/playwright.yml` has a top-level `concurrency: { group: playwright-suite-seed-account, cancel-in-progress: false }` — this queues (never cancels) overlapping CI runs so two runs never mutate the shared CI seed account at the same time. `cancel-in-progress` is deliberately `false`: cancelling mid-run could skip a test's own restore-to-baseline cleanup step, corrupting the account for whichever run goes next.
- What this can't do: coordinate between two different **people** running locally at the same time against the same account. There's no code-level fix for that (no shared lock reaches across two separate machines). Each developer should register and use their own separate seed test account in their own `.env`, not share one set of credentials — see the README's "If you're a second person picking this up" note.

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
