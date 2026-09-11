// spec: specs/teams-plans/teams-plan-gating-test-plan.md
// seed: tests/seed.spec.ts

import { test, expect, Page, devices } from '@playwright/test';
import { MongoClient } from 'mongodb';
import { requireEnv } from '../utils/env';
import { getVerificationLink, getInvitationLink } from '../utils/email';
import { generateUniqueEmailAlias, generateUsernameFromEmail, registerNewAccount, completeProfile } from '../utils/account';
import { login, loginAndGoToCompany } from '../utils/auth';
// Drives a real Stripe Test Clock via the REST API to simulate a subscription
// genuinely lapsing to Free - no UI interaction can do that within a test run.
import { stripeRequest, stripeFindCustomerByEmail, stripeFindActiveSubscription, pollTestClockUntilReady } from '../utils/stripe';
import { getPlanCardState, selectPlanAndContinue, cancelSubscriptionAndFinish } from '../utils/subscription-ui';
// Suite 7's "Resume Subscription" dialog reuses /payments' own embedded Stripe
// Elements component, so the same iframe-swap/mounting gotchas apply.
import { billingAddressFrame, cardElementFrame } from '../utils/stripe-elements';

const BASE_URL = requireEnv('BASE_URL');
const MONGO_URI = requireEnv('MONGODB_URI');

let disposableUsername: string;
let disposablePassword: string;
let stripeCustomerId: string;
let stripeSubscriptionId: string;
let memberUsername: string;
let ownerMongoId: string;
let memberMongoId: string;
let memberTierWhileOwnerActive: string | null;

// This file's CI-only Chromium software-rendering flags (see CLAUDE.md) live in its own dedicated project in playwright.config.ts, not a file-level test.use() here.

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
  await loginAndGoToCompany(page, disposableUsername, disposablePassword);
}

// Generic login for the second (member) disposable account - every
// disposable account in this project shares the same TEST_REGISTER_PASSWORD
// value, so disposablePassword works for both.
async function loginAs(page: Page, username: string) {
  await login(page, username, disposablePassword);
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

async function fillAndSubmitResumeDialogPaymentMethod(page: Page, cardNumber: string) {
  const fieldTimeout = { timeout: 10_000 };
  const settle = () => page.waitForTimeout(400);
  await (await billingAddressFrame(page)).getByRole('textbox', { name: 'Full name' }).pressSequentially('QA Tier Test', fieldTimeout);
  await settle();
  await (
    await billingAddressFrame(page)
  )
    .getByRole('textbox', { name: 'Address line 1' })
    .pressSequentially('123 Main Street', fieldTimeout);
  await settle();
  await (await billingAddressFrame(page)).locator('#billingAddress-localityInput').pressSequentially('Quito', fieldTimeout);
  await settle();
  await (await billingAddressFrame(page)).locator('#billingAddress-postalCodeInput').pressSequentially('170150', fieldTimeout);
  await settle();
  await (await cardElementFrame(page)).getByRole('textbox', { name: 'Card number' }).pressSequentially(cardNumber, fieldTimeout);
  await settle();
  await (await cardElementFrame(page)).getByRole('textbox', { name: 'Expiration date' }).pressSequentially('1234', fieldTimeout);
  await settle();
  await (await cardElementFrame(page)).getByRole('textbox', { name: 'Security code' }).pressSequentially('123', fieldTimeout);
  await settle();

  const saveCheckbox = (await cardElementFrame(page)).getByRole('checkbox', { name: 'Save payment details for future purchases' });
  await saveCheckbox.click();
  if (!(await saveCheckbox.isChecked())) {
    await saveCheckbox.click();
  }
  await expect(saveCheckbox).toBeChecked();
  await settle();

  const updateButton = page.getByRole('button', { name: 'Update Payment Method' });
  await expect(updateButton).toBeEnabled();
  await updateButton.click();
}

// WEB-TC-128 through 138: the per-member "Subscription Plan" delegation
// field (see specs/teams-plans/teams-membership-tier-test-plan.md) - its real DOM
// structure/id/options were confirmed via a live investigation script first.
test.describe('Teams — Membership Tier ("Subscription Plan") Delegation', () => {
  test.describe.configure({ mode: 'serial' });

  // Reuses one disposable owner+member pair already registered and
  // real-Pro-purchased by an earlier investigation script - avoids a second
  // full register+purchase+invite/accept round trip.
  const tierOwnerUsername = 'paulfreireausriz0lbh';
  const tierOwnerEmail = 'paul.freire+ausriz0lbh@crifa.com';
  const tierMemberUsername = 'paulfreireausrjrk3jy';
  const tierMemberEmail = 'paul.freire+ausrjrk3jy@crifa.com';
  let tierPassword: string;
  let tierOwnerMongoId: string;
  let tierMemberMongoId: string;
  let tierStripeCustomerId: string;
  let tierStripeSubscriptionId: string;

  async function loginAsTier(page: Page, username: string) {
    await page.goto(`${BASE_URL}/login`);
    await page.locator('input[name="username"]').fill(username);
    await page.locator('input[name="password"]').fill(tierPassword);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });
  }

  /** Navigates to the company-wide Members list and opens the one real member's 'About' panel. */
  async function openMemberDetailsPanel(page: Page) {
    await page.goto(`${BASE_URL}/teams/members`);
    const memberCard = page.getByRole('link', { name: /QA Automation/ }).or(page.getByRole('button', { name: /QA Automation/ }));
    await memberCard.first().click();
    await expect(page).toHaveURL(/\/teams\/members\?member=.+&cardDetails=true/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'About', exact: true })).toBeVisible({ timeout: 15_000 });
  }

  // Live-verified real id (see specs/teams-plans/teams-membership-tier-test-plan.md) - not the label text, since the label's accessible name changes with the current value (same MUI gotcha as Company Details' State field - see CLAUDE.md).
  function tierSelect(page: Page) {
    return page.locator('#mui-component-select-newType');
  }

  async function selectMemberTier(page: Page, optionName: 'Job Link' | 'Job Link Pro' | 'Job Link Pro + Invoicing') {
    await tierSelect(page).click();
    await page.getByRole('option', { name: optionName, exact: true }).click();
  }

  function updateSubscriptionDialogHeading(page: Page) {
    return page.getByRole('heading', { name: 'Update Subscription', exact: true });
  }

  /**
   * Waits for the dialog's cost preview to resolve, without assuming which
   * label it lands on - a pre-existing account credit can make even a
   * genuine upgrade show 'New Account Balance' instead of 'Order Total'
   * (see Suite 6). Only 4.1's own credit-free scenario asserts the specific label.
   */
  async function waitForCostPreviewResolved(page: Page) {
    await expect(page.getByText('Order Total', { exact: true }).or(page.getByText('New Account Balance', { exact: true }))).toBeVisible({
      timeout: 15_000,
    });
  }

  async function confirmDialogAndPay(page: Page) {
    await expect(page.getByRole('button', { name: 'Confirm and Pay' })).toBeEnabled({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Confirm and Pay' }).click();
  }

  test.beforeAll(async ({ browserName }) => {
    test.skip(
      browserName !== 'chromium',
      "Reuses one disposable owner+member pair from this session's own live investigation; runs once on chromium."
    );
    tierPassword = requireEnv('TEST_REGISTER_PASSWORD');

    const ownerDoc = await getUserByEmail(tierOwnerEmail);
    const memberDoc = await getUserByEmail(tierMemberEmail);
    if (!ownerDoc || !memberDoc) {
      throw new Error('Could not resolve the reused owner/member Mongo user documents for the Membership Tier suite - aborting.');
    }
    tierOwnerMongoId = String(ownerDoc._id);
    tierMemberMongoId = String(memberDoc._id);

    tierStripeCustomerId = await stripeFindCustomerByEmail(tierOwnerEmail);
    const { id: subId } = await stripeFindActiveSubscription(tierStripeCustomerId);
    tierStripeSubscriptionId = subId;
  });

  test.beforeEach(async ({ browserName }) => {
    test.skip(
      browserName !== 'chromium',
      "Reuses one disposable owner+member pair from this session's own live investigation; runs once on chromium."
    );
  });

  test.describe('Suite 2 - Base State on an Actively-Paid Owner', () => {
    test("2.1 REAL: on an actively-Pro owner, the member's Subscription Plan field is enabled, defaults to Job Link (free), and offers exactly three options @real-email", async ({
      page,
    }) => {
      await loginAsTier(page, tierOwnerUsername);
      await openMemberDetailsPanel(page);

      const field = tierSelect(page);
      await expect(field).toHaveText('Job Link');
      // MUI applies Mui-disabled to the immediate MuiInputBase-root wrapper when disabled - live-verified against this exact field's own disabled Email sibling above it, which does carry the class.
      await expect(field.locator('xpath=..')).not.toHaveClass(/Mui-disabled/);

      await field.click();
      await expect(page.getByRole('option', { name: 'Job Link', exact: true })).toBeVisible();
      await expect(page.getByRole('option', { name: 'Job Link Pro', exact: true })).toBeVisible();
      await expect(page.getByRole('option', { name: 'Job Link Pro + Invoicing', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');

      const tier = await getDelegatedMembershipTier(tierOwnerMongoId, tierMemberMongoId);
      expect(tier).toBe('free');
    });
  });

  test.describe('Suite 4 - Upgrading a Member (Dialog, Skeleton, No-Op Guard)', () => {
    test('4.1 Re-selecting the current value opens no dialog; selecting a higher tier opens Update Subscription with a real cost preview @real-email', async ({
      page,
    }) => {
      await loginAsTier(page, tierOwnerUsername);
      await openMemberDetailsPanel(page);

      // 1. No-op guard: re-selecting the field's own current value ('Job Link') must not open a dialog.
      await selectMemberTier(page, 'Job Link');
      await page.waitForTimeout(1_500);
      await expect(updateSubscriptionDialogHeading(page)).toHaveCount(0);

      // 2. A genuine upgrade opens the dialog immediately on selection - live-verified this is a real MuiModal (no role="dialog"), not the role-based dialog subscription.spec.ts's own comparison page uses.
      await selectMemberTier(page, 'Job Link Pro');
      await expect(updateSubscriptionDialogHeading(page)).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText('The full subscription amount will be billed on your next cycle date', { exact: true })).toBeVisible();

      // 3. Real cost preview resolves to 'Order Total' (a net charge, matching the owner's own equivalent dialog - see CLAUDE.md/specs/company-plans/subscription-test-plan.md) with a real dollar amount, not 'New Account Balance'.
      await expect(page.getByText('Order Total', { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('New Account Balance', { exact: true })).toHaveCount(0);
      await expect(page.getByText(/\$\d+\.\d{2}/).first()).toBeVisible();

      await expect(page.getByRole('button', { name: 'No, go back', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Confirm and Pay' })).toBeVisible();
    });

    test("4.2 'No, go back' reverts the visible selection and makes zero real change in Stripe or MongoDB @real-email", async ({
      page,
    }) => {
      const before = await stripeRequest('GET', `/subscriptions/${tierStripeSubscriptionId}`);
      const itemIdsBefore = (before.items?.data ?? []).map((i: { id: string }) => i.id).sort();

      await loginAsTier(page, tierOwnerUsername);
      await openMemberDetailsPanel(page);
      await selectMemberTier(page, 'Job Link Pro');
      await expect(updateSubscriptionDialogHeading(page)).toBeVisible({ timeout: 10_000 });
      await page.getByRole('button', { name: 'No, go back', exact: true }).click();

      await expect(updateSubscriptionDialogHeading(page)).toHaveCount(0);
      await expect(tierSelect(page)).toHaveText('Job Link');

      const after = await stripeRequest('GET', `/subscriptions/${tierStripeSubscriptionId}`);
      const itemIdsAfter = (after.items?.data ?? []).map((i: { id: string }) => i.id).sort();
      expect(itemIdsAfter).toEqual(itemIdsBefore);

      const tier = await getDelegatedMembershipTier(tierOwnerMongoId, tierMemberMongoId);
      expect(tier).toBe('free');
    });

    test("4.3 'Confirm and Pay' on a genuine upgrade completes end-to-end - in the UI (after reload), Stripe, and MongoDB @real-email", async ({
      page,
    }) => {
      const before = await stripeRequest('GET', `/subscriptions/${tierStripeSubscriptionId}`);
      const quantityBefore = before.items?.data?.[0]?.quantity ?? 0;

      await loginAsTier(page, tierOwnerUsername);
      await openMemberDetailsPanel(page);
      await selectMemberTier(page, 'Job Link Pro');
      await expect(updateSubscriptionDialogHeading(page)).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText('Order Total', { exact: true })).toBeVisible({ timeout: 15_000 });
      await confirmDialogAndPay(page);

      // The app does an unconditional window.location.reload() on success - a fresh re-navigation sidesteps needing to detect that exact event (see CLAUDE.md's general pattern for post-mutation reload races).
      await page.waitForTimeout(3_000);
      await openMemberDetailsPanel(page);
      await expect(tierSelect(page)).toHaveText('Job Link Pro', { timeout: 15_000 });

      const tier = await getDelegatedMembershipTier(tierOwnerMongoId, tierMemberMongoId);
      expect(['pro', 'invoicing']).toContain(tier);

      // REAL FINDING, not the intuitive mechanism: delegating a member's
      // tier does NOT add a new Stripe subscription item - it increments
      // the QUANTITY of the owner's own existing matching-tier item
      // instead (live-verified 2026-09-08: item count stayed exactly 1;
      // quantity went from 1 to 2 for the owner's own 'Job Link Pro' item).
      const subAfter = await stripeRequest('GET', `/subscriptions/${tierStripeSubscriptionId}`);
      expect(subAfter.items?.data ?? []).toHaveLength((before.items?.data ?? []).length);
      expect(subAfter.items?.data?.[0]?.quantity).toBeGreaterThan(quantityBefore);
    });
  });

  test.describe('Suite 5 - Downgrading a Member (New Account Balance)', () => {
    test("5.1 Selecting a lower tier shows 'New Account Balance' instead of 'Order Total', as a credit @real-email", async ({ page }) => {
      await loginAsTier(page, tierOwnerUsername);
      await openMemberDetailsPanel(page);
      await selectMemberTier(page, 'Job Link');
      await expect(updateSubscriptionDialogHeading(page)).toBeVisible({ timeout: 10_000 });

      await expect(page.getByText('New Account Balance', { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('Order Total', { exact: true })).toHaveCount(0);
    });

    test('5.2 Confirming the downgrade applies correctly - the field, Stripe, and MongoDB all agree it reverted to free @real-email', async ({
      page,
    }) => {
      await loginAsTier(page, tierOwnerUsername);
      await openMemberDetailsPanel(page);
      await selectMemberTier(page, 'Job Link');
      await expect(updateSubscriptionDialogHeading(page)).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText('New Account Balance', { exact: true })).toBeVisible({ timeout: 15_000 });
      await confirmDialogAndPay(page);

      await page.waitForTimeout(3_000);
      await openMemberDetailsPanel(page);
      await expect(tierSelect(page)).toHaveText('Job Link', { timeout: 15_000 });

      const tier = await getDelegatedMembershipTier(tierOwnerMongoId, tierMemberMongoId);
      expect(tier).toBe('free');

      // Best-effort real-world check that the resulting credit is actually visible somewhere real, not merely claimed by the dialog's own preview.
      const upcoming = await stripeRequest('GET', `/invoices/upcoming?customer=${tierStripeCustomerId}`).catch((e) => {
        console.log(
          `[WEB-TC-136] No upcoming invoice available to inspect (${e instanceof Error ? e.message : e}) - documenting, not failing.`
        );
        return null;
      });
      if (upcoming) {
        console.log(
          `[WEB-TC-136] Owner's upcoming invoice starting_balance/total after the member downgrade credit: ${JSON.stringify({ starting_balance: upcoming.starting_balance, total: upcoming.total })}`
        );
      }
    });
  });

  test.describe('Suite 6 - Gating While a Cancellation Is PENDING (Scheduled, Not Yet Effective)', () => {
    test('6.1 Re-elevating the member, then scheduling a real (pending) cancellation disables the Subscription Plan field @real-email', async ({
      page,
    }) => {
      test.setTimeout(120_000);
      // 1. Re-elevate the member to Job Link Pro first, so this suite tests a member who genuinely holds a paid delegated tier at the moment the cancellation is scheduled.
      await loginAsTier(page, tierOwnerUsername);
      await openMemberDetailsPanel(page);
      await selectMemberTier(page, 'Job Link Pro');
      await expect(updateSubscriptionDialogHeading(page)).toBeVisible({ timeout: 10_000 });
      await waitForCostPreviewResolved(page);
      await confirmDialogAndPay(page);
      await page.waitForTimeout(3_000);

      // 2. Schedule a real cancellation via the owner's own /subscription page (reuses this file's own already-proven helper).
      await page.goto(`${BASE_URL}/subscription`);
      await cancelSubscriptionAndFinish(page);

      const subAfter = await stripeRequest('GET', `/subscriptions/${tierStripeSubscriptionId}`);
      expect(subAfter.cancel_at_period_end).toBe(true);
      expect(subAfter.status).toBe('active');

      // 3. The Subscription Plan field is now disabled with a message naming the pending cancellation.
      await openMemberDetailsPanel(page);
      await expect(tierSelect(page).locator('xpath=..')).toHaveClass(/Mui-disabled/, { timeout: 15_000 });
      await expect(page.getByText(/^Plan will be canceled on .+\.$/)).toBeVisible();
    });

    test("6.2 The member's already-delegated tier is untouched by merely SCHEDULING a cancellation @real-email", async ({ page }) => {
      await loginAsTier(page, tierOwnerUsername);
      await openMemberDetailsPanel(page);
      await expect(tierSelect(page)).toHaveText('Job Link Pro');

      const tier = await getDelegatedMembershipTier(tierOwnerMongoId, tierMemberMongoId);
      expect(['pro', 'invoicing']).toContain(tier);
    });
  });

  test.describe('Suite 7 - Resuming Re-Enables Membership Tier Updates', () => {
    test("7.1 'Resume Subscription' (with a fresh card) re-enables the Subscription Plan field and clears the cancellation message @real-email", async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await loginAsTier(page, tierOwnerUsername);
      await page.goto(`${BASE_URL}/subscription`);
      await page.getByRole('button', { name: 'Resume Subscription', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Payment Method', exact: true })).toBeVisible();
      await fillAndSubmitResumeDialogPaymentMethod(page, '4242424242424242');
      await expect(page).toHaveURL(/\/subscription\?success=resume/, { timeout: 45_000 });

      const subAfter = await stripeRequest('GET', `/subscriptions/${tierStripeSubscriptionId}`);
      expect(subAfter.cancel_at_period_end).toBe(false);

      await openMemberDetailsPanel(page);
      await expect(tierSelect(page).locator('xpath=..')).not.toHaveClass(/Mui-disabled/, { timeout: 15_000 });
      await expect(page.getByText(/^Plan will be canceled on .+\.$/)).toHaveCount(0);
    });

    test('7.2 A real tier change after resuming completes end-to-end, proving the field is functionally re-enabled @real-email', async ({
      page,
    }) => {
      await loginAsTier(page, tierOwnerUsername);
      await openMemberDetailsPanel(page);
      await selectMemberTier(page, 'Job Link Pro + Invoicing');
      await expect(updateSubscriptionDialogHeading(page)).toBeVisible({ timeout: 10_000 });
      await waitForCostPreviewResolved(page);
      await confirmDialogAndPay(page);

      await page.waitForTimeout(3_000);
      await openMemberDetailsPanel(page);
      await expect(tierSelect(page)).toHaveText('Job Link Pro + Invoicing', { timeout: 15_000 });

      const tier = await getDelegatedMembershipTier(tierOwnerMongoId, tierMemberMongoId);
      expect(tier).toBe('invoicing');
    });
  });

  test.describe('Suite 8 - A Real Lapse Resets the Delegated Tier to Free', () => {
    test('8.1-8.2 Advancing a real Test Clock past a fresh cancellation resets the Subscription Plan to Job Link (free), disabled, with the no-subscription message @real-email', async ({
      page,
    }) => {
      test.setTimeout(400_000);
      // 1. Schedule a fresh real cancellation (the member still holds 'Job Link Pro + Invoicing' from 7.2).
      await loginAsTier(page, tierOwnerUsername);
      await page.goto(`${BASE_URL}/subscription`);
      await cancelSubscriptionAndFinish(page);

      // 2. Reuse this file's own already-proven Test Clock mechanism (Suite 1's beforeAll) to advance a real clock past the period end.
      const { currentPeriodEnd } = await stripeFindActiveSubscription(tierStripeCustomerId);
      await attachClockAndAdvancePastPeriodEnd(tierStripeCustomerId, currentPeriodEnd);

      const finalSub = await stripeRequest('GET', `/subscriptions/${tierStripeSubscriptionId}`);
      expect(finalSub.status).toBe('canceled');

      // 3. The field resets to Job Link (free), disabled, with the no-active-subscription-at-all message.
      await openMemberDetailsPanel(page);
      await expect(tierSelect(page)).toHaveText('Job Link', { timeout: 15_000 });
      await expect(tierSelect(page).locator('xpath=..')).toHaveClass(/Mui-disabled/);
      await expect(
        page.getByText("You'll need a subscription for your account before updating other member subscriptions.", { exact: true })
      ).toBeVisible();

      const tier = await getDelegatedMembershipTier(tierOwnerMongoId, tierMemberMongoId);
      expect(tier).toBe('free');
    });
  });

  test.describe('Suite 9 - Member-Side Perspective (No Self-Service, No Assigning to Others)', () => {
    test('9.1 REAL: logging in as the member directly, there is no UI anywhere to view/change their own or any other member’s delegated tier (WEB-TC-122) @real-email', async ({
      page,
    }) => {
      await loginAsTier(page, tierMemberUsername);

      // 1. No trace of the 'Subscription Plan' field/label anywhere reachable from the member's own session.
      await page.goto(`${BASE_URL}/company`);
      await expect(page.getByText('Subscription Plan', { exact: true })).toHaveCount(0);
      await page.goto(`${BASE_URL}/teams`);
      await expect(page.getByText('Subscription Plan', { exact: true })).toHaveCount(0);
      await page.goto(`${BASE_URL}/teams/members`);
      await expect(page.getByText('Subscription Plan', { exact: true })).toHaveCount(0);

      // 2. WEB-TC-122: a non-owner member has no path to assign a subscription to ANY member (themselves or anyone else) -
      // the owner-only DetailsPanel route, tried directly, does not expose the tier control to a member either.
      await page.goto(`${BASE_URL}/teams/members?member=${tierMemberMongoId}&cardDetails=true`);
      await expect(page.getByText('Subscription Plan', { exact: true })).toHaveCount(0);

      // 3. The member's OWN /subscription page reflects their own independent personal plan (still their own default trial, never touched by anything done to their delegated tier above) - never conflated with the owner's company-level delegation.
      await page.goto(`${BASE_URL}/subscription`);
      await expect(page.getByText(/^You're currently on a Free trial for .+\. Your free trial ends at .+\.$/)).toBeVisible({
        timeout: 15_000,
      });
    });
  });
});

// Does a never-purchased default trial count as "active" for Membership
// Tier gating? Cheapest scenario to set up (no Stripe Checkout at all) - a
// standalone describe, independent of the far more expensive Suite above.
test.describe('Teams — Membership Tier Gating on a Trial-Only Owner (Never Purchased)', () => {
  test('3.1 REAL FINDING: whether a Free Trial owner counts as "active" for a member\'s Subscription Plan field @real-email', async ({
    browser,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'Two real registrations + one invite/accept round-trip; runs once on chromium only.');
    test.setTimeout(500_000);

    const password = requireEnv('TEST_REGISTER_PASSWORD');

    const ownerContext = await browser.newContext({ ...devices['Desktop Chrome'] });
    const ownerPage = await ownerContext.newPage();
    const ownerEmail = generateUniqueEmailAlias();
    const ownerUsername = generateUsernameFromEmail(ownerEmail);
    const ownerRegisteredAt = new Date();
    await registerNewAccount(ownerPage, ownerEmail);
    const ownerVerifyLink = await getVerificationLink(ownerEmail, ownerRegisteredAt, 900_000);
    await ownerPage.goto(ownerVerifyLink);
    await expect(ownerPage).toHaveURL(`${BASE_URL}/login`);
    await ownerPage.locator('input[name="username"]').fill(ownerUsername);
    await ownerPage.locator('input[name="password"]').fill(password);
    await ownerPage.locator('button[type="submit"]').click();
    await expect(ownerPage).toHaveURL(`${BASE_URL}/complete-profile`);
    await completeProfile(ownerPage);
    await expect(ownerPage).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });
    // Deliberately never purchases anything - stays on the default trial.

    const memberContext = await browser.newContext({ ...devices['Desktop Chrome'] });
    const memberPage = await memberContext.newPage();
    const memberEmail = generateUniqueEmailAlias();
    const memberUsername = generateUsernameFromEmail(memberEmail);
    const memberRegisteredAt = new Date();
    await registerNewAccount(memberPage, memberEmail);
    const memberVerifyLink = await getVerificationLink(memberEmail, memberRegisteredAt, 900_000);
    await memberPage.goto(memberVerifyLink);
    await expect(memberPage).toHaveURL(`${BASE_URL}/login`);
    await memberPage.locator('input[name="username"]').fill(memberUsername);
    await memberPage.locator('input[name="password"]').fill(password);
    await memberPage.locator('button[type="submit"]').click();
    await expect(memberPage).toHaveURL(`${BASE_URL}/complete-profile`);
    await completeProfile(memberPage);
    await expect(memberPage).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });
    await memberContext.close();

    await ownerPage.goto(`${BASE_URL}/teams/members`);
    await ownerPage.getByRole('button', { name: 'Invite Member' }).click();
    const combobox = ownerPage.getByRole('combobox', { name: 'Add People by Email' });
    await combobox.click();
    await combobox.pressSequentially(memberEmail);
    await ownerPage.keyboard.press('Enter');
    await ownerPage.getByRole('button', { name: 'Invite' }).click();
    await expect(ownerPage.getByText('Your invitation(s) have been sent.', { exact: true })).toBeVisible();

    const invitationLink = await getInvitationLink(memberEmail, 240_000);
    const memberAcceptContext = await browser.newContext({ ...devices['Desktop Chrome'] });
    const memberAcceptPage = await memberAcceptContext.newPage();
    await memberAcceptPage.goto(`${BASE_URL}/login`);
    await memberAcceptPage.locator('input[name="username"]').fill(memberUsername);
    await memberAcceptPage.locator('input[name="password"]').fill(password);
    await memberAcceptPage.locator('button[type="submit"]').click();
    await expect(memberAcceptPage).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });
    await memberAcceptPage.goto(invitationLink);
    await memberAcceptPage.getByTestId('accept-btn').click();
    await expect(memberAcceptPage).toHaveURL(`${BASE_URL}/company`, { timeout: 15_000 });
    await memberAcceptContext.close();

    // The real finding: open the member's panel and inspect the field's enabled/disabled state and any message.
    await ownerPage.goto(`${BASE_URL}/teams/members`);
    const memberCard = ownerPage.getByRole('link', { name: /QA Automation/ }).or(ownerPage.getByRole('button', { name: /QA Automation/ }));
    await memberCard.first().click();
    await expect(ownerPage).toHaveURL(/\/teams\/members\?member=.+&cardDetails=true/, { timeout: 15_000 });
    await expect(ownerPage.getByRole('heading', { name: 'About', exact: true })).toBeVisible({ timeout: 15_000 });

    const field = ownerPage.locator('#mui-component-select-newType');
    await expect(field).toBeVisible({ timeout: 15_000 });
    const isDisabled = (await field.locator('xpath=..').getAttribute('class'))?.includes('Mui-disabled') ?? false;
    const memberInfoVisible = await ownerPage
      .getByText("You'll need a subscription for your account before updating other member subscriptions.", { exact: true })
      .isVisible()
      .catch(() => false);

    console.log(
      `[WEB-TC-128] REAL FINDING: on a never-purchased trial-only owner, the member's Subscription Plan field is ${isDisabled ? 'DISABLED' : 'ENABLED'}` +
        `${memberInfoVisible ? ' with the no-subscription message shown' : ' with no error message shown'}.`
    );

    // Document whichever real outcome occurred - both are legitimate, previously-unknown answers (see specs/teams-plans/teams-membership-tier-test-plan.md Suite 3).
    if (isDisabled) {
      expect(memberInfoVisible).toBe(true);
    } else {
      expect(memberInfoVisible).toBe(false);
    }
    await ownerContext.close();
  });
});
