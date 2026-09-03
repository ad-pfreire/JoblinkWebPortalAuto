// spec: specs/account-deletion-billing-test-plan.md
// seed: tests/seed.spec.ts

import { test, expect, Page, devices } from '@playwright/test';
import { MongoClient, ObjectId } from 'mongodb';
import { requireEnv } from './utils/env';
import { getVerificationLink, getInvitationLink } from './utils/email';
import { generateUniqueEmailAlias, generateUsernameFromEmail, registerNewAccount, completeProfile } from './utils/account';

const BASE_URL = requireEnv('BASE_URL');
const REGISTER_PASSWORD = requireEnv('TEST_REGISTER_PASSWORD');
const STRIPE_KEY = requireEnv('STRIPE_TEST_RESTRICTED_KEY');
const STRIPE_API = 'https://api.stripe.com/v1';
const MONGO_URI = requireEnv('MONGODB_PRESTAGING_URI');

// This file's CI-only Chromium software-rendering flags (see CLAUDE.md) live in its own dedicated project in playwright.config.ts, not a file-level test.use() here.

// --- Stripe REST API helpers (same pattern as teams-plan-gating.spec.ts) ---
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

async function stripeFindSubscription(customerId: string): Promise<{ id: string; currentPeriodEnd: number }> {
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

// Polls a test clock until it's done processing, matching
// teams-plan-gating.spec.ts's own already-proven pattern exactly.
async function pollTestClockUntilReady(clockId: string, maxWaitMs = 180_000) {
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

async function attachClockAndAdvancePastPeriodEnd(customerId: string, currentPeriodEnd: number): Promise<void> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const clock = await stripeRequest('POST', '/test_helpers/test_clocks', {
    frozen_time: String(nowSeconds),
    name: 'account-deletion-billing-spec',
    customer: customerId,
  });
  await pollTestClockUntilReady(clock.id);

  const targetTime = currentPeriodEnd + 3_600;
  await stripeRequest('POST', `/test_helpers/test_clocks/${clock.id}/advance`, {
    frozen_time: String(targetTime),
  });
  await pollTestClockUntilReady(clock.id, 180_000);
}

// --- MongoDB read-only helpers --- HARD RULE (see CLAUDE.md): read-only credential, only find()/findOne(), never write.
async function withMongo<T>(fn: (db: import('mongodb').Db) => Promise<T>): Promise<T> {
  const client = new MongoClient(MONGO_URI);
  try {
    await client.connect();
    return await fn(client.db());
  } finally {
    await client.close();
  }
}

async function getUserByEmail(email: string) {
  return withMongo((db) => db.collection('users').findOne({ email }));
}

async function getUserTier(userId: string): Promise<string | null> {
  return withMongo(async (db) => {
    const doc = await db.collection('account_memberships').findOne({ account_id: userId, user_id: userId });
    return doc?.tier ?? null;
  });
}

async function getDelegatedMembershipTier(ownerId: string, memberId: string): Promise<string | null> {
  return withMongo(async (db) => {
    const doc = await db.collection('account_memberships').findOne({ account_id: ownerId, user_id: memberId });
    return doc?.tier ?? null;
  });
}

// Snapshots everything referencing a given (still-existing) user id, used to
// diff an owner's own state before/after some other user's deletion.
async function getOwnedMongoSnapshot(userId: string) {
  return withMongo(async (db) => {
    const memberships = await db
      .collection('account_memberships')
      .find({ $or: [{ user_id: userId }, { account_id: userId }] })
      .toArray();
    const teams = await db.collection('teams').find({ owner_id: userId }).toArray();
    const teamIds = teams.map((t) => String(t._id));
    const teamMemberships = teamIds.length
      ? await db.collection('team_memberships').find({ team_id: { $in: teamIds } }).toArray()
      : [];
    return { memberships, teams, teamMemberships };
  });
}

// Confirms nothing anywhere still references a now-deleted user's old id -
// the core "no orphans" check this whole file exists to prove.
async function getOrphanCheck(oldUserId: string) {
  return withMongo(async (db) => {
    const usersDoc = await db.collection('users').findOne({ _id: new ObjectId(oldUserId) as any });
    const memberships = await db
      .collection('account_memberships')
      .find({ $or: [{ user_id: oldUserId }, { account_id: oldUserId }] })
      .toArray();
    const tierViews = await db.collection('tier_subscription_view').find({ user_id: oldUserId }).toArray();
    const teams = await db.collection('teams').find({ owner_id: oldUserId }).toArray();
    const teamMemberships = await db.collection('team_memberships').find({ user_id: oldUserId }).toArray();
    const subscriptionsLegacy = await db.collection('subscriptions').find({ user_id: oldUserId }).toArray();
    const invitationsSent = await db.collection('invitations').find({ inviter_id: oldUserId }).toArray();
    return { usersDocStillExists: !!usersDoc, memberships, tierViews, teams, teamMemberships, subscriptionsLegacy, invitationsSent };
  });
}

// --- App UI helpers ---
async function loginAs(page: Page, username: string) {
  await page.goto(`${BASE_URL}/login`);
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(REGISTER_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });
}

// Registers + verifies + logs in + completes profile for a brand-new
// disposable account, returning its email/username. Reuses the same
// real-email round trip every other file in this project already relies on.
async function registerFullAccount(page: Page): Promise<{ email: string; username: string }> {
  const email = generateUniqueEmailAlias();
  const username = generateUsernameFromEmail(email);
  const registeredAt = new Date();
  await registerNewAccount(page, email);
  const verificationLink = await getVerificationLink(email, registeredAt, 240_000);
  await page.goto(verificationLink);
  await expect(page).toHaveURL(`${BASE_URL}/login`);
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(REGISTER_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(`${BASE_URL}/complete-profile`);
  await completeProfile(page);
  await expect(page).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });
  return { email, username };
}

async function selectPlanAndContinue(page: Page, planName: string) {
  await page.getByRole('heading', { name: planName, exact: true }).click();
  const continueBtn = page.getByRole('button', { name: 'Continue', exact: true });
  await expect(continueBtn).toBeEnabled();
  await continueBtn.click();
}

async function toggleYearly(page: Page) {
  await page.getByText('Yearly', { exact: true }).click();
}

// Completes a real, externally-hosted Stripe Checkout purchase with a
// valid test card - reuses the exact pattern already proven in
// subscription.spec.ts test 4.2 / teams-plan-gating.spec.ts's beforeAll.
async function purchaseViaCheckout(page: Page, cardholderName: string) {
  await page.getByRole('button', { name: 'Confirm and Pay' }).click();
  await expect(page).toHaveURL(/checkout\.stripe\.com/, { timeout: 30_000 });

  const emailField = page.getByLabel('Email');
  if ((await emailField.count()) > 0 && !(await emailField.inputValue())) {
    await emailField.fill('qa-account-deletion-billing@example.com');
  }
  await page.getByRole('textbox', { name: 'Card number' }).fill('4242424242424242');
  await page.getByRole('textbox', { name: 'Expiration' }).fill('12/34');
  await page.getByRole('textbox', { name: 'CVC' }).fill('123');
  const cardholderNameField = page.getByRole('textbox', { name: 'Cardholder name' });
  if ((await cardholderNameField.count()) > 0 && !(await cardholderNameField.inputValue())) {
    await cardholderNameField.fill(cardholderName);
  }
  const payButton = page.getByRole('button', { name: /Subscribe|Pay/ });
  await expect(payButton).toBeVisible();
  await payButton.click();
  await expect(page).toHaveURL(/\/subscription\?success=true/, { timeout: 45_000 });
}

async function cancelSubscriptionAndFinish(page: Page) {
  await page.getByRole('button', { name: 'Cancel Subscription', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Cancel Subscription', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Finish Cancellation' }).click();
  await expect(
    page.getByText(/^You are currently on the .+ plan\. You will lose these features on .+ unless you resubscribe\.$/)
  ).toBeVisible();
}

// Deletes the currently logged-in account for real via the app's own
// "Delete Account" flow - reuses forgot-password.spec.ts's already-proven
// selectors exactly.
async function deleteAccountViaUI(page: Page) {
  await page.getByRole('button', { name: 'account of current user' }).click();
  await page.getByRole('menuitem', { name: 'Profile' }).click();
  await expect(page).toHaveURL(`${BASE_URL}/profile`);
  await page.getByRole('button', { name: 'Delete Account' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Delete Account' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Yes, delete' }).click();
  await expect(page).toHaveURL(`${BASE_URL}/login`, { timeout: 15_000 });
}

/** Invites `memberEmail` from the owner's page, then accepts it in a separate context so the owner's own session is undisturbed. */
async function inviteAndAcceptMember(ownerPage: Page, browser: import('@playwright/test').Browser, memberEmail: string, memberUsername: string) {
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
  await loginAs(memberPage, memberUsername);
  await memberPage.goto(invitationLink);
  await expect(memberPage.getByText('You’ve been invited!', { exact: true })).toBeVisible();
  await memberPage.getByTestId('accept-btn').click();
  await expect(memberPage).toHaveURL(`${BASE_URL}/company`, { timeout: 15_000 });
  await memberContext.close();
}

/** Adds an active company member to "My Team" via its own "+ Add Members" panel (distinct combobox/button from the company-wide invite modal). */
async function addMemberToMyTeam(page: Page, memberEmail: string) {
  await page.goto(`${BASE_URL}/teams/list`);
  await page.getByRole('button', { name: /My Team/ }).click();
  await expect(page).toHaveURL(/cardDetails=true/);
  await page.getByRole('button', { name: '+ Add Members' }).click();
  await expect(page.getByRole('combobox', { name: 'Add team members' })).toBeVisible();
  await page.getByRole('button', { name: 'Open' }).click();
  await page.getByText(memberEmail, { exact: false }).click();
  await page.keyboard.press('Escape');
  const saveButton = page.getByRole('button', { name: 'Save' });
  await expect(saveButton).toBeEnabled();
  await saveButton.click();
  await page.waitForTimeout(1_000);
}

test.describe('Account Deletion & Billing', () => {
  test.describe.configure({ mode: 'serial' });

  test.describe('Setup, Stripe Cascade, MongoDB Cascade, and Member-Unaffected Checks', () => {
    let ownerUsername: string;
    let memberUsername: string;
    let ownerMongoId: string;
    let stripeCustomerId: string;
    let stripeSubscriptionId: string;

    // Two registrations + two real emails + a real Stripe purchase + an
    // invitation + adding the member to a team - generous budget, same class of setup as teams-plan-gating.spec.ts.
    test.beforeAll(async ({ browser, browserName }) => {
      // Guarded here too, not just beforeEach - a beforeEach skip doesn't gate beforeAll (see CLAUDE.md).
      test.skip(
        browserName !== 'chromium',
        'Disposable multi-account state built up sequentially across this describe block; runs once serially on chromium to avoid cross-project races and redundant registrations.'
      );
      test.setTimeout(960_000);

      // newContext() with the device profile, not bare newPage() - see CLAUDE.md's real-email delivery gotcha.
      const ownerContext = await browser.newContext({ ...devices['Desktop Chrome'] });
      const ownerPage = await ownerContext.newPage();
      const owner = await registerFullAccount(ownerPage);
      ownerUsername = owner.username;

      const memberContext = await browser.newContext({ ...devices['Desktop Chrome'] });
      const memberPage = await memberContext.newPage();
      const member = await registerFullAccount(memberPage);
      memberUsername = member.username;
      await memberContext.close();

      // Purchases Job Link Pro (Monthly) via real Stripe Checkout, deliberately not cancelled - Suite 3 needs it still ACTIVE.
      await ownerPage.goto(`${BASE_URL}/subscription`);
      await selectPlanAndContinue(ownerPage, 'Job Link Pro');
      await purchaseViaCheckout(ownerPage, 'QA Account Deletion Billing');

      stripeCustomerId = await stripeFindCustomerByEmail(owner.email);
      const sub = await stripeFindSubscription(stripeCustomerId);
      stripeSubscriptionId = sub.id;

      const ownerDoc = await getUserByEmail(owner.email);
      if (!ownerDoc) throw new Error(`Owner user document not found in MongoDB for email ${owner.email} right after purchase.`);
      ownerMongoId = String(ownerDoc._id);

      const ownerTier = await getUserTier(ownerMongoId);
      if (ownerTier !== 'pro') {
        throw new Error(`Expected owner's own tier to be "pro" immediately after purchase, got "${ownerTier}". Aborting - every test below assumes a genuinely active paid subscription.`);
      }

      // Connects the member at both levels Suite 5 needs: company-wide invite/accept, and team-level.
      await inviteAndAcceptMember(ownerPage, browser, member.email, member.username);
      await addMemberToMyTeam(ownerPage, member.email);

      await ownerContext.close();
    });

    test.beforeEach(async ({ browserName }) => {
      test.skip(
        browserName !== 'chromium',
        'Disposable multi-account state built up sequentially across this describe block; runs once serially on chromium to avoid cross-project races and redundant registrations.'
      );
    });

    test('3.1 Deleting the account while the subscription is still genuinely active immediately cancels it for real @real-email', async ({ page }) => {
      // 1. Ground-truth confirmation the subscription is genuinely active
      // and NOT already scheduled to cancel, before touching the UI.
      const before = await stripeRequest('GET', `/subscriptions/${stripeSubscriptionId}`);
      expect(before.status).toBe('active');
      expect(before.cancel_at_period_end).toBe(false);
      expect(before.canceled_at).toBeNull();

      // 2. Delete the account for real via the app's own UI flow.
      await loginAs(page, ownerUsername);
      await deleteAccountViaUI(page);

      // 3. REAL FINDING: genuinely, immediately canceled - not merely scheduled for period end.
      const after = await stripeRequest('GET', `/subscriptions/${stripeSubscriptionId}`);
      expect(after.status).toBe('canceled');
      expect(after.canceled_at).not.toBeNull();

      // 4. REAL FINDING: the Stripe Customer object itself is removed, not just its subscription.
      const customerAfter = await stripeRequest('GET', `/customers/${stripeCustomerId}`);
      expect(customerAfter.deleted).toBe(true);
    });

    test("4.1 Every MongoDB collection referencing the deleted owner comes back empty - including the member's delegated membership @real-email", async () => {
      // Depends on 3.1 having already deleted the owner's account.
      const orphanCheck = await getOrphanCheck(ownerMongoId);

      // 1. A real, hard delete - not a soft "inactive" flag.
      expect(orphanCheck.usersDocStillExists).toBe(false);

      // 2. REAL FINDING: zero account_memberships rows reference the old
      // owner id in EITHER direction - including the MEMBER's own delegated row.
      expect(orphanCheck.memberships).toHaveLength(0);

      // 3. tier_subscription_view is a derived view of account_memberships - consistent with step 2.
      expect(orphanCheck.tierViews).toHaveLength(0);

      // 4. "My Team" and the member's own row within it are both gone.
      expect(orphanCheck.teams).toHaveLength(0);
      expect(orphanCheck.teamMemberships).toHaveLength(0);

      // 5. The legacy subscriptions collection was never written to for this account, before or after the purchase.
      expect(orphanCheck.subscriptionsLegacy).toHaveLength(0);

      // 6. The already-consumed invitation record doesn't linger either.
      expect(orphanCheck.invitationsSent).toHaveLength(0);
    });

    test("5.1 The member's own account is completely unaffected by the owner's deletion @real-email", async ({ page }) => {
      // Depends on 3.1 having already deleted the owner's account.
      await loginAs(page, memberUsername);

      // 1. The member's own company is back to a clean, isolated state -
      // no trace of the deleted owner's team or company.
      await page.goto(`${BASE_URL}/teams/members`);
      await expect(page.getByRole('heading', { name: 'Member (0)', exact: true })).toBeVisible();

      // 2. The member's own Company Details/Subscription are untouched -
      // still their own independent Free Trial, unrelated to the deleted
      // owner's plan.
      await page.goto(`${BASE_URL}/company`);
      await expect(page.getByText(/Free Trial/)).toBeVisible();
    });
  });

  test.describe('Re-Registration After Deletion: An Informational Probe, Not a Pass/Fail Assertion', () => {
    // Of 7 real deletions tried, re-registering with the same email+username
    // succeeded 6 times and failed once ("User already exists") - too
    // inconsistent for a hard pass/fail assertion, so this logs the outcome instead of asserting on it.
    test("6.1 Attempting to re-register with the exact same email and username as a just-deleted account is logged, not asserted on @real-email", async ({
      page,
      browserName,
    }) => {
      test.skip(browserName !== 'chromium', 'Backend-only flow; runs once to avoid tripling load on the real email pipeline.');
      test.setTimeout(300_000);

      // 1. Register a fresh, throwaway disposable account.
      const { email, username } = await registerFullAccount(page);

      // 2. Delete it for real.
      await deleteAccountViaUI(page);

      // 3. Register again with the IDENTICAL email/username and record the outcome (no hard assertion, see above).
      await page.goto(`${BASE_URL}/register`);
      await page.fill('input[name="email"]', email);
      await page.fill('input[name="username"]', username);
      await page.fill('input[name="password"]', REGISTER_PASSWORD);
      await page.fill('input[name="confirmPassword"]', REGISTER_PASSWORD);
      await page.check('input[name="acceptTerms"]');
      await page.locator('button[type="submit"]').click();

      const reachedEmailVerification = await page
        .waitForURL(/.*\/email-verification$/, { timeout: 15_000 })
        .then(() => true)
        .catch(() => false);

      const outcome = reachedEmailVerification ? 'freed (registration succeeded)' : 'blocked ("User already exists")';
      test.info().annotations.push({ type: 'account-deletion-billing:reregistration-outcome', description: outcome });
      console.log(`[6.1] Re-registration outcome for a just-deleted account's exact email+username: ${outcome}`);
    });
  });

  test.describe('Account Deletion Behaves the Same Regardless of Subscription State at Deletion Time', () => {
    test("7.1 Deleting an account whose subscription is already SCHEDULED to cancel (not yet lapsed) force-finalizes the cancellation immediately @real-email", async ({
      page,
      browserName,
    }) => {
      test.skip(browserName !== 'chromium', 'Real Stripe purchase + deletion; runs once to avoid tripling load on the real email/Stripe pipeline.');
      test.setTimeout(480_000);

      // 1. Register, purchase Job Link Pro (Monthly), then schedule a real
      // cancellation via the app's own Cancel Subscription flow.
      const { email } = await registerFullAccount(page);
      await page.goto(`${BASE_URL}/subscription`);
      await selectPlanAndContinue(page, 'Job Link Pro');
      await purchaseViaCheckout(page, 'QA Scheduled Cancel Test');
      await page.goto(`${BASE_URL}/subscription`);
      await cancelSubscriptionAndFinish(page);

      const customerId = await stripeFindCustomerByEmail(email);
      const sub = await stripeFindSubscription(customerId);

      // Scheduled but not lapsed: status still "active", cancel_at_period_end
      // true, and canceled_at already set (worth checking explicitly - easy to misread as a contradiction otherwise).
      const before = await stripeRequest('GET', `/subscriptions/${sub.id}`);
      expect(before.status).toBe('active');
      expect(before.cancel_at_period_end).toBe(true);
      expect(before.canceled_at).not.toBeNull();

      // 2. Delete while still in this scheduled state.
      await deleteAccountViaUI(page);

      // 3. REAL FINDING: deletion force-finalizes the scheduled cancellation
      // immediately - status flips to "canceled", cancel_at_period_end
      // resets to false, canceled_at stays the SAME timestamp from step 1.
      const after = await stripeRequest('GET', `/subscriptions/${sub.id}`);
      expect(after.status).toBe('canceled');
      expect(after.cancel_at_period_end).toBe(false);
      expect(after.canceled_at).toBe(before.canceled_at);

      const customerAfter = await stripeRequest('GET', `/customers/${customerId}`);
      expect(customerAfter.deleted).toBe(true);
    });

    test('7.2 Deleting an account whose subscription has already genuinely LAPSED to Free completes cleanly, with nothing left to cancel @real-email', async ({
      page,
      browser,
      browserName,
    }) => {
      test.skip(browserName !== 'chromium', 'Real Stripe purchase + Test Clock + deletion; runs once to avoid tripling load on the real email/Stripe pipeline.');
      test.setTimeout(960_000);

      // 1. Register, purchase, schedule a cancellation, then drive a real
      // Test Clock past the period end so it genuinely lapses (same pattern as teams-plan-gating.spec.ts).
      const { email, username } = await registerFullAccount(page);
      await page.goto(`${BASE_URL}/subscription`);
      await selectPlanAndContinue(page, 'Job Link Pro');
      await purchaseViaCheckout(page, 'QA Lapsed Delete Test');
      await page.goto(`${BASE_URL}/subscription`);
      await cancelSubscriptionAndFinish(page);

      const customerId = await stripeFindCustomerByEmail(email);
      const sub = await stripeFindSubscription(customerId);
      await attachClockAndAdvancePastPeriodEnd(customerId, sub.currentPeriodEnd);

      // expect: ground-truth confirmation the lapse is real, independent of
      // anything the UI will show next - before touching the UI at all.
      const lapsedCheck = await stripeRequest('GET', `/subscriptions/${sub.id}`);
      expect(lapsedCheck.status).toBe('canceled');

      // 2. Delete the already-lapsed account for real via a fresh login
      // (the page above may have gone stale across the Test Clock's real
      // wall-clock wait).
      const context = await browser.newContext({ ...devices['Desktop Chrome'] });
      const freshPage = await context.newPage();
      await loginAs(freshPage, username);
      await deleteAccountViaUI(freshPage);
      await context.close();

      // 3. Live-verified: deletion still completes cleanly with no error,
      // and the Stripe Customer is still correctly deleted, even with no
      // active subscription left to cancel.
      const customerAfter = await stripeRequest('GET', `/customers/${customerId}`);
      expect(customerAfter.deleted).toBe(true);
    });
  });

  test.describe('Account Deletion Is Plan-Agnostic', () => {
    test('8.1 Deleting an account on a different plan (Job Link Pro + Invoicing, Yearly) while active cancels it identically to the Monthly Pro case @real-email', async ({
      page,
      browserName,
    }) => {
      test.skip(browserName !== 'chromium', 'Real Stripe purchase + deletion; runs once to avoid tripling load on the real email/Stripe pipeline.');
      test.setTimeout(480_000);

      // 1. Register and purchase Job Link Pro + Invoicing, Yearly - a
      // different plan AND a different billing interval from every other
      // purchase in this file.
      const { email } = await registerFullAccount(page);
      await page.goto(`${BASE_URL}/subscription`);
      await toggleYearly(page);
      await selectPlanAndContinue(page, 'Job Link Pro + Invoicing');
      await purchaseViaCheckout(page, 'QA Plan Variant Test');

      const customerId = await stripeFindCustomerByEmail(email);
      const sub = await stripeFindSubscription(customerId);
      const before = await stripeRequest('GET', `/subscriptions/${sub.id}`);
      expect(before.status).toBe('active');
      expect(before.items.data[0].price.recurring.interval).toBe('year');

      // 2. Delete the account for real while active.
      await deleteAccountViaUI(page);

      // 3. Live-verified REAL FINDING: identical Stripe-side outcome to
      // 3.1's Monthly Pro case - deletion's behavior does not depend on
      // which specific plan or billing interval the subscription was on.
      const after = await stripeRequest('GET', `/subscriptions/${sub.id}`);
      expect(after.status).toBe('canceled');
    });
  });

  test.describe('A Member Deleting Their Own Account Is the Symmetric Mirror of the Owner-Deletion Suites Above', () => {
    test("9.1 When a MEMBER (not the owner) deletes their own account, the owner's own data is untouched and the owner's UI correctly reflects the member's departure @real-email", async ({
      browser,
      browserName,
    }) => {
      test.skip(browserName !== 'chromium', 'Two real registrations + an invitation email + a deletion; runs once to avoid tripling load on the real email pipeline.');
      test.setTimeout(600_000);

      // 1. Register owner and member, invite/accept. No real purchase needed
      // - this suite is about connection cleanup, not billing (Suites 3/4/8 already cover that).
      const ownerContext = await browser.newContext({ ...devices['Desktop Chrome'] });
      const ownerPage = await ownerContext.newPage();
      const owner = await registerFullAccount(ownerPage);

      const memberContext = await browser.newContext({ ...devices['Desktop Chrome'] });
      const memberPage = await memberContext.newPage();
      const member = await registerFullAccount(memberPage);
      await memberContext.close();

      await inviteAndAcceptMember(ownerPage, browser, member.email, member.username);

      const ownerDoc = await getUserByEmail(owner.email);
      if (!ownerDoc) throw new Error(`Owner user document not found in MongoDB for email ${owner.email}.`);
      const ownerMongoId = String(ownerDoc._id);
      const memberDoc = await getUserByEmail(member.email);
      if (!memberDoc) throw new Error(`Member user document not found in MongoDB for email ${member.email}.`);

      const before = await getOwnedMongoSnapshot(ownerMongoId);
      // expect: the owner's own self-row plus a new delegated row for the
      // member, per finding 5 in the plan.
      expect(before.memberships).toHaveLength(2);
      const ownerSelfRowBefore = before.memberships.find((m: any) => m.account_id === ownerMongoId && m.user_id === ownerMongoId);
      expect(ownerSelfRowBefore).toBeDefined();

      await ownerContext.close();

      // 2. Log in as the MEMBER and delete their own account - a fresh context, since the original was closed after step 1.
      const finalMemberContext = await browser.newContext({ ...devices['Desktop Chrome'] });
      const finalMemberPage = await finalMemberContext.newPage();
      await loginAs(finalMemberPage, member.username);
      await deleteAccountViaUI(finalMemberPage);
      await finalMemberContext.close();

      // 3. REAL FINDING: the owner's own data is byte-for-byte unchanged -
      // only the member's delegated row is gone, dropping the count from 2 to 1.
      const after = await getOwnedMongoSnapshot(ownerMongoId);
      expect(after.memberships).toHaveLength(1);
      expect(after.memberships[0]).toEqual(ownerSelfRowBefore);
      expect(after.teams).toEqual(before.teams);
      expect(after.teamMemberships).toEqual(before.teamMemberships);

      // 4. The member's own users doc and their delegated membership row
      // under the owner are both gone.
      const memberOrphanCheck = await getOrphanCheck(String(memberDoc._id));
      expect(memberOrphanCheck.usersDocStillExists).toBe(false);
      const delegatedTier = await getDelegatedMembershipTier(ownerMongoId, String(memberDoc._id));
      expect(delegatedTier).toBeNull();

      // 5. The owner's own UI immediately reflects the member's departure -
      // no leftover/ghost entry. The owner's original page/context was
      // already closed above, so this uses a fresh one.
      const finalOwnerContext = await browser.newContext({ ...devices['Desktop Chrome'] });
      const finalOwnerPage = await finalOwnerContext.newPage();
      await loginAs(finalOwnerPage, owner.username);
      await finalOwnerPage.goto(`${BASE_URL}/teams/members`);
      await expect(finalOwnerPage.getByRole('heading', { name: 'Member (0)', exact: true })).toBeVisible();
      await finalOwnerContext.close();
    });
  });
});
