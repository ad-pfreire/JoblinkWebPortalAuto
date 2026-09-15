// Provisioning script, NOT a test. Run it explicitly:
//
//   PROVISION=1 TEST_ENV=staging npx playwright test --project=provision
//
// Two separate guards, because each one alone leaks: the dedicated `provision`
// project keeps it out of every other project, but a bare `npx playwright test`
// (no --project filter) still runs EVERY project, this one included - live-
// verified 2026-09-14, when a plain full run silently registered two accounts
// and made a real Stripe purchase nobody asked for. So the PROVISION guard
// below is what actually makes an unintended run harmless.
//
// It creates the owner+member pair the Membership Tier suite of
// tests/teams/teams-plan-gating.spec.ts needs, and prints the four lines to
// paste into that environment's .env file. Re-run it before each full
// regression pass: Suite 8 genuinely cancels the owner's subscription and
// attaches a real Test Clock to it, so a pair survives only one complete run.
import { test, expect, devices, BrowserContext, Page } from '@playwright/test';
import { requireEnv } from '../utils/env';
import { generateUniqueEmailAlias } from '../utils/account';
import { registerAndCompleteProfile, purchasePlanViaStripeCheckout, inviteAndAcceptMember } from '../utils/provisioning';
import { login } from '../utils/auth';
import { stripeFindCustomerByEmail, stripeFindActiveSubscription } from '../utils/stripe';

test('provision a Membership Tier owner+member pair for this environment', async ({ browser }) => {
  test.skip(
    !process.env.PROVISION,
    'Provisioning script: it registers real accounts and makes a real Stripe purchase, so it only runs when asked for deliberately - PROVISION=1 npx playwright test --project=provision'
  );
  // Two real registrations with their verification emails, a real Stripe
  // Checkout purchase, and an invitation round trip with its own email.
  test.setTimeout(1_800_000);
  const password = requireEnv('TEST_REGISTER_PASSWORD');

  // 1. Owner: register, verify by real email, complete profile, then buy Job
  // Link Pro for real - the suite needs a genuinely active subscription.
  //
  // PROVISION_OWNER_EMAIL/USERNAME (and the MEMBER pair below) resume a run
  // that already created the accounts but died later, e.g. on the invitation -
  // re-registering would burn two more real email round trips and a second
  // real purchase for nothing.
  const ownerEmail = process.env.PROVISION_OWNER_EMAIL || generateUniqueEmailAlias();
  let owner: { context: BrowserContext; page: Page; username: string };
  if (process.env.PROVISION_OWNER_EMAIL) {
    const context = await browser.newContext({ ...devices['Desktop Chrome'] });
    const page = await context.newPage();
    const username = requireEnv('PROVISION_OWNER_USERNAME');
    await login(page, username, password);
    owner = { context, page, username };
    console.log(`[provision] reusing existing owner: ${username} <${ownerEmail}>`);
  } else {
    owner = await registerAndCompleteProfile(browser, ownerEmail, password);
    console.log(`[provision] owner registered: ${owner.username} <${ownerEmail}>`);
    await purchasePlanViaStripeCheckout(owner.page, 'Job Link Pro', 'QA Tier Provisioning');
    console.log('[provision] owner purchased Job Link Pro');
  }

  // 2. Member: its own account, then invited into the owner's company and
  // accepted through the real invitation email.
  const memberEmail = process.env.PROVISION_MEMBER_EMAIL || generateUniqueEmailAlias();
  let memberUsername: string;
  if (process.env.PROVISION_MEMBER_EMAIL) {
    memberUsername = requireEnv('PROVISION_MEMBER_USERNAME');
    console.log(`[provision] reusing existing member: ${memberUsername} <${memberEmail}>`);
  } else {
    const member = await registerAndCompleteProfile(browser, memberEmail, password);
    await member.context.close();
    memberUsername = member.username;
    console.log(`[provision] member registered: ${memberUsername} <${memberEmail}>`);
  }
  await inviteAndAcceptMember(owner.page, browser, memberEmail, memberUsername, password);
  console.log('[provision] member accepted the invitation');
  await owner.context.close();

  // 3. Confirm against Stripe that the subscription is really active before
  // declaring the pair usable - the suite's own beforeAll looks it up the
  // same way and fails outright if it can't.
  const customerId = await stripeFindCustomerByEmail(ownerEmail);
  const { id: subscriptionId } = await stripeFindActiveSubscription(customerId);
  expect(subscriptionId).toBeTruthy();

  console.log(
    [
      '',
      '=== Paste these four lines into this environment .env file ===',
      `TIER_OWNER_USERNAME=${owner.username}`,
      `TIER_OWNER_EMAIL=${ownerEmail}`,
      `TIER_MEMBER_USERNAME=${memberUsername}`,
      `TIER_MEMBER_EMAIL=${memberEmail}`,
      '==============================================================',
      '',
    ].join('\n')
  );
});
