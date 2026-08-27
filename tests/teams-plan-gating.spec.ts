// spec: specs/teams-plan-gating-test-plan.md
// seed: tests/seed.spec.ts

import { test, expect, Page, devices } from '@playwright/test';
import { MongoClient } from 'mongodb';
import { requireEnv } from './utils/env';
import { getVerificationLink } from './utils/email';
import { generateUniqueEmailAlias, generateUsernameFromEmail, registerNewAccount, completeProfile } from './utils/account';

const BASE_URL = requireEnv('BASE_URL');
const STRIPE_KEY = requireEnv('STRIPE_TEST_RESTRICTED_KEY');
const STRIPE_API = 'https://api.stripe.com/v1';
const MONGO_URI = requireEnv('MONGODB_PRESTAGING_URI');

let disposableUsername: string;
let disposablePassword: string;
let stripeCustomerId: string;
let stripeSubscriptionId: string;

// This file's CI-only Chromium software-rendering flags (same GPU/hCaptcha
// gotcha documented in CLAUDE.md for subscription.spec.ts - this file's
// own beforeAll also does a real Stripe Checkout purchase). Lives in this
// file's own dedicated `chromium-teams-plan-gating` project below and in
// playwright.config.ts, NOT as a file-level test.use({ launchOptions })
// here - live-verified in subscription.spec.ts's own history that a
// file-level test.use({ launchOptions }) gets applied across every
// project attempting the file when CI runs without a --project filter,
// crashing webkit/firefox outright (they don't understand Chromium
// flags). See the `chromium-teams-plan-gating` project's own comment in
// playwright.config.ts.

// --- Stripe REST API helpers ---
//
// This file drives a real Stripe Test Clock directly via the REST API
// (not through the browser) to simulate a subscription genuinely lapsing
// to Free - something no amount of UI interaction can do within a test
// run's timespan. See CLAUDE.md's "Optional: Stripe restricted key..."
// section and specs/teams-plan-gating-test-plan.md for the full
// reasoning. Plain fetch() with manual Basic Auth, matching the exact
// pattern already live-verified via curl throughout this investigation -
// no need for the full `stripe` SDK for the handful of calls this file
// makes.
async function stripeRequest(method: 'GET' | 'POST', path: string, body?: Record<string, string>) {
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${STRIPE_KEY}:`).toString('base64')}`,
  };
  let requestBody: string | undefined;
  if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    requestBody = new URLSearchParams(body).toString();
  }
  const response = await fetch(`${STRIPE_API}${path}`, { method, headers, body: requestBody });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`Stripe API ${method} ${path} failed (${response.status}): ${JSON.stringify(json)}`);
  }
  return json;
}

async function stripeFindCustomerByEmail(email: string): Promise<string> {
  const result = await stripeRequest('GET', `/customers?email=${encodeURIComponent(email)}&limit=1`);
  if (!result.data?.length) {
    throw new Error(`No Stripe customer found for email ${email}`);
  }
  return result.data[0].id;
}

async function stripeFindActiveSubscription(customerId: string): Promise<{ id: string; currentPeriodEnd: number }> {
  const result = await stripeRequest('GET', `/subscriptions?customer=${customerId}&status=all&limit=1`);
  if (!result.data?.length) {
    throw new Error(`No subscription found for Stripe customer ${customerId}`);
  }
  const sub = result.data[0];
  const currentPeriodEnd = sub.items?.data?.[0]?.current_period_end;
  if (!currentPeriodEnd) {
    throw new Error(`Subscription ${sub.id} has no current_period_end on its first item: ${JSON.stringify(sub.items)}`);
  }
  return { id: sub.id, currentPeriodEnd };
}

// Polls a test clock until it's done processing (status 'ready'), or
// throws if it fails. Live-verified this genuinely takes real wall-clock
// time (a few seconds up to roughly a minute for a full-period advance in
// this project's own exploration) - not instantaneous.
async function pollTestClockUntilReady(clockId: string, maxWaitMs = 120_000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const clock = await stripeRequest('GET', `/test_helpers/test_clocks/${clockId}`);
    if (clock.status === 'ready') return clock;
    if (clock.status === 'internal_failure') {
      throw new Error(`Test clock ${clockId} failed: ${JSON.stringify(clock)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error(`Test clock ${clockId} did not reach 'ready' within ${maxWaitMs}ms`);
}

// Creates a test clock attached to an EXISTING customer (live-verified
// this works without any 'Automations' blocker on this Stripe account -
// see CLAUDE.md), then advances it past the subscription's real period
// end so the already-scheduled real cancellation (done via the app's own
// UI just before this is called) actually takes effect. Deliberately does
// NOT delete the clock afterward - this project's own live exploration
// found cleanup isn't required (test clocks auto-expire after 30 days
// per Stripe's own retention), and deleting one also deletes its attached
// customer, which would remove the very account this test just spent this
// whole beforeAll building.
async function attachClockAndAdvancePastPeriodEnd(customerId: string, currentPeriodEnd: number): Promise<void> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const clock = await stripeRequest('POST', '/test_helpers/test_clocks', {
    frozen_time: String(nowSeconds),
    name: 'teams-plan-gating-spec',
    customer: customerId,
  });
  await pollTestClockUntilReady(clock.id);

  // A one-hour buffer past the real period end, matching this
  // investigation's own live-verified exploration.
  const targetTime = currentPeriodEnd + 3_600;
  await stripeRequest('POST', `/test_helpers/test_clocks/${clock.id}/advance`, {
    frozen_time: String(targetTime),
  });
  await pollTestClockUntilReady(clock.id, 180_000);
}

// --- MongoDB read-only helper ---
//
// HARD RULE, no exceptions: this connection is a credential shared with
// real people outside this project, approved for READ-ONLY use on this
// investigation specifically (see CLAUDE.md). This is the ONLY function
// in this file that touches MongoDB - it must never call anything but
// find()/findOne(). Never add an insert/update/delete call here or
// anywhere else in this file.
async function getTierForStripeCustomer(customerId: string): Promise<string | null> {
  const client = new MongoClient(MONGO_URI);
  try {
    await client.connect();
    const db = client.db();
    const userDoc = await db.collection('users').findOne({ stripe_id: customerId });
    if (!userDoc) return null;
    const tierDoc = await db.collection('tier_subscription_view').findOne({ user_id: userDoc._id.toString() });
    return tierDoc?.tier ?? null;
  } finally {
    await client.close();
  }
}

// --- App login/navigation and plan-card helpers, duplicated from
// subscription.spec.ts per this project's established per-file-helper
// convention (see that file's own identical comment on why these aren't
// shared via tests/utils/) ---
async function loginAsDisposableAndGoToCompany(page: Page) {
  await page.goto(`${BASE_URL}/login`);
  await page.locator('input[name="username"]').fill(disposableUsername);
  await page.locator('input[name="password"]').fill(disposablePassword);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });
  await page.goto(`${BASE_URL}/company`);
}

const SELECTED_CARD_BACKGROUND = 'rgba(255, 196, 0, 0.25)';

async function getPlanCardState(page: Page, planName: string): Promise<{ selected: boolean; cursor: string; text: string }> {
  return page.evaluate(
    ({ name, selectedBg }) => {
      const heading = Array.from(document.querySelectorAll('h4')).find((h) => h.textContent === name);
      if (!heading) throw new Error(`No plan card heading found for "${name}"`);
      const card = heading.parentElement?.parentElement;
      if (!card) throw new Error(`Could not find card ancestor for "${name}"`);
      const style = getComputedStyle(card);
      return { selected: style.backgroundColor === selectedBg, cursor: style.cursor, text: card.textContent || '' };
    },
    { name: planName, selectedBg: SELECTED_CARD_BACKGROUND }
  );
}

async function clickPlanCard(page: Page, planName: string) {
  await page.getByRole('heading', { name: planName, exact: true }).click();
}

async function selectPlanAndContinue(page: Page, planName: string) {
  const state = await getPlanCardState(page, planName);
  if (!state.selected) {
    await clickPlanCard(page, planName);
  }
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
}

async function cancelSubscriptionAndFinish(page: Page) {
  await page.getByRole('button', { name: 'Cancel Subscription', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Cancel Subscription', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Finish Cancellation' }).click();
  await expect(page.getByText(/^You are currently on the .+ plan\. You will lose these features on .+ unless you resubscribe\.$/)).toBeVisible();
}

test.describe('Teams Plan Gating', () => {
  test.describe.configure({ mode: 'serial' });

  // Account does not touch the shared seed account: a fresh disposable
  // account gets its own fully isolated Company/Payments/Subscription
  // record, the same account-isolation reasoning established for
  // Payments/Teams/Subscription (see CLAUDE.md's "Account/company
  // isolation" section). Register ONE disposable account ONCE here, drive
  // it through a real purchase + real cancellation + a real Stripe Test
  // Clock advance past its period end, then run every scenario below
  // serially against that one now-genuinely-lapsed account.
  test.beforeAll(async ({ browser, browserName }) => {
    // See subscription.spec.ts's identical guard for why this is needed
    // on beforeAll itself, not just inside beforeEach below.
    test.skip(
      browserName !== 'chromium',
      'Disposable single-account state built up sequentially across this file; runs once serially on chromium to avoid cross-project races, redundant registrations, and extra real-email load on the other 2 projects.'
    );

    // This setup does a lot of real, slow work: registration + a real
    // email + a real Stripe Checkout purchase + a real in-app
    // cancellation + creating and advancing a real Stripe test clock
    // (itself live-verified to take real wall-clock time to process - up
    // to roughly a minute for a full-period advance). Generous budget,
    // matching subscription.spec.ts's own beforeAll reasoning for the
    // same class of real-email + real-Stripe setup.
    test.setTimeout(960_000);

    // browser.newPage() alone drops this project's configured
    // devices['Desktop Chrome'] context options (notably the user agent),
    // which live-verified elsewhere in this project can make a real
    // verification email never arrive within budget - see CLAUDE.md.
    const context = await browser.newContext({ ...devices['Desktop Chrome'] });
    const page = await context.newPage();

    const emailAlias = generateUniqueEmailAlias();
    disposableUsername = generateUsernameFromEmail(emailAlias);
    disposablePassword = requireEnv('TEST_REGISTER_PASSWORD');
    const registeredAt = new Date();

    // 1. Register + verify + complete profile - standard pattern, no new
    // findings expected here (see specs/teams-plan-gating-test-plan.md
    // Suite 1.1 step 1).
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

    // 2. Purchase Job Link Pro (Monthly) via a real Stripe Checkout round
    // trip - reusing the exact pattern subscription.spec.ts test 4.2
    // already proved reliable, including its two live-verified fixes
    // (accessible-name-based field selectors, no premature .count() check).
    await page.goto(`${BASE_URL}/subscription`);
    await selectPlanAndContinue(page, 'Job Link Pro');
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
      await cardholderNameField.fill('QA Plan Gating Test');
    }
    // Deliberately never touches the 'I am an AI agent...' checkbox - see
    // subscription-test-plan.md overview finding 7 for why.
    const payButton = page.getByRole('button', { name: /Subscribe|Pay/ });
    await expect(payButton).toBeVisible();
    await payButton.click();
    await expect(page).toHaveURL(/\/subscription\?success=true/, { timeout: 45_000 });

    // 3. Schedule a REAL cancellation via the app's own Cancel
    // Subscription -> Finish Cancellation flow (matches
    // subscription.spec.ts Suite 7's already-proven behavior exactly).
    await page.goto(`${BASE_URL}/subscription`);
    await cancelSubscriptionAndFinish(page);

    await context.close();

    // 4. Find this account's real Stripe customer + subscription, then
    // drive a real Stripe Test Clock past the period end so the
    // already-scheduled cancellation actually takes effect - live-
    // verified via this exact sequence during this plan's own
    // exploration (see specs/teams-plan-gating-test-plan.md Suite 1.1).
    stripeCustomerId = await stripeFindCustomerByEmail(emailAlias);
    const { id: subId, currentPeriodEnd } = await stripeFindActiveSubscription(stripeCustomerId);
    stripeSubscriptionId = subId;
    await attachClockAndAdvancePastPeriodEnd(stripeCustomerId, currentPeriodEnd);

    // 5. Ground-truth confirmation the lapse is real, independent of
    // anything the UI will show next - this test's own equivalent of
    // subscription.spec.ts's "don't trust the toast" gotcha family:
    // verify against the real backend state, not an assumption.
    const finalSub = await stripeRequest('GET', `/subscriptions/${stripeSubscriptionId}`);
    if (finalSub.status !== 'canceled') {
      throw new Error(
        `Expected subscription ${stripeSubscriptionId} to be canceled after advancing the test clock past its period end, but status is "${finalSub.status}". Aborting - every test below assumes a genuinely lapsed account.`
      );
    }
  });

  test.beforeEach(async ({ page, browserName }) => {
    test.skip(
      browserName !== 'chromium',
      'Disposable single-account state built up sequentially across this file; runs once serially on chromium to avoid cross-project races and redundant registrations.'
    );
    await loginAsDisposableAndGoToCompany(page);
  });

  test.describe('Teams — Does Plan Gating Actually Block Anything?', () => {
    test('2.1 REAL FINDING: creating a team on a genuinely lapsed (no active subscription) account succeeds completely, with no restriction of any kind @real-email', async ({ page }) => {
      // 1. On the lapsed account, navigate to /teams and confirm '+ Create
      // Team'/'Invite Member' are enabled, not just present.
      await page.goto(`${BASE_URL}/teams`);
      const createTeamButton = page.getByRole('button', { name: '+ Create Team', exact: true });
      const inviteMemberButton = page.getByRole('button', { name: 'Invite Member', exact: true });
      await expect(createTeamButton).toBeEnabled();
      await expect(inviteMemberButton).toBeEnabled();

      // 2. Actually complete the flow - not just checking the button's
      // disabled state, but that the server genuinely allows the action.
      // Live-verified 2026-08-27: this succeeds with zero restriction.
      await createTeamButton.click();
      await expect(page.getByRole('heading', { name: 'Create Team', exact: true })).toBeVisible();
      const teamName = `QA Plan Gating ${Date.now()}`;
      await page.getByRole('textbox', { name: 'Name' }).fill(teamName);
      const createButton = page.getByRole('button', { name: 'Create', exact: true });
      await expect(createButton).toBeEnabled();
      await createButton.click();

      await expect(page).toHaveURL(/\/teams\/list/, { timeout: 15_000 });
      // Live-verified 2026-08-27 (this exact automated run): the dialog
      // doesn't close straight to the team list - it shows a confirmation
      // sub-state first (still titled 'Create Team', with the success
      // message and a 'Continue' button) that must be dismissed before the
      // new team's card becomes visible.
      await expect(page.getByText('Your team was created successfully!', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await expect(page.getByRole('heading', { name: teamName, exact: true })).toBeVisible();
    });

    test("2.2 REAL FINDING: 'Invite Member' also opens with no restriction on the same lapsed account @real-email", async ({ page }) => {
      await page.goto(`${BASE_URL}/teams`);
      await page.getByRole('button', { name: 'Invite Member', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Invite Member', exact: true })).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Add People by Email' })).toBeVisible();
    });

    test("2.3 REAL FINDING: Integrations, on the exact same lapsed account, correctly IS gated — confirming Teams' lack of gating is a real gap, not a universal limitation of this account state @real-email", async ({ page }) => {
      await page.goto(`${BASE_URL}/company`);
      await expect(
        page.getByText('Integrations are only available with a Job Link Pro or a Job Link Pro + Invoicing Subscription.', { exact: true })
      ).toBeVisible();
    });
  });

  test.describe('Cross-Page Consistency on a Genuinely Lapsed Account', () => {
    test('3.1 REAL FINDING: /company and /subscription describe the exact same lapsed state with different, inconsistent text @real-email', async ({ page }) => {
      await page.goto(`${BASE_URL}/company`);
      await expect(page.getByText('No subscription', { exact: true })).toBeVisible();

      await page.goto(`${BASE_URL}/subscription`);
      await expect(page.getByText('Currently Subscribed!', { exact: true })).toBeVisible();
      const freeCard = await getPlanCardState(page, 'Job Link');
      expect(freeCard.text).toContain('Free');
    });

    test('3.2 Payment History and Payments correctly reflect the lapsed state without losing historical data @real-email', async ({ page }) => {
      await page.goto(`${BASE_URL}/company`);
      await expect(page.getByText('No Payment Method', { exact: true })).toBeVisible();

      // See CLAUDE.md's gotcha: wait for a real data row (.nth(1)), not
      // .first() (always the header, visible immediately).
      const grid = page.getByRole('grid');
      await expect(grid.getByRole('row').nth(1)).toBeVisible();
      const rowCount = await grid.getByRole('row').count();
      expect(rowCount).toBeGreaterThan(1);
    });
  });

  test.describe('MongoDB Consistency Check', () => {
    test("4.1 The user's stored plan tier in MongoDB (tier_subscription_view) matches what the UI and Stripe both show once genuinely lapsed @real-email", async () => {
      // See specs/teams-plan-gating-test-plan.md Suite 4 for the full,
      // live-verified schema mapping (users.stripe_id -> users._id ->
      // tier_subscription_view.user_id -> tier). Distinct tier values seen
      // across this database: free, pro, invoice, invoicing - assert NOT
      // a paid tier rather than assuming 'free' is the only possible
      // non-paid value, per that same section's own reasoning.
      const tier = await getTierForStripeCustomer(stripeCustomerId);
      expect(tier).not.toBeNull();
      expect(['pro', 'invoice', 'invoicing']).not.toContain(tier);
    });
  });
});
