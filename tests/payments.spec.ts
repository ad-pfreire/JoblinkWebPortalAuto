// spec: specs/payments-test-plan.md
// seed: tests/seed.spec.ts

import { test, expect, Page, devices } from '@playwright/test';
import { requireEnv } from './utils/env';
import { getVerificationLink } from './utils/email';
import { generateUniqueEmailAlias, generateUsernameFromEmail, registerNewAccount, completeProfile } from './utils/account';

const BASE_URL = requireEnv('BASE_URL');

let disposableUsername: string;
let disposablePassword: string;

// Logs in with the one disposable account registered once in beforeAll below
// and lands on /company - the default first tab after login. Mirrors
// loginAsSeedAndGoToCompany() in company-details.spec.ts/logo-upload.spec.ts,
// just against a disposable account's credentials instead of the shared seed
// account's.
async function loginAsDisposableAndGoToCompany(page: Page) {
  await page.goto(`${BASE_URL}/login`);
  await page.locator('input[name="username"]').fill(disposableUsername);
  await page.locator('input[name="password"]').fill(disposablePassword);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });
  await page.goto(`${BASE_URL}/company`);
}

async function loginAsDisposableAndGoToPayments(page: Page) {
  await loginAsDisposableAndGoToCompany(page);
  await page.goto(`${BASE_URL}/payments`);
}

// The "Payments" heading text appears TWICE in the DOM on /company - the
// same hidden mobile-accordion duplicate pattern already documented on
// companyDetailsCard()/logoUploadCard() in
// tests/company-details.spec.ts/tests/logo-upload.spec.ts (live-verified via
// direct DOM inspection while writing this file). Scoping every locator
// below to this specific card (identified by containing the 'Manage
// Payments' link, live-verified to be unique on the page) avoids
// strict-mode ambiguity against that hidden duplicate.
function paymentsSummaryCard(page: Page) {
  return page.locator('.MuiCard-root').filter({ has: page.getByRole('link', { name: 'Manage Payments' }) });
}

// Resolves an ambiguous `iframe[title="..."]` CSS selector to the ONE
// candidate that actually contains the given expected field, rather than
// guessing via DOM order or attribute heuristics. Needed because Stripe
// mounts more than one iframe sharing the exact same `title` text on this
// page, non-deterministically and for more than one independent reason
// (live-verified while writing this file): a hidden
// "elements-inner-autocomplete-suggestions" accessory frame, and a separate
// "Link" (saved-payment/WebAuthn autofill) accessory frame - neither of
// which is reliably distinguishable from the real input frame by a fixed
// attribute (an `aria-hidden` exclusion alone still left Link's frame
// ambiguous; a further `allow*="publickey-credentials-get"` exclusion
// worked for a while but then excluded the genuinely real frame in a later
// run, since which of the two ends up carrying that permission was not
// actually stable). Checking each candidate for the one real, distinguishing
// fact - "does typing/reading actually work here" - is the only thing that
// held up under repeated live re-verification, so this is deliberately more
// defensive than a purely selector-based approach.
//
// Polls rather than checking once - Stripe injects these iframes
// asynchronously after page.goto() resolves, so an immediate zero-candidate
// count right after navigation doesn't mean the real frame will never
// arrive, just that it hasn't mounted YET (live-verified: an earlier
// one-shot version of this function threw "0 candidates" if called too soon
// after goto(), where a plain page.frameLocator(...)'s built-in auto-waiting
// would have simply kept retrying).
//
// Returns a FrameLocator scoped to this iframe's own `name` attribute, NOT
// `candidates.nth(i).contentFrame()` directly - live-verified this distinction
// matters: `nth(i)` is a live, POSITIONAL query that Playwright re-evaluates
// on every subsequent action performed through the returned FrameLocator, and
// the set of same-titled iframes on this page is NOT stable over a test's
// lifetime (Stripe's "Link" accessory iframe can mount/unmount as fields are
// filled). A test that types successfully into this frame once, then hangs
// (real 90s timeout, not a quick failure) typing into it again a moment
// later is this exact bug - by the second action, "index i" had silently
// started pointing at a different or no-longer-existent iframe. Each
// physical iframe's own `name` (unpredictable in VALUE, but STABLE for that
// specific mounted instance for the rest of the page's life) sidesteps this
// entirely.
async function resolveStripeFrameByContent(page: Page, iframeTitle: string, expectedFieldName: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastCandidateCount = 0;
  while (Date.now() < deadline) {
    const candidates = page.locator(`iframe[title="${iframeTitle}"]`);
    lastCandidateCount = await candidates.count();
    for (let i = 0; i < lastCandidateCount; i++) {
      const candidate = candidates.nth(i);
      // Wrapped in try/catch: this specific iframe can detach between the
      // count() check above resolving and this getAttribute() call, on the
      // rare occasion Stripe swaps it out for a new instance in that exact
      // window - falling through to the next poll iteration rather than
      // letting a transient detach fail the whole resolution.
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
  throw new Error(`No iframe titled "${iframeTitle}" (out of ${lastCandidateCount} candidate(s)) contained a "${expectedFieldName}" textbox within ${timeoutMs}ms.`);
}

// Locates the Billing Address Stripe AddressElement's iframe - see
// resolveStripeFrameByContent() above for why this can't just be a plain
// `page.frameLocator('iframe[title="..."]')`. 'Full name' is present on
// every country's variant of this form (unlike 'Address', whose role
// switches between textbox/combobox depending on the selected country), so
// it's a safe, always-present field to probe for.
async function billingAddressFrame(page: Page) {
  return resolveStripeFrameByContent(page, 'Secure address input frame', 'Full name');
}

// Same reasoning as billingAddressFrame() above, for the separate Card
// Stripe CardElement iframe.
async function cardElementFrame(page: Page) {
  return resolveStripeFrameByContent(page, 'Secure payment input frame', 'Card number');
}

// The 'Rewards & Balances' card sits inside several nested MuiBox-root
// ancestors (live-verified via direct DOM inspection while writing this
// suite - 4 separate ancestor elements all carry the `MuiBox-root` class and
// all structurally contain both the heading and the button). Filtering by
// `has:` for both the heading AND the button still matches every one of
// those ancestors, since containment is transitive - `.last()` picks the
// innermost/deepest match (the genuine card boundary, confirmed via
// `outerHTML` inspection to contain nothing but the heading, the Coupon Code
// input, and the Redeem Coupon button) rather than an oversized ancestor
// that also happens to contain both.
function rewardsBalancesCard(page: Page) {
  return page
    .locator('div')
    .filter({ has: page.getByRole('heading', { name: 'Rewards & Balances' }) })
    .filter({ has: page.getByRole('button', { name: 'Redeem Coupon' }) })
    .last();
}

// Registers a page.on('request') listener that records every request this
// page makes to the app's OWN host (deliberately excluding Stripe's
// api.stripe.com/js.stripe.com calls, which fire independently of anything
// the 'Rewards & Balances / Coupon Code' suite below does) - used there to
// prove a total ABSENCE of network activity for an action confirmed by the
// maintainer to be a client-side no-op in this release (Redeem Coupon is not
// enabled yet). A page.route()-based interception (as used elsewhere in this
// file's sibling logo-upload.spec.ts, for a different purpose) is the wrong
// tool for this specific assertion - there is deliberately nothing to
// intercept/fulfill here, this is a pure "did anything even try to fire"
// listener. Uses the request's own hostname (compared against BASE_URL's),
// not a hardcoded string, to stay portable across environments.
//
// Also excludes any URL carrying Next.js's own `_rsc=` query param - this
// app's Company/Teams tabs are Next.js <Link>s, and Next.js's App Router
// automatically fires a background React Server Component prefetch request
// for any such link visible in the viewport, entirely independent of
// anything a test does. Live-verified this can fire spontaneously at any
// point during a test's real, unrelated interactions (including the fixed
// wait these "zero network requests" checks use), intermittently polluting
// this listener with framework noise unrelated to the action under test -
// excluded here rather than at each call site since it applies universally
// to every use of this helper on this page.
function trackAppRequests(page: Page): string[] {
  const appHostname = new URL(BASE_URL).hostname;
  const requests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.hostname === appHostname && !url.searchParams.has('_rsc')) {
      requests.push(request.url());
    }
  });
  return requests;
}

// Fills the Billing Address (Stripe AddressElement) and Card (Stripe
// CardElement) iframes with a fully valid test payment method - test card
// 4242 4242 4242 4242, a future expiry (12/34), any 3-digit CVC, country
// United States, and placeholder Full Name/Address/City/State/ZIP values -
// then checks the 'Save payment details' checkbox. Per this project's
// documented Stripe Elements gotcha (see CLAUDE.md), every field is filled
// via real keystrokes (pressSequentially), not fill(), since fill() does not
// update Stripe's own internal per-field 'complete' tracking that the
// 'Update Payment Method' button's enabled state depends on.
async function fillValidPaymentMethodForm(page: Page) {
  // Deliberately does NOT select 'United States' (or any country at all) -
  // stays on the widget's own default ('Ecuador', per the plan's section
  // 2.2 finding), where 'Address line 1'/'City'/'Postal code' are plain text
  // fields with no Google Places autocomplete involved at all. This test
  // only needs *a* valid, saved payment method, not a specific country's
  // address shape (that reshaping behavior has its own dedicated coverage in
  // Suite 2), so this avoids depending on a live third-party API entirely -
  // live-verified during automation that selecting United States and typing
  // into the resulting Address autocomplete combobox intermittently never
  // showed a suggestions dropdown within a generous 20s wait under `npx
  // playwright test` (4 separate failures across repeated runs), even though
  // the identical sequence reliably returned real suggestions in under 3s
  // when driven interactively - genuine, hard-to-tame external flakiness
  // this simpler path sidesteps rather than chases.
  //
  // Each field below re-resolves billingAddressFrame(page)/cardElementFrame(page)
  // fresh, rather than capturing one addressFrame/paymentFrame up front and
  // reusing it for every field - live-verified this matters: Stripe can swap
  // either iframe out for a new instance partway through a slower sequence
  // of fills, and a reference captured once can silently go stale mid-way,
  // causing a real 30-90s hang on whichever field is typed into after the
  // swap (see resolveStripeFrameByContent()'s comment for the full story).
  await (await billingAddressFrame(page)).getByRole('textbox', { name: 'Full name' }).pressSequentially('QA Payments Test');
  await (await billingAddressFrame(page)).getByRole('textbox', { name: 'Address line 1' }).pressSequentially('123 Main Street');
  await (await billingAddressFrame(page)).getByRole('textbox', { name: 'City' }).pressSequentially('Quito');
  await (await billingAddressFrame(page)).getByRole('textbox', { name: 'Postal code' }).pressSequentially('170150');

  await (await cardElementFrame(page)).getByRole('textbox', { name: 'Card number' }).pressSequentially('4242424242424242');
  await (await cardElementFrame(page)).getByRole('textbox', { name: 'Expiration date' }).pressSequentially('1234');
  await (await cardElementFrame(page)).getByRole('textbox', { name: 'Security code' }).pressSequentially('123');

  const saveCheckbox = (await cardElementFrame(page)).getByRole('checkbox', { name: 'Save payment details for future purchases' });
  await saveCheckbox.click();
  // Live-verified (see CLAUDE.md's Stripe Elements gotcha): this checkbox
  // has occasionally required a second click to actually register as
  // checked - a real timing race with CardElement's own documented
  // 'auto-advance to next field' behavior, not something to assume always
  // lands on the first click.
  if (!(await saveCheckbox.isChecked())) {
    await saveCheckbox.click();
  }
  await expect(saveCheckbox).toBeChecked();
}

// Fills a fully valid payment method (see fillValidPaymentMethodForm()
// above) and clicks 'Update Payment Method', waiting for the genuine
// post-save redirect to /company (per the plan's section 5.1, a real Stripe
// SetupIntent confirmation + backend save round-trip, which can take a few
// seconds longer than this app's other saves) rather than any toast.
async function saveValidPaymentMethodAndWaitForCompany(page: Page) {
  await fillValidPaymentMethodForm(page);
  const updateButton = page.getByRole('button', { name: 'Update Payment Method' });
  await expect(updateButton).toBeEnabled();
  await updateButton.click();
  await expect(page).toHaveURL(`${BASE_URL}/company`, { timeout: 20_000 });
}

// Fills the same Billing Address/Card fields as fillValidPaymentMethodForm()
// above, with the same valid placeholder values, but deliberately does NOT
// touch the 'Save payment details' checkbox and allows Postal code to be
// overridden/omitted - neither of which fillValidPaymentMethodForm() can
// express, since it always checks the checkbox as its very last step and
// always fills Postal code. Used by 4.2 below (which needs to observe the
// 'Update Payment Method' button's disabled state BEFORE the checkbox is
// ever checked) and by 4.6 (which needs Postal code left genuinely blank).
async function fillBillingAndCardFieldsWithoutCheckbox(
  page: Page,
  { postalCode = '170150', city = 'Quito', fullName = 'QA Payments Test' }: { postalCode?: string; city?: string; fullName?: string } = {}
) {
  // See fillValidPaymentMethodForm() above for why each field re-resolves
  // billingAddressFrame(page)/cardElementFrame(page) fresh instead of
  // reusing one captured reference.
  if (fullName) {
    await (await billingAddressFrame(page)).getByRole('textbox', { name: 'Full name' }).pressSequentially(fullName);
  }
  await (await billingAddressFrame(page)).getByRole('textbox', { name: 'Address line 1' }).pressSequentially('123 Main Street');
  if (city) {
    await (await billingAddressFrame(page)).getByRole('textbox', { name: 'City' }).pressSequentially(city);
  }
  if (postalCode) {
    await (await billingAddressFrame(page)).getByRole('textbox', { name: 'Postal code' }).pressSequentially(postalCode);
  }

  await (await cardElementFrame(page)).getByRole('textbox', { name: 'Card number' }).pressSequentially('4242424242424242');
  await (await cardElementFrame(page)).getByRole('textbox', { name: 'Expiration date' }).pressSequentially('1234');
  await (await cardElementFrame(page)).getByRole('textbox', { name: 'Security code' }).pressSequentially('123');
}

// Checks the 'Save payment details for future purchases' checkbox on its
// own, applying the same live-verified second-click gotcha as
// fillValidPaymentMethodForm() above - extracted separately so 4.2 can
// assert the button's disabled state in the gap BEFORE this is called.
async function checkSavePaymentDetailsCheckbox(page: Page) {
  const saveCheckbox = (await cardElementFrame(page)).getByRole('checkbox', { name: 'Save payment details for future purchases' });
  await saveCheckbox.click();
  if (!(await saveCheckbox.isChecked())) {
    await saveCheckbox.click();
  }
  await expect(saveCheckbox).toBeChecked();
}

// Counts the number of DATA rows currently in the 'Payment History' table on
// /company - 0 when the table shows its 'No Payment History' empty state (no
// `grid`-role element is rendered at all in that case, live-verified via
// direct DOM inspection). Used by 5.1 below to capture a BEFORE/AFTER row
// count rather than asserting a literal 'No Payment History' text: the one
// disposable account this whole file shares permanently carries at least one
// real paid invoice (live-verified: a genuine Job Link Pro subscription
// purchase made against this SAME account while manually live-verifying this
// plan's section 6 scenarios, timestamped '8/17/2026, 6:40 PM' in the table)
// - a harmless, permanent side effect, same pattern already documented in
// CLAUDE.md for other areas' required-field side effects that can't be
// undone through the UI. Comparing the row count to itself before/after this
// test's own save is what genuinely proves a SetupIntent adds no new billing
// history entry, regardless of whatever the account's real starting state
// happens to be - the discover-don't-hardcode pattern this project's
// Portability section already documents for shared-account baselines.
async function paymentHistoryRowCount(page: Page): Promise<number> {
  const grid = page.getByRole('grid');
  if ((await grid.count()) === 0) return 0;
  return (await grid.getByRole('row').count()) - 1; // minus the header row
}

// Same trade-off already documented and applied in
// company-details.spec.ts/logo-upload.spec.ts/profile-settings.spec.ts:
// serial + chromium-only avoids racing parallel browser projects/workers on
// the one disposable company's Payments state built up sequentially across
// this file (a saved card, then a real active subscription in Suite 6).
test.describe('Payments', () => {
  // retries: 2 - matches company-details.spec.ts's own budget for the exact
  // same real external dependency (Google Places Autocomplete, used here by
  // Stripe's AddressElement), plus this file's beforeAll depends on real
  // Mandrill/SES email delivery via getVerificationLink() - both have been
  // live-verified to occasionally exceed generous timeouts (three
  // consecutive beforeAll runs while writing this file each exceeded a 240s
  // budget, and the Address autocomplete dropdown twice failed to appear
  // within 20s under `npx playwright test` despite the identical manual
  // sequence reliably returning results in under 3s when driven
  // interactively) - genuine external flakiness, not a bug. Without this,
  // one slow/empty response blocks every test in the file, not just the one
  // that hit it.
  test.describe.configure({ mode: 'serial', retries: 2 });

  // Payments does not touch the shared seed account: every self-registered
  // account gets its own fully isolated Company record (Payments, Payment
  // History, Subscription trial date), live-verified while writing
  // specs/payments-test-plan.md. Following the third account-isolation
  // pattern documented in CLAUDE.md's "Account/company isolation" section:
  // register ONE disposable account ONCE here, then run every scenario below
  // serially against that one throwaway company - avoids both risking real
  // state on the shared seed account (Company Details/Logo Upload/Profile
  // Settings' pattern) AND N redundant real email-verification round-trips
  // (account-registration.spec.ts/forgot-password.spec.ts's per-test pattern).
  test.beforeAll(async ({ browser }) => {
    // Generous budget - see the describe-level `retries: 2` comment above
    // for why this hook's own timeout is set well above
    // getVerificationLink's explicit budget rather than relying on the
    // default.
    test.setTimeout(300_000);

    // `browser.newPage()` alone creates a page in a bare default context,
    // WITHOUT this project's configured `devices['Desktop Chrome']` context
    // options (unlike the normal per-test `page` fixture, which does apply
    // them) - live-verified root cause of three consecutive real
    // registrations never receiving their verification email within a 240s
    // budget while writing this file, while the exact same registration flow
    // via the standard `page` fixture (account-registration.spec.ts's own
    // real-email test) delivered in ~35s every time it was run back-to-back
    // with these failures. A bare Chromium context's default user agent
    // string contains "HeadlessChrome", which some anti-abuse/WAF layer in
    // front of the real pre-staging registration endpoint appears to treat
    // differently (the account itself still gets created either way - only
    // the verification email was ever affected). Passing the same device
    // profile the project already uses elsewhere avoids the mismatch.
    const context = await browser.newContext({ ...devices['Desktop Chrome'] });
    const page = await context.newPage();
    const emailAlias = generateUniqueEmailAlias();
    disposableUsername = generateUsernameFromEmail(emailAlias);
    disposablePassword = requireEnv('TEST_REGISTER_PASSWORD');
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
    test("1.1 Fresh company shows 'No Payment Method' on the summary card with a working 'Manage Payments' link to /payments", async ({ page }) => {
      // 1. Log in with a fresh/disposable, profile-complete account whose
      // company has never had a payment method, and land on /company (done
      // by beforeEach) - this is the first test in this file to touch
      // Payments state, so the disposable account registered once in
      // beforeAll genuinely has never had a payment method saved yet.
      const card = paymentsSummaryCard(page);

      // A 'Payments' card is visible among the six cards on the page, after
      // Company Details, Logo Upload, and Integrations - checked via DOM
      // order, same reasoning as company-details.spec.ts test 1.1 (cards
      // can render side-by-side at the same y-coordinate in this app's
      // responsive grid, so DOM order is the reliable check, not position).
      const cardTitles = (await page.locator('.MuiCardHeader-title, [class*="CardHeader-title"]').allTextContents()).map((t) => t.trim());
      const paymentsIndex = cardTitles.indexOf('Payments');
      expect(paymentsIndex).toBeGreaterThan(cardTitles.indexOf('Company Details'));
      expect(paymentsIndex).toBeGreaterThan(cardTitles.indexOf('Logo Upload'));
      expect(paymentsIndex).toBeGreaterThan(cardTitles.indexOf('Integrations'));

      // On a company with no payment method, the card shows the heading
      // text exactly 'No Payment Method' - and, confirmed by there being
      // exactly one h6 on the card, no masked card/expiry heading pair
      // alongside it.
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

    test("1.2 After a payment method is saved, the summary card's masked card and expiry exactly match /payments' 'Current Payment Method' block", async ({ page }) => {
      // Real, multi-iframe Stripe Elements interaction (character-by-character
      // keystrokes across three separate iframes, per this project's Stripe
      // Elements gotcha) plus a genuine SetupIntent confirmation + backend
      // save round-trip - comfortably exceeds the default 30s test timeout
      // budget on a slow-but-not-broken run.
      test.slow();

      // 1. Save a valid payment method (test card 4242 4242 4242 4242,
      // future expiry 12/34, placeholder Full Name/Address/City/State/ZIP,
      // country United States) via /payments' Billing Address/Card form,
      // then land back on /company (the real post-save redirect) and
      // inspect the Payments summary card.
      await page.goto(`${BASE_URL}/payments`);
      await saveValidPaymentMethodAndWaitForCompany(page);

      const card = paymentsSummaryCard(page);
      const cardHeadings = card.getByRole('heading', { level: 6 });
      await expect(cardHeadings).toHaveCount(2);

      // The card shows a masked card number in the exact format
      // '**** **** **** 4242' (last 4 digits of the saved test card) and an
      // expiry heading in the exact format '12/2034' (MM/YYYY), with no
      // 'No Payment Method' text present anywhere on the card.
      await expect(card.getByRole('heading', { name: '**** **** **** 4242', exact: true })).toBeVisible();
      await expect(card.getByRole('heading', { name: '12/2034', exact: true })).toBeVisible();
      await expect(card.getByText('No Payment Method')).toHaveCount(0);

      // The 'Manage Payments' link is still present and points to
      // /payments.
      const manageLink = card.getByRole('link', { name: 'Manage Payments' });
      await expect(manageLink).toBeVisible();
      await expect(manageLink).toHaveAttribute('href', '/payments');

      const companyCardNumber = (await cardHeadings.nth(0).textContent())?.trim();
      const companyExpiry = (await cardHeadings.nth(1).textContent())?.trim();

      // 2. Navigate to /payments and inspect the 'Current Payment Method'
      // block at the top of the page.
      await page.goto(`${BASE_URL}/payments`);
      await expect(page.getByRole('heading', { name: 'Current Payment Method', exact: true })).toBeVisible();

      // The masked card number and expiry shown here are
      // character-for-character identical to what was shown on the
      // /company summary card in the previous step - asserted directly by
      // re-querying for the exact strings captured there (rather than a
      // second hardcoded literal), so this genuinely proves equality, not
      // just that both happen to match the same hardcoded expectation.
      await expect(page.getByRole('heading', { name: companyCardNumber!, exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: companyExpiry!, exact: true })).toBeVisible();
    });
  });

  test.describe('Payments — Page Structure, Empty State, and Country-Dependent Form Behavior', () => {
    test('2.1 /payments page structure inventory on a company with no payment method', async ({ page }) => {
      // 1. Navigate to /payments directly on a company with no payment
      // method saved. Test 1.2 above (this describe runs serially, sharing
      // one disposable company across every test in the file) left a
      // payment method saved - delete it first via the already-documented
      // 'Remove Payment Method' dialog (see specs/payments-test-plan.md
      // section 10/6.3) so this test genuinely exercises the empty-state
      // page structure, and so every later test in this describe also finds
      // the account in the empty state.
      await page.goto(`${BASE_URL}/payments`);
      const deleteButton = page.getByRole('button', { name: 'Delete Payment Method', exact: true });
      // `deleteButton.isVisible()` alone is a single immediate check with no
      // auto-retry, unlike `expect(...).toBeVisible()` - right after
      // `page.goto()`, the page can still be mid-render, so it can
      // momentarily report false for an account that genuinely DOES have a
      // saved payment method (live-verified: caused this test to skip the
      // delete step entirely and then fail below). Waiting for either
      // possible heading to settle first removes that race.
      await expect(page.getByRole('heading', { name: /No Payment Method|Current Payment Method/ })).toBeVisible();
      if (await deleteButton.isVisible()) {
        await deleteButton.click();
        await expect(page.getByRole('heading', { name: 'Remove Payment Method' })).toBeVisible();
        await page.getByRole('button', { name: 'Yes, remove' }).click();
      }

      // A heading reads exactly 'No Payment Method' at the top (no 'Current
      // Payment Method' block, no 'Delete Payment Method' button present
      // anywhere on the page).
      await expect(page.getByRole('heading', { name: 'No Payment Method', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Current Payment Method', exact: true })).toHaveCount(0);
      await expect(deleteButton).toHaveCount(0);

      // A 'Rewards & Balances' card is visible containing a 'Coupon Code'
      // textbox and a 'Redeem Coupon' button.
      const rewardsCard = rewardsBalancesCard(page);
      await expect(rewardsCard.getByRole('heading', { name: 'Rewards & Balances' })).toBeVisible();
      await expect(rewardsCard.getByRole('textbox', { name: 'Coupon Code' })).toBeVisible();
      await expect(rewardsCard.getByRole('button', { name: 'Redeem Coupon' })).toBeVisible();

      // A 'Billing Address' section is visible containing a Stripe-hosted
      // iframe (Stripe AddressElement) with 'Full name', 'Country or
      // region', and address fields.
      await expect(page.getByText('Billing Address', { exact: true })).toBeVisible();
      const addressFrame = await billingAddressFrame(page);
      await expect(addressFrame.getByRole('textbox', { name: 'Full name' })).toBeVisible();
      await expect(addressFrame.getByRole('combobox', { name: 'Country or region' })).toBeVisible();
      await expect(addressFrame.getByRole('textbox', { name: 'Address line 1' })).toBeVisible();
      await expect(addressFrame.getByPlaceholder('Apt., suite, unit number, etc. (optional)')).toBeVisible();
      await expect(addressFrame.getByText('Postal code', { exact: true })).toBeVisible();
      await expect(addressFrame.getByText('City', { exact: true })).toBeVisible();

      // A 'Card' section is visible in a SEPARATE iframe (Stripe
      // CardElement) with 'Card number', 'Expiration date'/'Expiration
      // (MM/YY)', 'Security code', and a 'Save payment details for future
      // purchases' checkbox, plus disclosure text beginning 'By providing
      // your card information, you allow...'.
      const paymentFrame = await cardElementFrame(page);
      await expect(paymentFrame.getByText('Card', { exact: true })).toBeVisible();
      await expect(paymentFrame.getByRole('textbox', { name: 'Card number' })).toBeVisible();
      await expect(paymentFrame.getByRole('textbox', { name: 'Expiration date' })).toBeVisible();
      await expect(paymentFrame.getByRole('textbox', { name: 'Security code' })).toBeVisible();
      await expect(paymentFrame.getByRole('checkbox', { name: 'Save payment details for future purchases' })).toBeVisible();
      await expect(paymentFrame.getByText(/^By providing your card information, you allow/)).toBeVisible();

      // An 'Update Payment Method' button is visible below both iframes and
      // is DISABLED by default on a pristine, empty form.
      const updateButton = page.getByRole('button', { name: 'Update Payment Method' });
      await expect(updateButton).toBeVisible();
      await expect(updateButton).toBeDisabled();

      // Live-verified minor note: the page's browser tab title is the bare
      // string 'Job Link', not e.g. 'Payments | Job Link' (unlike
      // /company's 'Company | Job Link').
      await expect(page).toHaveTitle('Job Link');

      // 2. Inspect the 'Rewards & Balances' card's contents in full.
      // Live-verified minor copy note: the card contains ONLY the Coupon
      // Code field and Redeem Coupon button - no balance, credit, or
      // rewards figure is displayed anywhere. Read via locator.innerText()
      // (not textContent()/toHaveText(), per this project's documented
      // innerText-vs-textContent gotcha): the heading and button live in
      // separate sibling containers with no literal whitespace between them
      // in the minified DOM, so toHaveText()'s textContent-based comparison
      // concatenates them with no separator at all ('Rewards &
      // BalancesRedeem Coupon', live-verified) - innerText is what genuinely
      // reflects the rendered line break a real user sees between them.
      expect(await rewardsCard.innerText()).toBe('Rewards & Balances\nRedeem Coupon');
    });

    test("2.2 Country defaults to 'Ecuador' on every fresh page load, with a plain (non-autocomplete) Address field and no State/Province field at that default", async ({ page }) => {
      // 1. On a fresh /payments load (before touching the Country
      // dropdown), inspect the Billing Address iframe's 'Country or
      // region' dropdown and the shape of the address fields below it.
      await page.goto(`${BASE_URL}/payments`);
      const addressFrame = await billingAddressFrame(page);

      // The dropdown is pre-selected to 'Ecuador' by default - checked via
      // the underlying <select>'s value ('EC', Ecuador's ISO 3166-1 alpha-2
      // code, live-verified via direct DOM inspection), a more robust check
      // than the visible option label text alone.
      await expect(addressFrame.getByRole('combobox', { name: 'Country or region' })).toHaveValue('EC');

      // At this default, 'Address line 1' renders as a PLAIN textbox (role
      // 'textbox', NOT 'combobox'), the postal field is labeled exactly
      // 'Postal code' (not 'ZIP code'), and NO State/Province field/label
      // is present at all.
      await expect(addressFrame.getByRole('textbox', { name: 'Address line 1' })).toBeVisible();
      await expect(addressFrame.getByRole('combobox', { name: 'Address', exact: true })).toHaveCount(0);
      await expect(addressFrame.getByText('Postal code', { exact: true })).toBeVisible();
      await expect(addressFrame.getByText('ZIP code', { exact: true })).toHaveCount(0);
      await expect(addressFrame.getByText('State', { exact: true })).toHaveCount(0);
      await expect(addressFrame.getByText('Province', { exact: true })).toHaveCount(0);
    });

    test("2.3 Selecting 'United States' reshapes the Billing Address form: Address becomes an autocomplete combobox, adds a 'State' dropdown, and relabels 'Postal code' to 'ZIP code'", async ({ page }) => {
      // 1. On a fresh /payments load, select 'United States' from the
      // 'Country or region' dropdown inside the Billing Address iframe -
      // deliberately never typing into the resulting Address combobox nor
      // waiting for any Google Places suggestions dropdown (per this file's
      // documented Google Places flakiness note); every expectation below
      // only depends on Stripe's own country-aware, 100%-client-side
      // AddressElement re-render, not on a live third-party API responding.
      await page.goto(`${BASE_URL}/payments`);
      const addressFrame = await billingAddressFrame(page);
      await addressFrame.getByRole('combobox', { name: 'Country or region' }).selectOption('United States');

      // 'Address line 1' becomes an autocomplete-style combobox (role
      // changes to 'combobox' with the accessible name 'Address').
      await expect(addressFrame.getByRole('combobox', { name: 'Address', exact: true })).toBeVisible();
      await expect(addressFrame.getByRole('textbox', { name: 'Address line 1' })).toHaveCount(0);

      // A new 'State' dropdown appears alongside City and ZIP code.
      // Live-verified: City and State actually render side-by-side on the
      // SAME row (identical boundingBox y-coordinate) in this responsive
      // layout, not strictly stacked - so this only asserts visibility, not
      // a specific geometric arrangement the plan's prose wasn't actually
      // making a hard claim about.
      await expect(addressFrame.getByText('State', { exact: true })).toBeVisible();

      // The postal field's label changes from 'Postal code' to 'ZIP code'.
      await expect(addressFrame.getByText('Postal code', { exact: true })).toHaveCount(0);

      // 'Address line 2' and 'City' fields remain present and unaffected.
      await expect(addressFrame.getByPlaceholder('Apt., suite, unit number, etc. (optional)')).toBeVisible();
      await expect(addressFrame.getByText('City', { exact: true })).toBeVisible();
    });

    test("2.4 Selecting 'Canada' reshapes the form differently from United States: adds a 'Province' dropdown (not 'State') and does NOT relabel the postal field", async ({ page }) => {
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

    test("2.5 Selecting 'France' shows an autocomplete Address field but NO state/province field at all", async ({ page }) => {
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

    test('2.6 Auth guard: accessing /payments directly while logged out redirects to /login with a redirectUrl, and logging in from that state lands back on /payments', async ({ page }) => {
      // 1. While logged in (done by beforeEach via
      // loginAsDisposableAndGoToCompany, landing on /company), log out via
      // the account menu (avatar button -> 'Log Out').
      await page.getByRole('button', { name: 'account of current user' }).click();
      await page.getByRole('menuitem', { name: 'Log Out' }).click();

      // The browser lands on /login.
      await expect(page).toHaveURL(`${BASE_URL}/login`);

      // 2. Attempt to navigate directly to
      // https://joblink-portal.prestg.fieldpiece.com/payments via a fresh
      // page.goto() while logged out.
      await page.goto(`${BASE_URL}/payments`);

      // The browser is redirected to
      // '/login?redirectUrl=https%3A%2F%2Fjoblink-portal.prestg.fieldpiece.com%2Fpayments'
      // (URL-encoded original destination).
      await expect(page).toHaveURL(`${BASE_URL}/login?redirectUrl=${encodeURIComponent(`${BASE_URL}/payments`)}`);

      // 3. Log in with valid credentials from this redirected login page.
      await page.locator('input[name="username"]').fill(disposableUsername);
      await page.locator('input[name="password"]').fill(disposablePassword);
      await page.locator('button[type="submit"]').click();

      // After a successful login, the browser lands directly on
      // '/payments' (the originally-requested page), not /company.
      await expect(page).toHaveURL(`${BASE_URL}/payments`, { timeout: 15_000 });
    });
  });

  test.describe('Payments — Rewards & Balances / Coupon Code', () => {
    test("3.1 Entering a realistic-looking coupon code and clicking 'Redeem Coupon' fires zero network requests and shows no success/error message (expected — feature not yet enabled)", async ({ page }) => {
      // 1. On /payments, type a plausible coupon code (e.g. 'TESTCOUPON123')
      // into the 'Coupon Code' field, then click 'Redeem Coupon'. Per the
      // maintainer (see specs/payments-test-plan.md section 3), Redeem
      // Coupon is confirmed NOT enabled yet in this release - this and the
      // next three tests document that current, correct, pre-release no-op
      // behavior rather than exercising a real success/error path.
      // Every /payments load fires its own POST /api/create-setup-intent
      // (per specs/payments-test-plan.md's preamble) independent of anything
      // this test does - waiting for that specific, expected response before
      // registering trackAppRequests() below avoids it intermittently
      // landing inside the tracking window (live-verified: registering the
      // listener right after a plain goto(), with only a couple of
      // synchronous locator lookups in between, isn't reliably enough time
      // for this async request to have already fired). Deliberately NOT
      // page.waitForLoadState('networkidle') - live-verified that hangs for
      // the full test timeout on this page, presumably some background
      // polling/beacon keeps the network from ever truly going idle; a
      // Playwright anti-pattern on real apps generally, not just this one.
      const setupIntentResponsePromise = page.waitForResponse((response) => response.url().includes('/api/create-setup-intent'));
      await page.goto(`${BASE_URL}/payments`);
      await setupIntentResponsePromise;
      const rewardsCard = rewardsBalancesCard(page);
      const couponInput = rewardsCard.getByRole('textbox', { name: 'Coupon Code' });
      const redeemButton = rewardsCard.getByRole('button', { name: 'Redeem Coupon' });

      const appRequests = trackAppRequests(page);
      await couponInput.fill('TESTCOUPON123');
      await redeemButton.click();

      // There is no success/error response to await for a feature that
      // isn't wired up to any backend endpoint yet, so a fixed wait is the
      // only reliable way to give a hypothetical delayed/async request a
      // fair chance to appear before asserting its absence.
      await page.waitForTimeout(2000);

      // NOT A SINGLE new network request is sent to this app's own host as a
      // result of the click.
      expect(appRequests).toEqual([]);

      // No success message, error message, toast, or any other visible
      // feedback of any kind appears anywhere on the page - asserted on
      // TEXT, not count, per this project's documented gotcha that
      // `getByRole('alert')` also matches Next.js's own always-present,
      // empty, visually-hidden route-announcer div.
      await expect(page.getByRole('alert')).toHaveText('');

      // The 'Coupon Code' field silently retains the typed value with no
      // visual change.
      await expect(couponInput).toHaveValue('TESTCOUPON123');
    });

    test('3.2 A whitespace-only Coupon Code value produces the identical no-op behavior', async ({ page }) => {
      // 1. Clear the 'Coupon Code' field and type only whitespace (e.g.
      // three spaces), then click 'Redeem Coupon'.
      // See test 3.1's comment above for why this waits for the specific
      // create-setup-intent response (not networkidle) before registering
      // trackAppRequests() below.
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

    test('3.3 A very long Coupon Code value (128 characters) is accepted with no truncation, and still produces the same no-op behavior on click', async ({ page }) => {
      // 1. Clear the 'Coupon Code' field and type a 128-character repeating
      // string.
      // See test 3.1's comment above for why this waits for the specific
      // create-setup-intent response (not networkidle) before registering
      // trackAppRequests() below.
      const setupIntentResponsePromise = page.waitForResponse((response) => response.url().includes('/api/create-setup-intent'));
      await page.goto(`${BASE_URL}/payments`);
      await setupIntentResponsePromise;
      const rewardsCard = rewardsBalancesCard(page);
      const couponInput = rewardsCard.getByRole('textbox', { name: 'Coupon Code' });
      const redeemButton = rewardsCard.getByRole('button', { name: 'Redeem Coupon' });

      const longValue = 'A'.repeat(128);
      await couponInput.fill(longValue);

      // The field accepts the full 128 characters with no truncation and no
      // inline length-limit error - checked directly via the input's own
      // value length, not just a visual glance.
      await expect(couponInput).toHaveValue(longValue);
      expect((await couponInput.inputValue()).length).toBe(128);

      // 2. Click 'Redeem Coupon' with this long value still in place.
      const appRequests = trackAppRequests(page);
      await redeemButton.click();
      await page.waitForTimeout(2000);

      // Identical to 3.1 - zero network requests, zero visible feedback,
      // regardless of input length.
      expect(appRequests).toEqual([]);
      await expect(page.getByRole('alert')).toHaveText('');
    });

    test("3.4 KNOWN LIMITATION: Redeem Coupon is not enabled in this release, so its success/error paths cannot be tested yet", async ({ page }) => {
      // Documentation-style consolidation test, not a new behavior to
      // discover: per the maintainer, 'Redeem Coupon' is intentionally not
      // wired up to any backend endpoint yet in this release (planned for a
      // future release - see specs/payments-test-plan.md section 3.4).
      // Re-confirms the same no-op guarantee against a pristine, completely
      // untouched field - the one input shape not separately covered by
      // 3.1-3.3 - so this suite's coverage across
      // empty/realistic/whitespace/128-char inputs is fully consolidated in
      // one place. TODO once Redeem Coupon is enabled in a future release:
      // replace this test (and 3.1-3.3) with real success/error-path
      // assertions rather than extending the no-op coverage further.
      // See test 3.1's comment above for why this waits for the specific
      // create-setup-intent response (not networkidle) before registering
      // trackAppRequests() below.
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
    test("4.1 Stripe's own real-time card validation shows specific inline error messages for incomplete/invalid Card fields", async ({ page }) => {
      // 1. In the Card iframe, type an incomplete card number (e.g. '4242')
      // and blur the field by clicking into 'Expiration date'.
      //
      // Deliberately re-resolves cardElementFrame(page) fresh before each
      // interaction below, rather than capturing one `paymentFrame` up front
      // and reusing it for the whole test (the pattern every other test in
      // this file uses safely). Live-verified this specific test needs it:
      // Stripe was observed to occasionally swap the Card iframe out for a
      // genuinely new one (a new `name` attribute, not just an extra
      // decoy alongside it) partway through this test's slower, more
      // drawn-out sequence of type/blur/assert steps - a name-pinned
      // FrameLocator captured once went stale mid-test when that happened,
      // causing a real 30s+ hang on the next action. Re-resolving before
      // each step is more expensive but immune to a mid-test remount.
      //
      // Live-verified this can still occasionally exceed the default 30s
      // test timeout even with the re-resolve mitigation above - two of
      // this file's four full runs today hit a bare "Test timeout of
      // 30000ms exceeded" here with no assertion-specific error, the exact
      // failure mode this comment already anticipated. Every other test in
      // this file with a comparably long multi-step Stripe iframe sequence
      // (5.4, 6.2, 6.5, 6.6) already calls test.slow() for this same
      // reason - this one had been a (now-fixed) inconsistency, not a case
      // where more time isn't warranted.
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
      await ((await cardElementFrame(page)).getByRole('textbox', { name: 'Expiration date' })).pressSequentially('0120');

      // An inline alert appears reading exactly "Your card's expiration
      // year is in the past." - Stripe renders this with a real curly
      // apostrophe (U+2019), not a straight one, matched exactly here.
      await expect((await cardElementFrame(page)).getByText('Your card’s expiration year is in the past.', { exact: true })).toBeVisible();

      // 3. Type a single-digit value into 'Security code' (e.g. '1') and
      // blur the field.
      await ((await cardElementFrame(page)).getByRole('textbox', { name: 'Security code' })).pressSequentially('1');
      await (await cardElementFrame(page)).getByText('Card', { exact: true }).click();

      // An inline alert appears reading exactly 'Your security code is
      // incomplete.' - NOT "Your card's security code is incomplete."
      // despite the plan's text and the pattern of the other two alerts;
      // live-verified via direct DOM inspection this one field's message
      // genuinely omits "card's".
      await expect((await cardElementFrame(page)).getByText('Your security code is incomplete.', { exact: true })).toBeVisible();

      // With all three fields simultaneously invalid, confirm the 'Update
      // Payment Method' button is disabled.
      await expect(page.getByRole('button', { name: 'Update Payment Method' })).toBeDisabled();
    });

    test("4.2 The 'Save payment details for future purchases' checkbox genuinely gates the 'Update Payment Method' button — clearing it alone disables the button even when every other field is valid", async ({
      page,
    }) => {
      // 1. Fill Full Name, Address/City/Postal (default country, plain text
      // fields), and a fully valid Card Number/Expiry/CVC - leave the 'Save
      // payment details for future purchases' checkbox UNCHECKED.
      await page.goto(`${BASE_URL}/payments`);
      await fillBillingAndCardFieldsWithoutCheckbox(page);
      const updateButton = page.getByRole('button', { name: 'Update Payment Method' });

      // 'Update Payment Method' remains DISABLED despite every other field
      // being valid - confirming this checkbox is functionally required,
      // not a cosmetic/optional 'remember me'-style control.
      await expect(updateButton).toBeDisabled();

      // 2. Check the checkbox (verify its checked state via DOM, may need
      // a second click).
      await checkSavePaymentDetailsCheckbox(page);

      // 'Update Payment Method' becomes ENABLED immediately once the
      // checkbox is confirmed checked, with no other field changes needed.
      await expect(updateButton).toBeEnabled();
    });

    test("4.3 NOTABLE INCONSISTENCY: unlike the checkbox, clearing 'Full Name' does NOT re-disable the 'Update Payment Method' button — the missing-field block only surfaces at submit-click time via Stripe's own client-side validation, with no API call made", async ({
      page,
    }) => {
      // 1. Fill every field EXCEPT 'Full Name' (Address/City/Postal, valid
      // Card fields, checkbox checked), leaving Full Name genuinely blank
      // from the start - functionally identical, for this test's purpose, to
      // filling then clearing it, but far simpler and avoids an entire class
      // of flakiness live-verified while writing this file: clearing an
      // ALREADY-FILLED Stripe field via keystrokes needs the exact iframe
      // instance that was typed into in the first place to still be mounted
      // by the time the clear happens, and Stripe was observed to
      // occasionally swap this iframe out for a new instance in the gap
      // between filling and clearing, silently leaving the ORIGINAL,
      // now-detached field's value intact while a fresh, still-blank field
      // took its place underneath - masking the very validation this test
      // exists to check. Never filling Full Name at all sidesteps the whole
      // "does the clear survive a mid-test remount" question.
      await page.goto(`${BASE_URL}/payments`);
      await fillBillingAndCardFieldsWithoutCheckbox(page, { fullName: '' });
      await checkSavePaymentDetailsCheckbox(page);
      const updateButton = page.getByRole('button', { name: 'Update Payment Method' });

      // 'Update Payment Method' is ENABLED even with Full Name genuinely
      // empty - no inline 'required' error appears near the Full Name field
      // at this point either, unlike the Card fields' real-time validation
      // in 4.1.
      await expect(updateButton).toBeEnabled();
      // Stripe.js needs a brief moment to settle its internal validation
      // state after the checkbox click above before a submit reliably
      // triggers full-form validation - live-verified via direct manual
      // reproduction that the exact same sequence with real pauses between
      // actions (matching a human's natural pace, or this MCP tooling's own
      // round-trip latency) always shows the expected error, while clicking
      // through it at Playwright's default speed with no explicit wait
      // reproducibly submits with no visible validation at all.
      await page.waitForTimeout(1_000);

      // 2. Click 'Update Payment Method' with Full Name still empty.
      const appRequests = trackAppRequests(page);
      await updateButton.click();

      // The submission is correctly BLOCKED - a page-level alert appears
      // reading exactly 'Please provide your full name.'. Live-verified via
      // direct diagnostic logging that `page.getByRole('alert', { name:
      // '...', exact: true })` can report "element(s) not found" here even
      // while a raw `document.querySelectorAll('[role="alert"]')` DOM query
      // in the very same instant finds TWO elements with that exact
      // textContent already in the top-level document - Playwright's
      // accessible-name computation for these MuiAlert regions doesn't
      // reliably match their visible textContent by the time this check
      // runs (a real ARIA live-region timing/computation quirk, not
      // something under this test's control), so this asserts on visible
      // TEXT instead of role+accessible-name, matching this project's
      // already-documented `getByRole('alert')` gotcha in spirit. `.first()`
      // sidesteps the 2-element ambiguity (a duplicate render of the same
      // alert, same general pattern as this app's other documented
      // hidden-mobile-accordion duplicates) rather than asserting on which
      // one specifically.
      await expect(page.getByText('Please provide your full name.', { exact: true }).first()).toBeVisible({ timeout: 10_000 });

      // NO new API request of any kind is sent to the app's own host as a
      // result of this blocked submit attempt - the block is a genuine,
      // purely client-side (Stripe.js) validation, not a wasted round-trip.
      expect(appRequests).toEqual([]);

      // The page does not navigate; still on /payments.
      await expect(page).toHaveURL(`${BASE_URL}/payments`);
    });

    test('4.4 The same button-stays-enabled-but-blocks-on-submit pattern generalizes to other Address fields (spot-checked with City)', async ({ page }) => {
      // 1. Fill every field EXCEPT 'City' (Full Name/Address/Postal, valid
      // Card fields, checkbox checked), leaving City genuinely blank from
      // the start - see 4.3's comment above for why this is deliberately
      // simpler than filling then clearing an already-filled Stripe field.
      await page.goto(`${BASE_URL}/payments`);
      await fillBillingAndCardFieldsWithoutCheckbox(page, { city: '' });
      await checkSavePaymentDetailsCheckbox(page);
      const updateButton = page.getByRole('button', { name: 'Update Payment Method' });

      // 'Update Payment Method' is ENABLED with City empty - confirming
      // 4.3's finding is not unique to Full Name, but a more general pattern
      // across at least the AddressElement's text fields.
      await expect(updateButton).toBeEnabled();
      // See 4.3's comment above for why this settle wait matters before
      // submitting.
      await page.waitForTimeout(1_000);

      // 2. Click 'Update Payment Method' with City still empty.
      await updateButton.click();

      // Submission is blocked with a page-level alert reading exactly
      // 'This field is incomplete.', the page stays on /payments -
      // confirming no partial/invalid save occurred. Asserts on visible
      // TEXT with `.first()`, not role+exact-accessible-name, for the same
      // reason documented in 4.3 above.
      await expect(page.getByText('This field is incomplete.', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
      await expect(page).toHaveURL(`${BASE_URL}/payments`);
    });

    test("4.5 No client-side maximum length is enforced on 'Full Name', at least up to 298 characters", async ({ page }) => {
      // 1. Type a 298-character value into 'Full Name'.
      await page.goto(`${BASE_URL}/payments`);
      const addressFrame = await billingAddressFrame(page);
      const fullNameField = addressFrame.getByRole('textbox', { name: 'Full name' });
      const longName = 'A'.repeat(298);
      await fullNameField.pressSequentially(longName);

      // The full 298-character value is accepted with no truncation -
      // checked directly via the input's own value length, not just a
      // visual glance.
      await expect(fullNameField).toHaveValue(longName);
      expect((await fullNameField.inputValue()).length).toBe(298);
    });

    test("4.6 EXCEPTION to the 4.3/4.4 pattern: 'Postal code' is genuinely NOT a required field — a submission with it blank succeeds outright, with no blocking validation of any kind", async ({
      page,
    }) => {
      // Real Stripe SetupIntent confirmation + backend save round-trip, same
      // as saveValidPaymentMethodAndWaitForCompany() above - comfortably
      // exceeds the default 30s test timeout on a slow-but-not-broken run.
      test.slow();

      // 1. With Full Name, Address line 1, City, valid Card fields, and the
      // checkbox all filled/checked/valid, leave 'Postal code' completely
      // empty and click 'Update Payment Method'.
      await page.goto(`${BASE_URL}/payments`);
      await fillBillingAndCardFieldsWithoutCheckbox(page, { postalCode: '' });
      await checkSavePaymentDetailsCheckbox(page);

      const updateButton = page.getByRole('button', { name: 'Update Payment Method' });
      await expect(updateButton).toBeEnabled();
      await updateButton.click();

      // Unlike Full Name (4.3), Address line 1, or City (4.4) - all of
      // which block submission - leaving Postal code blank does NOT block
      // the submission at all: the browser redirects to /company and the
      // new card is saved and shown normally, exactly as if Postal code had
      // been filled in. This test genuinely leaves the disposable account
      // WITH a saved payment method afterward - deliberately left as-is
      // (not cleaned up), since 4.7 below does not depend on the account's
      // payment-method state either way.
      await expect(page).toHaveURL(`${BASE_URL}/company`, { timeout: 20_000 });
      const card = paymentsSummaryCard(page);
      await expect(card.getByRole('heading', { name: '**** **** **** 4242', exact: true })).toBeVisible();
      await expect(card.getByText('No Payment Method')).toHaveCount(0);
    });

    test("4.7 A very long value in 'Address line 1' (257 characters) does not visually overflow or break the Billing Address form's layout", async ({ page }) => {
      // 1. Type a 257-character value into 'Address line 1' and inspect the
      // field and surrounding form.
      await page.goto(`${BASE_URL}/payments`);
      const addressFrame = await billingAddressFrame(page);
      const addressField = addressFrame.getByRole('textbox', { name: 'Address line 1' });
      const longAddress = '1'.repeat(257);
      await addressField.pressSequentially(longAddress);
      await expect(addressField).toHaveValue(longAddress);

      // Via DOM inspection, the input's scrollWidth exceeds its clientWidth
      // - the input scrolling its own text content horizontally within a
      // fixed-size box, standard native <input> behavior, not a defect.
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
    test("5.1 A fully valid submission (test card 4242, valid address, checkbox checked) redirects to /company, updates the summary card, and leaves Payment History unchanged — persisting across a real reload", async ({
      page,
    }) => {
      // Real, multi-iframe Stripe Elements interaction plus a genuine
      // SetupIntent confirmation + backend save round-trip, same as test
      // 1.2 above - comfortably exceeds the default 30s test timeout budget
      // on a slow-but-not-broken run.
      test.slow();

      // 1. On /payments, start from a genuinely clean slate: an earlier
      // test in this file (4.6) may have left a payment method saved -
      // delete it first via the same 'Remove Payment Method' confirmation
      // dialog already used in test 2.1, so this test's own save is the
      // one thing that changes the account's payment-method state.
      await page.goto(`${BASE_URL}/payments`);
      const deleteButton = page.getByRole('button', { name: 'Delete Payment Method', exact: true });
      await expect(page.getByRole('heading', { name: /No Payment Method|Current Payment Method/ })).toBeVisible();
      if (await deleteButton.isVisible()) {
        await deleteButton.click();
        await expect(page.getByRole('heading', { name: 'Remove Payment Method' })).toBeVisible();
        await page.getByRole('button', { name: 'Yes, remove' }).click();
        await expect(page.getByRole('heading', { name: 'No Payment Method', exact: true })).toBeVisible();
      }

      // Capture the 'Payment History' table's current row count on
      // /company BEFORE this test's own save - see
      // paymentHistoryRowCount()'s comment above for why this is compared
      // to itself before/after rather than asserting a literal 'No Payment
      // History' text: this disposable account permanently carries at
      // least one real paid invoice from this file's own Suite 6
      // subscription-purchase exploration, a harmless, permanent side
      // effect this test cannot and should not try to undo.
      await page.goto(`${BASE_URL}/company`);
      const paymentHistoryRowsBefore = await paymentHistoryRowCount(page);

      // Fill Full Name, Address/City/Postal, Card Number '4242 4242 4242
      // 4242', a future Expiry (12/34), any 3-digit CVC, and check 'Save
      // payment details for future purchases'. Click 'Update Payment
      // Method'.
      await page.goto(`${BASE_URL}/payments`);
      await saveValidPaymentMethodAndWaitForCompany(page);

      // The browser navigates away from /payments to /company (done by the
      // helper above - confirms a genuine save-and-redirect flow). The
      // /company Payments summary card now shows a masked card in the
      // format '**** **** **** 4242' and expiry '12/2034' (no more 'No
      // Payment Method' text).
      const card = paymentsSummaryCard(page);
      await expect(card.getByRole('heading', { name: '**** **** **** 4242', exact: true })).toBeVisible();
      await expect(card.getByRole('heading', { name: '12/2034', exact: true })).toBeVisible();
      await expect(card.getByText('No Payment Method')).toHaveCount(0);

      // 2. Check the 'Payment History' table at the bottom of /company.
      // It shows EXACTLY the same row count as before this save - a
      // SetupIntent save does not create any invoice/charge history entry.
      expect(await paymentHistoryRowCount(page)).toBe(paymentHistoryRowsBefore);

      // 3. Navigate to /payments and inspect the 'Current Payment Method'
      // block.
      await page.goto(`${BASE_URL}/payments`);
      await expect(page.getByRole('heading', { name: 'Current Payment Method', exact: true })).toBeVisible();

      // The masked card and expiry shown here exactly match the /company
      // summary card from the previous step.
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

    test('5.2 Decline flow (test card 4000 0000 0000 0002) shows three simultaneous error surfaces and leaves the form editable for immediate retry', async ({ page }) => {
      // Real, multi-iframe Stripe Elements interaction plus a genuine
      // Stripe decline round-trip (live-verified to take several seconds
      // longer than a successful confirm) - comfortably exceeds the default
      // 30s test timeout budget on a slow-but-not-broken run.
      test.slow();

      // 1. Fill the form fully valid in every respect except use Card
      // Number '4000000000000002' (generic decline). No existing helper
      // covers this specific card number, so this reuses
      // fillValidPaymentMethodForm()'s exact field-by-field pattern
      // (re-resolving billingAddressFrame(page)/cardElementFrame(page)
      // fresh before each action, per this project's documented Stripe
      // iframe-remount gotcha) with only the Card Number swapped out.
      // Check the checkbox and click 'Update Payment Method'.
      await page.goto(`${BASE_URL}/payments`);
      await (await billingAddressFrame(page)).getByRole('textbox', { name: 'Full name' }).pressSequentially('QA Payments Decline');
      await (await billingAddressFrame(page)).getByRole('textbox', { name: 'Address line 1' }).pressSequentially('123 Main Street');
      await (await billingAddressFrame(page)).getByRole('textbox', { name: 'City' }).pressSequentially('Quito');
      await (await billingAddressFrame(page)).getByRole('textbox', { name: 'Postal code' }).pressSequentially('170150');
      await (await cardElementFrame(page)).getByRole('textbox', { name: 'Card number' }).pressSequentially('4000000000000002');
      await (await cardElementFrame(page)).getByRole('textbox', { name: 'Expiration date' }).pressSequentially('1234');
      await (await cardElementFrame(page)).getByRole('textbox', { name: 'Security code' }).pressSequentially('123');
      await checkSavePaymentDetailsCheckbox(page);

      const updateButton = page.getByRole('button', { name: 'Update Payment Method' });
      await expect(updateButton).toBeEnabled();
      await updateButton.click();

      // A page-level alert appears reading exactly 'Your card has been
      // declined.' - `.first()` sidesteps this app's already-documented
      // hidden-mobile-accordion duplicate-render pattern, same reasoning as
      // tests 4.3/4.4 above.
      await expect(page.getByText('Your card has been declined.', { exact: true }).first()).toBeVisible({ timeout: 15_000 });

      // A separate inline alert appears directly under the Card Number
      // field (inside the Card iframe) reading exactly 'Your card was
      // declined.' - DIFFERENT wording from the page-level alert above,
      // confirming these are two genuinely separate error surfaces, not
      // the same text rendered twice.
      await expect((await cardElementFrame(page)).getByText('Your card was declined.', { exact: true })).toBeVisible();

      // A separate, dismissable toast also appears. Identified as the ONE
      // alert-role element that ALSO contains a visible 'Close' button -
      // distinguishing it both from the page-level alert above (no button)
      // and from Next.js's own always-present, empty route-announcer div
      // (also role='alert', per this project's documented gotcha) - rather
      // than a brittle CSS class selector.
      //
      // NOTABLE DISCREPANCY from specs/payments-test-plan.md's prose (which
      // describes this toast as reading 'Your card was declined.', matching
      // the inline alert): live-verified via a MutationObserver-based
      // capture of the toast's outerHTML at the exact moment it mounts
      // (immune to the toast's own ~5s auto-hide racing a manual read) that
      // this toast's real text is 'Your card has been declined.' -
      // matching the PAGE-LEVEL alert instead, reproduced identically
      // across independent clean, single-submission runs. Written to match
      // the real, currently-observed app behavior rather than the plan's
      // original prose.
      const toast = page.getByRole('alert').filter({ has: page.getByRole('button', { name: 'Close' }) });
      await expect(toast).toBeVisible({ timeout: 15_000 });
      await expect(toast).toHaveText('Your card has been declined.');

      // The page does NOT navigate away from /payments, and all previously
      // entered form values (Full Name, Address, Card fields) remain
      // populated and editable - the user can immediately correct the card
      // and retry without re-entering anything.
      await expect(page).toHaveURL(`${BASE_URL}/payments`);
      await expect((await billingAddressFrame(page)).getByRole('textbox', { name: 'Full name' })).toHaveValue('QA Payments Decline');
      await expect((await billingAddressFrame(page)).getByRole('textbox', { name: 'Address line 1' })).toHaveValue('123 Main Street');
      await expect((await billingAddressFrame(page)).getByRole('textbox', { name: 'City' })).toHaveValue('Quito');
      await expect((await cardElementFrame(page)).getByRole('textbox', { name: 'Card number' })).toHaveValue('4000 0000 0000 0002');
    });

    test('5.3 Incorrect-CVC decline (test card 4000 0000 0000 0127) surfaces a CVC-SPECIFIC error message, distinct from the generic decline message', async ({ page }) => {
      // Same real Stripe decline round-trip budget concern as 5.2 above.
      test.slow();

      // 1. Fill the form fully valid except use Card Number
      // '4000000000000127' (incorrect-CVC decline), with a valid 3-digit
      // CVC. Same reused fillValidPaymentMethodForm() field-by-field
      // pattern as 5.2, with only the Card Number swapped out. Check the
      // checkbox and click 'Update Payment Method'.
      await page.goto(`${BASE_URL}/payments`);
      await (await billingAddressFrame(page)).getByRole('textbox', { name: 'Full name' }).pressSequentially('QA Payments CVC');
      await (await billingAddressFrame(page)).getByRole('textbox', { name: 'Address line 1' }).pressSequentially('123 Main Street');
      await (await billingAddressFrame(page)).getByRole('textbox', { name: 'City' }).pressSequentially('Quito');
      await (await billingAddressFrame(page)).getByRole('textbox', { name: 'Postal code' }).pressSequentially('170150');
      await (await cardElementFrame(page)).getByRole('textbox', { name: 'Card number' }).pressSequentially('4000000000000127');
      await (await cardElementFrame(page)).getByRole('textbox', { name: 'Expiration date' }).pressSequentially('1234');
      await (await cardElementFrame(page)).getByRole('textbox', { name: 'Security code' }).pressSequentially('123');
      await checkSavePaymentDetailsCheckbox(page);

      const updateButton = page.getByRole('button', { name: 'Update Payment Method' });
      await expect(updateButton).toBeEnabled();
      await updateButton.click();

      // The page-level alert reads exactly "Your card's CVC is incorrect."
      // (a real curly apostrophe, U+2019) - NOT the generic 'Your card has
      // been declined.' text from 5.2 above, confirming Stripe surfaces
      // decline-reason-specific error text rather than one single generic
      // message for every failure type. `.first()` sidesteps this app's
      // already-documented hidden-mobile-accordion duplicate-render
      // pattern, same reasoning as tests 4.3/4.4/5.2 above.
      await expect(page.getByText('Your card’s CVC is incorrect.', { exact: true }).first()).toBeVisible({ timeout: 15_000 });

      // The inline alert under Security code (inside the Card iframe)
      // reads exactly "Your card's security code is incorrect." - also
      // with a real curly apostrophe.
      await expect((await cardElementFrame(page)).getByText('Your card’s security code is incorrect.', { exact: true })).toBeVisible();

      // The page stays on /payments with the form still populated/editable,
      // matching the retry-friendly behavior confirmed in 5.2 above.
      await expect(page).toHaveURL(`${BASE_URL}/payments`);
      await expect((await cardElementFrame(page)).getByRole('textbox', { name: 'Card number' })).toHaveValue('4000 0000 0000 0127');
    });

    test('5.4 3D Secure authentication flow (test card 4000 0025 0000 3155) shows a real Stripe-hosted challenge modal, and completing it successfully saves the card', async ({
      page,
    }) => {
      // Real, multi-iframe Stripe Elements interaction plus a genuine 3D
      // Secure challenge round-trip + SetupIntent confirmation + backend
      // save - the slowest real flow in this file, comfortably exceeding
      // the default 30s test timeout budget on a slow-but-not-broken run.
      test.slow();

      // 1. Fill the form fully valid using Card Number '4000002500003155'
      // (any future expiry/CVC). Same reused fillValidPaymentMethodForm()
      // field-by-field pattern as 5.2/5.3, with only the Card Number
      // swapped out. Check the checkbox and click 'Update Payment Method'.
      await page.goto(`${BASE_URL}/payments`);
      await (await billingAddressFrame(page)).getByRole('textbox', { name: 'Full name' }).pressSequentially('QA Payments 3DS');
      await (await billingAddressFrame(page)).getByRole('textbox', { name: 'Address line 1' }).pressSequentially('123 Main Street');
      await (await billingAddressFrame(page)).getByRole('textbox', { name: 'City' }).pressSequentially('Quito');
      await (await billingAddressFrame(page)).getByRole('textbox', { name: 'Postal code' }).pressSequentially('170150');
      await (await cardElementFrame(page)).getByRole('textbox', { name: 'Card number' }).pressSequentially('4000002500003155');
      await (await cardElementFrame(page)).getByRole('textbox', { name: 'Expiration date' }).pressSequentially('1234');
      await (await cardElementFrame(page)).getByRole('textbox', { name: 'Security code' }).pressSequentially('123');
      await checkSavePaymentDetailsCheckbox(page);

      const updateButton = page.getByRole('button', { name: 'Update Payment Method' });
      await expect(updateButton).toBeEnabled();
      await updateButton.click();

      // The 'Update Payment Method' button shows a loading spinner and
      // becomes disabled while the SetupIntent confirmation/3DS challenge
      // is in flight.
      await expect(updateButton).toBeDisabled();
      await expect(updateButton.getByRole('progressbar')).toBeVisible();

      // A real Stripe-hosted modal appears, in a NESTED pair of iframes -
      // live-verified via direct DOM inspection this is genuinely two
      // levels deep: an outer Stripe iframe (identified here by its `src`
      // containing 'three-ds-2-challenge', the one stable substring across
      // runs - its `name` attribute is a fresh, unpredictable
      // '__privateStripeFrameNNNNN' every run, same reasoning
      // resolveStripeFrameByContent() above documents for the
      // Address/Card iframes) wrapping a real Stripe-hosted dialog, which
      // itself contains a SECOND iframe (a stable `name="stripe-challenge-
      // frame"`, confirmed via Playwright's own recorded locator chain
      // while live-verifying this flow) holding the actual '3D Secure 2
      // Test Page' content.
      const challengeFrame = page.frameLocator('iframe[src*="three-ds-2-challenge"]').frameLocator('iframe[name="stripe-challenge-frame"]');
      await expect(challengeFrame.getByRole('heading', { name: '3D Secure 2 Test Page' })).toBeVisible({ timeout: 20_000 });
      await expect(challengeFrame.getByRole('button', { name: 'Fail' })).toBeVisible();
      await expect(challengeFrame.getByRole('button', { name: 'Complete' })).toBeVisible();
      // The outer Stripe dialog (one level up from the Test Page content
      // itself) carries the 'Cancel' control - live-verified via direct
      // DOM inspection this renders as a real <button>, not an <a> link,
      // despite the plan's prose calling it a 'Cancel link'.
      await expect(page.frameLocator('iframe[src*="three-ds-2-challenge"]').getByRole('button', { name: 'Cancel' })).toBeVisible();

      // The 'Complete'/'Fail' buttons render before the challenge page's own
      // JS (challenge.js, gated behind a trusted-types-checker script) has
      // finished loading and wiring up its click handler - live-verified via
      // trace network timing that a click fired immediately after the
      // buttons become visible lands ~1.5s before that script's network
      // request even completes, silently no-oping (no further network
      // activity at all afterward, and the app never navigates to
      // /company). Same root cause family as the checkbox/submit timing gap
      // documented elsewhere in this file - give the frame's own JS a real
      // settle window before clicking.
      await page.waitForTimeout(2_000);

      // 2. Click 'Complete' inside the 3D Secure modal.
      await challengeFrame.getByRole('button', { name: 'Complete' }).click();

      // The modal closes, and the browser navigates to /company, exactly
      // like the non-3DS successful-save flow in 5.1 - but only after a
      // real 3DS authentication round-trip completes on Stripe's own
      // servers AND this app's own SetupIntent confirmation/backend save
      // follows it, so this gets a more generous budget than a plain save;
      // live-verified this can occasionally exceed 20s on a
      // slow-but-not-broken run.
      await expect(page).toHaveURL(`${BASE_URL}/company`, { timeout: 45_000 });

      // The /company Payments summary card shows the masked card ending in
      // the 3DS test card's last 4 digits ('...3155') and its expiry.
      const card = paymentsSummaryCard(page);
      await expect(card.getByRole('heading', { name: '**** **** **** 3155', exact: true })).toBeVisible();
      await expect(card.getByRole('heading', { name: '12/2034', exact: true })).toBeVisible();
    });
  });

  test.describe('Payments — Replacing and Deleting a Payment Method', () => {
    test("6.1 With a payment method already saved, the Billing Address/Card form still renders below 'Current Payment Method' and starts blank (does not prefill the previously-saved billing address)", async ({ page }) => {
      // Reads 9 separate fields across 2 separate Stripe iframes, each
      // resolved fresh via resolveStripeFrameByContent()'s own up-to-15s
      // polling budget - live-verified this can add up close to the
      // default 30s test timeout on a slow-but-not-broken run (one full-
      // file run hit a bare "Test timeout of 30000ms exceeded" here with
      // no assertion-specific error). Every other test in this file with a
      // comparably long multi-step Stripe iframe sequence already calls
      // test.slow() for this same reason.
      test.slow();

      // 1. With a payment method already saved (Suite 5 above left the
      // disposable account with a saved 3D Secure test card, '...3155'),
      // reload /payments and inspect the Billing Address/Card form rendered
      // below 'Current Payment Method'.
      await page.goto(`${BASE_URL}/payments`);

      // 'Current Payment Method' correctly shows the existing masked
      // card/expiry with a 'Delete Payment Method' button.
      await expect(page.getByRole('heading', { name: 'Current Payment Method', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: '**** **** **** 3155', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: '12/2034', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Delete Payment Method', exact: true })).toBeVisible();

      // The Billing Address/Card form below it is COMPLETELY blank - it
      // does NOT prefill with the billing details that were used for the
      // currently-saved card, even though that data was submitted moments
      // earlier in the same overall run. This form is how the user replaces
      // their payment method (see 6.2 below) - worth confirming it stays
      // blank rather than assuming it should prefill.
      //
      // Reads the Address fields by their raw Stripe-assigned element `id`
      // (e.g. #billingAddress-localityInput for City) rather than by
      // getByRole(...,{name}) - live-verified via direct DOM inspection
      // this is the actual root cause of a failure repeatedly seen here
      // across several full-file runs (always on the SAME 'City' read,
      // 'element(s) not found' even after retrying the whole
      // resolve-then-check cycle for a full 15s). Unlike the Card iframe's
      // fields (Card number/Expiration date/Security code all carry a
      // direct `aria-label` attribute, confirmed robust), every Address
      // field except 'Full name'/'Address line 1'/'Country' gets its
      // accessible name purely from an external `<label for="...">`
      // association - structurally valid on a plain fresh load (confirmed
      // live), but apparently not reliably attached yet at the specific
      // moment this test's fast, type-free read sequence hits it,
      // specifically in the one context only Suite 6 exercises (a payment
      // method already on file, so 'Current Payment Method' renders above
      // this form - possibly triggering a layout reflow of the widget that
      // Suite 5's fresh-form-only loads never hit). Querying by id
      // sidesteps accessible-name computation entirely, so this timing gap
      // no longer matters. The ids themselves are Stripe's own stable,
      // semantically-named ones (not per-session-random), confirmed via
      // live DOM inspection, so this is safe to hardcode.
      await expect((await billingAddressFrame(page)).locator('#billingAddress-nameInput')).toHaveValue('');
      // Country resets to the widget's own 'Ecuador' default (value 'EC'),
      // same as every fresh page load per test 2.2 above - not whatever
      // country was used for the currently-saved card.
      await expect((await billingAddressFrame(page)).locator('#billingAddress-countryInput')).toHaveValue('EC');
      await expect((await billingAddressFrame(page)).locator('#billingAddress-addressLine1Input')).toHaveValue('');
      await expect((await billingAddressFrame(page)).locator('#billingAddress-localityInput')).toHaveValue('');
      await expect((await billingAddressFrame(page)).locator('#billingAddress-postalCodeInput')).toHaveValue('');

      await expect((await cardElementFrame(page)).getByRole('textbox', { name: 'Card number' })).toHaveValue('');
      await expect((await cardElementFrame(page)).getByRole('textbox', { name: 'Expiration date' })).toHaveValue('');
      await expect((await cardElementFrame(page)).getByRole('textbox', { name: 'Security code' })).toHaveValue('');
      await expect((await cardElementFrame(page)).getByRole('checkbox', { name: 'Save payment details for future purchases' })).not.toBeChecked();

      // The 'Update Payment Method' button reflects this blank state -
      // disabled until the form is filled out again.
      await expect(page.getByRole('button', { name: 'Update Payment Method' })).toBeDisabled();
    });

    test("6.2 Submitting this still-visible form with a different card, without clicking 'Delete Payment Method' first, replaces the existing payment method — expected behavior of the 'Update Payment Method' button", async ({
      page,
    }) => {
      // Real, multi-iframe Stripe Elements interaction plus a genuine
      // SetupIntent confirmation + backend save round-trip, same budget
      // concern as every other real save in this file.
      test.slow();

      // 1. With a Visa card already saved ('...3155', from Suite 5 above),
      // and WITHOUT clicking 'Delete Payment Method', fill the still-visible
      // Billing Address/Card form with different, fully valid billing
      // details and a DIFFERENT test card (Mastercard '5555 5555 5555
      // 4444'), check the checkbox, and click 'Update Payment Method'. Same
      // reused field-by-field pattern as tests 5.2/5.3/5.4 above (re-
      // resolving billingAddressFrame(page)/cardElementFrame(page) fresh
      // before each action, per this project's documented Stripe
      // iframe-remount gotcha), since fillValidPaymentMethodForm() always
      // uses the 4242 test card and this scenario specifically needs a
      // different one.
      await page.goto(`${BASE_URL}/payments`);
      await (await billingAddressFrame(page)).getByRole('textbox', { name: 'Full name' }).pressSequentially('QA Payments Replace');
      await (await billingAddressFrame(page)).getByRole('textbox', { name: 'Address line 1' }).pressSequentially('456 Second Avenue');
      await (await billingAddressFrame(page)).getByRole('textbox', { name: 'City' }).pressSequentially('Quito');
      await (await billingAddressFrame(page)).getByRole('textbox', { name: 'Postal code' }).pressSequentially('170150');
      await (await cardElementFrame(page)).getByRole('textbox', { name: 'Card number' }).pressSequentially('5555555555554444');
      await (await cardElementFrame(page)).getByRole('textbox', { name: 'Expiration date' }).pressSequentially('1234');
      await (await cardElementFrame(page)).getByRole('textbox', { name: 'Security code' }).pressSequentially('123');
      await checkSavePaymentDetailsCheckbox(page);

      const updateButton = page.getByRole('button', { name: 'Update Payment Method' });
      await expect(updateButton).toBeEnabled();
      await updateButton.click();

      // No confirmation dialog or 'this will replace your existing payment
      // method' message appears anywhere - the click redirects straight to
      // /company exactly like a very-first-time save (live-verified,
      // confirmed with the maintainer this is intended: the button is
      // explicitly labeled 'Update Payment Method', so clicking it after
      // entering new details already IS the user's confirmation of intent -
      // unlike 'Delete Payment Method' in 6.3 below, whose action isn't
      // fully self-explanatory from the label alone, hence its own
      // confirmation dialog).
      await expect(page).toHaveURL(`${BASE_URL}/company`, { timeout: 20_000 });

      // BOTH the /company summary card and /payments' 'Current Payment
      // Method' block now show the NEW card ('...4444') - the OLD card
      // ('...3155') is fully replaced, consistent with the button's stated
      // purpose.
      const card = paymentsSummaryCard(page);
      await expect(card.getByRole('heading', { name: '**** **** **** 4444', exact: true })).toBeVisible();
      await expect(card.getByText('**** **** **** 3155')).toHaveCount(0);

      await page.goto(`${BASE_URL}/payments`);
      await expect(page.getByRole('heading', { name: '**** **** **** 4444', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: '**** **** **** 3155' })).toHaveCount(0);
    });

    test("6.3 'Delete Payment Method' opens a confirmation dialog with specific copy, and 'No, go back' cancels cleanly without deleting anything (no active subscription case)", async ({ page }) => {
      // 1. With a payment method saved (test 6.2 above left card '...4444'
      // in place), and with NO active paid subscription (this disposable
      // account has never touched /subscription anywhere earlier in this
      // file), click 'Delete Payment Method' on /payments.
      await page.goto(`${BASE_URL}/payments`);
      const deleteButton = page.getByRole('button', { name: 'Delete Payment Method', exact: true });
      await expect(deleteButton).toBeVisible();

      // Capture the currently-shown masked card/expiry to compare against
      // after cancelling below - proves a genuine no-op by re-querying the
      // exact strings captured here, rather than asserting a second
      // hardcoded literal.
      const cardBefore = await page.getByRole('heading', { name: /^\*{4} \*{4} \*{4} \d{4}$/ }).textContent();
      const expiryBefore = await page.getByRole('heading', { name: /^\d{1,2}\/\d{4}$/ }).textContent();

      await deleteButton.click();

      // A dialog opens titled exactly 'Remove Payment Method' - NOT the
      // 'Cancel Subscription' variant used in 6.6 below, since this account
      // has no active subscription at this point in the file - with body
      // copy reading exactly "You're about to remove your saved payment
      // method." followed by two bullets and a third standalone line, plus
      // 'No, go back' / 'Yes, remove' buttons.
      await expect(page.getByRole('heading', { name: 'Remove Payment Method', exact: true })).toBeVisible();
      await expect(page.getByText("You're about to remove your saved payment method.", { exact: true })).toBeVisible();
      await expect(page.getByText("This will not cancel any subscription, since you don't currently have an active one.", { exact: true })).toBeVisible();
      await expect(page.getByText("If you choose to subscribe in the future, you'll need to add a payment method again.", { exact: true })).toBeVisible();
      await expect(page.getByText('Reach out to Job Link support for more information.', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'No, go back' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Yes, remove' })).toBeVisible();

      // 2. Click 'No, go back'.
      await page.getByRole('button', { name: 'No, go back' }).click();

      // The dialog closes.
      await expect(page.getByRole('heading', { name: 'Remove Payment Method' })).toHaveCount(0);

      // The payment method is COMPLETELY UNCHANGED - re-reading the masked
      // card/expiry immediately afterward shows the exact same values as
      // before opening the dialog, confirming this is a true cancel/no-op,
      // not a partial or delayed deletion.
      await expect(page.getByRole('heading', { name: cardBefore!, exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: expiryBefore!, exact: true })).toBeVisible();
    });

    test("6.4 Confirming deletion ('Yes, remove') removes the payment method and correctly reverts both /payments and the /company summary card to 'No Payment Method'", async ({ page }) => {
      // Capture the 'Payment History' table's row count on /company BEFORE
      // this test's deletion - compared to itself after, per this file's
      // established discover-don't-hardcode pattern (see
      // paymentHistoryRowCount()'s comment above), since a payment-method
      // deletion isn't a billing event either and shouldn't add/remove any
      // row.
      await page.goto(`${BASE_URL}/company`);
      const paymentHistoryRowsBefore = await paymentHistoryRowCount(page);

      // 1. On /payments, click 'Delete Payment Method' again, then click
      // 'Yes, remove' in the confirmation dialog.
      await page.goto(`${BASE_URL}/payments`);
      await page.getByRole('button', { name: 'Delete Payment Method', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Remove Payment Method', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Yes, remove' }).click();

      // The dialog closes and, WITHOUT needing a manual page reload,
      // /payments now shows the heading 'No Payment Method' and the
      // 'Current Payment Method' block (and its 'Delete Payment Method'
      // button) has disappeared entirely.
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

    test("6.5 Submitting the exact same card (same number, expiry, CVC) as the currently-saved one is accepted silently, with no 'this card is already saved' detection", async ({ page }) => {
      // Two real SetupIntent confirmation + backend save round-trips back
      // to back - comfortably exceeds the default 30s test timeout budget
      // on a slow-but-not-broken run.
      test.slow();

      // 1. Save a valid payment method first (test card 4242 4242 4242
      // 4242, via the same helper used throughout this file).
      await page.goto(`${BASE_URL}/payments`);
      await saveValidPaymentMethodAndWaitForCompany(page);
      const card = paymentsSummaryCard(page);
      await expect(card.getByRole('heading', { name: '**** **** **** 4242', exact: true })).toBeVisible();

      // 2. WITHOUT clicking 'Delete Payment Method', go back to /payments
      // and fill the still-visible form again with the SAME card number,
      // expiry, and CVC (fillValidPaymentMethodForm() always fills the
      // identical 4242/12-34/123 values), check the checkbox again, and
      // click 'Update Payment Method' a second time.
      await page.goto(`${BASE_URL}/payments`);
      await fillValidPaymentMethodForm(page);

      const updateButton = page.getByRole('button', { name: 'Update Payment Method' });
      await expect(updateButton).toBeEnabled();
      await updateButton.click();

      // No 'this card is already your saved payment method' message,
      // warning, or block of any kind appears - the submission is accepted
      // exactly like any other successful save/replace above, and redirects
      // to /company.
      await expect(page).toHaveURL(`${BASE_URL}/company`, { timeout: 20_000 });

      // Both the /company summary card and /payments' 'Current Payment
      // Method' block show the SAME masked card ('...4242') and expiry as
      // before, with no visible indication either way of whether this
      // created a second, technically-duplicate Stripe PaymentMethod object
      // behind the scenes or reused the existing one - a known black-box
      // UI-testing limitation (the UI only ever surfaces one 'current'
      // payment method), not something resolvable from this level.
      await expect(card.getByRole('heading', { name: '**** **** **** 4242', exact: true })).toBeVisible();
      await page.goto(`${BASE_URL}/payments`);
      await expect(page.getByRole('heading', { name: '**** **** **** 4242', exact: true })).toBeVisible();
    });

    test("6.6 With a real active PAID subscription, the button relabels to 'Delete Payment Method & Cancel Subscription' and opens a differently-titled 'Cancel Subscription' dialog instead of 'Remove Payment Method'", async ({
      page,
    }) => {
      // A real Stripe Checkout round-trip (navigation to Stripe's own
      // externally-hosted checkout.stripe.com, then a genuine subscription
      // purchase in Stripe's test/sandbox mode, then a redirect back) - by
      // far the slowest, most external-dependency-heavy flow in this file.
      test.slow();

      // 1. Get the account into a state with a real active paid
      // subscription: on /subscription, select a paid plan ('Job Link Pro',
      // $12/month), click 'Continue', confirm on the 'Review Purchase'
      // dialog ('Confirm and Pay'), and complete the real Stripe Checkout
      // page (test/sandbox mode) using the already-saved test card - or, if
      // Checkout instead shows a blank card-entry form (this can vary
      // run-to-run depending on Stripe's own Link/customer state, outside
      // this app's control), fall back to typing test card 4242 4242 4242
      // 4242 with a future expiry/any CVC directly on that page. Unlike
      // this app's own embedded Stripe Elements iframes above, Checkout is
      // a real, separately-hosted page at a different origin (not an iframe
      // embedded in this app), so plain fill() works normally here - this
      // project's documented Stripe Elements gotcha (real keystrokes over
      // fill()) is specific to embedded Elements, not Checkout's own page.
      await page.goto(`${BASE_URL}/subscription`);
      await page.getByRole('heading', { name: 'Job Link Pro', exact: true }).click();
      const continueButton = page.getByRole('button', { name: 'Continue' });
      await expect(continueButton).toBeEnabled();
      await continueButton.click();

      // A 'Review Purchase' confirmation dialog appears before any charge
      // occurs.
      await expect(page.getByRole('heading', { name: 'Review Purchase' })).toBeVisible();
      await page.getByRole('button', { name: 'Confirm and Pay' }).click();

      // The browser navigates to Stripe's own real, externally-hosted
      // Checkout page (test/sandbox mode) - confirmed via the URL's host,
      // not via any of this app's own DOM.
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

      // The subscription activates successfully in Stripe's test/sandbox
      // mode - no real charge occurs. The browser redirects back to this
      // app at '/subscription?success=true' with a success message and the
      // page showing the new plan is active.
      await expect(page).toHaveURL(/\/subscription\?success=true/, { timeout: 45_000 });
      await expect(page.getByText('Your subscription has been successfully activated!', { exact: true })).toBeVisible();
      // Live-verified via a real full-file run: this is ONE sentence pair
      // in a single text node ("...plan. Your next subscription will be
      // billed on <date>."), not just the plan-name clause alone - an
      // exact-match assertion on the plan-name clause in isolation never
      // matches. Same dynamic-date pattern test 6.7 below already handles
      // with an anchored regex; matched here the same way.
      await expect(page.getByText(/^You are currently subscribed to the Job Link Pro \(Monthly\) plan\. Your next subscription will be billed on .+\.$/)).toBeVisible();

      // 2. Navigate to /payments.
      await page.goto(`${BASE_URL}/payments`);

      // The button no longer reads plain 'Delete Payment Method' - it now
      // reads 'Delete Payment Method & Cancel Subscription', and is NOT
      // disabled or blocked.
      const deleteAndCancelButton = page.getByRole('button', { name: 'Delete Payment Method & Cancel Subscription', exact: true });
      await expect(deleteAndCancelButton).toBeVisible();
      await expect(deleteAndCancelButton).toBeEnabled();
      await expect(page.getByRole('button', { name: 'Delete Payment Method', exact: true })).toHaveCount(0);

      // 3. Click 'Delete Payment Method & Cancel Subscription'.
      await deleteAndCancelButton.click();

      // A dialog opens titled exactly 'Cancel Subscription' - NOT 'Remove
      // Payment Method' like the no-active-subscription case in 6.3 above -
      // with body copy reading exactly "Removing your payment method will
      // cancel your Job Link subscription. Click 'Finish Cancellation'
      // below to cancel your subscription." followed by three bullets (the
      // first stating the specific date cancellation takes effect - matched
      // via regex since the exact date depends on when this test runs, not
      // a fixed literal), plus 'Reach out to Job Link support for more
      // information.' and two buttons: 'No, go back' and 'Finish
      // Cancellation'. Live-verified character-for-character while writing
      // this suite.
      await expect(page.getByRole('heading', { name: 'Cancel Subscription', exact: true })).toBeVisible();
      await expect(
        page.getByText("Removing your payment method will cancel your Job Link subscription. Click 'Finish Cancellation' below to cancel your subscription.", { exact: true })
      ).toBeVisible();
      await expect(page.getByText(/^Cancellation will be effective at the end of your current billing period as of .+\.$/)).toBeVisible();
      await expect(
        page.getByText('Continue to use all the powerful features of your subscription until cancellation is effective on the date above.', { exact: true })
      ).toBeVisible();
      await expect(page.getByText('Restart your subscription anytime.', { exact: true })).toBeVisible();
      await expect(page.getByText('Reach out to Job Link support for more information.', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'No, go back' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Finish Cancellation' })).toBeVisible();
    });

    test("6.7 Confirming 'Finish Cancellation' removes the payment method immediately but schedules the subscription to cancel at period end, not immediately", async ({ page }) => {
      // A real payment-method removal + subscription-cancellation backend
      // round-trip - live-verified this can exceed the default 30s test
      // timeout on a slow-but-not-broken run, the same reasoning every
      // other real-mutation test in this file already calls test.slow()
      // for.
      test.slow();

      // 1. Re-open the 'Cancel Subscription' dialog from 6.6 above, then
      // click 'Finish Cancellation' in it.
      //
      // Does NOT rely on 6.6's dialog still being open - live-verified via
      // direct DOM inspection this test actually starts on a fresh
      // /company page with no dialog present at all, because this file's
      // own `test.beforeEach` (re-logs in and navigates to /company before
      // EVERY test, no exceptions) runs before this test too, same as
      // every other test in the file. The original test plan's "continues
      // from 6.6's dialog" framing doesn't hold given that established
      // convention - 6.6 only OPENED and inspected the dialog, never
      // clicked 'Finish Cancellation' itself, so the account still has its
      // payment method and active subscription at this point, and the
      // dialog can be deterministically reopened the same way 6.6 opened
      // it the first time.
      await page.goto(`${BASE_URL}/payments`);
      await page.getByRole('button', { name: 'Delete Payment Method & Cancel Subscription', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Cancel Subscription', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Finish Cancellation' }).click();

      // /payments immediately shows 'No Payment Method' (the payment method
      // itself IS removed right away) - the 'Current Payment Method' block
      // is gone too, with no manual reload needed.
      await expect(page.getByRole('heading', { name: 'No Payment Method', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Current Payment Method' })).toHaveCount(0);

      // 2. Navigate to /subscription.
      await page.goto(`${BASE_URL}/subscription`);

      // The page shows the plan is still active but will lose these
      // features on the specific date from the 6.6 dialog unless
      // resubscribed - the plan card still shows 'Currently Subscribed!',
      // and the action button has changed from 'Cancel Subscription' to
      // 'Resume Subscription'. Live-verified character-for-character while
      // writing this suite (matched via regex for the message since the
      // exact date depends on when this test runs).
      await expect(page.getByText(/^You are currently on the Job Link Pro \(Monthly\) plan\. You will lose these features on .+ unless you resubscribe\.$/)).toBeVisible();
      await expect(page.getByText('Currently Subscribed!', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Resume Subscription', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Cancel Subscription', exact: true })).toHaveCount(0);

      // This confirms the dialog's promise from 6.6 held exactly: removing
      // the payment method schedules the subscription to cancel at the end
      // of the current billing period, does NOT cancel access immediately,
      // and the user retains a path to resume before that date - a
      // well-implemented, non-punitive cancellation flow, not a bug.
    });
  });
});
