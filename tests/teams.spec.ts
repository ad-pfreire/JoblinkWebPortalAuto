// spec: specs/teams-test-plan.md
// seed: tests/seed.spec.ts

import { test, expect, Page, Locator, devices } from '@playwright/test';
import { requireEnv } from './utils/env';
import { getVerificationLink, getInvitationLink } from './utils/email';
import { generateUniqueEmailAlias, generateUsernameFromEmail, registerNewAccount, completeProfile } from './utils/account';

const BASE_URL = requireEnv('BASE_URL');

let disposableUsername: string;
let disposablePassword: string;

/** Logs in with the disposable account from `beforeAll` and lands on /company. */
async function loginAsDisposableAndGoToCompany(page: Page) {
  await page.goto(`${BASE_URL}/login`);
  await page.locator('input[name="username"]').fill(disposableUsername);
  await page.locator('input[name="password"]').fill(disposablePassword);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });
  await page.goto(`${BASE_URL}/company`);
}

/** Matches a team card's accessible name ('<team name> 1 member <owner>') - every team here has exactly 1 member, so that part is hardcoded. */
function teamCard(page: Page, teamName: string) {
  return page.getByRole('button', { name: `${teamName} 1 member QA` });
}

/** Clears a field via real Backspace keystrokes, not fill('') (see CLAUDE.md's validation-timing gotcha). */
async function clearFieldWithBackspace(page: Page, field: Locator) {
  await field.click();
  await page.keyboard.press('End');
  const currentLength = (await field.inputValue()).length;
  for (let i = 0; i < currentLength; i++) {
    await page.keyboard.press('Backspace');
  }
}

/** Opens 'Update Team Name' via the unlabeled edit icon - the only button with an empty accessible name inside `<main>` on a team's detail view. */
function updateTeamNameEditIcon(page: Page) {
  return page.getByRole('main').getByRole('button').filter({ hasText: /^$/ });
}

/** Clicks 'Remove Team' to open its confirmation dialog - split from `confirmRemoveTeam()` so 4.3 can assert the dialog's own content in between. */
async function openRemoveTeamDialog(page: Page) {
  await page.getByRole('button', { name: 'Remove Team' }).click();
}

/** Confirms 'Remove Team' via 'Yes, remove' and waits for the success toast. */
async function confirmRemoveTeam(page: Page) {
  await page.getByRole('button', { name: 'Yes, remove' }).click();
  await expect(page.locator('text=Your team was deleted successfully!')).toBeVisible();
}

// Serial + chromium-only: avoids racing parallel browser projects on the one
// disposable company's Teams state built up across this file (see CLAUDE.md).
test.describe('Teams', () => {
  // retries: 2 - beforeAll depends on real email delivery, which can exceed
  // generous timeouts; without this, one slow delivery blocks the whole file (see CLAUDE.md).
  test.describe.configure({ mode: 'serial', retries: 2 });

  // Registers ONE disposable account, then runs every scenario serially
  // against that throwaway company (see CLAUDE.md's account-isolation
  // pattern) - Suite 1 specifically needs a genuinely FRESH company, which
  // the long-lived shared seed account can't guarantee.
  test.beforeAll(async ({ browser, browserName }) => {
    // Guarded here too, not just beforeEach - a beforeEach skip doesn't gate beforeAll (see CLAUDE.md).
    test.skip(
      browserName !== 'chromium',
      'Disposable single-company state built up sequentially across this file; runs once serially on chromium to avoid cross-project races, redundant registrations, and extra real-email load on the other 2 projects.'
    );

    test.setTimeout(300_000);

    // newContext() with the device profile, not bare newPage() - see CLAUDE.md's real-email delivery gotcha.
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

  test.describe('Teams — Navigation Structure, Default State, and Auth Guard', () => {
    test("1.1 Fresh/isolated company's 'For You' tab shows an empty 'Members you work with' section and a default 'My Team' (Owner, 1 member) @real-email", async ({ page }) => {
      // 1. Land on /company (done by beforeEach), click the 'Teams' tab.
      await page.getByRole('tab', { name: 'Teams' }).click();

      // Browser navigates to /teams (the 'For you' sub-tab, selected by
      // default).
      await expect(page).toHaveURL(`${BASE_URL}/teams`);
      await expect(page.getByRole('tab', { name: 'For you' })).toHaveAttribute('aria-selected', 'true');

      // A 'Select Teams & People' search box, '+ Create Team', and 'Invite
      // Member' buttons are visible in the header - present on every Teams
      // sub-tab.
      await expect(page.getByRole('combobox', { name: 'Select Teams & People' })).toBeVisible();
      await expect(page.getByRole('button', { name: '+ Create Team' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Invite Member' })).toBeVisible();

      // 2. Inspect the 'Members you work with' section.
      await expect(page.getByRole('heading', { name: 'Members you work with' })).toBeVisible();
      // Live-verified via direct DOM inspection: the section's link to
      // /teams/members carries the real visible label 'Browse Everyone'
      // (not an unlabeled icon as its plain '/url' alone might suggest).
      const browseEveryoneLink = page.getByRole('link', { name: 'Browse Everyone' });
      await expect(browseEveryoneLink).toBeVisible();
      await expect(browseEveryoneLink).toHaveAttribute('href', '/teams/members');
      await expect(page.getByText('Add some members to be displayed here', { exact: true })).toBeVisible();

      // 3. Inspect the 'Your Teams' section.
      await expect(page.getByRole('heading', { name: 'Your Teams' })).toBeVisible();
      // Same reasoning as 'Browse Everyone' above - live-verified label.
      const browseAllTeamsLink = page.getByRole('link', { name: 'Browse All Teams' });
      await expect(browseAllTeamsLink).toBeVisible();
      await expect(browseAllTeamsLink).toHaveAttribute('href', '/teams/list');

      // Exactly one team card - the avatar's accessible text is only the
      // FIRST name ('QA'), not the full name, so matched by the card's own
      // distinctive '<team> <count> member(s) <first name>' shape rather
      // than a container locator (a naive `.filter({has}).last()` here resolves to the header row, not the card button).
      await expect(page.getByRole('button', { name: 'My Team 1 member QA' })).toBeVisible();
      await expect(page.getByRole('button', { name: /member/ })).toHaveCount(1);
    });

    test("1.2 The 'Teams' sub-tab lists every team as a card under 'Teams (N)', and clicking a card navigates to a deep-linkable team detail view @real-email", async ({ page }) => {
      // 1. Click the 'Teams' sub-tab (or navigate to /teams/list directly).
      await page.goto(`${BASE_URL}/teams/list`);

      // Heading reads 'Teams (1)' on a fresh company (matching the single
      // default team), with one card for 'My Team'.
      await expect(page.getByRole('heading', { name: 'Teams (1)', exact: true })).toBeVisible();
      const myTeamCard = page.getByRole('button', { name: 'My Team 1 member QA' });
      await expect(myTeamCard).toBeVisible();

      // 2. Click the 'My Team' card.
      await myTeamCard.click();

      // The URL becomes /teams/list?team=<teamId>&cardDetails=true - a
      // real, deep-linkable query-string route.
      await expect(page).toHaveURL(/\/teams\/list\?team=[a-f0-9]+&cardDetails=true$/);

      await expect(page.getByRole('button', { name: 'Go Back' })).toBeVisible();
      const teamNameHeading = page.getByRole('heading', { name: 'My Team', level: 4 });
      await expect(teamNameHeading).toBeVisible();

      // The edit icon sits two DOM levels up from the heading - a single
      // `.filter({has}).last()` resolves to the innermost heading-only div,
      // not the one with the button too, so this double-filters for both (same technique as payments.spec.ts's rewardsBalancesCard()).
      const teamNameHeadingContainer = page
        .locator('div')
        .filter({ has: teamNameHeading })
        .filter({ has: page.getByRole('button') })
        .last();
      await expect(teamNameHeadingContainer.getByRole('button')).toHaveCount(1);

      await expect(page.getByRole('heading', { name: 'Member', level: 6 })).toBeVisible();
      await expect(page.getByRole('button', { name: '+ Add Members' })).toBeVisible();
      await expect(page.getByText('You', { exact: true })).toBeVisible();
      await expect(page.getByText('Owner', { exact: true })).toBeVisible();
    });

    test("1.3 The Members sub-tab's company-wide 'Member (N)' count is a different concept from a team's own member count, and deliberately excludes the owner @real-email", async ({ page }) => {
      // 1. Navigate to /teams/members (Active tab, the default).
      await page.goto(`${BASE_URL}/teams/members`);

      // 'Member (0)' even though the SAME account shows as '1 member'/'Owner'
      // in My Team (1.1/1.2) - /teams/members tracks company-wide accepted invitations, not team membership (which includes the owner).
      await expect(page.getByRole('heading', { name: 'Member (0)', exact: true })).toBeVisible();

      // The page shows 'Active'/'Sent Invitations' tabs, with 'Active'
      // selected by default, and an empty-state message 'Add some members
      // to be displayed here'.
      const activeTab = page.getByRole('tab', { name: 'Active' });
      await expect(activeTab).toBeVisible();
      await expect(activeTab).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('tab', { name: 'Sent Invitations' })).toBeVisible();
      await expect(page.getByText('Add some members to be displayed here', { exact: true })).toBeVisible();
    });

    test('1.4 Auth guard: accessing any of /teams, /teams/list, /teams/members directly while logged out redirects to /login with a redirectUrl, and logging back in lands on the originally-requested page @real-email', async ({ page }) => {
      // 1. While logged in, log out via the account menu (avatar -> 'Log
      // Out').
      await page.getByRole('button', { name: 'account of current user' }).click();
      await page.getByRole('menuitem', { name: 'Log Out' }).click();

      // The browser lands on /login.
      await expect(page).toHaveURL(`${BASE_URL}/login`);

      // 2. Navigate directly to each of /teams, /teams/list, /teams/members while logged out.
      await page.goto(`${BASE_URL}/teams`);
      await expect(page).toHaveURL(`${BASE_URL}/login?redirectUrl=${encodeURIComponent(`${BASE_URL}/teams`)}`);

      await page.goto(`${BASE_URL}/teams/list`);
      await expect(page).toHaveURL(`${BASE_URL}/login?redirectUrl=${encodeURIComponent(`${BASE_URL}/teams/list`)}`);

      await page.goto(`${BASE_URL}/teams/members`);
      await expect(page).toHaveURL(`${BASE_URL}/login?redirectUrl=${encodeURIComponent(`${BASE_URL}/teams/members`)}`);

      // 3. Log in from the last redirected page - lands on '/teams/members' directly, not the default '/company'.
      await page.locator('input[name="username"]').fill(disposableUsername);
      await page.locator('input[name="password"]').fill(disposablePassword);
      await page.locator('button[type="submit"]').click();
      await expect(page).toHaveURL(`${BASE_URL}/teams/members`, { timeout: 15_000 });
    });
  });

  test.describe('Teams — Default Team (\'My Team\') Detail Page', () => {
    test("2.1 The default team's sole member row ('You' / 'Owner') has no visible remove or role-change action, and the page has NO 'Remove Team' button anywhere @real-email", async ({ page }) => {
      // 1. On My Team's detail page, inspect the 'You'/'Owner' row and the whole page for any delete/remove-team control.
      await page.goto(`${BASE_URL}/teams/list`);
      await teamCard(page, 'My Team').click();
      await expect(page).toHaveURL(/\/teams\/list\?team=[a-f0-9]+&cardDetails=true$/);

      // Scoped by the row's own stable MUI class, not a generic text
      // filter - the whole detail panel also contains 'You'/'Owner' as
      // descendants and DOES have other buttons ('Go Back', edit, '+ Add Members').
      const memberRow = page.locator('.MuiCardHeader-root');
      await expect(memberRow.getByText('You', { exact: true })).toBeVisible();
      await expect(memberRow.getByText('Owner', { exact: true })).toBeVisible();
      await expect(memberRow.getByRole('button')).toHaveCount(0);

      // No 'Remove Team' anywhere on this page - Suite 4 confirms this is specific to the default team, not a general rule.
      await expect(page.getByRole('button', { name: 'Remove Team' })).toHaveCount(0);
    });

    test("2.2 REAL BUG: the 'Update Team Name' modal's Name field accepts a whitespace-only value with the Update button becoming enabled and no validation shown @real-email", async ({ page }) => {
      // 1. Open 'Update Team Name', clear the pre-filled 'Name' via real Backspace keystrokes, then blur it.
      await page.goto(`${BASE_URL}/teams/list`);
      await teamCard(page, 'My Team').click();
      await updateTeamNameEditIcon(page).click();

      await expect(page.getByRole('heading', { name: 'Update Team Name' })).toBeVisible();
      const nameField = page.getByRole('textbox', { name: 'Name' });
      await expect(nameField).toHaveValue('My Team');
      const updateButton = page.getByRole('button', { name: 'Update' });
      await expect(updateButton).toBeDisabled();

      await clearFieldWithBackspace(page, nameField);
      await page.getByRole('heading', { name: 'Update Team Name' }).click();

      await expect(page.getByText('The field is required', { exact: true })).toBeVisible();
      await expect(nameField).toHaveAttribute('aria-invalid', 'true');
      await expect(updateButton).toBeDisabled();

      // 2. Type exactly three spaces via real keystrokes (not fill()).
      await nameField.click();
      await nameField.pressSequentially('   ');

      // REAL BUG: 'Update' becomes ENABLED with only whitespace, no error - the same fill()-vs-keystrokes gap (see CLAUDE.md), confirmed for Team Name too.
      await expect(updateButton).toBeEnabled();
      await expect(page.getByText('The field is required', { exact: true })).not.toBeVisible();

      // 3. Click 'Cancel' rather than submitting, to avoid corrupting the default team's name (3.2 already confirms this persists server-side).
      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByRole('heading', { name: 'Update Team Name' })).not.toBeVisible();
      await expect(page.getByRole('heading', { name: 'My Team', level: 4 })).toBeVisible();
    });

    test("2.3 '+ Add Members' shows a bare 'Select' placeholder as if it were a real option, instead of a proper empty-state message, when the company has no other active members @real-email", async ({ page }) => {
      // 1. Click '+ Add Members' on My Team's detail page, then open the 'Add team members' combobox's dropdown.
      await page.goto(`${BASE_URL}/teams/list`);
      await teamCard(page, 'My Team').click();
      await page.getByRole('button', { name: '+ Add Members' }).click();

      const combobox = page.getByRole('combobox', { name: 'Add team members' });
      await expect(combobox).toBeVisible();
      const saveButton = page.getByRole('button', { name: 'Save' });
      await expect(saveButton).toBeDisabled();
      await page.getByRole('button', { name: 'Open' }).click();

      // Shows a single row reading literally 'Select' - the field's own
      // placeholder text - rather than a real empty-state message; a plain non-interactive <p>, not a selectable option.
      await expect(page.getByText('Select', { exact: true })).toBeVisible();
      await expect(saveButton).toBeDisabled();
    });
  });

  test.describe('Teams — Create Team', () => {
    test("3.1 The Create Team modal's structure: required Name, optional Add Teams Members, Create disabled until Name holds a value @real-email", async ({ page }) => {
      // 1. Click '+ Create Team' from any Teams sub-tab.
      await page.goto(`${BASE_URL}/teams/list`);
      await page.getByRole('button', { name: '+ Create Team' }).click();

      // Required 'Name', optional 'Add Teams Members', 'Create' disabled on the pristine empty form.
      await expect(page.getByRole('heading', { name: 'Create Team' })).toBeVisible();
      const nameField = page.getByRole('textbox', { name: 'Name' });
      await expect(nameField).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Add Teams Members' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Open' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
      const createButton = page.getByRole('button', { name: 'Create' });
      await expect(createButton).toBeDisabled();

      // 2. Type a normal team name via real keystrokes - 'Create' becomes enabled.
      await nameField.click();
      await nameField.pressSequentially('QA Second Team');
      await expect(createButton).toBeEnabled();

      // Cleanup: close without submitting - this only verifies structure/enabled-state; 3.4 covers a real submission.
      await page.getByRole('button', { name: 'Cancel' }).click();
    });

    test('3.2 REAL BUG: submitting Create Team with a whitespace-only Name is accepted client-side and genuinely PERSISTS a blank-looking team to the backend @real-email', async ({ page }) => {
      // 1. Open 'Create Team', type exactly three spaces into 'Name' via real keystrokes, leave 'Add Teams Members' empty, click 'Create'.
      await page.goto(`${BASE_URL}/teams/list`);
      await expect(page.getByRole('heading', { name: 'Teams (1)', exact: true })).toBeVisible();
      await page.getByRole('button', { name: '+ Create Team' }).click();
      const nameField = page.getByRole('textbox', { name: 'Name' });
      await nameField.click();
      await nameField.pressSequentially('   ');
      await page.getByRole('button', { name: 'Create' }).click();

      // REAL BUG: an in-modal success screen appears exactly like a valid submission - no server-side rejection either.
      await expect(page.getByText('Your team was created successfully!', { exact: true })).toBeVisible();
      const continueButton = page.getByRole('button', { name: 'Continue' });
      await expect(continueButton).toBeVisible();

      // 2. Click 'Continue' - a new team card appears with a completely
      // EMPTY heading. Located by elimination (2 cards exist, the new one
      // is whichever doesn't contain 'My Team'), since a blank heading's contribution to the accessible name isn't predictable.
      await continueButton.click();
      await expect(page.getByRole('heading', { name: 'Teams (2)', exact: true })).toBeVisible();
      const allTeamCards = page.getByRole('button', { name: /member/ });
      await expect(allTeamCards).toHaveCount(2);
      const blankTeamCard = allTeamCards.filter({ hasNotText: 'My Team' });
      await expect(blankTeamCard).toHaveCount(1);
      await expect(blankTeamCard.getByText('1 member', { exact: true })).toBeVisible();

      // 3. Inspect the raw DOM textContent, not just the visual appearance
      // (toHaveText normalizes/trims whitespace by default).
      const blankNameHeading = blankTeamCard.locator('h6').first();
      await expect(blankNameHeading).toHaveText('');
      // Raw textContent is exactly three spaces - genuinely persisted server-side, not a client-side rendering quirk.
      const rawTextContent = await blankNameHeading.evaluate((el) => el.textContent);
      expect(rawTextContent).toBe('   ');

      // 4. Cleanup: delete this blank-named team, so the next test starts from a clean 'Teams (1)' state.
      await blankTeamCard.click();
      await expect(page).toHaveURL(/\/teams\/list\?team=[a-f0-9]+&cardDetails=true$/);
      await openRemoveTeamDialog(page);
      await confirmRemoveTeam(page);
      await page.goto(`${BASE_URL}/teams/list`);
      await expect(page.getByRole('heading', { name: 'Teams (1)', exact: true })).toBeVisible();
    });

    test("3.3 Creating a team with a name that exactly duplicates an existing team's name in the same company IS correctly blocked @real-email", async ({ page }) => {
      // 1. Open 'Create Team' and type the exact existing name 'My Team'
      // (character-for-character) into 'Name', then click 'Create'.
      await page.goto(`${BASE_URL}/teams/list`);
      await page.getByRole('button', { name: '+ Create Team' }).click();
      const nameField = page.getByRole('textbox', { name: 'Name' });
      await nameField.click();
      await nameField.pressSequentially('My Team');
      const createButton = page.getByRole('button', { name: 'Create' });
      await expect(createButton).toBeEnabled();
      await createButton.click();

      // A genuine, working validation - in contrast to 3.2's whitespace
      // gap, SOME name validation does exist here (duplicate detection).
      await expect(page.getByText('Team with that name already exists', { exact: true })).toBeVisible();
      await expect(nameField).toHaveAttribute('aria-invalid', 'true');
      await expect(createButton).toBeDisabled();

      // 2. (Cleanup) Click 'Cancel' to close the modal without creating
      // anything.
      await page.getByRole('button', { name: 'Cancel' }).click();

      // No new team is created.
      await page.goto(`${BASE_URL}/teams/list`);
      await expect(page.getByRole('heading', { name: 'Teams (1)', exact: true })).toBeVisible();
    });

    test("3.4 A successful Create Team (valid, non-blank, non-duplicate name) shows an in-modal success screen and the new team appears immediately across the UI @real-email", async ({ page }) => {
      // 1. Open 'Create Team', type a valid unique name, leave 'Add Teams Members' empty (no other candidates yet, see 2.3), click 'Create'.
      await page.goto(`${BASE_URL}/teams/list`);
      await page.getByRole('button', { name: '+ Create Team' }).click();
      const nameField = page.getByRole('textbox', { name: 'Name' });
      await nameField.click();
      await nameField.pressSequentially('QA Second Team');
      await page.getByRole('button', { name: 'Create' }).click();

      await expect(page.getByText('Your team was created successfully!', { exact: true })).toBeVisible();
      const continueButton = page.getByRole('button', { name: 'Continue' });

      // 2. Click 'Continue' - 'Teams (N)' increments, a new card appears here and under 'Your Teams' on 'For you'.
      await continueButton.click();
      await expect(page.getByRole('heading', { name: 'Create Team' })).not.toBeVisible();
      await expect(page.getByRole('heading', { name: 'Teams (2)', exact: true })).toBeVisible();
      await expect(teamCard(page, 'QA Second Team')).toBeVisible();

      await page.goto(`${BASE_URL}/teams`);
      await expect(teamCard(page, 'QA Second Team')).toBeVisible();

      // This team stays alive on purpose - Suite 4 below reuses it
      // (renames it, then deletes it).
    });
  });

  test.describe('Teams — Non-Default Team Lifecycle: Rename and Delete', () => {
    test("4.1 Unlike the default 'My Team', a team the user explicitly creates DOES show a 'Remove Team' button on its detail page - regardless of total team count @real-email", async ({ page }) => {
      // 1. Open a non-default team's detail page (e.g. 'QA Second Team', with 'My Team' still existing too).
      await page.goto(`${BASE_URL}/teams/list`);
      await expect(page.getByRole('heading', { name: 'Teams (2)', exact: true })).toBeVisible();
      await teamCard(page, 'QA Second Team').click();
      await expect(page).toHaveURL(/\/teams\/list\?team=[a-f0-9]+&cardDetails=true$/);
      await expect(page.getByRole('button', { name: 'Remove Team' })).toBeVisible();

      // 2. Go back and open 'My Team''s detail page, with the same 2 teams still existing.
      await page.getByRole('button', { name: 'Go Back' }).click();
      await teamCard(page, 'My Team').click();
      await expect(page.getByRole('heading', { name: 'My Team', level: 4 })).toBeVisible();

      // Still no 'Remove Team' - this is hardcoded to the seeded default team, not a "can't delete your only team" rule.
      await expect(page.getByRole('button', { name: 'Remove Team' })).toHaveCount(0);
    });

    test("4.2 A genuine, real 'Update Team Name' save on a non-default team persists correctly end-to-end @real-email", async ({ page }) => {
      // 1. On a non-default team, open 'Update Team Name', replace the Name via real keystrokes, click 'Update'.
      await page.goto(`${BASE_URL}/teams/list`);
      await teamCard(page, 'QA Second Team').click();
      await updateTeamNameEditIcon(page).click();

      const nameField = page.getByRole('textbox', { name: 'Name' });
      await expect(nameField).toHaveValue('QA Second Team');
      await clearFieldWithBackspace(page, nameField);
      await nameField.pressSequentially('QA Second Team Renamed');
      await page.getByRole('button', { name: 'Update' }).click();

      // Success screen reads "Your team's name have been changed
      // successfully!" - grammar defect ('have' should be 'has'), not functional.
      await expect(page.getByText("Your team's name have been changed successfully!", { exact: true })).toBeVisible();
      const continueButton = page.getByRole('button', { name: 'Continue' });

      // 2. Click 'Continue' - heading reflects the new name immediately, no reload needed.
      await continueButton.click();
      await expect(page.getByRole('heading', { name: 'QA Second Team Renamed', level: 4 })).toBeVisible();

      // 3. Navigate away and back - the new name persists, confirming a genuine backend save.
      await page.getByRole('button', { name: 'Go Back' }).click();
      await expect(page.getByRole('heading', { name: 'Teams (2)', exact: true })).toBeVisible();
      await teamCard(page, 'QA Second Team Renamed').click();
      await expect(page.getByRole('heading', { name: 'QA Second Team Renamed', level: 4 })).toBeVisible();
    });

    test("4.3 'Remove Team' opens a dialog titled 'Delete Team' (a label inconsistency with the triggering button) with a grammar defect in its body copy, and confirming genuinely deletes the team @real-email", async ({ page }) => {
      // 1. On a non-default team's detail page, click 'Remove Team'.
      await page.goto(`${BASE_URL}/teams/list`);
      await teamCard(page, 'QA Second Team Renamed').click();
      await openRemoveTeamDialog(page);

      // Dialog TITLE reads 'Delete Team', not 'Remove Team' (the triggering
      // button's own text) - a minor label inconsistency, same family as Payments' loose 'Remove'/'Delete' phrasing.
      await expect(page.getByRole('heading', { name: 'Delete Team', exact: true })).toBeVisible();

      // Grammar defect: missing 'be' before 'permanently deleted'. Uses a real typographic apostrophe (U+2019) in "team's", not ASCII.
      await expect(
        page.getByText(
          "Are you sure you want to delete this team? If you choose to delete the team, all of the team’s data will permanently deleted.",
          { exact: true }
        )
      ).toBeVisible();

      // 'No, go back' and 'Yes, remove' buttons are shown.
      await expect(page.getByRole('button', { name: 'No, go back' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Yes, remove' })).toBeVisible();

      // 2. Click 'Yes, remove'.
      await confirmRemoveTeam(page);

      // Re-navigating confirms genuine server-side deletion (not just an optimistic client-side removal) - 'Teams (N)' decrements, card is gone.
      await page.goto(`${BASE_URL}/teams/list`);
      await expect(page.getByRole('heading', { name: 'Teams (1)', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: /QA Second Team/ })).toHaveCount(0);

      // Also gone from 'Your Teams' on 'For you'.
      await page.goto(`${BASE_URL}/teams`);
      await expect(page.getByRole('button', { name: /QA Second Team/ })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'My Team 1 member QA' })).toBeVisible();
    });
  });

  test.describe('Teams — Members Page (/teams/members): Active and Sent Invitations Tabs', () => {
    test("5.1 A fresh/isolated company's Active tab and Sent Invitations tab each show their own distinct empty state @real-email", async ({ page }) => {
      // 1. Inspect the 'Active' tab (selected by default) with no invitations sent and no accepted members.
      await page.goto(`${BASE_URL}/teams/members`);
      await expect(page.getByRole('heading', { name: 'Member (0)', exact: true })).toBeVisible();
      const activeTab = page.getByRole('tab', { name: 'Active' });
      await expect(activeTab).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByText('Add some members to be displayed here', { exact: true })).toBeVisible();
      await expect(page.getByRole('grid')).toHaveCount(0);

      // 2. Click the 'Sent Invitations' tab.
      await page.getByRole('tab', { name: 'Sent Invitations' }).click();

      // URL gains a real, deep-linkable '?memberTab=sentInvitations' param, and a genuine grid renders (unlike Active's plain placeholder text).
      await expect(page).toHaveURL(`${BASE_URL}/teams/members?memberTab=sentInvitations`);
      const grid = page.getByRole('grid');
      await expect(grid).toBeVisible();
      await expect(grid.getByRole('columnheader', { name: 'Email Address' })).toBeVisible();
      await expect(grid.getByRole('columnheader', { name: 'Date Sent' })).toBeVisible();
      await expect(grid.getByRole('columnheader', { name: 'Actions' })).toBeVisible();
      await expect(page.getByText('You have not sent any invitations.', { exact: true })).toBeVisible();
      await expect(page.getByText('0–0 of 0', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Go to previous page' })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Go to next page' })).toBeDisabled();
    });

    test("5.2 Full Active-tab coverage (a real accepted member) is covered by test 6.7, not here @real-email", async () => {
      // Test 6.7 later covers the full invite -> accept -> 'Member (1)' flow
      // end-to-end - can't be verified here since this test runs before 6.7 ever creates a real accepted member (serial execution order).
      test.skip(true, "Covered by test 6.7 later in this file - see that test's own assertions on the Active tab's 'Member (1)' state.");
    });
  });

  test.describe('Teams — Invite Member Flow', () => {
    // Set by test 6.3 below (which registers a second real, disposable
    // Cognito sign-up and, in the same submission, also invites a
    // completely fresh never-used email) and reused by tests 6.4/6.5/6.6
    // later in this same serial file - a pending invitation created by one
    // test is exactly the fixture the next ones need (the invite
    // combobox's own duplicate-prevention guard, a real Resend, and a real
    // Cancel Invitation all need an ALREADY-existing pending invitation to
    // act on).
    let freshEmail: string;
    let pendingEmail: string;

    // Exact shape of a single record inside GET /api/invitations' `data`
    // array and of the response envelope itself - live-verified via direct
    // inspection of the real endpoint while writing this suite (confirmed
    // both on an empty company, `{"metadata":{"total":0,...},"data":[]}`,
    // and against a real invitation record,
    // `{"id":"...","email":"...","updatedAt":"..."}`).
    type InvitationRecord = { id: string; email: string; updatedAt: string };
    type InvitationsResponse = { metadata: { total: number; perPage: number; currentPage: number }; data: InvitationRecord[] };

    // Opens the 'Invite Member' modal - present on every Teams sub-tab
    // (already confirmed in test 1.1 above).
    async function openInviteMemberModal(page: Page) {
      await page.getByRole('button', { name: 'Invite Member' }).click();
      await expect(page.getByRole('heading', { name: 'Invite Member' })).toBeVisible();
    }

    // Types an email into the 'Add People by Email' combobox via real
    // keystrokes (pressSequentially, not fill()) and presses Enter to
    // attempt to chip it. Every scenario in this suite that uses this
    // helper is deliberately validation-triggering (an invalid format, an
    // existing active user's own email, a duplicate pending invitation),
    // so this follows the same fill()-vs-real-keystrokes validation-timing
    // gotcha already documented in CLAUDE.md and applied elsewhere in this
    // file (see clearFieldWithBackspace() above).
    async function typeAndChipInviteEmail(page: Page, email: string) {
      const combobox = page.getByRole('combobox', { name: 'Add People by Email' });
      await combobox.click();
      await combobox.pressSequentially(email);
      await page.keyboard.press('Enter');
    }

    // Locates a specific 'Sent Invitations' row by its exact email address
    // - needed from test 6.3 onward, since more than one pending
    // invitation can exist in the grid at once, making a plain page-wide
    // 'Resend'/cancel-icon locator ambiguous.
    function invitationRow(page: Page, email: string) {
      return page.getByRole('row').filter({ has: page.getByText(email, { exact: true }) });
    }

    /** Scopes to the row's unlabeled cancel-invitation icon - the only OTHER button in the row is 'Resend' (see updateTeamNameEditIcon()'s same technique). */
    function cancelInvitationIcon(page: Page, email: string) {
      return invitationRow(page, email).getByRole('button').filter({ hasText: /^$/ });
    }

    /**
     * Navigates to Sent Invitations via a real reload and returns the parsed
     * GET /api/invitations body - used to prove REAL backend state, not just
     * the client's in-memory grid. Intercepted via `page.route()`, since a
     * plain waitForResponse().then(r => r.json()) intermittently throws
     * "body not available" here (same fix as logo-upload.spec.ts, see CLAUDE.md).
     */
    async function gotoSentInvitationsAndGetResponse(page: Page): Promise<InvitationsResponse> {
      // `{ times: 1 }` self-detaches after one match - this function is
      // called twice per test (6.5's before/after), and a manual unroute()
      // right after the first call's poll can race a request already
      // matched by the same handler ("Route is already handled!").
      let parsed: InvitationsResponse | undefined;
      await page.route(
        '**/api/invitations*',
        async (route) => {
          if (route.request().method() !== 'GET') return route.fallback();
          const response = await route.fetch();
          parsed = (await response.json()) as InvitationsResponse;
          await route.fulfill({ response });
        },
        { times: 1 }
      );
      await page.goto(`${BASE_URL}/teams/members?memberTab=sentInvitations`);
      await expect.poll(() => parsed).toBeTruthy();
      return parsed!;
    }

    test('6.1 The Invite Member modal validates email format client-side @real-email', async ({ page }) => {
      // 1. Click 'Invite Member', type an invalid value, press Enter.
      await page.goto(`${BASE_URL}/teams/members`);
      await openInviteMemberModal(page);
      await typeAndChipInviteEmail(page, 'not-an-email');

      // The combobox is marked invalid, an inline message reads exactly
      // 'Invalid email address', and 'Invite' stays disabled.
      const combobox = page.getByRole('combobox', { name: 'Add People by Email' });
      await expect(combobox).toHaveAttribute('aria-invalid', 'true');
      await expect(page.getByText('Invalid email address', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Invite' })).toBeDisabled();

      // Cleanup: close without submitting.
      await page.getByRole('button', { name: 'Cancel' }).click();
    });

    test("6.2 REAL BUG: inviting an email that already belongs to an existing active user account (e.g. the logged-in account's own email) produces a false-positive success toast but creates NO real invitation @real-email", async ({ page }) => {
      // 1. Discover the logged-in account's own email from /profile (not hardcoded, see CLAUDE.md's Portability convention), then invite it.
      await page.goto(`${BASE_URL}/profile`);
      const ownEmail = await page.locator('input[name="email"]').inputValue();
      expect(ownEmail).toBeTruthy();

      await page.goto(`${BASE_URL}/teams/members`);
      await openInviteMemberModal(page);
      await typeAndChipInviteEmail(page, ownEmail);

      // 'Invite' becomes enabled once chipped (passes client-side validation).
      const inviteButton = page.getByRole('button', { name: 'Invite' });
      await expect(inviteButton).toBeEnabled();
      await inviteButton.click();

      // REAL BUG: a success toast still appears and the POST itself returns success.
      await expect(page.getByText('Your invitation(s) have been sent.', { exact: true })).toBeVisible();

      // But a real reload onto Sent Invitations shows total 0 / empty data -
      // a genuine silent false-positive, not merely a UI-refresh lag.
      const invitationsResponse = await gotoSentInvitationsAndGetResponse(page);
      expect(invitationsResponse.metadata.total).toBe(0);
      expect(invitationsResponse.data).toEqual([]);
      await expect(page.getByText('You have not sent any invitations.', { exact: true })).toBeVisible();
      await expect(page.getByText('0–0 of 0', { exact: true })).toBeVisible();
    });

    test('6.3 A brand-new never-used email, AND an email already tied to a not-yet-verified pending registration, both create genuine invitations — and multiple emails can be invited in a single submission @real-email', async ({ page, browser }) => {
      test.slow(); // a real second registration + real multi-email invite round-trip

      // 1. Register a second disposable email and stop at the pending
      // verification screen - never click the link or log in. Done in a
      // separate context so the inviter's own session is never disturbed.
      pendingEmail = generateUniqueEmailAlias();
      const registerContext = await browser.newContext({ ...devices['Desktop Chrome'] });
      const registerPage = await registerContext.newPage();
      await registerNewAccount(registerPage, pendingEmail);
      await registerContext.close();

      // 2. Chip a fresh email plus the unconfirmed one from step 1, then click 'Invite' once with both present.
      freshEmail = generateUniqueEmailAlias();
      await page.goto(`${BASE_URL}/teams/members`);
      await openInviteMemberModal(page);
      await typeAndChipInviteEmail(page, freshEmail);
      await typeAndChipInviteEmail(page, pendingEmail);
      const inviteButton = page.getByRole('button', { name: 'Invite' });
      await expect(inviteButton).toBeEnabled();
      await inviteButton.click();

      // This time it's a real, non-phantom result - both rows appear immediately.
      await expect(page.getByText('Your invitation(s) have been sent.', { exact: true })).toBeVisible();
      await page.getByRole('tab', { name: 'Sent Invitations' }).click();
      await expect(page.getByText('1–2 of 2', { exact: true })).toBeVisible();
      await expect(invitationRow(page, freshEmail)).toBeVisible();
      await expect(invitationRow(page, pendingEmail)).toBeVisible();
      await expect(invitationRow(page, freshEmail).getByRole('button', { name: 'Resend' })).toBeVisible();
      await expect(invitationRow(page, pendingEmail).getByRole('button', { name: 'Resend' })).toBeVisible();

      // 3. Inspect the GET /api/invitations response.
      const invitationsResponse = await gotoSentInvitationsAndGetResponse(page);

      // Two real invitation objects with distinct ids - genuine backend
      // records, unlike 6.2's self-invite case. Confirms 6.2's bug is
      // specific to an ALREADY-ACTIVE user, not any unconfirmed pending sign-up.
      expect(invitationsResponse.metadata.total).toBe(2);
      const emails = invitationsResponse.data.map((invitation) => invitation.email);
      expect(emails).toContain(freshEmail);
      expect(emails).toContain(pendingEmail);
      const ids = invitationsResponse.data.map((invitation) => invitation.id);
      expect(new Set(ids).size).toBe(2);
    });

    test('6.4 The invite combobox client-side blocks re-inviting an email that already has a pending invitation, preventing duplicate rows @real-email', async ({ page }) => {
      // 1. Chip the SAME email already pending from 6.3.
      await page.goto(`${BASE_URL}/teams/members`);
      await openInviteMemberModal(page);
      await typeAndChipInviteEmail(page, freshEmail);

      // A genuine, working duplicate-prevention guard - real typographic apostrophe (U+2019), not ASCII.
      const combobox = page.getByRole('combobox', { name: 'Add People by Email' });
      await expect(combobox).toHaveAttribute('aria-invalid', 'true');
      await expect(page.getByText('You’ve already invited this email address.', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Invite' })).toBeDisabled();

      // Cleanup: close without submitting - 6.3's pending invitations stay untouched for 6.5/6.6.
      await page.getByRole('button', { name: 'Cancel' }).click();
    });

    test("6.5 'Resend' on a pending invitation shows a success toast and genuinely updates the invitation server-side — even though the UI's minute-granularity 'Date Sent' column can look visually unchanged @real-email", async ({ page }) => {
      // Captures the real 'before' updatedAt via a full reload.
      const beforeResponse = await gotoSentInvitationsAndGetResponse(page);
      const beforeInvitation = beforeResponse.data.find((invitation) => invitation.email === freshEmail);
      expect(beforeInvitation).toBeTruthy();

      // 1. Click 'Resend' on a pending invitation row.
      await invitationRow(page, freshEmail).getByRole('button', { name: 'Resend' }).click();
      await expect(page.getByText('Invitation has been resent successfully!', { exact: true })).toBeVisible();

      // 2. Re-check via a fresh full reload.
      const afterResponse = await gotoSentInvitationsAndGetResponse(page);
      const afterInvitation = afterResponse.data.find((invitation) => invitation.email === freshEmail);
      expect(afterInvitation).toBeTruthy();

      // updatedAt genuinely changed server-side - but the UI's 'Date Sent'
      // column only shows minute precision, so a same-minute resend can
      // visually look unchanged even though it worked (display limitation, not a bug).
      expect(afterInvitation!.updatedAt).not.toBe(beforeInvitation!.updatedAt);
      expect(new Date(afterInvitation!.updatedAt).getTime()).toBeGreaterThan(new Date(beforeInvitation!.updatedAt).getTime());
    });

    test("6.6 'Cancel Invitation' opens a confirmation dialog, and confirming genuinely revokes the invitation @real-email", async ({ page }) => {
      // 1. Click the unlabeled cancel-invitation icon on a pending row.
      await page.goto(`${BASE_URL}/teams/members?memberTab=sentInvitations`);
      await expect(page.getByText('1–2 of 2', { exact: true })).toBeVisible();
      await cancelInvitationIcon(page, freshEmail).click();

      await expect(page.getByRole('heading', { name: 'Cancel Invitation', exact: true })).toBeVisible();
      await expect(page.getByText('Are you sure you want to cancel the invitation for this member?', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'No, go back' })).toBeVisible();
      const confirmButton = page.getByRole('button', { name: 'Yes, cancel' });
      await expect(confirmButton).toBeVisible();

      // 2. Click 'Yes, cancel'.
      await confirmButton.click();

      // Row disappears immediately, pagination decrements - no manual reload needed.
      await expect(page.getByText('Invitation has been revoked successfully!', { exact: true })).toBeVisible();
      await expect(invitationRow(page, freshEmail)).toHaveCount(0);
      await expect(page.getByText('1–1 of 1', { exact: true })).toBeVisible();

      // Cleanup: also cancel 6.3's other pending invitation, so later suites start from a clean Sent Invitations state.
      await cancelInvitationIcon(page, pendingEmail).click();
      await page.getByRole('button', { name: 'Yes, cancel' }).click();
      await expect(page.getByText('Invitation has been revoked successfully!', { exact: true })).toBeVisible();
      await expect(page.getByText('You have not sent any invitations.', { exact: true })).toBeVisible();
      await expect(page.getByText('0–0 of 0', { exact: true })).toBeVisible();
    });

    test("6.7 The full invite → real email → accept → appears as 'Active' member flow works end-to-end @real-email", async ({ page, browser }) => {
      // Two separate real-email round-trips (invitation + verification) on
      // top of registration/profile UI steps comfortably exceed even
      // test.slow()'s 3x multiplier - an explicit generous timeout instead.
      test.setTimeout(480_000);

      // 1. Invite a brand-new, never-used email from the inviter's own session.
      const inviteeEmail = generateUniqueEmailAlias();
      await page.goto(`${BASE_URL}/teams/members`);
      await openInviteMemberModal(page);
      await typeAndChipInviteEmail(page, inviteeEmail);
      await page.getByRole('button', { name: 'Invite' }).click();
      await expect(page.getByText('Your invitation(s) have been sent.', { exact: true })).toBeVisible();

      // 2. Read the real invitation email - a DIFFERENT template/subject
      // ("New Invitation!") from the registration email (see CLAUDE.md).
      // 240s timeout, not the 150s default - genuinely needed under heavy mailbox load.
      const invitationLink = await getInvitationLink(inviteeEmail, 240_000);

      // 3. Act as the invitee in a SEPARATE browser context, so the inviter's own session is never disturbed.
      const inviteeContext = await browser.newContext({ ...devices['Desktop Chrome'] });
      const inviteePage = await inviteeContext.newPage();

      // Logged-out redirects to /login with the invitee's email pre-filled, and 'Sign Up' carries it as a ?email= param.
      await inviteePage.goto(invitationLink);
      await expect(inviteePage).toHaveURL(new RegExp(`^${BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/login\\?redirectUrl=`));
      await expect(inviteePage.getByRole('textbox', { name: 'Username or Email' })).toHaveValue(inviteeEmail);
      const inviteeUsername = generateUsernameFromEmail(inviteeEmail);
      const inviteePassword = requireEnv('TEST_REGISTER_PASSWORD');
      await inviteePage.getByRole('link', { name: 'Sign Up' }).click();
      await expect(inviteePage).toHaveURL(`${BASE_URL}/register?email=${encodeURIComponent(inviteeEmail)}`);

      // 4. Register for real, reached via the invitation link's 'Sign Up' link, with Email Address already pre-filled.
      const registeredAt = new Date();
      await inviteePage.getByRole('textbox', { name: 'Username' }).fill(inviteeUsername);
      await inviteePage.getByRole('textbox', { name: 'Password', exact: true }).fill(inviteePassword);
      await inviteePage.getByRole('textbox', { name: 'Confirm Password' }).fill(inviteePassword);
      await inviteePage
        .getByRole('checkbox', { name: 'By checking the box you confirm you have read and agree to our Terms of Service' })
        .check();
      await inviteePage.getByRole('button', { name: 'Register' }).click();
      await expect(inviteePage).toHaveURL(`${BASE_URL}/email-verification`, { timeout: 15_000 });

      // 5. Verify the invitee's own registration email (separate from step 2's invitation), log in, complete the profile.
      const verificationLink = await getVerificationLink(inviteeEmail, registeredAt, 240_000);
      await inviteePage.goto(verificationLink);
      await expect(inviteePage).toHaveURL(`${BASE_URL}/login`);
      await inviteePage.getByRole('textbox', { name: 'Username or Email' }).fill(inviteeUsername);
      await inviteePage.getByRole('textbox', { name: 'Password' }).fill(inviteePassword);
      await inviteePage.getByRole('button', { name: 'Log In' }).click();
      await expect(inviteePage).toHaveURL(`${BASE_URL}/complete-profile`, { timeout: 15_000 });
      await completeProfile(inviteePage);
      await expect(inviteePage).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });

      // 6. Re-visit the ORIGINAL invitation link now that the invitee is
      // logged in - registration does NOT auto-redirect back to it.
      await inviteePage.goto(invitationLink);
      await expect(inviteePage.getByText('You’ve been invited!', { exact: true })).toBeVisible();
      // completeProfile() hardcodes 'QA'/'Automation' for every account it completes, so this name is deterministic, not a placeholder.
      await expect(inviteePage.getByText('We found your invitation to QA Automation Job Link team!', { exact: true })).toBeVisible();
      await inviteePage.getByTestId('accept-btn').click();

      // Redirects to the invitee's OWN separate company, still blank - acceptance doesn't switch to the inviter's company context.
      await expect(inviteePage).toHaveURL(`${BASE_URL}/company`, { timeout: 15_000 });
      await inviteeContext.close();

      // 7. Back in the inviter's session, the invitee is now a real, company-wide 'Active' member.
      await page.goto(`${BASE_URL}/teams/members`);
      await expect(page.getByRole('heading', { name: 'Member (1)', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'QA Automation' })).toBeVisible();

      // The invitation disappears from 'Sent Invitations' entirely (not merely moved), now fulfilled.
      await page.getByRole('tab', { name: 'Sent Invitations' }).click();
      await expect(page.getByText('You have not sent any invitations.', { exact: true })).toBeVisible();
      await expect(page.getByText('0–0 of 0', { exact: true })).toBeVisible();

      // Accepting company-wide does NOT also add the invitee to the
      // SPECIFIC team they were invited through - that's a separate '+ Add Members' step from the team's own detail page.
      await page.goto(`${BASE_URL}/teams/list`);
      await expect(teamCard(page, 'My Team')).toBeVisible();
    });
  });

  test.describe("Teams — 'Select Teams & People' Global Search", () => {
    test("7.1 Typing a query filters live and groups matching teams under a 'Teams' heading; selecting a result navigates directly to that team's detail page @real-email", async ({ page }) => {
      // 1. Setup: Suite 4 already deleted its own team, so create a throwaway second team here to have 2 existing at once.
      await page.goto(`${BASE_URL}/teams/list`);
      await expect(page.getByRole('heading', { name: 'Teams (1)', exact: true })).toBeVisible();
      await page.getByRole('button', { name: '+ Create Team' }).click();
      const nameField = page.getByRole('textbox', { name: 'Name' });
      await nameField.click();
      await nameField.pressSequentially('QA Search Test Team');
      await page.getByRole('button', { name: 'Create' }).click();
      await expect(page.getByText('Your team was created successfully!', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Continue' }).click();

      await expect(page.getByRole('heading', { name: 'Create Team' })).not.toBeVisible();
      await expect(page.getByRole('heading', { name: 'Teams (2)', exact: true })).toBeVisible();

      // 2. Type a partial match common to both names into 'Select Teams & People'.
      const searchBox = page.getByRole('combobox', { name: 'Select Teams & People' });
      await searchBox.click();
      await searchBox.pressSequentially('Team');

      // Grouped under a plain paragraph reading 'Teams' (accessibility tree
      // reports it as "paragraph", not a heading role, so matched by text) -
      // filters live as typed, no submit needed. Both real teams should appear.
      const dropdown = page.getByRole('listbox', { name: 'Select Teams & People' });
      await expect(dropdown.getByText('Teams', { exact: true })).toBeVisible();
      const myTeamOption = dropdown.getByRole('option', { name: 'My Team', exact: true });
      const searchTeamOption = dropdown.getByRole('option', { name: 'QA Search Test Team', exact: true });
      await expect(myTeamOption).toBeVisible();
      await expect(searchTeamOption).toBeVisible();

      // 3. Click one of the team options in the dropdown.
      await searchTeamOption.click();

      // Navigates directly to that team's detail page - same deep-linkable URL shape as test 1.2.
      await expect(page).toHaveURL(/\/teams\/list\?team=[a-f0-9]+&cardDetails=true$/);
      await expect(page.getByRole('heading', { name: 'QA Search Test Team', level: 4 })).toBeVisible();

      // 4. Cleanup: delete the throwaway team so it doesn't linger.
      await openRemoveTeamDialog(page);
      await confirmRemoveTeam(page);
      await page.goto(`${BASE_URL}/teams/list`);
      await expect(page.getByRole('heading', { name: 'Teams (1)', exact: true })).toBeVisible();
    });

    test("7.2 The search box's 'People' grouping shows a real active company member, distinct from 'Teams' @real-email", async ({ page }) => {
      // 1. 6.7 already left one real Active member ('QA Automation',
      // completeProfile()'s fixed name) - search for it. Assumed to share
      // the same combobox/listbox shape as 7.1's 'Teams' grouping (never
      // independently re-verified, since the seed account has zero real Active members to test against).
      await page.goto(`${BASE_URL}/teams/list`);
      const searchBox = page.getByRole('combobox', { name: 'Select Teams & People' });
      await searchBox.click();
      await searchBox.pressSequentially('QA Automation');

      const dropdown = page.getByRole('listbox', { name: 'Select Teams & People' });
      await expect(dropdown.getByText('People', { exact: true })).toBeVisible();
      await expect(dropdown.getByRole('option', { name: 'QA Automation', exact: true })).toBeVisible();

      // 'Teams' is NOT also shown (no team matches this query) - confirms 'People' is a genuinely separate grouping, not a rename/merge.
      await expect(dropdown.getByText('Teams', { exact: true })).not.toBeVisible();
    });
  });

  test.describe('Teams — Accessibility Notes', () => {
    test('8.1 Two icon-only action buttons in this area have no accessible name @real-email', async ({ page }) => {
      // 1. Inspect the unlabeled edit-icon (opens 'Update Team Name') and the unlabeled cancel-icon in a 'Sent Invitations' row.
      await page.goto(`${BASE_URL}/teams/list`);
      await teamCard(page, 'My Team').click();
      const editIcon = updateTeamNameEditIcon(page);
      await expect(editIcon).toBeVisible();
      await expect(editIcon).not.toHaveAttribute('aria-label');
      await expect(editIcon).not.toHaveAttribute('title');

      // The cancel-invitation icon needs a real pending invitation to
      // inspect - Suite 6 leaves none behind, so create one here and cancel it again at the end.
      const email = generateUniqueEmailAlias();
      await page.goto(`${BASE_URL}/teams/members`);
      await page.getByRole('button', { name: 'Invite Member' }).click();
      await expect(page.getByRole('heading', { name: 'Invite Member' })).toBeVisible();
      const emailCombobox = page.getByRole('combobox', { name: 'Add People by Email' });
      await emailCombobox.click();
      await emailCombobox.pressSequentially(email);
      await page.keyboard.press('Enter');
      const inviteButton = page.getByRole('button', { name: 'Invite' });
      await expect(inviteButton).toBeEnabled();
      await inviteButton.click();
      await expect(page.getByText('Your invitation(s) have been sent.', { exact: true })).toBeVisible();

      await page.goto(`${BASE_URL}/teams/members?memberTab=sentInvitations`);
      const invitationRow = page.getByRole('row').filter({ has: page.getByText(email, { exact: true }) });
      await expect(invitationRow).toBeVisible();
      const cancelIcon = invitationRow.getByRole('button').filter({ hasText: /^$/ });
      await expect(cancelIcon).toBeVisible();

      // A screen-reader user hears no name for either control, unlike this
      // page's other icon-adjacent controls (pagination buttons DO carry a proper aria-label/title).
      await expect(cancelIcon).not.toHaveAttribute('aria-label');
      await expect(cancelIcon).not.toHaveAttribute('title');

      const previousPageButton = page.getByRole('button', { name: 'Go to previous page' });
      await expect(previousPageButton).toHaveAttribute('aria-label', 'Go to previous page');
      await expect(previousPageButton).toHaveAttribute('title', 'Go to previous page');

      // (Cleanup) Cancel the disposable invitation created above so it
      // doesn't linger.
      await cancelIcon.click();
      await page.getByRole('button', { name: 'Yes, cancel' }).click();
      await expect(page.getByText('Invitation has been revoked successfully!', { exact: true })).toBeVisible();
      await expect(page.getByText('You have not sent any invitations.', { exact: true })).toBeVisible();
    });
  });
});
