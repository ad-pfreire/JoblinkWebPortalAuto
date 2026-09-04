// spec: specs/payments-test-plan.md
// seed: tests/seed.spec.ts

import { test, expect, Page, devices } from '@playwright/test';
import { requireEnv } from './utils/env';
import { getVerificationLink } from './utils/email';
import { generateUniqueEmailAlias, generateUsernameFromEmail, registerNewAccount, completeProfile } from './utils/account';
import { stripeFindCustomerByEmail, stripeListCardPaymentMethods } from './utils/stripe';

const BASE_URL = requireEnv('BASE_URL');

let disposableUsername: string;
let disposablePassword: string;
let disposableEmail: string;

/** Logs in with the disposable account from `beforeAll` and lands on /company. */
async function loginAsDisposableAndGoToCompany(page: Page) {
  await page.goto(`${BASE_URL}/login`);
  await page.locator('input[name="username"]').fill(disposableUsername);
  await page.locator('input[name="password"]').fill(disposablePassword);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });
  await page.goto(`${BASE_URL}/company`);
}

/** Scopes to the real Payments card on /company, not its hidden mobile-accordion duplicate. */
function paymentsSummaryCard(page: Page) {
  return page.locator('.MuiCard-root').filter({ has: page.getByRole('link', { name: 'Manage Payments' }) });
}

/** Resolves an ambiguous `iframe[title="..."]` selector to the one candidate containing `expectedFieldName`, polling until it mounts (see CLAUDE.md's Stripe iframe-swap gotcha). */
async function resolveStripeFrameByContent(page: Page, iframeTitle: string, expectedFieldName: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastCandidateCount = 0;
  while (Date.now() < deadline) {
    const candidates = page.locator(`iframe[title="${iframeTitle}"]`);
    lastCandidateCount = await candidates.count();
    for (let i = 0; i < lastCandidateCount; i++) {
      const candidate = candidates.nth(i);
      // A candidate can detach between count() and getAttribute() if Stripe swaps it mid-check.
      try {
        if ((await candidate.contentFrame().getByRole('textbox', { name: expectedFieldName }).count()) > 0) {
          const frameName = await candidate.getAttribute('name');
          return page.frameLocator(`iframe[name="${frameName}"]`);
        }
      } catch {
        // Fall through to the next poll iteration.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `No iframe titled "${iframeTitle}" (out of ${lastCandidateCount} candidate(s)) contained a "${expectedFieldName}" textbox within ${timeoutMs}ms.`
  );
}

/** Resolves the Billing Address iframe (probes 'Full name'), also waiting for Address line 1's id to attach (CI-only mount gap, see CLAUDE.md). */
async function billingAddressFrame(page: Page) {
  const frame = await resolveStripeFrameByContent(page, 'Secure address input frame', 'Full name');
  await frame.locator('#billingAddress-addressLine1Input').waitFor({ state: 'attached', timeout: 15_000 });
  return frame;
}

/** Resolves the Card CardElement iframe, probing for 'Card number'. */
async function cardElementFrame(page: Page) {
  return resolveStripeFrameByContent(page, 'Secure payment input frame', 'Card number');
}

/** Scopes to the 'Rewards & Balances' card - `.last()` picks the innermost of several nested containing ancestors. */
function rewardsBalancesCard(page: Page) {
  return page
    .locator('div')
    .filter({ has: page.getByRole('heading', { name: 'Rewards & Balances' }) })
    .filter({ has: page.getByRole('button', { name: 'Redeem Coupon' }) })
    .last();
}

/** Records requests to the app's own host, excluding Stripe/`_rsc=`/favicon noise, to prove a click fires zero network activity. */
function trackAppRequests(page: Page): string[] {
  const appHostname = new URL(BASE_URL).hostname;
  const requests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.hostname === appHostname && !url.searchParams.has('_rsc') && url.pathname !== '/favicon.ico') {
      requests.push(request.url());
    }
  });
  return requests;
}

/** Fills a valid test payment method and checks 'Save payment details' - real keystrokes, frames re-resolved per field (see CLAUDE.md). */
async function fillValidPaymentMethodForm(page: Page) {
  // Stays on the default country (Ecuador) instead of United States, whose
  // Google Places autocomplete is separately flaky under automation.
  await (await billingAddressFrame(page)).getByRole('textbox', { name: 'Full name' }).pressSequentially('QA Payments Test');
  await (await billingAddressFrame(page)).getByRole('textbox', { name: 'Address line 1' }).pressSequentially('123 Main Street');
  await (await billingAddressFrame(page)).locator('#billingAddress-localityInput').pressSequentially('Quito');
  await (await billingAddressFrame(page)).locator('#billingAddress-postalCodeInput').pressSequentially('170150');

  await (await cardElementFrame(page)).getByRole('textbox', { name: 'Card number' }).pressSequentially('4242424242424242');
  await (await cardElementFrame(page)).getByRole('textbox', { name: 'Expiration date' }).pressSequentially('1234');
  await (await cardElementFrame(page)).getByRole('textbox', { name: 'Security code' }).pressSequentially('123');

  const saveCheckbox = (await cardElementFrame(page)).getByRole('checkbox', { name: 'Save payment details for future purchases' });
  await saveCheckbox.click();
  // Occasionally needs a second click to register as checked (see CLAUDE.md's Stripe Elements gotcha).
  if (!(await saveCheckbox.isChecked())) {
    await saveCheckbox.click();
  }
  await expect(saveCheckbox).toBeChecked();
}

/** Fills a valid payment method and saves it, waiting for the real post-save redirect to /company. */
async function saveValidPaymentMethodAndWaitForCompany(page: Page) {
  await fillValidPaymentMethodForm(page);
  const updateButton = page.getByRole('button', { name: 'Update Payment Method' });
  await expect(updateButton).toBeEnabled();
  await updateButton.click();
  await expect(page).toHaveURL(`${BASE_URL}/company`, { timeout: 20_000 });
}

/** Same as `fillValidPaymentMethodForm()` but leaves the checkbox unchecked and Postal code overridable (used by 4.2/4.6). */
async function fillBillingAndCardFieldsWithoutCheckbox(
  page: Page,
  { postalCode = '170150', city = 'Quito', fullName = 'QA Payments Test' }: { postalCode?: string; city?: string; fullName?: string } = {}
) {
  if (fullName) {
    await (await billingAddressFrame(page)).getByRole('textbox', { name: 'Full name' }).pressSequentially(fullName);
  }
  await (await billingAddressFrame(page)).getByRole('textbox', { name: 'Address line 1' }).pressSequentially('123 Main Street');
  if (city) {
    await (await billingAddressFrame(page)).locator('#billingAddress-localityInput').pressSequentially(city);
  }
  if (postalCode) {
    await (await billingAddressFrame(page)).locator('#billingAddress-postalCodeInput').pressSequentially(postalCode);
  }

  await (await cardElementFrame(page)).getByRole('textbox', { name: 'Card number' }).pressSequentially('4242424242424242');
  await (await cardElementFrame(page)).getByRole('textbox', { name: 'Expiration date' }).pressSequentially('1234');
  await (await cardElementFrame(page)).getByRole('textbox', { name: 'Security code' }).pressSequentially('123');
}

/** Checks 'Save payment details', extracted separately so 4.2 can assert the button's disabled state beforehand. */
async function checkSavePaymentDetailsCheckbox(page: Page) {
  const saveCheckbox = (await cardElementFrame(page)).getByRole('checkbox', { name: 'Save payment details for future purchases' });
  await saveCheckbox.click();
  if (!(await saveCheckbox.isChecked())) {
    await saveCheckbox.click();
  }
  await expect(saveCheckbox).toBeChecked();
}

/** Counts data rows in 'Payment History' (0 when empty) - this account permanently has a real invoice, so tests compare before/after, not a literal empty state. */
async function paymentHistoryRowCount(page: Page): Promise<number> {
  const grid = page.getByRole('grid');
  if ((await grid.count()) === 0) return 0;
  return (await grid.getByRole('row').count()) - 1; // minus the header row
}

// Serial + chromium-only: avoids racing parallel browser projects/workers on
// the one disposable company's Payments state built up sequentially across
// this file (a saved card, then a real active subscription in Suite 6).
test.describe('Payments', () => {
  // retries: 2 - real external dependencies (Google Places, email delivery
  // in beforeAll) can occasionally exceed generous timeouts, blocking the whole serial file otherwise.
  test.describe.configure({ mode: 'serial', retries: 2 });

  // Registers ONE disposable account here, then runs every scenario serially
  // against that one throwaway company (see CLAUDE.md's account-isolation pattern).
  test.beforeAll(async ({ browser, browserName }) => {
    // A beforeEach-level skip doesn't gate beforeAll (see CLAUDE.md) - guarded here too.
    test.skip(
      browserName !== 'chromium',
      'Disposable single-company state built up sequentially across this file; runs once serially on chromium to avoid cross-project races, redundant registrations, and extra real-email load on the other 2 projects.'
    );

    test.setTimeout(300_000);

    // browser.newPage() drops this project's device context options, which
    // breaks real email delivery (see CLAUDE.md) - use newContext() instead.
    const context = await browser.newContext({ ...devices['Desktop Chrome'] });
    const page = await context.newPage();
    const emailAlias = generateUniqueEmailAlias();
    disposableUsername = generateUsernameFromEmail(emailAlias);
    disposablePassword = requireEnv('TEST_REGISTER_PASSWORD');
    disposableEmail = emailAlias;
    const registeredAt = new Date();

    await registerNewAccount(page, emailAlias);

    const verificationLink = await getVerificationLink(emailAlias, registeredAt, 240_000);
    await page.goto(verificationLink);
    await expect(page).toHaveURL(`${BASE_URL}/login`);

    await page.locator('input[name="username"]').fill(disposableUsername);
    await page.locator('input[name="password"]').fill(disposablePassword);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(`${BASE_URL}/complete-profile`);
    await completeProfile(page);
    await expect(page).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });

    await context.close();
  });

  test.beforeEach(async ({ page, browserName }) => {
    test.skip(
      browserName !== 'chromium',
      'Disposable single-company state built up sequentially across this file; runs once serially on chromium to avoid cross-project races and redundant registrations.'
    );
    await loginAsDisposableAndGoToCompany(page);
  });

  test.describe('Payments — Summary Card (/company)', () => {
    test("1.1 Fresh company shows 'No Payment Method' on the summary card with a working 'Manage Payments' link to /payments @real-email", async ({
      page,
    }) => {
      // 1. Start from a fresh company that has never had a payment method (done by beforeEach).
      const card = paymentsSummaryCard(page);

      // A 'Payments' card appears after Company Details, Logo Upload, and
      // Integrations - checked via DOM order, since cards can render
      // side-by-side at the same y-coordinate in this responsive grid.
      const cardTitles = (await page.locator('.MuiCardHeader-title, [class*="CardHeader-title"]').allTextContents()).map((t) => t.trim());
      const paymentsIndex = cardTitles.indexOf('Payments');
      expect(paymentsIndex).toBeGreaterThan(cardTitles.indexOf('Company Details'));
      expect(paymentsIndex).toBeGreaterThan(cardTitles.indexOf('Logo Upload'));
      expect(paymentsIndex).toBeGreaterThan(cardTitles.indexOf('Integrations'));

      // Heading reads exactly 'No Payment Method', with exactly one h6 on
      // the card (no masked card/expiry pair alongside it).
      await expect(card.getByRole('heading', { name: 'No Payment Method', exact: true })).toBeVisible();
      await expect(card.getByRole('heading', { level: 6 })).toHaveCount(1);

      // A 'Manage Payments' link is visible and enabled below it.
      const manageLink = card.getByRole('link', { name: 'Manage Payments' });
      await expect(manageLink).toBeVisible();
      await expect(manageLink).toBeEnabled();

      // 2. Inspect the 'Manage Payments' link's underlying href.
      await expect(manageLink).toHaveAttribute('href', '/payments');

      // 3. Click 'Manage Payments'.
      await manageLink.click();

      // The browser navigates to /payments and the page renders the full
      // Payments page (heading visible).
      await expect(page).toHaveURL(`${BASE_URL}/payments`);
      await expect(page.getByRole('heading', { name: 'No Payment Method', exact: true })).toBeVisible();
      await expect(page.getByText('Billing Address', { exact: true })).toBeVisible();
    });

    test("1.2 After a payment method is saved, the summary card's masked card and expiry exactly match /payments' 'Current Payment Method' block @real-email", async ({
      page,
    }) => {
      // Real, multi-iframe Stripe Elements interaction plus a genuine
      // SetupIntent confirmation - exceeds the default 30s test timeout.
      test.slow();

      // 1. Save a valid payment method and land back on /company (the real post-save redirect).
      await page.goto(`${BASE_URL}/payments`);
      await saveValidPaymentMethodAndWaitForCompany(page);

      const card = paymentsSummaryCard(page);
      const cardHeadings = card.getByRole('heading', { level: 6 });
      await expect(cardHeadings).toHaveCount(2);

      // Masked card shows '**** **** **** 4242' and expiry '12/2034', with no 'No Payment Method' text left.
      await expect(card.getByRole('heading', { name: '**** **** **** 4242', exact: true })).toBeVisible();
      await expect(card.getByRole('heading', { name: '12/2034', exact: true })).toBeVisible();
      await expect(card.getByText('No Payment Method')).toHaveCount(0);

      const manageLink = card.getByRole('link', { name: 'Manage Payments' });
      await expect(manageLink).toBeVisible();
      await expect(manageLink).toHaveAttribute('href', '/payments');

      const companyCardNumber = (await cardHeadings.nth(0).textContent())?.trim();
      const companyExpiry = (await cardHeadings.nth(1).textContent())?.trim();

      // 2. Navigate to /payments and inspect the 'Current Payment Method' block.
      await page.goto(`${BASE_URL}/payments`);
      await expect(page.getByRole('heading', { name: 'Current Payment Method', exact: true })).toBeVisible();

      // Re-queries the exact strings captured on /company above, rather than
      // a second hardcoded literal, so this proves equality, not a coincidence.
      await expect(page.getByRole('heading', { name: companyCardNumber!, exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: companyExpiry!, exact: true })).toBeVisible();
    });
  });

  test.describe('Payments — Page Structure, Empty State, and Country-Dependent Form Behavior', () => {
    test('2.1 /payments page structure inventory on a company with no payment method @real-email', async ({ page }) => {
      // 1. Test 1.2 left a payment method saved - delete it first so this
      // test genuinely exercises the empty-state structure (and every later
      // test in this describe also finds the account empty).
      await page.goto(`${BASE_URL}/payments`);
      const deleteButton = page.getByRole('button', { name: 'Delete Payment Method', exact: true });
      // Waits for either heading to settle first - deleteButton.isVisible()
      // alone doesn't auto-retry and can momentarily report false right after goto().
      await expect(page.getByRole('heading', { name: /No Payment Method|Current Payment Method/ })).toBeVisible();
      if (await deleteButton.isVisible()) {
        await deleteButton.click();
        await expect(page.getByRole('heading', { name: 'Remove Payment Method' })).toBeVisible();
        await page.getByRole('button', { name: 'Yes, remove' }).click();
      }

      // No 'Current Payment Method' block or 'Delete Payment Method' button anywhere on the page.
      await expect(page.getByRole('heading', { name: 'No Payment Method', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Current Payment Method', exact: true })).toHaveCount(0);
      await expect(deleteButton).toHaveCount(0);

      const rewardsCard = rewardsBalancesCard(page);
      await expect(rewardsCard.getByRole('heading', { name: 'Rewards & Balances' })).toBeVisible();
      await expect(rewardsCard.getByRole('textbox', { name: 'Coupon Code' })).toBeVisible();
      await expect(rewardsCard.getByRole('button', { name: 'Redeem Coupon' })).toBeVisible();

      // Billing Address renders in a Stripe-hosted iframe (AddressElement).
      await expect(page.getByText('Billing Address', { exact: true })).toBeVisible();
      const addressFrame = await billingAddressFrame(page);
      await expect(addressFrame.getByRole('textbox', { name: 'Full name' })).toBeVisible();
      await expect(addressFrame.getByRole('combobox', { name: 'Country or region' })).toBeVisible();
      await expect(addressFrame.getByRole('textbox', { name: 'Address line 1' })).toBeVisible();
      await expect(addressFrame.getByPlaceholder('Apt., suite, unit number, etc. (optional)')).toBeVisible();
      await expect(addressFrame.getByText('Postal code', { exact: true })).toBeVisible();
      await expect(addressFrame.getByText('City', { exact: true })).toBeVisible();

      // Card renders in a SEPARATE iframe (CardElement).
      const paymentFrame = await cardElementFrame(page);
      await expect(paymentFrame.getByText('Card', { exact: true })).toBeVisible();
      await expect(paymentFrame.getByRole('textbox', { name: 'Card number' })).toBeVisible();
      await expect(paymentFrame.getByRole('textbox', { name: 'Expiration date' })).toBeVisible();
      await expect(paymentFrame.getByRole('textbox', { name: 'Security code' })).toBeVisible();
      await expect(paymentFrame.getByRole('checkbox', { name: 'Save payment details for future purchases' })).toBeVisible();
      await expect(paymentFrame.getByText(/^By providing your card information, you allow/)).toBeVisible();

      // 'Update Payment Method' is DISABLED by default on a pristine, empty form.
      const updateButton = page.getByRole('button', { name: 'Update Payment Method' });
      await expect(updateButton).toBeVisible();
      await expect(updateButton).toBeDisabled();

      // Tab title is the bare 'Job Link', unlike /company's 'Company | Job Link'.
      await expect(page).toHaveTitle('Job Link');

      // 2. Only Coupon Code + Redeem Coupon, no balance figure - read via innerText(), not textContent() (see CLAUDE.md).
      expect(await rewardsCard.innerText()).toBe('Rewards & Balances\nRedeem Coupon');
    });

    test("2.2 Country defaults to 'Ecuador' on every fresh page load, with a plain (non-autocomplete) Address field and no State/Province field at that default @real-email", async ({
      page,
    }) => {
      // 1. On a fresh /payments load, before touching the Country dropdown.
      await page.goto(`${BASE_URL}/payments`);
      const addressFrame = await billingAddressFrame(page);

      // Pre-selected to 'Ecuador' - checked via the <select>'s value ('EC'), not the visible label text.
      await expect(addressFrame.getByRole('combobox', { name: 'Country or region' })).toHaveValue('EC');

      // At this default: 'Address line 1' is a PLAIN textbox (not combobox),
      // postal field reads 'Postal code' (not 'ZIP code'), no State/Province field.
      await expect(addressFrame.getByRole('textbox', { name: 'Address line 1' })).toBeVisible();
      await expect(addressFrame.getByRole('combobox', { name: 'Address', exact: true })).toHaveCount(0);
      await expect(addressFrame.getByText('Postal code', { exact: true })).toBeVisible();
      await expect(addressFrame.getByText('ZIP code', { exact: true })).toHaveCount(0);
      await expect(addressFrame.getByText('State', { exact: true })).toHaveCount(0);
      await expect(addressFrame.getByText('Province', { exact: true })).toHaveCount(0);
    });

    test("2.3 Selecting 'United States' reshapes the Billing Address form: Address becomes an autocomplete combobox, adds a 'State' dropdown, and relabels 'Postal code' to 'ZIP code' @real-email", async ({
      page,
    }) => {
      // 1. Select 'United States' - never types into Address nor waits for
      // Google Places (separately flaky), since this only checks Stripe's own re-render.
      await page.goto(`${BASE_URL}/payments`);
      const addressFrame = await billingAddressFrame(page);
      await addressFrame.getByRole('combobox', { name: 'Country or region' }).selectOption('United States');

      // 'Address line 1' becomes an autocomplete combobox (accessible name 'Address').
      await expect(addressFrame.getByRole('combobox', { name: 'Address', exact: true })).toBeVisible();
      await expect(addressFrame.getByRole('textbox', { name: 'Address line 1' })).toHaveCount(0);

      // A 'State' dropdown appears alongside City and ZIP code.
      await expect(addressFrame.getByText('State', { exact: true })).toBeVisible();

      // Postal field's label changes from 'Postal code' to 'ZIP code'.
      await expect(addressFrame.getByText('Postal code', { exact: true })).toHaveCount(0);

      await expect(addressFrame.getByPlaceholder('Apt., suite, unit number, etc. (optional)')).toBeVisible();
      await expect(addressFrame.getByText('City', { exact: true })).toBeVisible();
    });

    test("2.4 Selecting 'Canada' reshapes the form differently from United States: adds a 'Province' dropdown (not 'State') and does NOT relabel the postal field @real-email", async ({
      page,
    }) => {
      // 1. On a fresh /payments load, select 'Canada' from the 'Country or
      // region' dropdown.
      await page.goto(`${BASE_URL}/payments`);
      const addressFrame = await billingAddressFrame(page);
      await addressFrame.getByRole('combobox', { name: 'Country or region' }).selectOption('Canada');

      // 'Address line 1' also becomes an autocomplete combobox (same as
      // US), and a region dropdown appears labeled 'Province', not 'State'.
      await expect(addressFrame.getByRole('combobox', { name: 'Address', exact: true })).toBeVisible();
      await expect(addressFrame.getByText('Province', { exact: true })).toBeVisible();
      await expect(addressFrame.getByText('State', { exact: true })).toHaveCount(0);

      // Unlike selecting United States, the postal field's label stays
      // exactly 'Postal code' - it is NOT relabeled to 'ZIP code'.
      await expect(addressFrame.getByText('Postal code', { exact: true })).toBeVisible();
      await expect(addressFrame.getByText('ZIP code', { exact: true })).toHaveCount(0);
    });

    test("2.5 Selecting 'France' shows an autocomplete Address field but NO state/province field at all @real-email", async ({ page }) => {
      // 1. On a fresh /payments load, select 'France' from the 'Country or
      // region' dropdown.
      await page.goto(`${BASE_URL}/payments`);
      const addressFrame = await billingAddressFrame(page);
      await addressFrame.getByRole('combobox', { name: 'Country or region' }).selectOption('France');

      // 'Address line 1' becomes an autocomplete combobox (same pattern as
      // US/Canada).
      await expect(addressFrame.getByRole('combobox', { name: 'Address', exact: true })).toBeVisible();

      // NO state/province/region dropdown of any kind appears for France
      // (France has no such concept in Stripe's AddressElement config here).
      await expect(addressFrame.getByText('State', { exact: true })).toHaveCount(0);
      await expect(addressFrame.getByText('Province', { exact: true })).toHaveCount(0);

      // The postal field remains labeled 'Postal code'.
      await expect(addressFrame.getByText('Postal code', { exact: true })).toBeVisible();
    });

    test('2.6 Auth guard: accessing /payments directly while logged out redirects to /login with a redirectUrl, and logging in from that state lands back on /payments @real-email', async ({
      page,
    }) => {
      // 1. Log out via the account menu.
      await page.getByRole('button', { name: 'account of current user' }).click();
      await page.getByRole('menuitem', { name: 'Log Out' }).click();
      await expect(page).toHaveURL(`${BASE_URL}/login`);

      // 2. Navigate directly to /payments while logged out - redirects to
      // /login with the original destination URL-encoded into redirectUrl.
      await page.goto(`${BASE_URL}/payments`);
      await expect(page).toHaveURL(`${BASE_URL}/login?redirectUrl=${encodeURIComponent(`${BASE_URL}/payments`)}`);

      // 3. Log in - lands directly on /payments (the originally-requested page), not /company.
      await page.locator('input[name="username"]').fill(disposableUsername);
      await page.locator('input[name="password"]').fill(disposablePassword);
      await page.locator('button[type="submit"]').click();
      await expect(page).toHaveURL(`${BASE_URL}/payments`, { timeout: 15_000 });
    });
  });

  // Skipped: 'Redeem Coupon' is planned to be wired up in the next release,
  // at which point these 4 no-op tests need to be rewritten entirely as real
  // success/error-path coverage (see the TODO on 3.4 below).
  test.describe.skip('Payments — Rewards & Balances / Coupon Code', () => {
    test("3.1 Entering a realistic-looking coupon code and clicking 'Redeem Coupon' fires zero network requests and shows no success/error message (expected — feature not yet enabled) @real-email", async ({
      page,
    }) => {
      // 1. Type a plausible coupon code and click 'Redeem Coupon' - not wired up yet, so this documents the no-op behavior.
      // Waits for the page's own create-setup-intent request first, so it
      // doesn't land inside the tracking window below (not networkidle - this page never goes fully idle).
      const setupIntentResponsePromise = page.waitForResponse((response) => response.url().includes('/api/create-setup-intent'));
      await page.goto(`${BASE_URL}/payments`);
      await setupIntentResponsePromise;
      const rewardsCard = rewardsBalancesCard(page);
      const couponInput = rewardsCard.getByRole('textbox', { name: 'Coupon Code' });
      const redeemButton = rewardsCard.getByRole('button', { name: 'Redeem Coupon' });

      const appRequests = trackAppRequests(page);
      await couponInput.fill('TESTCOUPON123');
      await redeemButton.click();

      // No success/error response exists to await for a not-yet-wired-up
      // feature, so a fixed wait gives a hypothetical async request a fair
      // chance to appear before asserting its absence.
      await page.waitForTimeout(2000);

      expect(appRequests).toEqual([]);

      // Asserted on TEXT, not count - getByRole('alert') also matches Next.js's route-announcer (see CLAUDE.md).
      await expect(page.getByRole('alert')).toHaveText('');

      await expect(couponInput).toHaveValue('TESTCOUPON123');
    });

    test('3.2 A whitespace-only Coupon Code value produces the identical no-op behavior @real-email', async ({ page }) => {
      // 1. Type only whitespace, then click 'Redeem Coupon' (see 3.1 for the setup-intent wait).
      const setupIntentResponsePromise = page.waitForResponse((response) => response.url().includes('/api/create-setup-intent'));
      await page.goto(`${BASE_URL}/payments`);
      await setupIntentResponsePromise;
      const rewardsCard = rewardsBalancesCard(page);
      const couponInput = rewardsCard.getByRole('textbox', { name: 'Coupon Code' });
      const redeemButton = rewardsCard.getByRole('button', { name: 'Redeem Coupon' });

      const appRequests = trackAppRequests(page);
      await couponInput.fill('   ');
      await redeemButton.click();
      await page.waitForTimeout(2000);

      // Identical to 3.1 - zero network requests, zero visible feedback.
      expect(appRequests).toEqual([]);
      await expect(page.getByRole('alert')).toHaveText('');
    });

    test('3.3 A very long Coupon Code value (128 characters) is accepted with no truncation, and still produces the same no-op behavior on click @real-email', async ({
      page,
    }) => {
      // 1. Type a 128-character repeating string (see 3.1 for the setup-intent wait).
      const setupIntentResponsePromise = page.waitForResponse((response) => response.url().includes('/api/create-setup-intent'));
      await page.goto(`${BASE_URL}/payments`);
      await setupIntentResponsePromise;
      const rewardsCard = rewardsBalancesCard(page);
      const couponInput = rewardsCard.getByRole('textbox', { name: 'Coupon Code' });
      const redeemButton = rewardsCard.getByRole('button', { name: 'Redeem Coupon' });

      const longValue = 'A'.repeat(128);
      await couponInput.fill(longValue);

      // Accepts the full 128 characters with no truncation or length-limit error.
      await expect(couponInput).toHaveValue(longValue);
      expect(await couponInput.inputValue()).toHaveLength(128);

      // 2. Click 'Redeem Coupon' with this long value still in place.
      const appRequests = trackAppRequests(page);
      await redeemButton.click();
      await page.waitForTimeout(2000);

      // Identical to 3.1 - zero network requests, zero visible feedback,
      // regardless of input length.
      expect(appRequests).toEqual([]);
      await expect(page.getByRole('alert')).toHaveText('');
    });

    test('3.4 KNOWN LIMITATION: Redeem Coupon is not enabled in this release, so its success/error paths cannot be tested yet @real-email', async ({
      page,
    }) => {
      // Consolidation test: the one untouched-field shape not covered by
      // 3.1-3.3. TODO once enabled: replace this and 3.1-3.3 with real success/error assertions.
      const setupIntentResponsePromise = page.waitForResponse((response) => response.url().includes('/api/create-setup-intent'));
      await page.goto(`${BASE_URL}/payments`);
      await setupIntentResponsePromise;
      const rewardsCard = rewardsBalancesCard(page);
      const couponInput = rewardsCard.getByRole('textbox', { name: 'Coupon Code' });
      const redeemButton = rewardsCard.getByRole('button', { name: 'Redeem Coupon' });

      // Confirm the field is genuinely untouched/empty before clicking.
      await expect(couponInput).toHaveValue('');

      const appRequests = trackAppRequests(page);
      await redeemButton.click();
      await page.waitForTimeout(2000);

      expect(appRequests).toEqual([]);
      await expect(page.getByRole('alert')).toHaveText('');
    });
  });

  test.describe('Payments — Card Form Validation and the Save Payment Details Checkbox Requirement', () => {
    test("4.1 Stripe's own real-time card validation shows specific inline error messages for incomplete/invalid Card fields @real-email", async ({
      page,
    }) => {
      // 1. Type an incomplete card number, blur into 'Expiration date'.
      // Re-resolves cardElementFrame(page) fresh each time - this test is
      // slow enough for Stripe to swap the iframe mid-test (see CLAUDE.md).
      test.slow();

      await page.goto(`${BASE_URL}/payments`);
      const cardNumberField = (await cardElementFrame(page)).getByRole('textbox', { name: 'Card number' });
      await cardNumberField.pressSequentially('4242');
      const expirationField = (await cardElementFrame(page)).getByRole('textbox', { name: 'Expiration date' });
      await expirationField.click();

      // An inline alert appears reading exactly 'Your card number is
      // incomplete.' directly beneath the Card Number field.
      await expect((await cardElementFrame(page)).getByText('Your card number is incomplete.', { exact: true })).toBeVisible();

      // 2. Type an already-expired date directly into 'Expiration (MM/YY)'
      // (e.g. '0120' for 01/20).
      await (await cardElementFrame(page)).getByRole('textbox', { name: 'Expiration date' }).pressSequentially('0120');

      // An inline alert appears reading exactly "Your card's expiration
      // year is in the past." - Stripe renders this with a real curly
      // apostrophe (U+2019), not a straight one, matched exactly here.
      await expect((await cardElementFrame(page)).getByText('Your card’s expiration year is in the past.', { exact: true })).toBeVisible();

      // 3. Type a single-digit value into 'Security code' (e.g. '1') and
      // blur the field.
      await (await cardElementFrame(page)).getByRole('textbox', { name: 'Security code' }).pressSequentially('1');
      await (await cardElementFrame(page)).getByText('Card', { exact: true }).click();

      // Reads exactly 'Your security code is incomplete.' - genuinely omits "card's", unlike the other two alerts' wording.
      await expect((await cardElementFrame(page)).getByText('Your security code is incomplete.', { exact: true })).toBeVisible();

      // With all three fields simultaneously invalid, confirm the 'Update
      // Payment Method' button is disabled.
      await expect(page.getByRole('button', { name: 'Update Payment Method' })).toBeDisabled();
    });

    test("4.2 The 'Save payment details for future purchases' checkbox genuinely gates the 'Update Payment Method' button — clearing it alone disables the button even when every other field is valid @real-email", async ({
      page,
    }) => {
      // 1. Fill every field valid, leave the 'Save payment details' checkbox unchecked.
      await page.goto(`${BASE_URL}/payments`);
      await fillBillingAndCardFieldsWithoutCheckbox(page);
      const updateButton = page.getByRole('button', { name: 'Update Payment Method' });

      // Remains DISABLED - confirms this checkbox is functionally required, not cosmetic.
      await expect(updateButton).toBeDisabled();

      // 2. Check the checkbox.
      await checkSavePaymentDetailsCheckbox(page);
      await expect(updateButton).toBeEnabled();
    });

    test("4.3 NOTABLE INCONSISTENCY: unlike the checkbox, clearing 'Full Name' does NOT re-disable the 'Update Payment Method' button — the missing-field block only surfaces at submit-click time via Stripe's own client-side validation, with no API call made @real-email", async ({
      page,
    }) => {
      // 1. Leave Full Name blank from the start, rather than filling then
      // clearing it - sidesteps a real flakiness source where a mid-fill
      // iframe swap can mask the clear entirely (see CLAUDE.md).
      await page.goto(`${BASE_URL}/payments`);
      await fillBillingAndCardFieldsWithoutCheckbox(page, { fullName: '' });
      await checkSavePaymentDetailsCheckbox(page);
      const updateButton = page.getByRole('button', { name: 'Update Payment Method' });

      // ENABLED even with Full Name empty - no inline 'required' error, unlike Card fields' real-time validation in 4.1.
      await expect(updateButton).toBeEnabled();
      // Stripe.js needs a moment to settle after the checkbox click, or submitting shows no validation at all.
      await page.waitForTimeout(1_000);

      // 2. Click 'Update Payment Method' with Full Name still empty.
      const appRequests = trackAppRequests(page);
      await updateButton.click();

      // Blocked - alert reads exactly 'Please provide your full name.' (`.first()`, see CLAUDE.md's alert gotcha).
      await expect(page.getByText('Please provide your full name.', { exact: true }).first()).toBeVisible({ timeout: 10_000 });

      // The block is purely client-side (Stripe.js) validation - no API request is sent.
      expect(appRequests).toEqual([]);
      await expect(page).toHaveURL(`${BASE_URL}/payments`);
    });

    test('4.4 The same button-stays-enabled-but-blocks-on-submit pattern generalizes to other Address fields (spot-checked with City) @real-email', async ({
      page,
    }) => {
      // 1. Fill every field EXCEPT 'City', leaving it blank from the start (see 4.3 for why).
      await page.goto(`${BASE_URL}/payments`);
      await fillBillingAndCardFieldsWithoutCheckbox(page, { city: '' });
      await checkSavePaymentDetailsCheckbox(page);
      const updateButton = page.getByRole('button', { name: 'Update Payment Method' });

      // ENABLED with City empty - confirms 4.3's finding generalizes across the AddressElement's text fields.
      await expect(updateButton).toBeEnabled();
      await page.waitForTimeout(1_000); // settle wait, see 4.3

      // 2. Click 'Update Payment Method' with City still empty.
      await updateButton.click();

      // Blocked with a page-level alert reading exactly 'This field is incomplete.'; stays on /payments.
      await expect(page.getByText('This field is incomplete.', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
      await expect(page).toHaveURL(`${BASE_URL}/payments`);
    });

    test("4.5 No client-side maximum length is enforced on 'Full Name', at least up to 298 characters @real-email", async ({ page }) => {
      // 1. Type a 298-character value into 'Full Name'.
      await page.goto(`${BASE_URL}/payments`);
      const addressFrame = await billingAddressFrame(page);
      const fullNameField = addressFrame.getByRole('textbox', { name: 'Full name' });
      const longName = 'A'.repeat(298);
      await fullNameField.pressSequentially(longName);

      // Accepted with no truncation.
      await expect(fullNameField).toHaveValue(longName);
      expect(await fullNameField.inputValue()).toHaveLength(298);
    });

    test("4.6 EXCEPTION to the 4.3/4.4 pattern: 'Postal code' is genuinely NOT a required field — a submission with it blank succeeds outright, with no blocking validation of any kind @real-email", async ({
      page,
    }) => {
      // Real Stripe SetupIntent confirmation - exceeds the default 30s timeout.
      test.slow();

      // 1. Fill everything valid except leave 'Postal code' empty, then submit.
      await page.goto(`${BASE_URL}/payments`);
      await fillBillingAndCardFieldsWithoutCheckbox(page, { postalCode: '' });
      await checkSavePaymentDetailsCheckbox(page);

      const updateButton = page.getByRole('button', { name: 'Update Payment Method' });
      await expect(updateButton).toBeEnabled();
      await updateButton.click();

      // Unlike Full Name (4.3) or City (4.4), a blank Postal code does NOT
      // block submission - redirects to /company and saves normally. Leaves
      // the account with a saved payment method (not cleaned up; 4.7 doesn't depend on it).
      await expect(page).toHaveURL(`${BASE_URL}/company`, { timeout: 20_000 });
      const card = paymentsSummaryCard(page);
      await expect(card.getByRole('heading', { name: '**** **** **** 4242', exact: true })).toBeVisible();
      await expect(card.getByText('No Payment Method')).toHaveCount(0);
    });

    test("4.7 A very long value in 'Address line 1' (257 characters) does not visually overflow or break the Billing Address form's layout @real-email", async ({
      page,
    }) => {
      // 1. Type a 257-character value into 'Address line 1' and inspect the
      // field and surrounding form.
      await page.goto(`${BASE_URL}/payments`);
      const addressFrame = await billingAddressFrame(page);
      const addressField = addressFrame.getByRole('textbox', { name: 'Address line 1' });
      const longAddress = '1'.repeat(257);
      await addressField.pressSequentially(longAddress);
      await expect(addressField).toHaveValue(longAddress);

      // scrollWidth exceeds clientWidth - the input scrolls its text horizontally, standard native behavior.
      const { scrollWidth, clientWidth } = await addressField.evaluate((el: HTMLInputElement) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }));
      expect(scrollWidth).toBeGreaterThan(clientWidth);

      // But there is NO overflow at the page level.
      const { bodyScrollWidth, bodyClientWidth } = await page.evaluate(() => ({
        bodyScrollWidth: document.body.scrollWidth,
        bodyClientWidth: document.body.clientWidth,
      }));
      expect(bodyScrollWidth).toBe(bodyClientWidth);
    });
  });

  test.describe('Payments — Successful Save, Decline, and 3D Secure Flows', () => {
    test('5.1 A fully valid submission (test card 4242, valid address, checkbox checked) redirects to /company, updates the summary card, and leaves Payment History unchanged — persisting across a real reload @real-email', async ({
      page,
    }) => {
      test.slow(); // real Stripe Elements + SetupIntent round-trip, same as test 1.2

      // 1. Start from a clean slate - 4.6 may have left a payment method saved, delete it first.
      await page.goto(`${BASE_URL}/payments`);
      const deleteButton = page.getByRole('button', { name: 'Delete Payment Method', exact: true });
      await expect(page.getByRole('heading', { name: /No Payment Method|Current Payment Method/ })).toBeVisible();
      if (await deleteButton.isVisible()) {
        await deleteButton.click();
        await expect(page.getByRole('heading', { name: 'Remove Payment Method' })).toBeVisible();
        await page.getByRole('button', { name: 'Yes, remove' }).click();
        await expect(page.getByRole('heading', { name: 'No Payment Method', exact: true })).toBeVisible();
      }

      // Capture Payment History's row count before this save, compared to
      // itself after (see paymentHistoryRowCount()'s own comment).
      await page.goto(`${BASE_URL}/company`);
      const paymentHistoryRowsBefore = await paymentHistoryRowCount(page);

      // Save a valid payment method (test card 4242...).
      await page.goto(`${BASE_URL}/payments`);
      await saveValidPaymentMethodAndWaitForCompany(page);

      // Redirects to /company; summary card shows '**** **** **** 4242' / '12/2034'.
      const card = paymentsSummaryCard(page);
      await expect(card.getByRole('heading', { name: '**** **** **** 4242', exact: true })).toBeVisible();
      await expect(card.getByRole('heading', { name: '12/2034', exact: true })).toBeVisible();
      await expect(card.getByText('No Payment Method')).toHaveCount(0);

      // 2. Payment History shows the SAME row count as before - a SetupIntent save adds no history entry.
      expect(await paymentHistoryRowCount(page)).toBe(paymentHistoryRowsBefore);

      // 3. /payments' 'Current Payment Method' block matches the /company summary card.
      await page.goto(`${BASE_URL}/payments`);
      await expect(page.getByRole('heading', { name: 'Current Payment Method', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: '**** **** **** 4242', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: '12/2034', exact: true })).toBeVisible();

      // 4. Perform a genuine full-page reload of /payments (via
      // page.goto(), not a soft client-side refresh).
      await page.goto(`${BASE_URL}/payments`);

      // The same masked card and expiry are still shown after this real
      // reload - confirms the value is read fresh from the backend on
      // load, not just held in client-side state from the earlier save.
      await expect(page.getByRole('heading', { name: 'Current Payment Method', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: '**** **** **** 4242', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: '12/2034', exact: true })).toBeVisible();
    });

    test('5.2 Decline flow (test card 4000 0000 0000 0002) shows three simultaneous error surfaces and leaves the form editable for immediate retry @real-email', async ({
      page,
    }) => {
      test.slow(); // real Stripe decline round-trip, slower than a successful confirm

      // 1. Fill the form fully valid except Card Number '4000000000000002' (generic decline).
      await page.goto(`${BASE_URL}/payments`);
      await (await billingAddressFrame(page)).getByRole('textbox', { name: 'Full name' }).pressSequentially('QA Payments Decline');
      await (await billingAddressFrame(page)).getByRole('textbox', { name: 'Address line 1' }).pressSequentially('123 Main Street');
      await (await billingAddressFrame(page)).locator('#billingAddress-localityInput').pressSequentially('Quito');
      await (await billingAddressFrame(page)).locator('#billingAddress-postalCodeInput').pressSequentially('170150');
      await (await cardElementFrame(page)).getByRole('textbox', { name: 'Card number' }).pressSequentially('4000000000000002');
      await (await cardElementFrame(page)).getByRole('textbox', { name: 'Expiration date' }).pressSequentially('1234');
      await (await cardElementFrame(page)).getByRole('textbox', { name: 'Security code' }).pressSequentially('123');
      await checkSavePaymentDetailsCheckbox(page);

      const updateButton = page.getByRole('button', { name: 'Update Payment Method' });
      await expect(updateButton).toBeEnabled();
      await updateButton.click();

      // Page-level alert reads exactly 'Your card has been declined.' (`.first()` for the hidden duplicate-render pattern).
      await expect(page.getByText('Your card has been declined.', { exact: true }).first()).toBeVisible({ timeout: 15_000 });

      // A separate inline alert under Card Number reads 'Your card was
      // declined.' - different wording, confirming two genuinely separate error surfaces.
      await expect((await cardElementFrame(page)).getByText('Your card was declined.', { exact: true })).toBeVisible();

      // A dismissable toast also appears (identified by its 'Close' button).
      // Its real text matches the page-level alert ('...has been declined.'), not the inline alert's wording.
      const toast = page.getByRole('alert').filter({ has: page.getByRole('button', { name: 'Close' }) });
      await expect(toast).toBeVisible({ timeout: 15_000 });
      await expect(toast).toHaveText('Your card has been declined.');

      // Stays on /payments with all form values still populated and editable - retry without re-entering anything.
      await expect(page).toHaveURL(`${BASE_URL}/payments`);
      await expect((await billingAddressFrame(page)).getByRole('textbox', { name: 'Full name' })).toHaveValue('QA Payments Decline');
      await expect((await billingAddressFrame(page)).getByRole('textbox', { name: 'Address line 1' })).toHaveValue('123 Main Street');
      await expect((await billingAddressFrame(page)).locator('#billingAddress-localityInput')).toHaveValue('Quito');
      await expect((await cardElementFrame(page)).getByRole('textbox', { name: 'Card number' })).toHaveValue('4000 0000 0000 0002');
    });

    test('5.3 Incorrect-CVC decline (test card 4000 0000 0000 0127) surfaces a CVC-SPECIFIC error message, distinct from the generic decline message @real-email', async ({
      page,
    }) => {
      test.slow(); // same real decline round-trip budget as 5.2

      // 1. Fill the form fully valid except Card Number '4000000000000127' (incorrect-CVC decline).
      await page.goto(`${BASE_URL}/payments`);
      await (await billingAddressFrame(page)).getByRole('textbox', { name: 'Full name' }).pressSequentially('QA Payments CVC');
      await (await billingAddressFrame(page)).getByRole('textbox', { name: 'Address line 1' }).pressSequentially('123 Main Street');
      await (await billingAddressFrame(page)).locator('#billingAddress-localityInput').pressSequentially('Quito');
      await (await billingAddressFrame(page)).locator('#billingAddress-postalCodeInput').pressSequentially('170150');
      await (await cardElementFrame(page)).getByRole('textbox', { name: 'Card number' }).pressSequentially('4000000000000127');
      await (await cardElementFrame(page)).getByRole('textbox', { name: 'Expiration date' }).pressSequentially('1234');
      await (await cardElementFrame(page)).getByRole('textbox', { name: 'Security code' }).pressSequentially('123');
      await checkSavePaymentDetailsCheckbox(page);

      const updateButton = page.getByRole('button', { name: 'Update Payment Method' });
      await expect(updateButton).toBeEnabled();
      await updateButton.click();

      // Page-level alert reads exactly "Your card's CVC is incorrect." (curly
      // apostrophe) - NOT 5.2's generic decline text, confirming Stripe surfaces decline-reason-specific errors.
      await expect(page.getByText('Your card’s CVC is incorrect.', { exact: true }).first()).toBeVisible({ timeout: 15_000 });

      // Inline alert under Security code reads "Your card's security code is incorrect."
      await expect((await cardElementFrame(page)).getByText('Your card’s security code is incorrect.', { exact: true })).toBeVisible();

      await expect(page).toHaveURL(`${BASE_URL}/payments`);
      await expect((await cardElementFrame(page)).getByRole('textbox', { name: 'Card number' })).toHaveValue('4000 0000 0000 0127');
    });

    test('5.4 3D Secure authentication flow (test card 4000 0025 0000 3155) shows a real Stripe-hosted challenge modal, and completing it successfully saves the card @real-email', async ({
      page,
    }) => {
      test.slow(); // 3D Secure round-trip + SetupIntent confirmation - the slowest flow in this file

      // 1. Fill the form fully valid using Card Number '4000002500003155' (any future expiry/CVC).
      await page.goto(`${BASE_URL}/payments`);
      await (await billingAddressFrame(page)).getByRole('textbox', { name: 'Full name' }).pressSequentially('QA Payments 3DS');
      await (await billingAddressFrame(page)).getByRole('textbox', { name: 'Address line 1' }).pressSequentially('123 Main Street');
      await (await billingAddressFrame(page)).locator('#billingAddress-localityInput').pressSequentially('Quito');
      await (await billingAddressFrame(page)).locator('#billingAddress-postalCodeInput').pressSequentially('170150');
      await (await cardElementFrame(page)).getByRole('textbox', { name: 'Card number' }).pressSequentially('4000002500003155');
      await (await cardElementFrame(page)).getByRole('textbox', { name: 'Expiration date' }).pressSequentially('1234');
      await (await cardElementFrame(page)).getByRole('textbox', { name: 'Security code' }).pressSequentially('123');
      await checkSavePaymentDetailsCheckbox(page);

      const updateButton = page.getByRole('button', { name: 'Update Payment Method' });
      await expect(updateButton).toBeEnabled();
      await updateButton.click();

      // Button shows a loading spinner and disables while the SetupIntent/3DS challenge is in flight.
      await expect(updateButton).toBeDisabled();
      await expect(updateButton.getByRole('progressbar')).toBeVisible();

      // A real Stripe-hosted modal appears in nested iframes: an outer one
      // keyed by its stable `src`, wrapping an inner one keyed by its stable `name`.
      const challengeFrame = page.frameLocator('iframe[src*="three-ds-2-challenge"]').frameLocator('iframe[name="stripe-challenge-frame"]');
      await expect(challengeFrame.getByRole('heading', { name: '3D Secure 2 Test Page' })).toBeVisible({ timeout: 20_000 });
      await expect(challengeFrame.getByRole('button', { name: 'Fail' })).toBeVisible();
      await expect(challengeFrame.getByRole('button', { name: 'Complete' })).toBeVisible();
      // The outer dialog's 'Cancel' control renders as a real <button>, not an <a> link.
      await expect(page.frameLocator('iframe[src*="three-ds-2-challenge"]').getByRole('button', { name: 'Cancel' })).toBeVisible();

      // The 'Complete'/'Fail' buttons render before the challenge page's own
      // JS finishes wiring up their click handler - a click fired too early
      // silently no-ops (see CLAUDE.md's 3D Secure gotcha).
      await page.waitForTimeout(2_000);

      // 2. Click 'Complete' inside the 3D Secure modal.
      await challengeFrame.getByRole('button', { name: 'Complete' }).click();

      // Navigates to /company like 5.1's non-3DS flow, but after a real 3DS
      // round-trip completes - a more generous budget than a plain save.
      await expect(page).toHaveURL(`${BASE_URL}/company`, { timeout: 45_000 });

      const card = paymentsSummaryCard(page);
      await expect(card.getByRole('heading', { name: '**** **** **** 3155', exact: true })).toBeVisible();
      await expect(card.getByRole('heading', { name: '12/2034', exact: true })).toBeVisible();
    });
  });

  test.describe('Payments — Replacing and Deleting a Payment Method', () => {
    test("6.1 With a payment method already saved, the Billing Address/Card form still renders below 'Current Payment Method' and starts blank (does not prefill the previously-saved billing address) @real-email", async ({
      page,
    }) => {
      test.slow(); // reads 9 fields across 2 Stripe iframes, each resolved fresh - adds up close to the default 30s timeout

      // 1. Reload /payments (Suite 5 left a saved 3D Secure test card, '...3155').
      await page.goto(`${BASE_URL}/payments`);

      await expect(page.getByRole('heading', { name: 'Current Payment Method', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: '**** **** **** 3155', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: '12/2034', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Delete Payment Method', exact: true })).toBeVisible();

      // The form below is COMPLETELY blank, not prefilled from the saved card (this is how the user replaces it, see 6.2).
      // Reads by Stripe's own stable element `id`, not getByRole(name) -
      // City/Postal code's accessible name isn't reliably attached yet on a fast read (see CLAUDE.md).
      await expect((await billingAddressFrame(page)).locator('#billingAddress-nameInput')).toHaveValue('');
      // Resets to the widget's 'Ecuador' default, not whatever country was used for the saved card.
      await expect((await billingAddressFrame(page)).locator('#billingAddress-countryInput')).toHaveValue('EC');
      await expect((await billingAddressFrame(page)).locator('#billingAddress-addressLine1Input')).toHaveValue('');
      await expect((await billingAddressFrame(page)).locator('#billingAddress-localityInput')).toHaveValue('');
      await expect((await billingAddressFrame(page)).locator('#billingAddress-postalCodeInput')).toHaveValue('');

      await expect((await cardElementFrame(page)).getByRole('textbox', { name: 'Card number' })).toHaveValue('');
      await expect((await cardElementFrame(page)).getByRole('textbox', { name: 'Expiration date' })).toHaveValue('');
      await expect((await cardElementFrame(page)).getByRole('textbox', { name: 'Security code' })).toHaveValue('');
      await expect(
        (await cardElementFrame(page)).getByRole('checkbox', { name: 'Save payment details for future purchases' })
      ).not.toBeChecked();

      await expect(page.getByRole('button', { name: 'Update Payment Method' })).toBeDisabled();
    });

    test("6.2 Submitting this still-visible form with a different card, without clicking 'Delete Payment Method' first, replaces the existing payment method — expected behavior of the 'Update Payment Method' button @real-email", async ({
      page,
    }) => {
      test.slow(); // real SetupIntent confirmation round-trip, same budget concern as every save in this file

      // 1. WITHOUT clicking 'Delete Payment Method', fill the still-visible
      // form with a DIFFERENT test card (Mastercard '5555 5555 5555 4444').
      await page.goto(`${BASE_URL}/payments`);
      await (await billingAddressFrame(page)).getByRole('textbox', { name: 'Full name' }).pressSequentially('QA Payments Replace');
      await (await billingAddressFrame(page)).getByRole('textbox', { name: 'Address line 1' }).pressSequentially('456 Second Avenue');
      await (await billingAddressFrame(page)).locator('#billingAddress-localityInput').pressSequentially('Quito');
      await (await billingAddressFrame(page)).locator('#billingAddress-postalCodeInput').pressSequentially('170150');
      await (await cardElementFrame(page)).getByRole('textbox', { name: 'Card number' }).pressSequentially('5555555555554444');
      await (await cardElementFrame(page)).getByRole('textbox', { name: 'Expiration date' }).pressSequentially('1234');
      await (await cardElementFrame(page)).getByRole('textbox', { name: 'Security code' }).pressSequentially('123');
      await checkSavePaymentDetailsCheckbox(page);

      const updateButton = page.getByRole('button', { name: 'Update Payment Method' });
      await expect(updateButton).toBeEnabled();
      await updateButton.click();

      // No confirmation dialog appears - redirects straight to /company like
      // a first-time save (intended: the button's own label already is the
      // confirmation, unlike 'Delete Payment Method' in 6.3 below).
      await expect(page).toHaveURL(`${BASE_URL}/company`, { timeout: 20_000 });

      // Both /company and /payments show the NEW card ('...4444') - the OLD one ('...3155') is fully replaced.
      const card = paymentsSummaryCard(page);
      await expect(card.getByRole('heading', { name: '**** **** **** 4444', exact: true })).toBeVisible();
      await expect(card.getByText('**** **** **** 3155')).toHaveCount(0);

      await page.goto(`${BASE_URL}/payments`);
      await expect(page.getByRole('heading', { name: '**** **** **** 4444', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: '**** **** **** 3155' })).toHaveCount(0);
    });

    test("6.3 'Delete Payment Method' opens a confirmation dialog with specific copy, and 'No, go back' cancels cleanly without deleting anything (no active subscription case) @real-email", async ({
      page,
    }) => {
      // 1. With a payment method saved (6.2's '...4444') and no active subscription, click 'Delete Payment Method'.
      await page.goto(`${BASE_URL}/payments`);
      const deleteButton = page.getByRole('button', { name: 'Delete Payment Method', exact: true });
      await expect(deleteButton).toBeVisible();

      // Captured here to re-query after cancelling below, proving a genuine no-op.
      const cardBefore = await page.getByRole('heading', { name: /^\*{4} \*{4} \*{4} \d{4}$/ }).textContent();
      const expiryBefore = await page.getByRole('heading', { name: /^\d{1,2}\/\d{4}$/ }).textContent();

      await deleteButton.click();

      // Titled exactly 'Remove Payment Method' - not the 'Cancel
      // Subscription' variant from 6.6, since there's no active subscription yet.
      await expect(page.getByRole('heading', { name: 'Remove Payment Method', exact: true })).toBeVisible();
      await expect(page.getByText("You're about to remove your saved payment method.", { exact: true })).toBeVisible();
      await expect(
        page.getByText("This will not cancel any subscription, since you don't currently have an active one.", { exact: true })
      ).toBeVisible();
      await expect(
        page.getByText("If you choose to subscribe in the future, you'll need to add a payment method again.", { exact: true })
      ).toBeVisible();
      await expect(page.getByText('Reach out to Job Link support for more information.', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'No, go back' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Yes, remove' })).toBeVisible();

      // 2. Click 'No, go back'.
      await page.getByRole('button', { name: 'No, go back' }).click();

      // The dialog closes.
      await expect(page.getByRole('heading', { name: 'Remove Payment Method' })).toHaveCount(0);

      // Re-reads the same masked card/expiry - a true cancel/no-op, not a partial or delayed deletion.
      await expect(page.getByRole('heading', { name: cardBefore!, exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: expiryBefore!, exact: true })).toBeVisible();
    });

    test("6.4 Confirming deletion ('Yes, remove') removes the payment method and correctly reverts both /payments and the /company summary card to 'No Payment Method' @real-email", async ({
      page,
    }) => {
      // Compares Payment History's row count to itself before/after - a payment-method deletion isn't a billing event.
      await page.goto(`${BASE_URL}/company`);
      const paymentHistoryRowsBefore = await paymentHistoryRowCount(page);

      // 1. On /payments, click 'Delete Payment Method' again, then click
      // 'Yes, remove' in the confirmation dialog.
      await page.goto(`${BASE_URL}/payments`);
      await page.getByRole('button', { name: 'Delete Payment Method', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Remove Payment Method', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Yes, remove' }).click();

      // No manual reload needed - shows 'No Payment Method' and the 'Current Payment Method' block is gone.
      await expect(page.getByRole('heading', { name: 'No Payment Method', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Current Payment Method', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Delete Payment Method', exact: true })).toHaveCount(0);

      // 2. Navigate to /company and inspect the Payments summary card.
      await page.goto(`${BASE_URL}/company`);
      const card = paymentsSummaryCard(page);
      await expect(card.getByRole('heading', { name: 'No Payment Method', exact: true })).toBeVisible();
      // No masked card/expiry heading pair left on the card - matching the
      // same single-heading empty-state check test 1.1 above uses.
      await expect(card.getByRole('heading', { level: 6 })).toHaveCount(1);

      // Payment History remains completely unaffected by the deletion (as
      // expected - a payment-method deletion isn't a billing event either).
      expect(await paymentHistoryRowCount(page)).toBe(paymentHistoryRowsBefore);
    });

    test('6.5 Submitting the exact same card (same number, expiry, CVC) as the currently-saved one is accepted silently, and never leaves a duplicate Stripe PaymentMethod behind @real-email', async ({
      page,
    }) => {
      // Two real SetupIntent confirmation + backend save round-trips back
      // to back, plus two real Stripe API calls - comfortably exceeds the
      // default 30s test timeout budget on a slow-but-not-broken run.
      test.slow();

      // 1. Save a valid payment method first (test card 4242 4242 4242
      // 4242, via the same helper used throughout this file).
      await page.goto(`${BASE_URL}/payments`);
      await saveValidPaymentMethodAndWaitForCompany(page);
      const card = paymentsSummaryCard(page);
      await expect(card.getByRole('heading', { name: '**** **** **** 4242', exact: true })).toBeVisible();

      // The UI only ever shows one 'current' card, so it can't tell 'no
      // duplicate was created' apart from 'a duplicate exists but only the
      // newest is displayed' - ask Stripe directly instead (see CLAUDE.md).
      const stripeCustomerId = await stripeFindCustomerByEmail(disposableEmail);
      const methodsBefore = await stripeListCardPaymentMethods(stripeCustomerId);

      // 2. WITHOUT deleting, resubmit the still-visible form with the SAME card and check the checkbox again.
      await page.goto(`${BASE_URL}/payments`);
      await fillValidPaymentMethodForm(page);

      const updateButton = page.getByRole('button', { name: 'Update Payment Method' });
      await expect(updateButton).toBeEnabled();
      await updateButton.click();

      // No 'already your saved payment method' warning - accepted like any other save, redirects to /company.
      await expect(page).toHaveURL(`${BASE_URL}/company`, { timeout: 20_000 });

      // Both /company and /payments show the SAME masked card ('...4242') as before.
      await expect(card.getByRole('heading', { name: '**** **** **** 4242', exact: true })).toBeVisible();
      await page.goto(`${BASE_URL}/payments`);
      await expect(page.getByRole('heading', { name: '**** **** **** 4242', exact: true })).toBeVisible();

      // What the UI can't answer: ask Stripe directly how many PaymentMethod objects this customer has.
      const methodsAfter = await stripeListCardPaymentMethods(stripeCustomerId);
      test.info().annotations.push({
        type: '6.5 Stripe PaymentMethod count',
        description: `before: ${methodsBefore.length} (${methodsBefore.map((m) => m.id).join(', ')}), after: ${methodsAfter.length} (${methodsAfter.map((m) => m.id).join(', ')})`,
      });

      // Not a no-op under the hood: creates a genuinely new PaymentMethod (same fingerprint) but detaches the old one.
      expect(methodsAfter).toHaveLength(methodsBefore.length);
      expect(methodsAfter[0].id).not.toBe(methodsBefore[0].id);
    });

    test("6.6 With a real active PAID subscription, the button relabels to 'Delete Payment Method & Cancel Subscription' and opens a differently-titled 'Cancel Subscription' dialog instead of 'Remove Payment Method' @real-email", async ({
      page,
    }) => {
      test.slow(); // real Stripe Checkout round-trip - the slowest, most external-dependency-heavy flow in this file

      // 1. Purchase 'Job Link Pro' via /subscription's real Stripe Checkout -
      // a separately-hosted page, so plain fill() works fine here.
      await page.goto(`${BASE_URL}/subscription`);
      await page.getByRole('heading', { name: 'Job Link Pro', exact: true }).click();
      const continueButton = page.getByRole('button', { name: 'Continue' });
      await expect(continueButton).toBeEnabled();
      await continueButton.click();

      // 'Review Purchase' confirmation dialog appears before any charge occurs.
      await expect(page.getByRole('heading', { name: 'Review Purchase' })).toBeVisible();
      await page.getByRole('button', { name: 'Confirm and Pay' }).click();

      // Navigates to Stripe's real, externally-hosted Checkout page.
      await expect(page).toHaveURL(/checkout\.stripe\.com/, { timeout: 30_000 });

      // Fill an email address only if Checkout is asking for one and it
      // isn't already pre-filled from the account.
      const emailField = page.getByLabel('Email');
      if ((await emailField.count()) > 0 && !(await emailField.inputValue())) {
        await emailField.fill(`${disposableUsername}@example.com`);
      }

      // Fill card details only if Checkout is showing a blank card-entry
      // form (rather than reusing an already-known saved card/Link account
      // for this email).
      const cardNumberField = page.getByPlaceholder('Card number');
      if ((await cardNumberField.count()) > 0) {
        await cardNumberField.fill('4242424242424242');
        await page.getByPlaceholder('MM / YY').fill('12/34');
        await page.getByPlaceholder('CVC').fill('123');
      }

      await page.getByRole('button', { name: /Subscribe|Pay/ }).click();

      // Activates in test/sandbox mode, no real charge - redirects back to '/subscription?success=true'.
      await expect(page).toHaveURL(/\/subscription\?success=true/, { timeout: 45_000 });
      await expect(page.getByText('Your subscription has been successfully activated!', { exact: true })).toBeVisible();
      // One sentence pair in a single text node - an exact match on just the
      // plan-name clause never matches; anchored regex handles the dynamic date.
      await expect(
        page.getByText(
          /^You are currently subscribed to the Job Link Pro \(Monthly\) plan\. Your next subscription will be billed on .+\.$/
        )
      ).toBeVisible();

      // 2. Navigate to /payments - the button now reads 'Delete Payment
      // Method & Cancel Subscription' instead of plain 'Delete Payment Method'.
      await page.goto(`${BASE_URL}/payments`);
      const deleteAndCancelButton = page.getByRole('button', { name: 'Delete Payment Method & Cancel Subscription', exact: true });
      await expect(deleteAndCancelButton).toBeVisible();
      await expect(deleteAndCancelButton).toBeEnabled();
      await expect(page.getByRole('button', { name: 'Delete Payment Method', exact: true })).toHaveCount(0);

      // 3. Click 'Delete Payment Method & Cancel Subscription'.
      await deleteAndCancelButton.click();

      // Titled exactly 'Cancel Subscription' - not 'Remove Payment Method'
      // like 6.3's no-subscription case. First bullet's date is matched via
      // regex since it depends on when this test runs.
      await expect(page.getByRole('heading', { name: 'Cancel Subscription', exact: true })).toBeVisible();
      await expect(
        page.getByText(
          "Removing your payment method will cancel your Job Link subscription. Click 'Finish Cancellation' below to cancel your subscription.",
          { exact: true }
        )
      ).toBeVisible();
      await expect(page.getByText(/^Cancellation will be effective at the end of your current billing period as of .+\.$/)).toBeVisible();
      await expect(
        page.getByText(
          'Continue to use all the powerful features of your subscription until cancellation is effective on the date above.',
          { exact: true }
        )
      ).toBeVisible();
      await expect(page.getByText('Restart your subscription anytime.', { exact: true })).toBeVisible();
      await expect(page.getByText('Reach out to Job Link support for more information.', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'No, go back' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Finish Cancellation' })).toBeVisible();
    });

    test("6.7 Confirming 'Finish Cancellation' removes the payment method immediately but schedules the subscription to cancel at period end, not immediately @real-email", async ({
      page,
    }) => {
      test.slow(); // real payment-method removal + subscription-cancellation round-trip

      // 1. Reopens the 'Cancel Subscription' dialog itself rather than
      // assuming 6.6 left it open - beforeEach resets to /company before
      // every test (see CLAUDE.md), and 6.6 only inspected the dialog.
      await page.goto(`${BASE_URL}/payments`);
      await page.getByRole('button', { name: 'Delete Payment Method & Cancel Subscription', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Cancel Subscription', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Finish Cancellation' }).click();

      // Payment method IS removed right away, no manual reload needed.
      await expect(page.getByRole('heading', { name: 'No Payment Method', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Current Payment Method' })).toHaveCount(0);

      // 2. /subscription still shows the plan active - 'Currently
      // Subscribed!' plus 'Resume Subscription' instead of 'Cancel Subscription'.
      await page.goto(`${BASE_URL}/subscription`);
      await expect(
        page.getByText(
          /^You are currently on the Job Link Pro \(Monthly\) plan\. You will lose these features on .+ unless you resubscribe\.$/
        )
      ).toBeVisible();
      await expect(page.getByText('Currently Subscribed!', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Resume Subscription', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Cancel Subscription', exact: true })).toHaveCount(0);

      // Confirms 6.6's promise: cancellation takes effect at period end, not
      // immediately, and the user retains a path to resume before then.
    });
  });
});
