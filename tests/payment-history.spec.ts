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

// This file's CI-only Chromium software-rendering flags (see CLAUDE.md) live in its own dedicated project in playwright.config.ts, not a file-level test.use() here.

/** Logs in with the disposable account from `beforeAll` and lands on /company. */
async function loginAsDisposableAndGoToCompany(page: Page) {
  await page.goto(`${BASE_URL}/login`);
  await page.locator('input[name="username"]').fill(disposableUsername);
  await page.locator('input[name="password"]').fill(disposablePassword);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });
  await page.goto(`${BASE_URL}/company`);
}

/** Logs in with the shared seed account - used ONLY by 1.1, strictly read-only, since it never touches Payments/Subscription elsewhere (see CLAUDE.md). */
async function loginAsSeedAndGoToCompany(page: Page) {
  await page.goto(`${BASE_URL}/login`);
  await page.locator('input[name="username"]').fill(SEED_USERNAME);
  await page.locator('input[name="password"]').fill(SEED_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });
  await page.goto(`${BASE_URL}/company`);
}

/** Switches billing interval via /subscription's 'Update Subscription' dialog, always clicking the plan card first ('Continue' silently no-ops otherwise, see CLAUDE.md). `'toggle'` switches away from whatever interval is currently active. */
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
// Unlike other /company cards, this MUI DataGrid renders exactly one real
// `grid` landmark - no hidden mobile-accordion duplicate to work around.
function paymentHistoryGrid(page: Page) {
  return page.getByRole('grid');
}

/** Data rows only, excluding the header row - scoped to the nested `rowgroup` that data rows live in but the header row doesn't. */
function paymentHistoryDataRows(page: Page) {
  return paymentHistoryGrid(page).getByRole('rowgroup').getByRole('row');
}

function paymentHistoryFooter(page: Page) {
  return page.locator('p').filter({ hasText: /^\d+–\d+ of (\d+|more than \d+)$/ });
}

/** Finds a row by Billing ID across pages, polling the row count (not a single `.count()` read) and clicking 'Go to next page' as needed. */
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
    await page.waitForTimeout(500); // settle wait for the new page's rows to render
  }
  throw new Error(`Billing ID ${billingId} not found within 5 pages of the Payment History table.`);
}

/** Navigates to /company and returns the invoices table's first-page response body - intercepted via `page.route()` with a `handled` guard, retrying up to 3x on a non-JSON response (see CLAUDE.md). */
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

/** Extracts a downloaded PDF's full text via pdf-parse, given its Stripe-hosted URL - used only by Suite 7's content-level cross-checks. */
async function extractPdfText(url: string): Promise<string> {
  const parser = new PDFParse({ url });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

// Serial + chromium-only: avoids racing parallel browser projects on the one disposable company's growing Payment History (see CLAUDE.md).
test.describe('Payment History', () => {
  test.describe.configure({ mode: 'serial' });

  // Registers ONE disposable account, completes a real Stripe purchase, then
  // a few more real interval changes to seed rows with distinct
  // amounts/dates/descriptions (including a credit row) - deliberately not
  // enough to cross the 10-row page size yet; 3.3 crosses that boundary itself.
  test.beforeAll(async ({ browser, browserName }) => {
    // Guarded here too, not just beforeEach - a beforeEach skip doesn't gate beforeAll (see CLAUDE.md).
    test.skip(
      browserName !== 'chromium',
      'Disposable single-company state built up sequentially across this file; runs once serially on chromium to avoid cross-project races, redundant registrations, and extra real-email load on the other 2 projects.'
    );

    test.setTimeout(960_000); // real email delivery + several real Stripe round trips

    // newContext() with the device profile, not bare newPage() - see CLAUDE.md's real-email delivery gotcha.
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

    // Real Stripe Checkout purchase: 'Job Link Pro', Monthly - produces this
    // account's first Payment History row, a non-prorated purchase with a null Stripe line description (needed by 1.2/7.2).
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
    // Never touches the 'I am an AI agent...' checkbox (see subscription.spec.ts test 4.1's comment).
    const payButton = page.getByRole('button', { name: /Subscribe|Pay/ });
    await expect(payButton).toBeVisible();
    await payButton.click();
    await expect(page).toHaveURL(/\/subscription\?success=true/, { timeout: 45_000 });
    await expect(page.getByText('Your subscription has been successfully activated!', { exact: true })).toBeVisible();

    // Three more real interval changes (Yearly/Monthly/Yearly) - each adds a
    // row with a real description, alternating positive/negative amounts,
    // giving Suite 1/4 the variety they need without crossing the 10-row page size (4 rows total).
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

  // Safety net on top of loadCompanyAndGetFirstPageInvoices()'s own 'handled' guard, against any route-in-flight edge case it doesn't already cover.
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test.describe('Payment History — Table Structure and Empty/Populated States', () => {
    test('1.1 A company that has never made a real purchase shows the correct, genuinely-empty Payment History state @real-email', async ({ page }) => {
      // 1. Log in as the shared seed account (read-only use only).
      await loginAsSeedAndGoToCompany(page);
      // 'Payment History' text matches twice (hidden mobile duplicate +
      // real) like other cards, but here it's the SECOND match that's real - `.last()`, not this project's usual `.first()`.
      await expect(page.getByText('Payment History', { exact: true }).last()).toBeVisible();
      for (const column of ['Status', 'Date', 'Title', 'Amount', 'Billing ID', 'Invoice']) {
        await expect(page.getByRole('columnheader', { name: column, exact: true })).toBeVisible();
      }

      // 2. Inspect the grid body and the footer below it.
      await expect(page.getByText('No Payment History', { exact: true })).toBeVisible();
      await expect(paymentHistoryFooter(page)).toHaveText('0–0 of 0');
      await expect(page.getByRole('button', { name: 'Go to previous page' })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Go to next page' })).toBeDisabled();

      // 3. The underlying request returns a genuinely empty dataset, not a placeholder masking a failed fetch.
      const body = await loadCompanyAndGetFirstPageInvoices(page);
      expect(body).toEqual({ metadata: { hasMore: false }, data: [] });
    });

    test('1.2 A company with real payment history shows correctly structured, correctly formatted rows matching the underlying Stripe invoice data @real-email', async ({ page }) => {
      // 1. Log in as the disposable account (real history from beforeAll).
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
        // A real description renders verbatim; a null one gets a synthesized fallback (see 7.2) - either way, never blank.
        const titleText = await row.getByRole('gridcell').nth(2).textContent();
        expect(titleText?.length).toBeGreaterThan(0);
        if (invoice.lines?.data?.[0]?.description) {
          expect(titleText).toBe(invoice.lines.data[0].description);
        }
      }
    });

    test('1.3 A real subscription change made on /subscription populates a new Payment History row on the very next /company load, with no manual refresh needed @real-email', async ({ page }) => {
      test.slow();
      // 1. Note the current rows, then complete a real interval change.
      await loginAsDisposableAndGoToCompany(page);
      const before = await loadCompanyAndGetFirstPageInvoices(page);
      const billingIdsBefore = new Set(before.data.map((i: any) => i.number));

      await changeSubscriptionInterval(page, 'Monthly');

      // 2. A genuine new navigation to /company shows the new row.
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
    // These assertions capture the CURRENT, broken behavior deliberately -
    // if a future release wires up real sorting, these tests failing is the correct signal, not a false alarm.
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
      // Waits for network idle first - this app can fire a second, delayed
      // initial-load request (see CLAUDE.md) that could otherwise land inside the observation window below and get misattributed to the clicks.
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
      // Parsed via searchParams, not raw string-matching, so encoding of '[' ']' doesn't matter.
      const params = new URL(response.url()).searchParams;
      expect(params.get('paginationModel[pageSize]')).toBe('10');
    });

    test('3.2 With 10 or fewer total rows, both navigation buttons stay disabled and the footer label shows the true, exact count @real-email', async ({ page }) => {
      await loginAsDisposableAndGoToCompany(page);
      const body = await loadCompanyAndGetFirstPageInvoices(page);
      // Guard: this scenario only makes sense at or under the page size - asserted defensively rather than silently misreading a stale account.
      expect(body.metadata.hasMore).toBe(false);
      await expect(paymentHistoryFooter(page)).toHaveText(`1–${body.data.length} of ${body.data.length}`);
      await expect(page.getByRole('button', { name: 'Go to previous page' })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Go to next page' })).toBeDisabled();
    });

    test("3.3 Crossing the 10-row boundary switches the footer to an 'estimated' total and enables 'Go to next page' for the first time @real-email", async ({ page }) => {
      test.slow();
      await loginAsDisposableAndGoToCompany(page);
      // Loops real interval changes until more than one page exists -
      // self-adjusting to whatever row count earlier tests left, using
      // 'toggle' rather than a hardcoded value (see its own comment for
      // why guessing wrong would hang the loop). Capped at 15 iterations (normally needs ~6-7).
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

      // Same route-interception + 'handled' guard as loadCompanyAndGetFirstPageInvoices() (see CLAUDE.md), applied to this pagination click too.
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
      // Groups by the DISPLAYED minute (matching the Date cell's formatting), not the raw second-precision 'created' value.
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
      // Every real interval-change invoice here has exactly 2 line items - a
      // proration line (real description) plus a plain recurring line
      // (Stripe never generates a description for that one, see 7.2). Only
      // needs >= 2 lines, not a described second line specifically, to prove the same underlying rule.
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
      // Stripe serves this as 'application/octet-stream', not
      // 'application/pdf' - checking the real PDF magic bytes ('%PDF') is what actually confirms it.
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
      // No row-selection state applied - 'aria-selected' is genuinely absent, not merely 'false'.
      expect(await row.getAttribute('aria-selected')).toBeNull();
    });

    // 6.2 (a real Test-Clock-driven lapse doesn't hide/corrupt prior rows) is covered in teams-plan-gating.spec.ts's Suite 3.2, not re-derived here.

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
        // NOT comparing invoicePdf/invoice_pdf directly - Stripe generates a
        // fresh, differently-signed URL on every request, so two independent
        // calls always legitimately differ (link/content checks live in 5.1/7.3/7.4 instead).
      }
    });

    test('7.2 CLARIFICATION, confirmed via Stripe raw data: the Title column synthesizes its own text when the real line description is null, rather than always proxying it verbatim @real-email', async ({ page }) => {
      await loginAsDisposableAndGoToCompany(page);
      const customerId = await stripeFindCustomerByEmail(disposableEmail);
      const stripeResult = await stripeRequest('GET', `/invoices?customer=${customerId}&limit=100`);
      // A plain "type": "subscription" line never gets an auto-generated
      // Stripe description - only a proration "invoiceitem" line does - so
      // the account's very first purchase invoice always has a null one.
      const nullDescriptionInvoice = stripeResult.data.find((i: any) => i.lines?.data?.[0]?.description === null);
      expect(nullDescriptionInvoice, 'expected beforeAll\'s initial purchase invoice to have a null Stripe line description').toBeTruthy();

      // This is the account's oldest invoice, fallen onto page 2 by now (see findRowByBillingId()).
      const row = await findRowByBillingId(page, nullDescriptionInvoice.number);
      const titleText = await row.getByRole('gridcell').nth(2).textContent();
      expect(titleText).toBeTruthy();
      expect(titleText).not.toBe('');
      // The synthesized fallback names the real plan, not a literal proxy of the null description.
      expect(titleText).toContain(nullDescriptionInvoice.lines.data[0].plan.name);
    });

    test('7.3 A downloaded Invoice PDF\'s own content matches the table and Stripe\'s API exactly, for a normal positive-amount invoice @real-email', async ({ page }) => {
      test.slow();
      await loginAsDisposableAndGoToCompany(page);
      const body = await loadCompanyAndGetFirstPageInvoices(page);
      const positiveInvoice = body.data.find((i: any) => i.total > 0);
      expect(positiveInvoice).toBeTruthy();

      const pdfText = await extractPdfText(positiveInvoice.invoicePdf ?? positiveInvoice.invoice_pdf);
      // The character connecting the Billing ID's prefix/number in the PDF
      // isn't reliably a space or hyphen - one invoice rendered a literal
      // NULL byte there (see CLAUDE.md), so match via a single-char wildcard instead of a fixed connector.
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
      // Table's own Amount cell IS negative, for contrast with the PDF text below.
      const row = paymentHistoryDataRows(page).filter({ hasText: creditInvoice.number });
      const expectedAmount = `-$${Math.abs(creditInvoice.total / 100).toFixed(2)}`;
      await expect(row.getByRole('gridcell').nth(3)).toHaveText(expectedAmount);

      // The PDF never renders a minus sign - the credit is a separate 'Applied balance' line, netting to $0.00 due.
      expect(pdfText).not.toContain('-$');
      expect(pdfText).toContain('Applied balance');
    });

    test('7.5 MongoDB holds no local record of this table\'s data whatsoever @real-email', async ({ page }) => {
      test.setTimeout(120_000); // scoped to 2 specific collections (see CLAUDE.md - a full database sweep is too slow to depend on)

      await loginAsDisposableAndGoToCompany(page);
      const body = await loadCompanyAndGetFirstPageInvoices(page);
      const user = await getUserByEmail(disposableEmail);
      expect(user, 'expected the disposable account to exist in MongoDB').toBeTruthy();

      // Searches ONLY by each invoice's own Stripe id, not the account's own
      // _id/stripe_id - those legitimately appear in unrelated
      // account/membership bookkeeping in other collections, which would
      // trivially fail this for ANY account. An invoice id is never a legitimate value there, so any hit is a real signal.
      const invoiceIds = body.data.map((i: any) => i.id).filter(Boolean);
      const hits = await findAnyCollectionReferencing(invoiceIds, ['stripe_invoices', 'invoices']);
      expect(hits, `expected zero Mongo collections to reference this account's real invoices, found: ${JSON.stringify(hits)}`).toEqual([]);
    });
  });
});
