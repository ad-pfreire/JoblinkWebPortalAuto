// spec: specs/teams-plan-gating-test-plan.md
// seed: tests/seed.spec.ts

import { test, expect, Page, devices } from '@playwright/test';
import { MongoClient } from 'mongodb';
import { requireEnv } from './utils/env';
import { getVerificationLink, getInvitationLink } from './utils/email';
import { generateUniqueEmailAlias, generateUsernameFromEmail, registerNewAccount, completeProfile } from './utils/account';

const BASE_URL = requireEnv('BASE_URL');
const STRIPE_KEY = requireEnv('STRIPE_TEST_RESTRICTED_KEY');
const STRIPE_API = 'https://api.stripe.com/v1';
const MONGO_URI = requireEnv('MONGODB_PRESTAGING_URI');

let disposableUsername: string;
let disposablePassword: string;
let stripeCustomerId: string;
let stripeSubscriptionId: string;
let memberUsername: string;
let ownerMongoId: string;
let memberMongoId: string;
let memberTierWhileOwnerActive: string | null;

// This file's CI-only Chromium software-rendering flags (see CLAUDE.md) live in its own dedicated project in playwright.config.ts, not a file-level test.use() here.

// --- Stripe REST API helpers ---
// Drives a real Stripe Test Clock directly via the REST API to simulate a
// subscription genuinely lapsing to Free - no UI interaction can do that within a test run's timespan (see CLAUDE.md).
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

/** Polls a test clock until 'ready', or throws on failure - a full-period advance can take up to roughly a minute. */
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

/** Attaches a test clock to an existing customer and advances it past the period end, so the scheduled cancellation takes effect (never deleted after - see CLAUDE.md). */
async function attachClockAndAdvancePastPeriodEnd(customerId: string, currentPeriodEnd: number): Promise<void> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const clock = await stripeRequest('POST', '/test_helpers/test_clocks', {
    frozen_time: String(nowSeconds),
    name: 'teams-plan-gating-spec',
    customer: customerId,
  });
  await pollTestClockUntilReady(clock.id);

  const targetTime = currentPeriodEnd + 3_600; // one-hour buffer past the real period end
  await stripeRequest('POST', `/test_helpers/test_clocks/${clock.id}/advance`, {
    frozen_time: String(targetTime),
  });
  await pollTestClockUntilReady(clock.id, 180_000);
}

// --- MongoDB read-only helpers --- HARD RULE (see CLAUDE.md): shared credential, only find()/findOne(), never write.
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

/** Extends finding 4 (a member's delegated tier never elevates to the owner's paid tier) across a real subscription lapse, not just while active. */
async function getUserByEmail(email: string) {
  const client = new MongoClient(MONGO_URI);
  try {
    await client.connect();
    return await client.db().collection('users').findOne({ email });
  } finally {
    await client.close();
  }
}

async function getDelegatedMembershipTier(ownerId: string, memberId: string): Promise<string | null> {
  const client = new MongoClient(MONGO_URI);
  try {
    await client.connect();
    const doc = await client.db().collection('account_memberships').findOne({ account_id: ownerId, user_id: memberId });
    return doc?.tier ?? null;
  } finally {
    await client.close();
  }
}

// --- App login/navigation and plan-card helpers, duplicated from subscription.spec.ts (see that file's own comment on why these aren't shared) ---
async function loginAsDisposableAndGoToCompany(page: Page) {
  await page.goto(`${BASE_URL}/login`);
  await page.locator('input[name="username"]').fill(disposableUsername);
  await page.locator('input[name="password"]').fill(disposablePassword);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });
  await page.goto(`${BASE_URL}/company`);
}

// Generic login for the second (member) disposable account - every
// disposable account in this project shares the same TEST_REGISTER_PASSWORD
// value, so disposablePassword works for both.
async function loginAs(page: Page, username: string) {
  await page.goto(`${BASE_URL}/login`);
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(disposablePassword);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });
}

// Reuses the exact invite -> real email -> accept pattern already proven in
// teams.spec.ts test 6.7 and account-deletion-billing.spec.ts.
async function inviteAndAcceptMember(
  ownerPage: Page,
  browser: import('@playwright/test').Browser,
  memberEmail: string,
  memberUsernameArg: string
) {
  await ownerPage.goto(`${BASE_URL}/teams/members`);
  await ownerPage.getByRole('button', { name: 'Invite Member' }).click();
  await expect(ownerPage.getByRole('heading', { name: 'Invite Member' })).toBeVisible();
  const combobox = ownerPage.getByRole('combobox', { name: 'Add People by Email' });
  await combobox.click();
  await combobox.pressSequentially(memberEmail);
  await ownerPage.keyboard.press('Enter');
  await ownerPage.getByRole('button', { name: 'Invite' }).click();
  await expect(ownerPage.getByText('Your invitation(s) have been sent.', { exact: true })).toBeVisible();

  const invitationLink = await getInvitationLink(memberEmail, 240_000);

  const memberContext = await browser.newContext({ ...devices['Desktop Chrome'] });
  const memberPage = await memberContext.newPage();
  await loginAs(memberPage, memberUsernameArg);
  await memberPage.goto(invitationLink);
  await expect(memberPage.getByText('You’ve been invited!', { exact: true })).toBeVisible();
  await memberPage.getByTestId('accept-btn').click();
  await expect(memberPage).toHaveURL(`${BASE_URL}/company`, { timeout: 15_000 });
  await memberContext.close();
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
  await expect(
    page.getByText(/^You are currently on the .+ plan\. You will lose these features on .+ unless you resubscribe\.$/)
  ).toBeVisible();
}

test.describe('Teams Plan Gating', () => {
  test.describe.configure({ mode: 'serial' });

  // Registers ONE disposable account here, drives it through a real
  // purchase + cancellation + Test Clock advance past its period end, then
  // runs every scenario serially against that one now-lapsed account (see CLAUDE.md's account-isolation pattern).
  test.beforeAll(async ({ browser, browserName }) => {
    // Guarded here too, not just beforeEach - a beforeEach skip doesn't gate beforeAll (see CLAUDE.md).
    test.skip(
      browserName !== 'chromium',
      'Disposable single-account state built up sequentially across this file; runs once serially on chromium to avoid cross-project races, redundant registrations, and extra real-email load on the other 2 projects.'
    );

    // Two real registrations/emails, an invitation round trip, a real
    // Stripe purchase, a real cancellation, and a real Test Clock advance - generous headroom for it all.
    test.setTimeout(1_800_000);

    // newContext() with the device profile, not bare newPage() - see CLAUDE.md's real-email delivery gotcha.
    const context = await browser.newContext({ ...devices['Desktop Chrome'] });
    const page = await context.newPage();

    const emailAlias = generateUniqueEmailAlias();
    disposableUsername = generateUsernameFromEmail(emailAlias);
    disposablePassword = requireEnv('TEST_REGISTER_PASSWORD');
    const registeredAt = new Date();

    // 1. Register + verify + complete profile - standard pattern.
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

    // 2. Purchase Job Link Pro (Monthly) via real Stripe Checkout (same pattern as subscription.spec.ts test 4.2).
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

    // 2b. While the owner is still genuinely Pro/active, register a second
    // MEMBER account, invite and accept, then capture the member's
    // delegated tier now - the "before" half of extending finding 4 across a real lapse.
    const memberSetupContext = await browser.newContext({ ...devices['Desktop Chrome'] });
    const memberSetupPage = await memberSetupContext.newPage();
    const memberEmailAlias = generateUniqueEmailAlias();
    memberUsername = generateUsernameFromEmail(memberEmailAlias);
    const memberRegisteredAt = new Date();
    await registerNewAccount(memberSetupPage, memberEmailAlias);
    const memberVerificationLink = await getVerificationLink(memberEmailAlias, memberRegisteredAt, 900_000);
    await memberSetupPage.goto(memberVerificationLink);
    await expect(memberSetupPage).toHaveURL(`${BASE_URL}/login`);
    await memberSetupPage.locator('input[name="username"]').fill(memberUsername);
    await memberSetupPage.locator('input[name="password"]').fill(disposablePassword);
    await memberSetupPage.locator('button[type="submit"]').click();
    await expect(memberSetupPage).toHaveURL(`${BASE_URL}/complete-profile`);
    await completeProfile(memberSetupPage);
    await expect(memberSetupPage).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });
    await memberSetupContext.close();

    await inviteAndAcceptMember(page, browser, memberEmailAlias, memberUsername);

    const ownerUserDoc = await getUserByEmail(emailAlias);
    const memberUserDoc = await getUserByEmail(memberEmailAlias);
    if (!ownerUserDoc || !memberUserDoc) {
      throw new Error(
        'Could not resolve owner/member Mongo user documents after invite/accept - aborting, every test below assumes both exist.'
      );
    }
    ownerMongoId = String(ownerUserDoc._id);
    memberMongoId = String(memberUserDoc._id);
    memberTierWhileOwnerActive = await getDelegatedMembershipTier(ownerMongoId, memberMongoId);

    // 3. Schedule a REAL cancellation via Cancel Subscription -> Finish Cancellation.
    await page.goto(`${BASE_URL}/subscription`);
    await cancelSubscriptionAndFinish(page);

    await context.close();

    // 4. Find the real Stripe customer/subscription, then advance a real Test Clock past the period end.
    stripeCustomerId = await stripeFindCustomerByEmail(emailAlias);
    const { id: subId, currentPeriodEnd } = await stripeFindActiveSubscription(stripeCustomerId);
    stripeSubscriptionId = subId;
    await attachClockAndAdvancePastPeriodEnd(stripeCustomerId, currentPeriodEnd);

    // 5. Ground-truth confirmation the lapse is real against the backend, not an assumption from the UI.
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
    test('2.1 REAL FINDING: creating a team on a genuinely lapsed (no active subscription) account succeeds completely, with no restriction of any kind @real-email', async ({
      page,
    }) => {
      // 1. On the lapsed account, navigate to /teams and confirm '+ Create
      // Team'/'Invite Member' are enabled, not just present.
      await page.goto(`${BASE_URL}/teams`);
      const createTeamButton = page.getByRole('button', { name: '+ Create Team', exact: true });
      const inviteMemberButton = page.getByRole('button', { name: 'Invite Member', exact: true });
      await expect(createTeamButton).toBeEnabled();
      await expect(inviteMemberButton).toBeEnabled();

      // 2. Complete the flow for real - the server genuinely allows it, with zero restriction.
      await createTeamButton.click();
      await expect(page.getByRole('heading', { name: 'Create Team', exact: true })).toBeVisible();
      const teamName = `QA Plan Gating ${Date.now()}`;
      await page.getByRole('textbox', { name: 'Name' }).fill(teamName);
      const createButton = page.getByRole('button', { name: 'Create', exact: true });
      await expect(createButton).toBeEnabled();
      await createButton.click();

      // The dialog shows a confirmation sub-state first (still 'Create
      // Team', with a 'Continue' button) before the new team's card appears.
      await expect(page).toHaveURL(/\/teams\/list/, { timeout: 15_000 });
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

    test("2.3 REAL FINDING: Integrations, on the exact same lapsed account, correctly IS gated — confirming Teams' lack of gating is a real gap, not a universal limitation of this account state @real-email", async ({
      page,
    }) => {
      await page.goto(`${BASE_URL}/company`);
      await expect(
        page.getByText('Integrations are only available with a Job Link Pro or a Job Link Pro + Invoicing Subscription.', { exact: true })
      ).toBeVisible();
    });
  });

  test.describe('Cross-Page Consistency on a Genuinely Lapsed Account', () => {
    test('3.1 REAL FINDING: /company and /subscription describe the exact same lapsed state with different, inconsistent text @real-email', async ({
      page,
    }) => {
      await page.goto(`${BASE_URL}/company`);
      await expect(page.getByText('No subscription', { exact: true })).toBeVisible();

      await page.goto(`${BASE_URL}/subscription`);
      await expect(page.getByText('Currently Subscribed!', { exact: true })).toBeVisible();
      const freeCard = await getPlanCardState(page, 'Job Link');
      expect(freeCard.text).toContain('Free');
    });

    test('3.2 Payment History and Payments correctly reflect the lapsed state without losing historical data @real-email', async ({
      page,
    }) => {
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
      // Schema: users.stripe_id -> users._id -> tier_subscription_view.user_id
      // -> tier (see CLAUDE.md). Asserts NOT a paid tier rather than assuming 'free' is the only non-paid value.
      const tier = await getTierForStripeCustomer(stripeCustomerId);
      expect(tier).not.toBeNull();
      expect(['pro', 'invoice', 'invoicing']).not.toContain(tier);
    });
  });

  test.describe("A Member's Delegated Tier Across a Real Subscription Lapse", () => {
    test("5.1 While the owner was still genuinely Pro/active, the invited member's own delegated tier was never elevated @real-email", async () => {
      // The "before" half, captured in beforeAll while the owner was still unambiguously paid/active.
      expect(memberTierWhileOwnerActive).not.toBeNull();
      expect(['pro', 'invoice', 'invoicing']).not.toContain(memberTierWhileOwnerActive);
    });

    test("5.2 After the owner's subscription genuinely LAPSED, the member's delegated tier is exactly unchanged from before the lapse @real-email", async () => {
      // The "after" half: confirms the member's tier was neither granted while the owner was paid (5.1) nor corrupted by the lapse itself.
      const memberTierAfterLapse = await getDelegatedMembershipTier(ownerMongoId, memberMongoId);
      expect(memberTierAfterLapse).toBe(memberTierWhileOwnerActive);
      expect(['pro', 'invoice', 'invoicing']).not.toContain(memberTierAfterLapse);
    });
  });
});
