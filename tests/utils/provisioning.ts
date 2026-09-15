import { Browser, BrowserContext, Page, devices, expect } from '@playwright/test';
import { requireEnv } from './env';
import { getInvitationLink, getVerificationLink } from './email';
import { completeProfile, generateUsernameFromEmail, registerNewAccount } from './account';
import { login } from './auth';
import { selectPlanAndContinue } from './subscription-ui';

const BASE_URL = requireEnv('BASE_URL');

/**
 * Registers one real account end-to-end: /register, the real verification
 * email, first login, and Complete Profile.
 *
 * Opens its own context with the device profile rather than `browser.newPage()`
 * - a bare context's `HeadlessChrome` user agent has been live-verified to stop
 * the real verification email from ever arriving (see CLAUDE.md).
 *
 * @returns The context (caller closes it), its page, and the derived username.
 */
export async function registerAndCompleteProfile(
  browser: Browser,
  emailAlias: string,
  password: string
): Promise<{ context: BrowserContext; page: Page; username: string }> {
  const context = await browser.newContext({ ...devices['Desktop Chrome'] });
  const page = await context.newPage();
  const username = generateUsernameFromEmail(emailAlias);
  const registeredAt = new Date();

  await registerNewAccount(page, emailAlias);
  const verificationLink = await getVerificationLink(emailAlias, registeredAt, 900_000);
  await page.goto(verificationLink);
  await expect(page).toHaveURL(`${BASE_URL}/login`);
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(`${BASE_URL}/complete-profile`);
  await completeProfile(page);
  await expect(page).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });

  return { context, page, username };
}

/**
 * Buys a plan for real through Stripe Checkout, with the 4242 test card.
 *
 * Deliberately never touches Checkout's 'I am an AI agent...' checkbox - see
 * subscription-test-plan.md overview finding 7.
 */
export async function purchasePlanViaStripeCheckout(
  page: Page,
  planName: 'Job Link Pro' | 'Job Link Pro + Invoicing',
  cardholderName: string
): Promise<void> {
  await page.goto(`${BASE_URL}/subscription`);
  await selectPlanAndContinue(page, planName);
  await expect(page.getByRole('heading', { name: 'Review Purchase', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm and Pay' }).click();
  await expect(page).toHaveURL(/checkout\.stripe\.com/, { timeout: 30_000 });

  const emailField = page.getByLabel('Email');
  if ((await emailField.count()) > 0 && !(await emailField.inputValue())) {
    await emailField.fill(`${cardholderName.replace(/\s+/g, '').toLowerCase()}@example.com`);
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

/**
 * Invites an already-registered account into the owner's company and accepts
 * the invitation as that member, through the real invitation email.
 *
 * The invitee must already exist: accepting requires being logged in as them
 * (see the invitation-flow gotcha in CLAUDE.md).
 */
export async function inviteAndAcceptMember(
  ownerPage: Page,
  browser: Browser,
  memberEmail: string,
  memberUsername: string,
  memberPassword: string
): Promise<void> {
  await ownerPage.goto(`${BASE_URL}/teams/members`);
  await ownerPage.getByRole('button', { name: 'Invite Member' }).click();
  await expect(ownerPage.getByRole('heading', { name: 'Invite Member' })).toBeVisible();
  const combobox = ownerPage.getByRole('combobox', { name: 'Add People by Email' });
  await combobox.click();
  await combobox.pressSequentially(memberEmail);
  await ownerPage.keyboard.press('Enter');
  await ownerPage.getByRole('button', { name: 'Invite' }).click();
  // Either outcome means a pending invitation now exists, so both are fine to
  // continue from - re-inviting an address the owner already invited answers
  // "You've already invited this email address." instead of the success toast,
  // which is exactly what a resumed provisioning run hits.
  // Explicit timeout: the button sits in its own loading state while the real
  // request is in flight, which on a slower environment outlasts the 5s default.
  const invitationSent = ownerPage.getByText('Your invitation(s) have been sent.', { exact: true });
  const alreadyInvited = ownerPage.getByText('You’ve already invited this email address.', { exact: true });
  await expect(invitationSent.or(alreadyInvited)).toBeVisible({ timeout: 30_000 });

  const invitationLink = await getInvitationLink(memberEmail, 240_000);

  const memberContext = await browser.newContext({ ...devices['Desktop Chrome'] });
  const memberPage = await memberContext.newPage();
  await login(memberPage, memberUsername, memberPassword);
  await memberPage.goto(invitationLink);
  await expect(memberPage.getByText('You’ve been invited!', { exact: true })).toBeVisible();
  await memberPage.getByTestId('accept-btn').click();
  await expect(memberPage).toHaveURL(`${BASE_URL}/company`, { timeout: 15_000 });
  await memberContext.close();
}
