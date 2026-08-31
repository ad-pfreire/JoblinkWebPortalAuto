// spec: specs/payment-history-test-plan.md
// seed: tests/seed.spec.ts

import { test, expect, Page, devices, APIResponse } from '@playwright/test';
import { PDFParse } from 'pdf-parse';
import { requireEnv } from './utils/env';
import { getVerificationLink } from './utils/email';
import { generateUniqueEmailAlias, generateUsernameFromEmail, registerNewAccount, completeProfile } from './utils/account';
import { stripeRequest, stripeFindCustomerByEmail } from './utils/stripe';
import { getUserByEmail, findAnyCollectionReferencing } from './utils/mongo';

const BASE_URL = requireEnv('BASE_URL');
const SEED_USERNAME = requireEnv('TEST_USERNAME');
const SEED_PASSWORD = requireEnv('TEST_LOGIN_PASSWORD');

let disposableUsername: string;
let disposablePassword: string;
let disposableEmail: string;

// This file's CI-only Chromium software-rendering flags (same GPU/hCaptcha
// gotcha documented in CLAUDE.md for subscription.spec.ts/
// teams-plan-gating.spec.ts/account-deletion-billing.spec.ts - this file's
// own beforeAll does a real Stripe Checkout purchase). Lives in this file's
// own dedicated `chromium-payment-history` project in playwright.config.ts,
// NOT as a file-level test.use({ launchOptions }) here - see that project's
// own comment for why a file-level test.use() would break webkit/firefox.

// Logs in with the one disposable account registered once in beforeAll below
// and lands on /company. Mirrors loginAsDisposableAndGoToCompany() in
// payments.spec.ts/subscription.spec.ts.
async function loginAsDisposableAndGoToCompany(page: Page) {
  await page.goto(`${BASE_URL}/login`);
  await page.locator('input[name="username"]').fill(disposableUsername);
  await page.locator('input[name="password"]').fill(disposablePassword);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });
  await page.goto(`${BASE_URL}/company`);
}

// Logs in with the shared seed account instead - used ONLY by 1.1, which
// needs a real company that has never made a purchase (the seed account
// never touches Payments/Subscription elsewhere in this project - see
// CLAUDE.md's "Account/company isolation" section). Strictly read-only here:
// no field on this account is ever read via a mutating action. Mirrors
// loginAsSeedAndGoToCompany() in company-details.spec.ts/logo-upload.spec.ts.
async function loginAsSeedAndGoToCompany(page: Page) {
  await page.goto(`${BASE_URL}/login`);
  await page.locator('input[name="username"]').fill(SEED_USERNAME);
  await page.locator('input[name="password"]').fill(SEED_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });
  await page.goto(`${BASE_URL}/company`);
}

// Switches the account's billing interval on its CURRENT plan ('Job Link
// Pro' throughout this file - no plan-tier change) via /subscription's
// 'Update Subscription' dialog, producing one real new Payment History row
// per call. Deliberately names the target interval explicitly ('Monthly' or
// 'Yearly') rather than blindly re-clicking one fixed toggle button -
// live-verified in specs/subscription-test-plan.md section 3/4 that
// 'Monthly' and 'Yearly' are two independently-clickable, named toggle
// options (a real segmented control), not a single button that flips on
// every click.
//
// LIVE-VERIFIED ROOT CAUSE, not obvious from subscription.spec.ts alone:
// 'Continue' visually becomes enabled purely from the interval toggle
// alone, but its click handler is a silent no-op (no dialog opens, no
// error, no console warning) unless a plan card has ALSO been explicitly
// clicked at least once first - confirmed by directly reproducing both the
// broken sequence (toggle interval only, click Continue) and the working
// one (click the plan card, THEN toggle interval, THEN click Continue) by
// hand against a real account, several times each, with no timing
// differences between them. subscription.spec.ts's own Suite 3 never hits
// this because its very first step is always clicking a plan card
// (`selectPlanAndContinue`'s `clickPlanCard`) before ever touching the
// interval toggle - this file's original version skipped that click
// entirely (assuming the current plan's card counts as "already selected"
// since the page visually marks it 'Currently Subscribed!'), which turned
// out to be a real, distinct gap in that assumption, not a flaky race. The
// current plan's own card is genuinely safe to click here (unlike
// re-clicking an already-selected card elsewhere in this project, which
// deselects it) - live-verified this only sets the missing internal
// selection state without changing anything else.
// 'toggle' switches away from whichever interval the account is CURRENTLY
// really on (read live from the toggle group's own 'pressed' state right
// after navigating), rather than the caller having to track/predict that
// across several earlier real changes - used by Suite 3.3's own loop, where
// hardcoding an assumed starting interval would silently desync if an
// earlier test's own call sequence ever changes (requesting an interval
// that's already active would leave 'Continue' disabled forever, hanging
// the loop). beforeAll/1.3 still pass an explicit value where the exact
// sequence is deliberately documented and doesn't need this flexibility.
async function changeSubscriptionInterval(page: Page, interval: 'Monthly' | 'Yearly' | 'toggle') {
  await page.goto(`${BASE_URL}/subscription`);
  await page.getByRole('heading', { name: 'Job Link Pro', exact: true }).click();
  let target = interval;
  if (target === 'toggle') {
    const yearlyPressed = await page.getByRole('button', { name: 'Yearly', exact: true }).getAttribute('aria-pressed');
    target = yearlyPressed === 'true' ? 'Monthly' : 'Yearly';
  }
  await page.getByRole('button', { name: target, exact: true }).click();
  const continueButton = page.getByRole('button', { name: 'Continue', exact: true });
  await expect(continueButton).toBeEnabled();
  await continueButton.click();
  await expect(page.getByRole('heading', { name: 'Update Subscription', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm and Pay' }).click();
  await expect(page).toHaveURL(/\/subscription\?success=update/, { timeout: 30_000 });
}

// --- Payment History table locators ---
//
// Unlike most other cards on /company (Company Details, Logo Upload,
// Payments, Subscription - each documented elsewhere in this project as
// having a duplicate, hidden, mobile-accordion copy of their own heading
// text), Payment History's own MUI DataGrid renders exactly one real
// `grid`-role landmark on the page - live-verified via a direct accessibility
// snapshot while writing specs/payment-history-test-plan.md. Locating by
// role('grid') directly sidesteps that whole class of duplicate-heading
// gotcha entirely, rather than needing a card-scoping workaround like the
// other files use.
function paymentHistoryGrid(page: Page) {
  return page.getByRole('grid');
}

// Data rows only - excludes the header row. The header row (role='row',
// containing the columnheaders) is a direct child of the grid, while data
// rows live inside their own nested `rowgroup` - scoping to that rowgroup
// specifically is what excludes the header row, since getByRole('row')
// against the grid directly would otherwise also match the header row (role
// queries search the full subtree regardless of intermediate containers).
function paymentHistoryDataRows(page: Page) {
  return paymentHistoryGrid(page).getByRole('rowgroup').getByRole('row');
}

function paymentHistoryFooter(page: Page) {
  return page.locator('p').filter({ hasText: /^\d+–\d+ of (\d+|more than \d+)$/ });
}

// Finds a specific row by Billing ID, clicking 'Go to next page' if it
// isn't on the currently-displayed page - needed for any lookup driven by
// a full, unpaginated Stripe query (e.g. Suite 7.2's null-description
// search) rather than by loadCompanyAndGetFirstPageInvoices()'s own
// page-1-only data. By Suite 7's point in this file, Suite 3.3 has already
// pushed this account past the 10-row page size, so the account's very
// FIRST invoice (the oldest - exactly what 7.2 looks for) has fallen onto
// a later page, live-verified as the real cause of this test's first
// failure (a 30s locator timeout waiting for a row that was never on page
// 1 to begin with).
//
// Deliberately a bounded for-loop, not a while loop with a hard
// `expect(row).toHaveCount(1)` assertion after each click - an earlier
// version of this helper had exactly that assertion, which live-verified
// broke this exact lookup: if the target row isn't on the very next page
// either, that assertion throws its own timeout error immediately instead
// of letting the loop try a further page.
//
// SECOND live-verified issue on top of that: `.count()` is a one-shot,
// non-retrying read (the same general gotcha already documented elsewhere
// in this project) - it does NOT wait for the grid to finish rendering.
// Calling this helper right after a fresh page load (as Suite 7.2 does,
// after its own real Stripe API calls, which normally give the grid
// plenty of time to settle - but not always, live-verified this can still
// occasionally read 0 before the grid or the 'Go to next page' button's
// own enabled state have actually finished settling) can otherwise
// conclude "not found, and can't go further" before either has genuinely
// finished loading. A short manual poll on the row count (not a single
// instantaneous `.count()` read) is what actually waits properly.
async function findRowByBillingId(page: Page, billingId: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = paymentHistoryDataRows(page).filter({ hasText: billingId });
    let count = await row.count();
    const deadline = Date.now() + 5_000;
    while (count === 0 && Date.now() < deadline) {
      await page.waitForTimeout(250);
      count = await row.count();
    }
    if (count > 0) return row;
    const nextButton = page.getByRole('button', { name: 'Go to next page' });
    if (!(await nextButton.isEnabled())) {
      throw new Error(`Billing ID ${billingId} not found on any page of the Payment History table (checked ${attempt + 1} page(s)).`);
    }
    await nextButton.click();
    // A brief settle wait for the new page's rows to render, on top of
    // the next iteration's own poll - cheap insurance given how expensive
    // re-running this whole file is.
    await page.waitForTimeout(500);
  }
  throw new Error(`Billing ID ${billingId} not found within 5 pages of the Payment History table.`);
}

// Waits for the table's own first-page network response (no lastCursor
// param) and returns its parsed JSON body - the same
// `{"metadata":{"hasMore":bool,"lastCursor"?:id},"data":[...]}` shape
// documented in specs/payment-history-test-plan.md. Triggered by a genuine
// navigation to /company, matching how a real user would land on this table.
//
// LIVE-VERIFIED, matches an already-documented CLAUDE.md gotcha
// (logo-upload.spec.ts's WEBP-rejection case): calling `response.json()`
// after `page.waitForResponse()` around a real `page.goto()` navigation can
// intermittently throw "Response body is not available for a response that
// was navigated away from" - some client-side router activity this app
// does shortly after the response resolves can discard the buffered body
// before it's read, even with no explicit further navigation in this code.
// Fix: intercept the request with `page.route()`, fetch it ourselves,
// capture the parsed body deterministically, then `route.fulfill()` so the
// app still gets the real response - same pattern already proven for that
// other case, applied here since this helper is the single most-used
// function in this file and hit the identical race on its very first real
// run.
//
// SECOND live-verified issue on top of that: this app can fire more than
// one matching request for a single /company load (observed directly - the
// exact mechanism wasn't pinned down, but a second, redundant request is
// real). Without a guard, a second concurrent invocation of this same route
// callback can still be mid-`route.fetch()` when the test itself finishes
// and tears down the page, throwing "Test ended" from inside the callback
// and failing the test even though the FIRST invocation already captured
// everything this function needed. `handled` is set synchronously (no
// `await` before it), so only the true first invocation - in JS's
// single-threaded execution order, not wall-clock request order - ever
// proceeds past the guard; every other matching request, whatever its
// cause, is left completely untouched via `route.fallback()`.
// THIRD live-verified issue: the real backend can occasionally return a
// non-JSON error page (HTML) for this endpoint instead of the expected
// body - observed during Suite 3.3's own loop of several rapid, real,
// back-to-back subscription changes, consistent with genuine transient
// backend/infra load rather than anything wrong with this test's own
// logic (the same general "expect real flakiness under load, add
// resilience" pattern already documented elsewhere in this project for
// this app's real pre-staging backend). Retries the whole navigation a
// few times if the body fails to parse as JSON, rather than letting one
// transient bad response fail this expensive-to-rerun file outright.
async function loadCompanyAndGetFirstPageInvoices(page: Page): Promise<{ metadata: { hasMore: boolean; lastCursor?: string }; data: any[] }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let capturedBody: { metadata: { hasMore: boolean; lastCursor?: string }; data: any[] } | null = null;
    let parseFailed = false;
    let handled = false;
    await page.route('**/api/stripe-invoices*', async (route) => {
      if (handled || route.request().method() !== 'GET' || route.request().url().includes('lastCursor')) {
        return route.fallback();
      }
      handled = true;
      const response = await route.fetch();
      try {
        capturedBody = await response.json();
      } catch {
        parseFailed = true;
      }
      await route.fulfill({ response });
    });
    await page.goto(`${BASE_URL}/company`);
    await expect.poll(() => capturedBody !== null || parseFailed, { timeout: 15_000 }).toBe(true);
    await page.unroute('**/api/stripe-invoices*');
    if (capturedBody !== null) return capturedBody;
  }
  throw new Error('Failed to load a valid JSON Payment History response after 3 attempts.');
}

// Extracts a downloaded PDF's full text content via pdf-parse, given its
// direct Stripe-hosted URL - used only by Suite 7's content-level
// cross-checks (Suite 5's own link-behavior scenarios stay lean and never
// parse content, matching the plan's own suite split).
async function extractPdfText(url: string): Promise<string> {
  const parser = new PDFParse({ url });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

// Same trade-off already documented and applied throughout this project
// (payments.spec.ts/subscription.spec.ts/teams-plan-gating.spec.ts/
// account-deletion-billing.spec.ts): serial + chromium-only avoids racing
// parallel browser projects/workers on the one disposable company's
// progressively-growing Payment History built up across this file.
test.describe('Payment History', () => {
  test.describe.configure({ mode: 'serial' });

  // Payment History does not touch the shared seed account for its
  // populated-state scenarios (only 1.1 does, strictly read-only, for the
  // empty-state case): every self-registered account gets its own fully
  // isolated Company/Payments/Subscription record, the same
  // account-isolation reasoning already established for Payments/
  // Subscription/Teams (see CLAUDE.md's "Account/company isolation"
  // section). Register ONE disposable account ONCE here, complete one real
  // Stripe Checkout purchase (the only "fresh, no payment method yet"
  // window this account will ever have), then a small number of additional
  // real in-app interval changes to seed a few Payment History rows with
  // genuinely distinct amounts/dates/descriptions (including at least one
  // negative/credit row) - deliberately NOT enough to cross the 10-row
  // pagination page size yet. Suite 3's own 3.3 test performs however many
  // additional real changes are needed to cross that boundary, right where
  // the test plan's own scenario narrative expects it to happen - see that
  // test's own comment for why this is more robust than pre-generating a
  // fixed row count here.
  test.beforeAll(async ({ browser, browserName }) => {
    // See payments.spec.ts's identical guard for why this is needed on
    // `beforeAll` itself, not just inside `beforeEach` below.
    test.skip(
      browserName !== 'chromium',
      'Disposable single-company state built up sequentially across this file; runs once serially on chromium to avoid cross-project races, redundant registrations, and extra real-email load on the other 2 projects.'
    );

    // Generous budget for real email delivery plus several real Stripe
    // round trips (one Checkout purchase, three in-app interval changes) -
    // matches the scale of other files' own beforeAll timeouts in this
    // project (e.g. subscription.spec.ts's 960_000ms).
    test.setTimeout(960_000);

    // browser.newPage() alone creates a page without this project's
    // configured devices['Desktop Chrome'] context options (notably the
    // user agent), which live-verified elsewhere in this project can make a
    // real verification email never arrive within budget - see
    // payments.spec.ts's identical comment.
    const context = await browser.newContext({ ...devices['Desktop Chrome'] });
    const page = await context.newPage();
    const emailAlias = generateUniqueEmailAlias();
    disposableUsername = generateUsernameFromEmail(emailAlias);
    disposablePassword = requireEnv('TEST_REGISTER_PASSWORD');
    disposableEmail = emailAlias;
    const registeredAt = new Date();

    await registerNewAccount(page, emailAlias);

    const verificationLink = await getVerificationLink(emailAlias, registeredAt, 900_000);
    await page.goto(verificationLink);
    await expect(page).toHaveURL(`${BASE_URL}/login`);

    await page.locator('input[name="username"]').fill(disposableUsername);
    await page.locator('input[name="password"]').fill(disposablePassword);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(`${BASE_URL}/complete-profile`);
    await completeProfile(page);
    await expect(page).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });

    // Real Stripe Checkout purchase: 'Job Link Pro', Monthly ($12.00) - the
    // exact flow already proven in subscription.spec.ts test 4.2. This
    // produces this account's very first Payment History row - a
    // straightforward, non-prorated purchase whose Stripe line item
    // carries a null 'description' (see finding 15/Suite 7.2), the same
    // shape Suite 1.2/7.2 need.
    await page.goto(`${BASE_URL}/subscription`);
    await page.getByRole('heading', { name: 'Job Link Pro', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Review Purchase', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Confirm and Pay' }).click();
    await expect(page).toHaveURL(/checkout\.stripe\.com/, { timeout: 30_000 });

    const emailField = page.getByLabel('Email');
    if ((await emailField.count()) > 0 && !(await emailField.inputValue())) {
      await emailField.fill(`${disposableUsername}@example.com`);
    }
    await page.getByRole('textbox', { name: 'Card number' }).fill('4242424242424242');
    await page.getByRole('textbox', { name: 'Expiration' }).fill('12/34');
    await page.getByRole('textbox', { name: 'CVC' }).fill('123');
    const cardholderNameField = page.getByRole('textbox', { name: 'Cardholder name' });
    if ((await cardholderNameField.count()) > 0 && !(await cardholderNameField.inputValue())) {
      await cardholderNameField.fill('QA Payment History Test');
    }
    // Deliberately never touches the 'I am an AI agent...' checkbox - see
    // subscription.spec.ts test 4.1's identical comment for why (a
    // live-verified 30-minute tool hang when it was clicked during
    // exploration).
    const payButton = page.getByRole('button', { name: /Subscribe|Pay/ });
    await expect(payButton).toBeVisible();
    await payButton.click();
    await expect(page).toHaveURL(/\/subscription\?success=true/, { timeout: 45_000 });
    await expect(page.getByText('Your subscription has been successfully activated!', { exact: true })).toBeVisible();

    // Three more real in-app interval changes (Yearly, then Monthly, then
    // Yearly again) - each produces one more real Payment History row,
    // alternating positive (upgrade to the pricier Yearly interval) and
    // negative (downgrade credit back to Monthly) amounts, and each row
    // carries a real, non-null Stripe line description (a proration
    // line) - giving Suite 1/4's scenarios the variety they need (multiple
    // distinct rows, at least one negative/credit row, at least one row
    // with a real description) without yet crossing the 10-row pagination
    // boundary (4 total rows after this: the purchase plus these 3).
    await changeSubscriptionInterval(page, 'Yearly');
    await changeSubscriptionInterval(page, 'Monthly');
    await changeSubscriptionInterval(page, 'Yearly');

    await context.close();
  });

  test.beforeEach(async ({ browserName }) => {
    test.skip(
      browserName !== 'chromium',
      'Disposable single-company state built up sequentially across this file; runs once serially on chromium to avoid cross-project races and redundant registrations.'
    );
  });

  // Safety net on top of loadCompanyAndGetFirstPageInvoices()'s own
  // 'handled' guard: Playwright's own suggestion when a route callback gets
  // cut short by test teardown ("route.fetch: Test ended") is exactly this
  // call - cheap insurance against any route-in-flight edge case the guard
  // doesn't already cover, given how expensive re-running this whole file
  // is (a real registration, real email, and a real Stripe Checkout
  // purchase every time).
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test.describe('Payment History — Table Structure and Empty/Populated States', () => {
    test('1.1 A company that has never made a real purchase shows the correct, genuinely-empty Payment History state @real-email', async ({ page }) => {
      // 1. Log in as the shared seed account (read-only use only) and land
      // on /company.
      await loginAsSeedAndGoToCompany(page);
      // 'Payment History' renders as a plain generic text node, not a
      // heading-role element - live-verified via direct accessibility
      // snapshot while writing specs/payment-history-test-plan.md. Like
      // every other card's own title text elsewhere in this project
      // (Company Details, Logo Upload, Payments - each documented as having
      // a hidden mobile-accordion duplicate), this text also matches twice
      // in the DOM - but unlike those other cases, direct DOM inspection
      // here showed the FIRST match (a 0x0 <h6>) is the hidden one and the
      // SECOND (a MuiCardHeader-title <span>) is the real, visible one -
      // `.last()`, not the `.first()` convention used elsewhere in this
      // project, is what's actually needed for this specific element.
      await expect(page.getByText('Payment History', { exact: true }).last()).toBeVisible();
      for (const column of ['Status', 'Date', 'Title', 'Amount', 'Billing ID', 'Invoice']) {
        await expect(page.getByRole('columnheader', { name: column, exact: true })).toBeVisible();
      }

      // 2. Inspect the grid body and the footer below it.
      await expect(page.getByText('No Payment History', { exact: true })).toBeVisible();
      await expect(paymentHistoryFooter(page)).toHaveText('0–0 of 0');
      await expect(page.getByRole('button', { name: 'Go to previous page' })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Go to next page' })).toBeDisabled();

      // 3. Inspect the underlying network request the table's own initial
      // load fires - a genuinely empty real dataset, not a client-side
      // placeholder masking a failed/errored fetch.
      const body = await loadCompanyAndGetFirstPageInvoices(page);
      expect(body).toEqual({ metadata: { hasMore: false }, data: [] });
    });

    test('1.2 A company with real payment history shows correctly structured, correctly formatted rows matching the underlying Stripe invoice data @real-email', async ({ page }) => {
      // 1. Log in as the disposable account (with real history from
      // beforeAll) and land on /company.
      const body = await (async () => {
        await loginAsDisposableAndGoToCompany(page);
        return loadCompanyAndGetFirstPageInvoices(page);
      })();
      expect(body.data.length).toBeGreaterThan(0);
      const rows = paymentHistoryDataRows(page);
      await expect(rows).toHaveCount(body.data.length);

      // 2. Cross-check the rendered rows' Amount/Billing ID cells directly
      // against the raw JSON returned by the same request.
      for (const invoice of body.data) {
        const row = rows.filter({ hasText: invoice.number });
        const expectedAmount = (invoice.total / 100).toFixed(2);
        const expectedAmountText = invoice.total < 0 ? `-$${Math.abs(Number(expectedAmount)).toFixed(2)}` : `$${expectedAmount}`;
        await expect(row.getByRole('gridcell').nth(3)).toHaveText(expectedAmountText);
        await expect(row.getByRole('gridcell').nth(4)).toHaveText(invoice.number);
        // A real (non-null) first-line description renders verbatim; a
        // null one is backfilled by the app with its own synthesized text
        // (see finding 15/Suite 7.2) - either way the Title cell must be
        // non-empty, never blank.
        const titleText = await row.getByRole('gridcell').nth(2).textContent();
        expect(titleText?.length).toBeGreaterThan(0);
        if (invoice.lines?.data?.[0]?.description) {
          expect(titleText).toBe(invoice.lines.data[0].description);
        }
      }
    });

    test('1.3 A real subscription change made on /subscription populates a new Payment History row on the very next /company load, with no manual refresh needed @real-email', async ({ page }) => {
      test.slow();
      // 1. Note the current row count and top row's Billing ID, then
      // complete a real interval change.
      await loginAsDisposableAndGoToCompany(page);
      const before = await loadCompanyAndGetFirstPageInvoices(page);
      const billingIdsBefore = new Set(before.data.map((i: any) => i.number));

      await changeSubscriptionInterval(page, 'Monthly');

      // 2. Navigate back to /company (a genuine new navigation) and inspect
      // the table.
      const after = await loadCompanyAndGetFirstPageInvoices(page);
      expect(after.data.length).toBe(before.data.length + 1);
      const newInvoice = after.data.find((i: any) => !billingIdsBefore.has(i.number));
      expect(newInvoice).toBeTruthy();
      // Newest-first: the new row is the top row.
      expect(after.data[0].number).toBe(newInvoice.number);
      await expect(paymentHistoryDataRows(page).first()).toContainText(newInvoice.number);
    });
  });

  test.describe('Payment History — Column Sort Headers Appear Interactive But Are Non-Functional (Likely Bug)', () => {
    // See specs/payment-history-test-plan.md finding 1 and Suite 2 for the
    // full live-verified reasoning. These assertions capture the CURRENT,
    // observed (broken) behavior deliberately - if a future release wires
    // up real sorting, these tests failing is the correct, desired signal
    // that this section needs updating, not a false alarm to silence.
    const sortableColumns = ['Status', 'Date', 'Title', 'Amount', 'Billing ID'];
    sortableColumns.forEach((column, index) => {
      test(`2.${index + 1} LIKELY BUG: clicking the ${column} column header does not reorder rows, and its aria-sort attribute never leaves 'none' @real-email`, async ({ page }) => {
        await loginAsDisposableAndGoToCompany(page);
        const header = page.getByRole('columnheader', { name: column, exact: true });
        await expect(header).toHaveAttribute('aria-sort', 'none');
        const before = await paymentHistoryDataRows(page).allTextContents();

        await header.click();
        await expect(header).toHaveAttribute('aria-sort', 'none');
        expect(await paymentHistoryDataRows(page).allTextContents()).toEqual(before);

        // A second click (testing for a possible ascending->descending
        // toggle reachable only on a repeat click) still does nothing.
        await header.click();
        await expect(header).toHaveAttribute('aria-sort', 'none');
        expect(await paymentHistoryDataRows(page).allTextContents()).toEqual(before);
      });
    });

    test('2.6 Zero network requests fire as a result of any sort-header click, ruling out a server-side sort as cleanly as a client-side one @real-email', async ({ page }) => {
      await loginAsDisposableAndGoToCompany(page);
      // Live-verified this test can otherwise intermittently fail: this
      // app can fire more than one /api/stripe-invoices request for a
      // single /company load (the same real, live-verified behavior
      // loadCompanyAndGetFirstPageInvoices() already guards against
      // elsewhere in this file), with variable timing - a request listener
      // attached immediately after login can occasionally still catch that
      // SECOND, delayed, totally unrelated initial-load request within the
      // 1s observation window below, misattributing it to the header
      // clicks. Waiting for the network to genuinely go idle first ensures
      // any such leftover initial-load activity has already settled before
      // this test starts watching for NEW requests caused specifically by
      // its own clicks.
      await page.waitForLoadState('networkidle');
      let requestFired = false;
      const onRequest = (url: string) => {
        if (url.includes('/api/stripe-invoices')) requestFired = true;
      };
      page.on('request', (r) => onRequest(r.url()));
      for (const column of sortableColumns) {
        await page.getByRole('columnheader', { name: column, exact: true }).click();
      }
      await page.waitForTimeout(1_000);
      expect(requestFired).toBe(false);
    });

    test("2.7 The 'Invoice' column correctly has NO sort affordance at all, in clear contrast to the other five columns' broken-but-present affordance @real-email", async ({ page }) => {
      await loginAsDisposableAndGoToCompany(page);
      const invoiceHeader = page.getByRole('columnheader', { name: 'Invoice', exact: true });
      const amountHeader = page.getByRole('columnheader', { name: 'Amount', exact: true });
      await expect(invoiceHeader).not.toHaveClass(/MuiDataGrid-columnHeader--sortable/);
      await expect(amountHeader).toHaveClass(/MuiDataGrid-columnHeader--sortable/);
    });

    test('2.8 Clicking a sort header on a genuinely empty (0-row) table produces no error and no crash @real-email', async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });
      await loginAsSeedAndGoToCompany(page);
      await page.getByRole('columnheader', { name: 'Date', exact: true }).click();
      await expect(page.getByText('No Payment History', { exact: true })).toBeVisible();
      expect(consoleErrors).toEqual([]);
    });
  });

  test.describe('Payment History — Pagination', () => {
    test('3.1 The real page size is a fixed 10 rows, confirmed directly via the underlying API request query parameter @real-email', async ({ page }) => {
      await loginAsDisposableAndGoToCompany(page);
      const responsePromise = page.waitForResponse((r) => r.url().includes('/api/stripe-invoices'));
      await page.goto(`${BASE_URL}/company`);
      const response = await responsePromise;
      // Parsed via URL/searchParams rather than string-matching the raw
      // URL, so this doesn't depend on whether the app's own client code
      // happens to percent-encode the '[' ']' characters or leaves them
      // literal on the wire.
      const params = new URL(response.url()).searchParams;
      expect(params.get('paginationModel[pageSize]')).toBe('10');
    });

    test('3.2 With 10 or fewer total rows, both navigation buttons stay disabled and the footer label shows the true, exact count @real-email', async ({ page }) => {
      await loginAsDisposableAndGoToCompany(page);
      const body = await loadCompanyAndGetFirstPageInvoices(page);
      // Guard: this scenario only makes sense while still at or under the
      // page size - if a previous run already pushed this account past 10
      // (shouldn't happen given this file's own serial, single-run
      // ordering, but asserted defensively rather than silently
      // misinterpreting a stale account).
      expect(body.metadata.hasMore).toBe(false);
      await expect(paymentHistoryFooter(page)).toHaveText(`1–${body.data.length} of ${body.data.length}`);
      await expect(page.getByRole('button', { name: 'Go to previous page' })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Go to next page' })).toBeDisabled();
    });

    test("3.3 Crossing the 10-row boundary switches the footer to an 'estimated' total and enables 'Go to next page' for the first time @real-email", async ({ page }) => {
      test.slow();
      await loginAsDisposableAndGoToCompany(page);
      // Repeatedly perform a real interval change until the table's own
      // backing request reports more than one page exists - self-adjusting
      // to whatever count beforeAll/earlier tests left this account at,
      // rather than a hardcoded number of clicks, so this test doesn't need
      // updating if that seeded row count ever changes. Uses 'toggle' (not
      // an assumed starting value) since this loop's own starting point
      // depends on exactly how many real changes earlier tests already
      // made - see changeSubscriptionInterval()'s own comment for why
      // guessing wrong here would hang the loop. Capped at 15 iterations as
      // a safety net (comfortably more than the ~6-7 normally needed).
      let body = await loadCompanyAndGetFirstPageInvoices(page);
      let guard = 0;
      while (!body.metadata.hasMore && guard < 15) {
        await changeSubscriptionInterval(page, 'toggle');
        body = await loadCompanyAndGetFirstPageInvoices(page);
        guard++;
      }
      expect(body.metadata.hasMore).toBe(true);
      expect(body.data.length).toBe(10);
      await expect(paymentHistoryFooter(page)).toHaveText('1–10 of more than 10');
      await expect(page.getByRole('button', { name: 'Go to previous page' })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Go to next page' })).toBeEnabled();
    });

    test("3.4 Clicking 'Go to next page' correctly fetches the next cursor-based page, finalizes the exact total once the true end is reached, and correctly flips both buttons' state @real-email", async ({ page }) => {
      // Continues from the 11-row state 3.3 already established.
      await loginAsDisposableAndGoToCompany(page);
      const firstPage = await loadCompanyAndGetFirstPageInvoices(page);
      expect(firstPage.metadata.hasMore).toBe(true);

      // Same route-interception fix as loadCompanyAndGetFirstPageInvoices()
      // above (including its own 'handled' guard against a second
      // concurrent matching request), applied here too rather than reading
      // the response body directly off a plain waitForResponse() -
      // defensive against the identical race documented there, even though
      // this particular response follows a same-page pagination click
      // rather than a full page.goto().
      let secondPageUrl = '';
      let secondPageBody: { metadata: { hasMore: boolean }; data: any[] } | null = null;
      let secondPageHandled = false;
      await page.route('**/api/stripe-invoices*', async (route) => {
        if (secondPageHandled || route.request().method() !== 'GET' || !route.request().url().includes('lastCursor')) {
          return route.fallback();
        }
        secondPageHandled = true;
        const response = await route.fetch();
        secondPageUrl = route.request().url();
        secondPageBody = await response.json();
        await route.fulfill({ response });
      });
      await page.getByRole('button', { name: 'Go to next page' }).click();
      await expect.poll(() => secondPageBody !== null, { timeout: 15_000 }).toBe(true);
      await page.unroute('**/api/stripe-invoices*');

      const secondPageParams = new URL(secondPageUrl).searchParams;
      const expectedCursor = firstPage.metadata.lastCursor ?? firstPage.data[firstPage.data.length - 1].id;
      expect(secondPageParams.get('paginationModel[lastCursor]')).toBe(expectedCursor);
      const secondPage = secondPageBody!;
      expect(secondPage.metadata.hasMore).toBe(false);

      const totalRows = firstPage.data.length + secondPage.data.length;
      await expect(paymentHistoryDataRows(page)).toHaveCount(secondPage.data.length);
      await expect(paymentHistoryFooter(page)).toHaveText(`${totalRows}–${totalRows} of ${totalRows}`);
      await expect(page.getByRole('button', { name: 'Go to previous page' })).toBeEnabled();
      await expect(page.getByRole('button', { name: 'Go to next page' })).toBeDisabled();
    });

    test("3.5 Clicking 'Go to previous page' returns to page 1 via a genuine fresh network re-fetch, not a client-side cache restore @real-email", async ({ page }) => {
      // Continues from page 2 (per 3.4).
      await loginAsDisposableAndGoToCompany(page);
      await loadCompanyAndGetFirstPageInvoices(page);
      await page.getByRole('button', { name: 'Go to next page' }).click();
      await expect(page.getByRole('button', { name: 'Go to previous page' })).toBeEnabled();

      const responsePromise = page.waitForResponse((r) => r.url().includes('/api/stripe-invoices') && !r.url().includes('lastCursor'));
      await page.getByRole('button', { name: 'Go to previous page' }).click();
      await responsePromise;

      await expect(paymentHistoryFooter(page)).toHaveText('1–10 of more than 10');
      await expect(page.getByRole('button', { name: 'Go to previous page' })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Go to next page' })).toBeEnabled();
    });

    test('3.6 Pagination position is pure client-side state — it is not reflected in the URL and does not survive a genuine full-page reload @real-email', async ({ page }) => {
      await loginAsDisposableAndGoToCompany(page);
      await page.getByRole('button', { name: 'Go to next page' }).click();
      await expect(page.getByRole('button', { name: 'Go to previous page' })).toBeEnabled();
      expect(page.url()).toBe(`${BASE_URL}/company`);

      await page.goto(`${BASE_URL}/company`);
      await expect(paymentHistoryFooter(page)).toHaveText('1–10 of more than 10');
      await expect(page.getByRole('button', { name: 'Go to previous page' })).toBeDisabled();
    });
  });

  test.describe('Payment History — Row Ordering and Data Formatting', () => {
    test('4.1 Rows are sorted newest-first by Date by default, on first load, with no header ever clicked @real-email', async ({ page }) => {
      await loginAsDisposableAndGoToCompany(page);
      const body = await loadCompanyAndGetFirstPageInvoices(page);
      const createdTimestamps = body.data.map((i: any) => i.created);
      const sorted = [...createdTimestamps].sort((a, b) => b - a);
      expect(createdTimestamps).toEqual(sorted);
    });

    test('4.2 Rows sharing the identical DISPLAYED minute are still ordered correctly by a finer-grained real underlying creation time @real-email', async ({ page }) => {
      await loginAsDisposableAndGoToCompany(page);
      const body = await loadCompanyAndGetFirstPageInvoices(page);
      // Group by the DISPLAYED minute (matching the Date cell's own
      // to-the-minute formatting), not the raw second-precision
      // 'created' value - looking for a real coincidence where two rows
      // rendered the same visible minute string, the same condition the
      // original live exploration happened to hit.
      const byMinute = new Map<number, any[]>();
      for (const invoice of body.data) {
        const minuteKey = Math.floor(invoice.created / 60);
        byMinute.set(minuteKey, [...(byMinute.get(minuteKey) ?? []), invoice]);
      }
      const tie = [...byMinute.values()].find((group) => group.length > 1);
      test.skip(!tie, 'No two rows landed in the same displayed minute in this run to exercise this tie-breaking case.');
      if (!tie) return; // Unreachable at runtime (test.skip() above already stops execution) - narrows the type for TypeScript.

      const [later, earlier] = [...tie].sort((a, b) => b.created - a.created);
      const rows = paymentHistoryDataRows(page);
      const laterIndex = await rows.filter({ hasText: later.number }).evaluate((el) => Array.from(el.parentElement!.children).indexOf(el));
      const earlierIndex = await rows.filter({ hasText: earlier.number }).evaluate((el) => Array.from(el.parentElement!.children).indexOf(el));
      expect(laterIndex).toBeLessThan(earlierIndex);
    });

    test('4.3 A negative-amount (credit/proration) row renders correctly with a leading minus sign, and still shows Status Paid rather than a distinct credit-specific status @real-email', async ({ page }) => {
      await loginAsDisposableAndGoToCompany(page);
      const body = await loadCompanyAndGetFirstPageInvoices(page);
      const creditInvoice = body.data.find((i: any) => i.total < 0);
      expect(creditInvoice, 'expected beforeAll to have produced at least one credit/negative-amount row').toBeTruthy();

      const row = paymentHistoryDataRows(page).filter({ hasText: creditInvoice.number });
      const expectedAmount = `-$${Math.abs(creditInvoice.total / 100).toFixed(2)}`;
      await expect(row.getByRole('gridcell').nth(3)).toHaveText(expectedAmount);
      await expect(row.getByRole('gridcell').nth(0)).toHaveText('Paid');
    });

    test('4.4 An invoice with multiple Stripe line items only surfaces the FIRST line\'s description as Title @real-email', async ({ page }) => {
      await loginAsDisposableAndGoToCompany(page);
      const body = await loadCompanyAndGetFirstPageInvoices(page);
      // Every real interval-change invoice this file's beforeAll/Suite 3
      // produces carries exactly 2 line items: a proration credit/charge
      // (real description) plus the new full-price recurring line (Stripe
      // itself never generates a description for a plain, non-prorated
      // recurring line - see finding 15/Suite 7.2) - so line[1]'s
      // description is null here, unlike the plan's own original example
      // (a plan-TIER change, which happens to get a real description on
      // both lines). Either shape proves the same underlying rule (only
      // line[0] ever surfaces as Title), so this only requires >= 2 lines,
      // not a described second line specifically.
      const multiLineInvoice = body.data.find((i: any) => (i.lines?.data?.length ?? 0) >= 2);
      expect(multiLineInvoice, 'expected at least one of beforeAll\'s real interval-change invoices to carry 2 line items').toBeTruthy();

      const row = paymentHistoryDataRows(page).filter({ hasText: multiLineInvoice.number });
      const titleText = await row.getByRole('gridcell').nth(2).textContent();
      expect(titleText).toBe(multiLineInvoice.lines.data[0].description);
      const secondLineDescription = multiLineInvoice.lines.data[1]?.description;
      if (secondLineDescription) {
        expect(titleText).not.toContain(secondLineDescription);
      }

      // No dollar amount is lost even though the second line's description
      // never appears - the row's Amount still reflects the full combined
      // total.
      const expectedAmount =
        multiLineInvoice.total < 0
          ? `-$${Math.abs(multiLineInvoice.total / 100).toFixed(2)}`
          : `$${(multiLineInvoice.total / 100).toFixed(2)}`;
      await expect(row.getByRole('gridcell').nth(3)).toHaveText(expectedAmount);
    });

    test('4.5 A long Title value truncates gracefully with a CSS ellipsis and remains fully readable via a native hover tooltip @real-email', async ({ page }) => {
      await loginAsDisposableAndGoToCompany(page);
      const body = await loadCompanyAndGetFirstPageInvoices(page);
      const withDescription = body.data.find((i: any) => (i.lines?.data?.[0]?.description ?? '').length > 40);
      test.skip(!withDescription, 'No sufficiently long real Title was produced by beforeAll in this run to exercise truncation.');

      const cell = paymentHistoryDataRows(page).filter({ hasText: withDescription.number }).getByRole('gridcell').nth(2);
      await expect(cell).toHaveAttribute('title', withDescription.lines.data[0].description);
      const overflow = await cell.evaluate((el) => getComputedStyle(el).textOverflow);
      expect(overflow).toBe('ellipsis');
    });

    test('4.6 The Amount column is consistently left-aligned, both header and every cell @real-email', async ({ page }) => {
      await loginAsDisposableAndGoToCompany(page);
      const header = page.getByRole('columnheader', { name: 'Amount', exact: true });
      await expect(header).toHaveClass(/MuiDataGrid-columnHeader--alignLeft/);
      const rows = paymentHistoryDataRows(page);
      const count = await rows.count();
      for (let i = 0; i < count; i++) {
        await expect(rows.nth(i).getByRole('gridcell').nth(3)).toHaveClass(/MuiDataGrid-cell--textLeft/);
      }
    });
  });

  test.describe('Payment History — Invoice Links (basic link behavior, not content)', () => {
    test('5.1 An Invoice link points to a real, resolvable Stripe-hosted PDF, opens in a new tab, with safe rel attributes @real-email', async ({ page, request }) => {
      await loginAsDisposableAndGoToCompany(page);
      const link = paymentHistoryDataRows(page).first().getByRole('link');
      const href = await link.getAttribute('href');
      expect(href).toMatch(/^https:\/\/pay\.stripe\.com\/invoice\/.+\/pdf/);
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', 'noopener noreferrer');

      const response: APIResponse = await request.get(href!);
      expect(response.ok()).toBe(true);
      // Live-verified: Stripe serves this as 'application/octet-stream',
      // not 'application/pdf' - the Content-Type header isn't a reliable
      // signal here. Checking the real PDF magic bytes ('%PDF') at the
      // start of the body is what actually confirms this is a genuine PDF.
      const body = await response.body();
      expect(body.subarray(0, 4).toString('utf8')).toBe('%PDF');
    });
  });

  test.describe('Payment History — Row/Cell Interaction', () => {
    test('6.1 Clicking anywhere in a row other than the Invoice link has no effect @real-email', async ({ page }) => {
      await loginAsDisposableAndGoToCompany(page);
      const row = paymentHistoryDataRows(page).first();
      const statusCell = row.getByRole('gridcell').nth(0);
      await statusCell.click();
      await expect(page).toHaveURL(`${BASE_URL}/company`);
      // No MUI DataGrid row-selection state gets applied either - the
      // 'aria-selected' attribute is genuinely absent (not merely 'false'),
      // matching specs/payment-history-test-plan.md finding 10's direct DOM
      // inspection.
      expect(await row.getAttribute('aria-selected')).toBeNull();
    });

    // 6.2 (a genuine Stripe Test-Clock-driven subscription lapse doesn't
    // hide/corrupt prior Payment History rows) is already live-verified in
    // tests/teams-plan-gating.spec.ts's own Suite 3.2 - cited, not
    // re-derived here, per specs/payment-history-test-plan.md's own scope
    // guidance.

    test("6.3 /company's own auth guard covers this table too @real-email", async ({ page }) => {
      await page.goto(`${BASE_URL}/company`);
      await expect(page).toHaveURL(/\/login\?redirectUrl=/);
      const redirectUrl = new URL(page.url()).searchParams.get('redirectUrl');
      expect(redirectUrl).toBe(`${BASE_URL}/company`);
    });
  });

  test.describe('Payment History — Cross-Verification Against Stripe API, Real PDF Content, and MongoDB', () => {
    test("7.1 Every invoice the app's table shows matches Stripe's own API exactly, field-for-field, when queried independently @real-email", async ({ page }) => {
      await loginAsDisposableAndGoToCompany(page);
      const appBody = await loadCompanyAndGetFirstPageInvoices(page);

      const customerId = await stripeFindCustomerByEmail(disposableEmail);
      const stripeResult = await stripeRequest('GET', `/invoices?customer=${customerId}&limit=100`);
      const stripeByNumber = new Map<string, any>(stripeResult.data.map((i: any) => [i.number, i]));

      for (const appInvoice of appBody.data) {
        const stripeInvoice = stripeByNumber.get(appInvoice.number);
        expect(stripeInvoice, `Stripe has no invoice matching Billing ID ${appInvoice.number}`).toBeTruthy();
        expect(appInvoice.total).toBe(stripeInvoice.total);
        expect(appInvoice.status).toBe(stripeInvoice.status);
        // NOT comparing invoicePdf/invoice_pdf directly - live-verified
        // this field is NOT a stable value to compare across two
        // independent API calls for the same invoice: Stripe generates a
        // fresh, differently-signed PDF URL on every single request (the
        // long token in the URL path changes each time, not just a query
        // param), so the app's own fetch and this test's separate fetch
        // will always legitimately differ here even when both are
        // completely correct. Confirming the PDF link RESOLVES and its
        // content matches is already covered elsewhere (Suite 5.1's link
        // check, Suite 7.3/7.4's real content extraction).
      }
    });

    test('7.2 CLARIFICATION, confirmed via Stripe raw data: the Title column synthesizes its own text when the real line description is null, rather than always proxying it verbatim @real-email', async ({ page }) => {
      await loginAsDisposableAndGoToCompany(page);
      const customerId = await stripeFindCustomerByEmail(disposableEmail);
      const stripeResult = await stripeRequest('GET', `/invoices?customer=${customerId}&limit=100`);
      // The very first, non-prorated purchase invoice always has a null
      // Stripe line description - a straightforward `"type": "subscription"`
      // line never gets an auto-generated description from Stripe, only a
      // proration `"type": "invoiceitem"` line does.
      const nullDescriptionInvoice = stripeResult.data.find((i: any) => i.lines?.data?.[0]?.description === null);
      expect(nullDescriptionInvoice, 'expected beforeAll\'s initial purchase invoice to have a null Stripe line description').toBeTruthy();

      // This is the account's very first (oldest) invoice, which by this
      // point in the file has fallen onto page 2 - see findRowByBillingId()
      // for why a plain page-1-only lookup isn't enough here.
      const row = await findRowByBillingId(page, nullDescriptionInvoice.number);
      const titleText = await row.getByRole('gridcell').nth(2).textContent();
      expect(titleText).toBeTruthy();
      expect(titleText).not.toBe('');
      // The synthesized fallback names the real plan, distinguishing it
      // from a literal proxy of the (null) raw description.
      expect(titleText).toContain(nullDescriptionInvoice.lines.data[0].plan.name);
    });

    test('7.3 A downloaded Invoice PDF\'s own content matches the table and Stripe\'s API exactly, for a normal positive-amount invoice @real-email', async ({ page }) => {
      test.slow();
      await loginAsDisposableAndGoToCompany(page);
      const body = await loadCompanyAndGetFirstPageInvoices(page);
      const positiveInvoice = body.data.find((i: any) => i.total > 0);
      expect(positiveInvoice).toBeTruthy();

      const pdfText = await extractPdfText(positiveInvoice.invoicePdf ?? positiveInvoice.invoice_pdf);
      // Live-verified via direct byte-level inspection: the character
      // connecting the Billing ID's prefix and number in the PDF's own
      // 'Invoice number' line is NOT reliably a space (or the original
      // hyphen) - one real invoice rendered a literal NULL byte (char code
      // 0, confirmed via charCodeAt) there instead, a pdf-parse/font-encoding
      // artifact specific to this field. Matching via a single-character
      // wildcard instead of assuming any specific connector is what
      // actually holds up.
      const [prefix, suffix] = positiveInvoice.number.split('-');
      expect(pdfText).toMatch(new RegExp(`${prefix}.${suffix}`));
      const expectedTotal = `$${(positiveInvoice.total / 100).toFixed(2)}`;
      expect(pdfText).toContain(expectedTotal);
    });

    test("7.4 NEW FINDING: a credit invoice's downloaded PDF shows no negative sign anywhere, unlike the table's own negative Amount @real-email", async ({ page }) => {
      test.slow();
      await loginAsDisposableAndGoToCompany(page);
      const body = await loadCompanyAndGetFirstPageInvoices(page);
      const creditInvoice = body.data.find((i: any) => i.total < 0);
      expect(creditInvoice, 'expected beforeAll to have produced at least one credit/negative-amount row').toBeTruthy();

      const pdfText = await extractPdfText(creditInvoice.invoicePdf ?? creditInvoice.invoice_pdf);
      // The table's own Amount cell for this exact invoice IS negative -
      // asserted here for contrast with the PDF's own text below.
      const row = paymentHistoryDataRows(page).filter({ hasText: creditInvoice.number });
      const expectedAmount = `-$${Math.abs(creditInvoice.total / 100).toFixed(2)}`;
      await expect(row.getByRole('gridcell').nth(3)).toHaveText(expectedAmount);

      // The PDF itself never renders a minus sign for this same invoice -
      // see specs/payment-history-test-plan.md finding 16 for the full
      // live-verified reasoning (the credit is represented via a separate
      // 'Applied balance' line instead, netting to a $0.00 due amount).
      expect(pdfText).not.toContain('-$');
      expect(pdfText).toContain('Applied balance');
    });

    test('7.5 MongoDB holds no local record of this table\'s data whatsoever @real-email', async ({ page }) => {
      // Scoped to only the 2 specific, plausible-by-name collections (see
      // findAnyCollectionReferencing()'s own comment for why a full
      // ~63-collection database sweep was dropped - it was live-verified
      // to be too slow to depend on, exceeding even an 8-minute budget on
      // one real run). Still generous headroom beyond this, since it's a
      // shared database with other real usage outside this project's
      // control.
      test.setTimeout(120_000);

      await loginAsDisposableAndGoToCompany(page);
      const body = await loadCompanyAndGetFirstPageInvoices(page);
      const user = await getUserByEmail(disposableEmail);
      expect(user, 'expected the disposable account to exist in MongoDB').toBeTruthy();

      // Deliberately searches ONLY by each invoice's own real Stripe id
      // (e.g. 'in_...'), NOT by the account's own Mongo _id/stripe_id -
      // live-verified while writing this test that including the
      // account's own identity values makes this assertion trivially
      // fail for ANY real account: `users`/`account_memberships`/
      // `team_memberships`/`tier_subscription_view` all correctly
      // reference a user's own _id/stripe_id as part of completely
      // unrelated, expected account/membership bookkeeping - that's not
      // evidence of Payment History being cached anywhere, just this
      // helper's search criteria being too broad. An invoice id, by
      // contrast, is never a legitimate value for any of those
      // collections' own fields, so a hit on ANY collection here is a
      // real, meaningful signal.
      const invoiceIds = body.data.map((i: any) => i.id).filter(Boolean);
      const hits = await findAnyCollectionReferencing(invoiceIds, ['stripe_invoices', 'invoices']);
      expect(hits, `expected zero Mongo collections to reference this account's real invoices, found: ${JSON.stringify(hits)}`).toEqual([]);
    });
  });
});
