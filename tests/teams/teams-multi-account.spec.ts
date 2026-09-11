// spec: specs/teams-multi-account-test-plan.md
// seed: tests/seed.spec.ts
//
// Split out of tests/teams.spec.ts: unlike that file's main 'Teams' describe -
// which shares one disposable account via its own beforeAll and runs serial -
// every describe here is self-contained. Each test registers the accounts it
// needs inside the test itself, so these carry no shared setup and no
// cross-test ordering, and cost nothing extra by living in their own file.

import { test, expect, devices } from '@playwright/test';
import { requireEnv } from '../utils/env';
import { getVerificationLink, getInvitationLink, checkForAnyEmail } from '../utils/email';
import { generateUniqueEmailAlias, generateUsernameFromEmail, registerNewAccount, completeProfile } from '../utils/account';
import { teamCard } from '../utils/teams-ui';

const BASE_URL = requireEnv('BASE_URL');

// Fully self-contained (registers all 3 accounts from scratch) - its own
// top-level describe so it never touches the main 'Teams' describe's shared state.
test.describe('Teams — Accepting Multiple Pending Invitations Sequentially', () => {
  test("6.13 A user with two separate pending invitations, from two different companies, can accept both one after another - each lands them as an Active member of that inviter's own company, independently @real-email", async ({
    browser,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'Three real registrations + two real invitation round-trips; runs once on chromium only.');
    test.setTimeout(600_000);

    // 1. Register + verify the shared invitee (D).
    const inviteeAlias = generateUniqueEmailAlias();
    const inviteeUsername = generateUsernameFromEmail(inviteeAlias);
    const password = requireEnv('TEST_REGISTER_PASSWORD');
    const inviteeContext = await browser.newContext({ ...devices['Desktop Chrome'] });
    const inviteePage = await inviteeContext.newPage();
    const inviteeRegisteredAt = new Date();
    await registerNewAccount(inviteePage, inviteeAlias);
    const inviteeVerificationLink = await getVerificationLink(inviteeAlias, inviteeRegisteredAt, 240_000);
    await inviteePage.goto(inviteeVerificationLink);
    await expect(inviteePage).toHaveURL(`${BASE_URL}/login`);
    await inviteePage.getByRole('textbox', { name: 'Username or Email' }).fill(inviteeUsername);
    await inviteePage.getByRole('textbox', { name: 'Password' }).fill(password);
    await inviteePage.getByRole('button', { name: 'Log In' }).click();
    await expect(inviteePage).toHaveURL(`${BASE_URL}/complete-profile`, { timeout: 15_000 });
    await completeProfile(inviteePage);
    await expect(inviteePage).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });

    // 2. Register two separate owner accounts (C1, C2), each inviting D from their own separate company.
    async function registerOwnerAndInvite(ownerAlias: string) {
      const ownerUsername = generateUsernameFromEmail(ownerAlias);
      const ownerContext = await browser.newContext({ ...devices['Desktop Chrome'] });
      const ownerPage = await ownerContext.newPage();
      const ownerRegisteredAt = new Date();
      await registerNewAccount(ownerPage, ownerAlias);
      const ownerVerificationLink = await getVerificationLink(ownerAlias, ownerRegisteredAt, 240_000);
      await ownerPage.goto(ownerVerificationLink);
      await expect(ownerPage).toHaveURL(`${BASE_URL}/login`);
      await ownerPage.getByRole('textbox', { name: 'Username or Email' }).fill(ownerUsername);
      await ownerPage.getByRole('textbox', { name: 'Password' }).fill(password);
      await ownerPage.getByRole('button', { name: 'Log In' }).click();
      await expect(ownerPage).toHaveURL(`${BASE_URL}/complete-profile`, { timeout: 15_000 });
      await completeProfile(ownerPage);
      await expect(ownerPage).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });

      await ownerPage.goto(`${BASE_URL}/teams/members`);
      await ownerPage.getByRole('button', { name: 'Invite Member' }).click();
      await expect(ownerPage.getByRole('heading', { name: 'Invite Member' })).toBeVisible();
      const combobox = ownerPage.getByRole('combobox', { name: 'Add People by Email' });
      await combobox.click();
      await combobox.pressSequentially(inviteeAlias);
      await ownerPage.keyboard.press('Enter');
      await ownerPage.getByRole('button', { name: 'Invite' }).click();
      await expect(ownerPage.getByText('Your invitation(s) have been sent.', { exact: true })).toBeVisible();
      await ownerContext.close();
    }

    // getInvitationLink() matches by subject + 'to', not "newest" - since
    // both invitations share the same 'to' address, a call issued before
    // invitation 2 arrives can re-return invitation 1's link. Polls until a
    // genuinely different link shows up.
    async function getDistinctInvitationLink(toAddress: string, excludeLink: string, timeoutMs = 240_000): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const link = await getInvitationLink(toAddress, 5_000).catch(() => null);
        if (link && link !== excludeLink) return link;
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
      throw new Error(`Timed out waiting for a second, distinct invitation link to ${toAddress}.`);
    }

    const owner1Alias = generateUniqueEmailAlias();
    await registerOwnerAndInvite(owner1Alias);
    const invitationLink1 = await getInvitationLink(inviteeAlias, 240_000);

    const owner2Alias = generateUniqueEmailAlias();
    await registerOwnerAndInvite(owner2Alias);
    const invitationLink2 = await getDistinctInvitationLink(inviteeAlias, invitationLink1, 240_000);
    expect(invitationLink2).not.toBe(invitationLink1);

    // 3. D accepts BOTH invitations sequentially, in the same already-logged-in session.
    await inviteePage.goto(invitationLink1);
    await expect(inviteePage.getByText('You’ve been invited!', { exact: true })).toBeVisible();
    await inviteePage.getByTestId('accept-btn').click();
    await expect(inviteePage).toHaveURL(`${BASE_URL}/company`, { timeout: 15_000 });

    await inviteePage.goto(invitationLink2);
    await expect(inviteePage.getByText('You’ve been invited!', { exact: true })).toBeVisible();
    await inviteePage.getByTestId('accept-btn').click();
    await expect(inviteePage).toHaveURL(`${BASE_URL}/company`, { timeout: 15_000 });

    await inviteeContext.close();

    // 4. Each inviter's OWN company independently shows D as a real Active member now.
    async function loginAndConfirmActiveMember(ownerAlias: string) {
      const checkContext = await browser.newContext({ ...devices['Desktop Chrome'] });
      const checkPage = await checkContext.newPage();
      await checkPage.goto(`${BASE_URL}/login`);
      await checkPage.locator('input[name="username"]').fill(generateUsernameFromEmail(ownerAlias));
      await checkPage.locator('input[name="password"]').fill(password);
      await checkPage.locator('button[type="submit"]').click();
      await expect(checkPage).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });
      await checkPage.goto(`${BASE_URL}/teams/members`);
      await expect(checkPage.getByRole('heading', { name: 'Member (1)', exact: true })).toBeVisible({ timeout: 20_000 });
      // Same role-inconsistency already documented for teamCard() - a
      // member row can render as either a button or a link.
      await expect(
        checkPage.getByRole('link', { name: 'QA Automation' }).or(checkPage.getByRole('button', { name: 'QA Automation' }))
      ).toBeVisible();
      await checkContext.close();
    }
    await loginAndConfirmActiveMember(owner1Alias);
    await loginAndConfirmActiveMember(owner2Alias);
  });
});

// Fully self-contained - registers its own account so it doesn't depend on
// or interfere with the main 'Teams' describe's own shared, order-sensitive state.
test.describe('Teams — List Sorting and Ownership Filtering', () => {
  test('6.14 Teams are shown alphabetically by name (not creation order), and that order survives a real reload; no team-ownership filter control exists anywhere on the page @real-email', async ({
    browser,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'One real registration; runs once on chromium only.');
    test.setTimeout(300_000);

    const emailAlias = generateUniqueEmailAlias();
    const username = generateUsernameFromEmail(emailAlias);
    const password = requireEnv('TEST_REGISTER_PASSWORD');
    const context = await browser.newContext({ ...devices['Desktop Chrome'] });
    const page = await context.newPage();
    const registeredAt = new Date();
    await registerNewAccount(page, emailAlias);
    const verifyLink = await getVerificationLink(emailAlias, registeredAt);
    await page.goto(verifyLink);
    await page.goto(`${BASE_URL}/login`);
    await page.fill('input[name="username"]', username);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/complete-profile$/, { timeout: 15_000 });
    await completeProfile(page);
    await expect(page).toHaveURL(/\/company$/, { timeout: 15_000 });

    // 1. Create 3 teams in deliberately reverse-alphabetical creation order.
    for (const name of ['Zebra Team', 'Middle Team', 'Alpha Team']) {
      await page.goto(`${BASE_URL}/teams/list`);
      await page.getByRole('button', { name: '+ Create Team' }).click();
      const nameField = page.getByRole('textbox', { name: 'Name' });
      await nameField.click();
      await nameField.pressSequentially(name);
      await page.getByRole('button', { name: 'Create' }).click();
      await expect(page.getByText('Your team was created successfully!', { exact: true })).toBeVisible({ timeout: 15_000 });
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.waitForTimeout(500);
    }

    // 2. Despite being created Zebra -> Middle -> Alpha, the real display
    // order is genuinely alphabetical: 'Alpha Team' < 'Middle Team' <
    // 'My Team' (the pre-existing default) < 'Zebra Team'.
    await page.goto(`${BASE_URL}/teams/list`);
    const cardOrder = async () => {
      const cards = page.getByRole('link', { name: /member/ }).or(page.getByRole('button', { name: /member/ }));
      const texts = await cards.allTextContents();
      return texts.map((t) => t.replace(/\d+ members?.*$/, '').trim());
    };
    await expect(async () => {
      expect(await cardOrder()).toEqual(['Alpha Team', 'Middle Team', 'My Team', 'Zebra Team']);
    }).toPass({ timeout: 15_000 });

    // 3. The same alphabetical order survives a real, full reload - not just an in-memory artifact of creation.
    await page.reload();
    await expect(async () => {
      expect(await cardOrder()).toEqual(['Alpha Team', 'Middle Team', 'My Team', 'Zebra Team']);
    }).toPass({ timeout: 15_000 });

    // 4. No ownership/sharing filter control exists anywhere on this page -
    // confirmed by enumerating every button/combobox present.
    const allButtonTexts = await page.getByRole('button').allTextContents();
    const filterLikeButtons = allButtonTexts.filter((t) => /filter|owned|shared/i.test(t));
    expect(filterLikeButtons).toEqual([]);
    await expect(page.locator('[role="combobox"]')).toHaveCount(1);

    await context.close();
  });
});

// Fully self-contained.
test.describe('Teams — Deleting a Team Does Not Cascade to its Invitations', () => {
  test("6.15 REAL: deleting a team does NOT remove pending invitations sent from that team's own detail page - invitations are genuinely company-wide, not team-scoped @real-email", async ({
    browser,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'One real registration + one real invitation; runs once on chromium only.');
    test.setTimeout(300_000);

    const emailAlias = generateUniqueEmailAlias();
    const username = generateUsernameFromEmail(emailAlias);
    const password = requireEnv('TEST_REGISTER_PASSWORD');
    const context = await browser.newContext({ ...devices['Desktop Chrome'] });
    const page = await context.newPage();
    const registeredAt = new Date();
    await registerNewAccount(page, emailAlias);
    const verifyLink = await getVerificationLink(emailAlias, registeredAt);
    await page.goto(verifyLink);
    await page.goto(`${BASE_URL}/login`);
    await page.fill('input[name="username"]', username);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/complete-profile$/, { timeout: 15_000 });
    await completeProfile(page);
    await expect(page).toHaveURL(/\/company$/, { timeout: 15_000 });

    // 1. Create a throwaway team and invite a brand-new email FROM that team's own detail page.
    await page.goto(`${BASE_URL}/teams/list`);
    await page.getByRole('button', { name: '+ Create Team' }).click();
    const nameField = page.getByRole('textbox', { name: 'Name' });
    await nameField.click();
    await nameField.pressSequentially('QA Cascade Test Team');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByText('Your team was created successfully!', { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForTimeout(500);

    await page.goto(`${BASE_URL}/teams/list`);
    await page
      .getByRole('link', { name: /QA Cascade Test Team/ })
      .or(page.getByRole('button', { name: /QA Cascade Test Team/ }))
      .click();
    await page.getByRole('button', { name: 'Invite Member' }).click();
    const cascadeEmail = generateUniqueEmailAlias();
    const combobox = page.getByRole('combobox', { name: 'Add People by Email' });
    await combobox.click();
    await combobox.pressSequentially(cascadeEmail);
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Invite' }).click();
    await expect(page.getByText('Your invitation(s) have been sent.', { exact: true })).toBeVisible({ timeout: 15_000 });

    // 2. Delete the team entirely.
    await page.goto(`${BASE_URL}/teams/list`);
    await page
      .getByRole('link', { name: /QA Cascade Test Team/ })
      .or(page.getByRole('button', { name: /QA Cascade Test Team/ }))
      .click();
    await page.getByRole('button', { name: 'Remove Team' }).click();
    await page.getByRole('button', { name: 'Yes, remove' }).click();
    await expect(page.getByText('Your team was deleted successfully!', { exact: true })).toBeVisible({ timeout: 15_000 });

    // 3. REAL: the invitation is still there, fully intact - it was never
    // actually tied to the team it was sent from (same shape as accepting
    // an invitation not auto-joining that team either - see CLAUDE.md).
    await page.goto(`${BASE_URL}/teams/members?memberTab=sentInvitations`);
    await expect(page.getByText(cascadeEmail, { exact: true })).toBeVisible();
    await expect(page.getByText('1–1 of 1', { exact: true })).toBeVisible();

    // Cleanup: cancel the invitation.
    const invitationRow = page.getByRole('row').filter({ has: page.getByText(cascadeEmail, { exact: true }) });
    await invitationRow.getByRole('button').filter({ hasText: /^$/ }).click();
    await page.getByRole('button', { name: 'Yes, cancel' }).click();
    await expect(page.getByText('Invitation has been revoked successfully!', { exact: true })).toBeVisible();

    await context.close();
  });
});

// Fully self-contained.
test.describe('Teams — Active Members List Has No Sort Control', () => {
  test('6.16 REAL: the company-wide Active Members list is a plain list with zero sort controls of any kind - no sortable column headers exist for it @real-email', async ({
    browser,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'One real registration; runs once on chromium only.');
    test.setTimeout(120_000);

    // This check is about the widget's own structure, not its data - any
    // logged-in account works, so a fresh throwaway registration is enough.
    const emailAlias = generateUniqueEmailAlias();
    const username = generateUsernameFromEmail(emailAlias);
    const password = requireEnv('TEST_REGISTER_PASSWORD');
    const context = await browser.newContext({ ...devices['Desktop Chrome'] });
    const page = await context.newPage();
    const registeredAt = new Date();
    await registerNewAccount(page, emailAlias);
    const verifyLink = await getVerificationLink(emailAlias, registeredAt);
    await page.goto(verifyLink);
    await page.goto(`${BASE_URL}/login`);
    await page.fill('input[name="username"]', username);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/complete-profile$/, { timeout: 15_000 });
    await completeProfile(page);
    await expect(page).toHaveURL(/\/company$/, { timeout: 15_000 });

    await page.goto(`${BASE_URL}/teams/members`);
    await expect(page.getByRole('tab', { name: 'Active' })).toHaveAttribute('aria-selected', 'true');

    // Zero column headers anywhere on this tab (unlike Sent Invitations,
    // which IS a real grid - see its own already-documented 'looks
    // sortable but isn't' bug for WEB-TC-083).
    await expect(page.getByRole('columnheader')).toHaveCount(0);
    await expect(page.getByRole('grid')).toHaveCount(0);

    await context.close();
  });
});

// Fully self-contained.
test.describe('Teams — Removal Notification Email', () => {
  test('6.17 Removing a member from a team @real-email', async ({ browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'Two real registrations + one real invite/accept round-trip; runs once on chromium only.');
    test.setTimeout(400_000);

    const password = requireEnv('TEST_REGISTER_PASSWORD');

    // 1. Register the owner.
    const ownerAlias = generateUniqueEmailAlias();
    const ownerUsername = generateUsernameFromEmail(ownerAlias);
    const ownerContext = await browser.newContext({ ...devices['Desktop Chrome'] });
    const ownerPage = await ownerContext.newPage();
    const ownerRegisteredAt = new Date();
    await registerNewAccount(ownerPage, ownerAlias);
    const ownerVerifyLink = await getVerificationLink(ownerAlias, ownerRegisteredAt);
    await ownerPage.goto(ownerVerifyLink);
    await ownerPage.goto(`${BASE_URL}/login`);
    await ownerPage.fill('input[name="username"]', ownerUsername);
    await ownerPage.fill('input[name="password"]', password);
    await ownerPage.click('button[type="submit"]');
    await expect(ownerPage).toHaveURL(/\/complete-profile$/, { timeout: 15_000 });
    await completeProfile(ownerPage);
    await expect(ownerPage).toHaveURL(/\/company$/, { timeout: 15_000 });

    // 2. Register the member, invite + accept.
    const memberAlias = generateUniqueEmailAlias();
    const memberUsername = generateUsernameFromEmail(memberAlias);
    const memberContext = await browser.newContext({ ...devices['Desktop Chrome'] });
    const memberPage = await memberContext.newPage();
    const memberRegisteredAt = new Date();
    await registerNewAccount(memberPage, memberAlias);
    const memberVerifyLink = await getVerificationLink(memberAlias, memberRegisteredAt);
    await memberPage.goto(memberVerifyLink);
    await memberPage.goto(`${BASE_URL}/login`);
    await memberPage.fill('input[name="username"]', memberUsername);
    await memberPage.fill('input[name="password"]', password);
    await memberPage.click('button[type="submit"]');
    await expect(memberPage).toHaveURL(/\/complete-profile$/, { timeout: 15_000 });
    await completeProfile(memberPage);
    await expect(memberPage).toHaveURL(/\/company$/, { timeout: 15_000 });

    await ownerPage.goto(`${BASE_URL}/teams/members`);
    await ownerPage.getByRole('button', { name: 'Invite Member' }).click();
    const combobox = ownerPage.getByRole('combobox', { name: 'Add People by Email' });
    await combobox.click();
    await combobox.pressSequentially(memberAlias);
    await ownerPage.keyboard.press('Enter');
    await ownerPage.getByRole('button', { name: 'Invite' }).click();
    await expect(ownerPage.getByText('Your invitation(s) have been sent.', { exact: true })).toBeVisible({ timeout: 15_000 });

    const invitationLink = await getInvitationLink(memberAlias, 240_000);
    await memberPage.goto(invitationLink);
    await memberPage.getByTestId('accept-btn').click();
    await expect(memberPage).toHaveURL(`${BASE_URL}/company`, { timeout: 15_000 });

    // 3. Add the member to 'My Team', then note the exact time before removing them.
    await ownerPage.goto(`${BASE_URL}/teams/list`);
    await ownerPage
      .getByRole('link', { name: /My Team/ })
      .or(ownerPage.getByRole('button', { name: /My Team/ }))
      .click();
    await ownerPage.getByRole('button', { name: '+ Add Members' }).click();
    await ownerPage.getByRole('button', { name: 'Open' }).click();
    await ownerPage.getByRole('option', { name: 'QA Automation' }).click();
    await ownerPage.getByRole('button', { name: 'Save' }).click();
    await expect(ownerPage.getByText('QA Automation', { exact: true })).toBeVisible();

    const removalRequestedAt = new Date();
    const memberRow = ownerPage.locator('.MuiCardHeader-root').filter({ hasText: 'QA Automation' });
    await memberRow.getByRole('button', { name: 'Remove member' }).click();
    await ownerPage.getByRole('button', { name: 'Yes, remove' }).click();
    await expect(ownerPage.getByText('QA Automation', { exact: true })).toHaveCount(0);

    // 4. REAL: removing a member sends no notification email of any kind -
    // if this ever starts failing, the app genuinely added one.
    const subject = await checkForAnyEmail(memberAlias, removalRequestedAt, 60_000);
    expect(subject, 'expected no removal-notification email to be sent to the removed member').toBeNull();

    await ownerContext.close();
    await memberContext.close();
  });
});
