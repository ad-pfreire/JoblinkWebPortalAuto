// spec: specs/teams-plans/teams-test-plan.md
// seed: tests/seed.spec.ts

import { test, expect, Page, Locator, devices } from '@playwright/test';
import { requireEnv } from '../utils/env';
import { blurAndReadValue, clearFieldWithBackspace } from '../utils/forms';
import { getVerificationLink, getInvitationLink } from '../utils/email';
import { generateUniqueEmailAlias, generateUsernameFromEmail, registerNewAccount, completeProfile } from '../utils/account';
import { loginAndGoToCompany } from '../utils/auth';
import { teamCard } from '../utils/teams-ui';

const BASE_URL = requireEnv('BASE_URL');

let disposableUsername: string;
let disposablePassword: string;
// Set by test 6.7 (the real invite -> accept flow) and reused by later
// suites that need to act as this same real, already-active member (search
// by their real email, log back in as them to check permissions/leaving a team).
let inviteeEmail: string;

/** Logs in with the disposable account from `beforeAll` and lands on /company. */
async function loginAsDisposableAndGoToCompany(page: Page) {
  await loginAndGoToCompany(page, disposableUsername, disposablePassword);
}

/**
 * Logs in as 6.7's real invited member (not the owner), used by 6.8b/6.9/6.10.
 * Wrapped in `toPass()` - this exact goto+fill sequence can hit a real >30s
 * stall on a fresh /login load, unlike the identical pattern in
 * `loginAsDisposableAndGoToCompany()`. Root cause not isolated - treat any
 * future failure here as this same known flakiness, not a timeout to raise again.
 */
async function loginAsInvitee(page: Page) {
  const inviteeUsername = generateUsernameFromEmail(inviteeEmail);
  const inviteePassword = requireEnv('TEST_REGISTER_PASSWORD');
  await expect(async () => {
    await page.goto(`${BASE_URL}/login`);
    await page.locator('input[name="username"]').fill(inviteeUsername, { timeout: 10_000 });
    await page.locator('input[name="password"]').fill(inviteePassword);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });
  }).toPass({ timeout: 90_000 });
}

/**
 * Whether this build strips leading/trailing whitespace out of a name field on blur.
 *
 * Probed with a neutral sentinel value rather than inferred from the behavior
 * under test, so the whitespace tests below still assert something real on both
 * builds. A 2026-09-17 pre-staging deploy added this trim app-wide and, with it,
 * fixed the three whitespace defects 2.2/3.2/3.3b were written to document;
 * staging still runs the older build (see CLAUDE.md). Leaves the field empty.
 */
async function nameFieldTrimsOnBlur(page: Page, nameField: Locator, blurTarget: Locator): Promise<boolean> {
  await clearFieldWithBackspace(page, nameField);
  await nameField.pressSequentially('  X  ');
  const settled = await blurAndReadValue(nameField, blurTarget);
  await clearFieldWithBackspace(page, nameField);
  return settled === 'X';
}

/** Opens 'Update Team Name' via the unlabeled edit icon - the only button with an empty accessible name inside `<main>` on a team's detail view. */
function updateTeamNameEditIcon(page: Page) {
  return page.getByRole('main').getByRole('button').filter({ hasText: /^$/ });
}

/** Clicks 'Remove Team' to open its confirmation dialog - split from `confirmRemoveTeam()` so 4.3 can assert the dialog's own content in between. */
async function openRemoveTeamDialog(page: Page) {
  await page.getByRole('button', { name: 'Remove Team' }).click();
}

/**
 * Confirms 'Remove Team' via 'Yes, remove' and waits for the success toast.
 * Retries internally - the backend can occasionally close the dialog with an
 * "Unable to fetch team information" error instead, even when the deletion
 * went through anyway (see CLAUDE.md's "backend needs settle time" gotchas).
 */
async function confirmRemoveTeam(page: Page) {
  await expect(async () => {
    const yesButton = page.getByRole('button', { name: 'Yes, remove' });
    if ((await yesButton.count()) === 0) {
      const removeTeamButton = page.getByRole('button', { name: 'Remove Team' });
      if ((await removeTeamButton.count()) === 0) return; // already deleted
      await removeTeamButton.click();
    }
    await page.getByRole('button', { name: 'Yes, remove' }).click();
    await expect(page.locator('text=Your team was deleted successfully!')).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
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
    test("1.1 Fresh/isolated company's 'For You' tab shows an empty 'Members you work with' section and a default 'My Team' (Owner, 1 member) @real-email", async ({
      page,
    }) => {
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
      // Link to /teams/members has the real visible label 'Browse Everyone', not an unlabeled icon.
      const browseEveryoneLink = page.getByRole('link', { name: 'Browse Everyone' });
      await expect(browseEveryoneLink).toBeVisible();
      await expect(browseEveryoneLink).toHaveAttribute('href', '/teams/members');
      await expect(page.getByText('Add some members to be displayed here', { exact: true })).toBeVisible();

      // 3. Inspect the 'Your Teams' section.
      await expect(page.getByRole('heading', { name: 'Your Teams' })).toBeVisible();
      const browseAllTeamsLink = page.getByRole('link', { name: 'Browse All Teams' });
      await expect(browseAllTeamsLink).toBeVisible();
      await expect(browseAllTeamsLink).toHaveAttribute('href', '/teams/list');

      // Matched by the card's own '<team> <count> member(s) <first name>'
      // shape, not a container locator - and by either role, since this
      // card's role is inconsistent even across identical loads (see teamCard()).
      await expect(teamCard(page, 'My Team')).toBeVisible();
      await expect(page.getByRole('link', { name: /member/ }).or(page.getByRole('button', { name: /member/ }))).toHaveCount(1);
    });

    test("1.2 The 'Teams' sub-tab lists every team as a card under 'Teams (N)', and clicking a card navigates to a deep-linkable team detail view @real-email", async ({
      page,
    }) => {
      // 1. Click the 'Teams' sub-tab (or navigate to /teams/list directly).
      await page.goto(`${BASE_URL}/teams/list`);

      // Heading reads 'Teams (1)' on a fresh company (matching the single
      // default team), with one card for 'My Team'.
      await expect(page.getByRole('heading', { name: 'Teams (1)', exact: true })).toBeVisible();
      const myTeamCard = teamCard(page, 'My Team');
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

    test("1.3 The Members sub-tab's company-wide 'Member (N)' count is a different concept from a team's own member count, and deliberately excludes the owner @real-email", async ({
      page,
    }) => {
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

    test('1.4 Auth guard: accessing any of /teams, /teams/list, /teams/members directly while logged out redirects to /login with a redirectUrl, and logging back in lands on the originally-requested page @real-email', async ({
      page,
    }) => {
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

  test.describe("Teams — Default Team ('My Team') Detail Page", () => {
    test("2.1 The default team's sole member row ('You' / 'Owner') has no visible remove or role-change action, and the page has NO 'Remove Team' button anywhere @real-email", async ({
      page,
    }) => {
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

      // Nor 'Leave Team' - an owner can only delete a team (Suite 4), never
      // leave it like a non-owner member can (test 6.9's own mirror check).
      await expect(page.getByRole('button', { name: 'Leave Team' })).toHaveCount(0);
    });

    test("2.2 The 'Update Team Name' modal's Name field handles a whitespace-only value as its deployed build does - rejected since pre-staging's trim, a REAL BUG that enabled 'Update' before it @real-email", async ({
      page,
    }) => {
      // 1. Open 'Update Team Name', clear the pre-filled 'Name' via real Backspace keystrokes, then blur it.
      await page.goto(`${BASE_URL}/teams/list`);
      await teamCard(page, 'My Team').click();
      await updateTeamNameEditIcon(page).click();

      await expect(page.getByRole('heading', { name: 'Update Team Name' })).toBeVisible();
      const nameField = page.getByRole('textbox', { name: 'Name' });
      await expect(nameField).toHaveValue('My Team');
      const updateButton = page.getByRole('button', { name: 'Update' });
      await expect(updateButton).toBeDisabled();

      const modalHeading = page.getByRole('heading', { name: 'Update Team Name' });
      const buildTrimsOnBlur = await nameFieldTrimsOnBlur(page, nameField, modalHeading);
      await modalHeading.click();

      await expect(page.getByText('The field is required', { exact: true })).toBeVisible();
      await expect(nameField).toHaveAttribute('aria-invalid', 'true');
      await expect(updateButton).toBeDisabled();

      // 2. Type exactly three spaces via real keystrokes (not fill()).
      await nameField.click();
      await nameField.pressSequentially('   ');

      if (buildTrimsOnBlur) {
        // Fixed on pre-staging 2026-09-17: whitespace no longer counts as content,
        // so 'Update' stays disabled and the required-field error stays up.
        await expect(updateButton).toBeDisabled();
        await expect(page.getByText('The field is required', { exact: true })).toBeVisible();
      } else {
        // REAL BUG on the older build: 'Update' becomes ENABLED with only whitespace, no error - the same fill()-vs-keystrokes gap (see CLAUDE.md), confirmed for Team Name too.
        await expect(updateButton).toBeEnabled();
        await expect(page.getByText('The field is required', { exact: true })).toBeHidden();
      }

      // 3. Click 'Cancel' rather than submitting, to avoid corrupting the default team's name (3.2 already confirms this persists server-side).
      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByRole('heading', { name: 'Update Team Name' })).toBeHidden();
      await expect(page.getByRole('heading', { name: 'My Team', level: 4 })).toBeVisible();
    });

    test("2.3 '+ Add Members' shows a bare 'Select' placeholder as if it were a real option, instead of a proper empty-state message, when the company has no other active members @real-email", async ({
      page,
    }) => {
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
    test("3.1 The Create Team modal's structure: required Name, optional Add Teams Members, Create disabled until Name holds a value @real-email", async ({
      page,
    }) => {
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

    test('3.1b Neither Escape nor clicking the backdrop closes the Create Team modal - only the explicit Cancel button does, the same "explicit close only" pattern already documented for Logo Upload/Profile Settings @real-email', async ({
      page,
    }) => {
      // 1. Open Create Team, type a name, then press Escape.
      // Live-verified: unlike WEB-TC-060's general assumption, this
      // specific modal does NOT close on Escape - joining the same family
      // of "explicit button only" dialogs already documented in CLAUDE.md
      // for Logo Upload's error dialog and Profile Settings' password modal.
      await page.goto(`${BASE_URL}/teams/list`);
      await page.getByRole('button', { name: '+ Create Team' }).click();
      const nameField = page.getByRole('textbox', { name: 'Name' });
      await nameField.click();
      await nameField.pressSequentially('Not Discarded By Escape');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('heading', { name: 'Create Team' })).toBeVisible();
      await expect(nameField).toHaveValue('Not Discarded By Escape');

      // 2. Click the backdrop directly (same technique already established
      // for Profile Settings/Logo Upload's own dialogs) - also does NOT close it.
      await page.locator('.MuiBackdrop-root').click({ position: { x: 5, y: 5 } });
      await expect(page.getByRole('heading', { name: 'Create Team' })).toBeVisible();
      await expect(nameField).toHaveValue('Not Discarded By Escape');

      // 3. Only the explicit 'Cancel' button actually closes it, discarding what was typed.
      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByRole('heading', { name: 'Create Team' })).toBeHidden();
      await expect(page.getByRole('heading', { name: 'Teams (1)', exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: /Not Discarded By/ })).toHaveCount(0);
    });

    test('3.1c A very long team name does not visually break the Create Team modal or, once created, the team card/detail layout @real-email', async ({
      page,
    }) => {
      // Generous budget: the cleanup toPass() below retries through a chain
      // of separate eventual-consistency gaps, and can still be mid-retry
      // past Playwright's default 30s.
      test.setTimeout(180_000);

      // 1. Type a very long name into 'Name' - reads back whatever the
      // field actually accepted (truncated or not) rather than assuming a
      // specific limit, then checks the modal itself never overflows the page.
      await page.goto(`${BASE_URL}/teams/list`);
      await page.getByRole('button', { name: '+ Create Team' }).click();
      const nameField = page.getByRole('textbox', { name: 'Name' });
      // A run-unique suffix - a fixed literal here would collide with a
      // same-named team left behind by an earlier failed/retried attempt
      // (this suite blocks duplicate names, per test 3.3).
      const longName = `QA Long Team Name That Keeps Going And Going For A While ${Date.now()}`; // ~80 chars
      await nameField.click();
      await nameField.pressSequentially(longName);
      const acceptedValue = await nameField.inputValue();
      expect(acceptedValue.length).toBeGreaterThan(0);

      const { bodyScrollWidth, bodyClientWidth } = await page.evaluate(() => ({
        bodyScrollWidth: document.body.scrollWidth,
        bodyClientWidth: document.body.clientWidth,
      }));
      expect(bodyScrollWidth).toBe(bodyClientWidth);

      // 2. Actually create it, so the card/detail-page rendering (not just
      // the input field) is checked too.
      const createButton = page.getByRole('button', { name: 'Create' });
      await expect(createButton).toBeEnabled();
      await createButton.click();
      await expect(page.getByText('Your team was created successfully!', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Continue' }).click();

      const { bodyScrollWidth: listScrollWidth, bodyClientWidth: listClientWidth } = await page.evaluate(() => ({
        bodyScrollWidth: document.body.scrollWidth,
        bodyClientWidth: document.body.clientWidth,
      }));
      expect(listScrollWidth).toBe(listClientWidth);

      // Cleanup: delete this throwaway team. Viewing a JUST-created team's
      // own detail page this soon can hit a real "Unable to fetch team
      // information" error (a backend eventual-consistency gap specific to
      // a brand-new team - see CLAUDE.md), so the whole view -> remove ->
      // confirm-gone sequence is wrapped in one toPass() that re-attempts
      // the actual removal on every retry, not just re-checking - a toast
      // alone isn't a reliable signal the delete landed server-side. The
      // card locator matches either role (see CLAUDE.md's role-inconsistency
      // gotcha) - missing that was the real cause of this test's own past
      // flakiness: a link-only `waitFor` failing on a button-rendered card
      // made the loop wrongly conclude "already gone" and skip deletion.
      const longNameCard = page
        .getByRole('link', { name: /QA Long Team Name/ })
        .or(page.getByRole('button', { name: /QA Long Team Name/ }));
      let detailScrollWidth = 0;
      let detailClientWidth = 0;
      await expect(async () => {
        await page.goto(`${BASE_URL}/teams/list`);
        // Waits for real visibility rather than an instant count() read -
        // count() can race the page's own render and read 0 for a card
        // that hasn't appeared YET, wrongly skipping deletion.
        const isPresent = await longNameCard
          .waitFor({ state: 'visible', timeout: 5_000 })
          .then(() => true)
          .catch(() => false);
        if (!isPresent) return;

        await longNameCard.click();
        await expect(page.getByText('Unable to fetch team information', { exact: false })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Remove Team' })).toBeVisible();

        if (detailScrollWidth === 0) {
          const sizes = await page.evaluate(() => ({
            bodyScrollWidth: document.body.scrollWidth,
            bodyClientWidth: document.body.clientWidth,
          }));
          detailScrollWidth = sizes.bodyScrollWidth;
          detailClientWidth = sizes.bodyClientWidth;
        }

        await openRemoveTeamDialog(page);
        await confirmRemoveTeam(page);

        // Don't trust the toast alone - re-navigate and confirm the card is
        // genuinely gone before letting this toPass() succeed.
        await page.goto(`${BASE_URL}/teams/list`);
        await expect(longNameCard).toHaveCount(0);
      }).toPass({ timeout: 120_000 });

      expect(detailScrollWidth).toBe(detailClientWidth);
      // The 'Teams (N)' heading count can still read stale for a moment
      // even right after the card itself is confirmed gone above.
      await expect(async () => {
        await page.goto(`${BASE_URL}/teams/list`);
        await expect(page.getByRole('heading', { name: 'Teams (1)', exact: true })).toBeVisible();
      }).toPass({ timeout: 45_000 });
    });

    test("3.2 A whitespace-only Team Name is handled as the deployed build handles it - rejected client-side since pre-staging's trim, a REAL BUG that persisted a blank team before it @real-email", async ({
      page,
    }) => {
      // 1. Open 'Create Team', type exactly three spaces into 'Name' via real keystrokes, leave 'Add Teams Members' empty, click 'Create'.
      await page.goto(`${BASE_URL}/teams/list`);
      await expect(page.getByRole('heading', { name: 'Teams (1)', exact: true })).toBeVisible();
      await page.getByRole('button', { name: '+ Create Team' }).click();
      const nameField = page.getByRole('textbox', { name: 'Name' });
      const modalHeading = page.getByRole('heading', { name: 'Create Team' });
      const buildTrimsOnBlur = await nameFieldTrimsOnBlur(page, nameField, modalHeading);
      await nameField.click();
      await nameField.pressSequentially('   ');

      if (buildTrimsOnBlur) {
        // Fixed on pre-staging 2026-09-17: 'Create' never enables for whitespace,
        // so the submission below can't even be attempted, and blurring empties
        // the field and raises the required-field error instead.
        await expect(page.getByRole('button', { name: 'Create' })).toBeDisabled();
        await modalHeading.click();
        await expect(nameField).toHaveValue('');
        await expect(page.getByText('The field is required', { exact: true })).toBeVisible();
        await expect(nameField).toHaveAttribute('aria-invalid', 'true');

        // No team is created, and the modal closes only through its own Cancel.
        await page.getByRole('button', { name: 'Cancel' }).click();
        await page.goto(`${BASE_URL}/teams/list`);
        await expect(page.getByRole('heading', { name: 'Teams (1)', exact: true })).toBeVisible();
        return;
      }

      await page.getByRole('button', { name: 'Create' }).click();

      // REAL BUG: an in-modal success screen appears exactly like a valid
      // submission - no server-side rejection either. Generous timeout: the
      // Create button can stay in its disabled spinner state past 5s under real load.
      await expect(page.getByText('Your team was created successfully!', { exact: true })).toBeVisible({
        timeout: 20_000,
      });
      const continueButton = page.getByRole('button', { name: 'Continue' });
      await expect(continueButton).toBeVisible();

      // 2. Click 'Continue' - a new team card appears with a completely
      // EMPTY heading. Located by elimination (2 cards exist, the new one
      // is whichever doesn't contain 'My Team'), since a blank heading's contribution to the accessible name isn't predictable.
      await continueButton.click();
      await expect(page.getByRole('heading', { name: 'Teams (2)', exact: true })).toBeVisible();
      // Matches either role - see CLAUDE.md's card role-inconsistency gotcha.
      const allTeamCards = page.getByRole('link', { name: /member/ }).or(page.getByRole('button', { name: /member/ }));
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

    test("3.3 Creating a team with a name that exactly duplicates an existing team's name in the same company IS correctly blocked @real-email", async ({
      page,
    }) => {
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

    test("3.3b Whether '  My Team  ' escapes 3.3's duplicate guard depends on the deployed build - caught since pre-staging's trim, a REAL BUG that created a second team before it @real-email", async ({
      page,
    }) => {
      // Two stacked toPass() blocks below (30s each, for two DIFFERENT
      // documented eventual-consistency gaps) can together exceed
      // Playwright's 30s per-test default on a single retry - same fix as
      // 3.1c above, see its own comment for the live-verified failure mode.
      test.setTimeout(90_000);

      // Types '  My Team  ' (real keystrokes, padded on both sides) against an
      // existing 'My Team'. Whether the padding survives to the comparison is
      // exactly what separates the two builds.
      await page.goto(`${BASE_URL}/teams/list`);
      await page.getByRole('button', { name: '+ Create Team' }).click();
      const nameField = page.getByRole('textbox', { name: 'Name' });
      const modalHeading = page.getByRole('heading', { name: 'Create Team' });
      const buildTrimsOnBlur = await nameFieldTrimsOnBlur(page, nameField, modalHeading);
      await nameField.click();
      await nameField.pressSequentially('  My Team  ');
      const createButton = page.getByRole('button', { name: 'Create' });
      await expect(createButton).toBeEnabled();

      if (buildTrimsOnBlur) {
        // Fixed on pre-staging 2026-09-17: clicking 'Create' blurs the field
        // first, so what reaches the duplicate check is the trimmed 'My Team'
        // and 3.3's guard catches it - live-verified, no second team created.
        await createButton.click();
        await expect(page.getByText('Team with that name already exists', { exact: true })).toBeVisible();
        await expect(nameField).toHaveAttribute('aria-invalid', 'true');
        await expect(createButton).toBeDisabled();

        await page.getByRole('button', { name: 'Cancel' }).click();
        await page.goto(`${BASE_URL}/teams/list`);
        await expect(page.getByRole('heading', { name: 'Teams (1)', exact: true })).toBeVisible();
        return;
      }

      await createButton.click();
      // Generous timeout - same slow-Create-response reasoning as 3.2.
      await expect(page.getByText('Your team was created successfully!', { exact: true })).toBeVisible({
        timeout: 20_000,
      });
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page.getByRole('heading', { name: 'Teams (2)', exact: true })).toBeVisible();

      // Cleanup: both cards share the same ACCESSIBLE name once ARIA
      // normalizes whitespace, and the create POST is an RSC/Flight stream
      // with no reliably-parseable new-team id - so this distinguishes the
      // two cards via their raw, un-normalized DOM textContent instead,
      // since the app does NOT trim the name there.
      async function findPaddedMyTeamCard() {
        // Matches either role - see CLAUDE.md's card role-inconsistency gotcha.
        const allTeamCards = page.getByRole('link', { name: /My Team.*member/ }).or(page.getByRole('button', { name: /My Team.*member/ }));
        await expect(allTeamCards).toHaveCount(2);
        for (let i = 0; i < 2; i++) {
          const heading = allTeamCards.nth(i).locator('h6').first();
          const raw = await heading.evaluate((el) => el.textContent);
          if (raw === '  My Team  ') return allTeamCards.nth(i);
        }
        throw new Error('Could not find the padded \'  My Team  \' card among the 2 "My Team"-named cards.');
      }
      await expect(async () => {
        await page.goto(`${BASE_URL}/teams/list`);
        const targetCard = await findPaddedMyTeamCard();
        await targetCard.click();
        await expect(page.getByText('Unable to fetch team information', { exact: false })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Remove Team' })).toBeVisible();
      }).toPass({ timeout: 30_000 });
      await openRemoveTeamDialog(page);
      await confirmRemoveTeam(page);
      await expect(async () => {
        await page.goto(`${BASE_URL}/teams/list`);
        await expect(page.getByRole('heading', { name: 'Teams (1)', exact: true })).toBeVisible();
      }).toPass({ timeout: 30_000 });
    });

    test('3.4 A successful Create Team (valid, non-blank, non-duplicate name) shows an in-modal success screen and the new team appears immediately across the UI @real-email', async ({
      page,
    }) => {
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
      await expect(page.getByRole('heading', { name: 'Create Team' })).toBeHidden();
      await expect(page.getByRole('heading', { name: 'Teams (2)', exact: true })).toBeVisible();
      await expect(teamCard(page, 'QA Second Team')).toBeVisible();

      await page.goto(`${BASE_URL}/teams`);
      await expect(teamCard(page, 'QA Second Team')).toBeVisible();

      // This team stays alive on purpose - Suite 4 below reuses it
      // (renames it, then deletes it).
    });

    test('3.5 A name with HTML-like/special characters and emoji is accepted and persists as literal text, not interpreted as markup or stripped @real-email', async ({
      page,
    }) => {
      // 1. Create a team whose name contains characters a naive
      // implementation might mishandle: HTML tags, an ampersand, a quote, and an emoji.
      const specialName = `QA <b>Bold</b> & "Quote" \u{1F600} ${Date.now()}`;
      await page.goto(`${BASE_URL}/teams/list`);
      await page.getByRole('button', { name: '+ Create Team' }).click();
      const nameField = page.getByRole('textbox', { name: 'Name' });
      await nameField.click();
      await nameField.pressSequentially(specialName);
      await expect(nameField).toHaveValue(specialName);
      await page.getByRole('button', { name: 'Create' }).click();
      await expect(page.getByText('Your team was created successfully!', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Continue' }).click();

      // Back on the list, the new card's own heading is level 6 (a team
      // detail page's own heading is level 4 instead - checked next) - the
      // literal characters render as plain text (e.g. '<b>' shows up as
      // visible text, not real bold formatting), confirming no markup injection risk.
      const listHeading = page.getByRole('heading', { name: specialName, level: 6 });
      await expect(listHeading).toBeVisible();
      await expect(listHeading.locator('b')).toHaveCount(0);

      // Same check again on the team's own detail page.
      await teamCard(page, specialName).click();
      const detailHeading = page.getByRole('heading', { name: specialName, level: 4 });
      await expect(detailHeading).toBeVisible();
      await expect(detailHeading.locator('b')).toHaveCount(0);

      // Cleanup.
      await openRemoveTeamDialog(page);
      await confirmRemoveTeam(page);
    });
  });

  test.describe('Teams — Non-Default Team Lifecycle: Rename and Delete', () => {
    test("4.1 Unlike the default 'My Team', a team the user explicitly creates DOES show a 'Remove Team' button on its detail page - regardless of total team count @real-email", async ({
      page,
    }) => {
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

    test("4.2 A genuine, real 'Update Team Name' save on a non-default team persists correctly end-to-end @real-email", async ({
      page,
    }) => {
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

    test("4.3 'Remove Team' opens a dialog titled 'Delete Team' (a label inconsistency with the triggering button) with a grammar defect in its body copy, and confirming genuinely deletes the team @real-email", async ({
      page,
    }) => {
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
          'Are you sure you want to delete this team? If you choose to delete the team, all of the team’s data will permanently deleted.',
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
      // Matches either role - see CLAUDE.md's card role-inconsistency
      // gotcha (a link-only check for absence can false-negative "gone" if
      // the still-present card happens to render as a button instead).
      await expect(page.getByRole('link', { name: /QA Second Team/ }).or(page.getByRole('button', { name: /QA Second Team/ }))).toHaveCount(
        0
      );

      // Also gone from 'Your Teams' on 'For you'.
      await page.goto(`${BASE_URL}/teams`);
      await expect(page.getByRole('link', { name: /QA Second Team/ }).or(page.getByRole('button', { name: /QA Second Team/ }))).toHaveCount(
        0
      );
      await expect(teamCard(page, 'My Team')).toBeVisible();
    });
  });

  test.describe('Teams — Members Page (/teams/members): Active and Sent Invitations Tabs', () => {
    test("5.1 A fresh/isolated company's Active tab and Sent Invitations tab each show their own distinct empty state @real-email", async ({
      page,
    }) => {
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

    test('5.2 Full Active-tab coverage (a real accepted member) is covered by test 6.7, not here @real-email', async () => {
      // Test 6.7 later covers the full invite -> accept -> 'Member (1)' flow
      // end-to-end - can't be verified here since this test runs before 6.7 ever creates a real accepted member (serial execution order).
      test.skip(true, "Covered by test 6.7 later in this file - see that test's own assertions on the Active tab's 'Member (1)' state.");
    });

    test("5.3 The page's 'Select Teams & People' search box is genuinely cleared when switching between the Active and Sent Invitations tabs, not preserved @real-email", async ({
      page,
    }) => {
      // 1. On the Active tab, type into the search box - it lives in the
      // shared page header above the Active/Sent Invitations tab content,
      // visually above either tab panel, not inside them.
      await page.goto(`${BASE_URL}/teams/members`);
      const searchBox = page.getByRole('combobox', { name: 'Select Teams & People' });
      await searchBox.click();
      await searchBox.pressSequentially('persistence-check');
      await expect(searchBox).toHaveValue('persistence-check');

      // 2. Switch to Sent Invitations - live-verified 2026-09-07 (contrary
      // to this box's own shared-header placement, which might suggest
      // otherwise): the typed value is genuinely CLEARED, not preserved.
      // Switching back to Active does not restore it either.
      await page.getByRole('tab', { name: 'Sent Invitations' }).click();
      await expect(searchBox).toHaveValue('');
      await page.getByRole('tab', { name: 'Active' }).click();
      await expect(searchBox).toHaveValue('');
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

    // Real shape of GET /api/invitations' response, confirmed against the live endpoint.
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

    test('6.1b A very long (but validly-formatted) chipped email does not visually break the Invite Member modal @real-email', async ({
      page,
    }) => {
      // Non-mutating - never clicks 'Invite', just inspects the chipped state and layout.
      await page.goto(`${BASE_URL}/teams/members`);
      await openInviteMemberModal(page);
      const longEmail = `${'a'.repeat(200)}@example.com`;
      await typeAndChipInviteEmail(page, longEmail);

      const { bodyScrollWidth, bodyClientWidth } = await page.evaluate(() => ({
        bodyScrollWidth: document.body.scrollWidth,
        bodyClientWidth: document.body.clientWidth,
      }));
      expect(bodyScrollWidth).toBe(bodyClientWidth);

      // Cleanup: close without submitting.
      await page.getByRole('button', { name: 'Cancel' }).click();
    });

    test("6.2 REAL BUG: inviting an email that already belongs to an existing active user account (e.g. the logged-in account's own email) produces a false-positive success toast but creates NO real invitation @real-email", async ({
      page,
    }) => {
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

    test('6.3 A brand-new never-used email, AND an email already tied to a not-yet-verified pending registration, both create genuine invitations — and multiple emails can be invited in a single submission @real-email', async ({
      page,
      browser,
    }) => {
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

    test('6.4 The invite combobox client-side blocks re-inviting an email that already has a pending invitation, preventing duplicate rows @real-email', async ({
      page,
    }) => {
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

    test("6.5 'Resend' on a pending invitation shows a success toast and genuinely updates the invitation server-side — even though the UI's minute-granularity 'Date Sent' column can look visually unchanged @real-email", async ({
      page,
    }) => {
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

    test("6.6 'Cancel Invitation' opens a confirmation dialog, and confirming genuinely revokes the invitation @real-email", async ({
      page,
    }) => {
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

    test('6.6b Re-inviting an email whose earlier invitation was just cancelled creates a genuinely NEW invitation, not blocked as a duplicate @real-email', async ({
      page,
    }) => {
      // 1. freshEmail's invitation was fully cancelled/removed by 6.6 above
      // - re-invite the exact same address.
      await page.goto(`${BASE_URL}/teams/members`);
      await openInviteMemberModal(page);
      await typeAndChipInviteEmail(page, freshEmail);

      // Not blocked as a duplicate (unlike 6.4's still-pending case) - the
      // combobox accepts it and 'Invite' is enabled.
      const combobox = page.getByRole('combobox', { name: 'Add People by Email' });
      await expect(combobox).not.toHaveAttribute('aria-invalid', 'true');
      const inviteButton = page.getByRole('button', { name: 'Invite' });
      await expect(inviteButton).toBeEnabled();
      await inviteButton.click();
      await expect(page.getByText('Your invitation(s) have been sent.', { exact: true })).toBeVisible();

      // 2. A real, new, pending row appears again.
      await page.getByRole('tab', { name: 'Sent Invitations' }).click();
      await expect(invitationRow(page, freshEmail)).toBeVisible();
      await expect(page.getByText('1–1 of 1', { exact: true })).toBeVisible();

      // Cleanup: cancel again, so later suites (6.7 onward) start from a clean Sent Invitations state.
      await cancelInvitationIcon(page, freshEmail).click();
      await page.getByRole('button', { name: 'Yes, cancel' }).click();
      await expect(page.getByText('Invitation has been revoked successfully!', { exact: true })).toBeVisible();
      await expect(page.getByText('0–0 of 0', { exact: true })).toBeVisible();
    });

    test("6.7 The full invite → real email → accept → appears as 'Active' member flow works end-to-end @real-email", async ({
      page,
      browser,
    }) => {
      // Two separate real-email round-trips (invitation + verification) on
      // top of registration/profile UI steps comfortably exceed even
      // test.slow()'s 3x multiplier - an explicit generous timeout instead.
      test.setTimeout(480_000);

      // 1. Invite a brand-new, never-used email from the inviter's own session.
      inviteeEmail = generateUniqueEmailAlias();
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

      // 6b. Revisiting the EXACT SAME invitation link a second time, now
      // that it's already been accepted, doesn't show the same 'Accept'
      // screen again - the link is genuinely single-use, not just
      // suppressed client-side (the invitee is still logged in as themselves here).
      await inviteePage.goto(invitationLink);
      await expect(inviteePage.getByTestId('accept-btn')).toHaveCount(0);
      await expect(inviteePage.getByText('You’ve been invited!', { exact: true })).toHaveCount(0);

      await inviteeContext.close();

      // 7. Back in the inviter's session, the invitee is now a real, company-wide 'Active' member.
      await page.goto(`${BASE_URL}/teams/members`);
      await expect(page.getByRole('heading', { name: 'Member (1)', exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'QA Automation' }).or(page.getByRole('button', { name: 'QA Automation' }))).toBeVisible();

      // The invitation disappears from 'Sent Invitations' entirely (not merely moved), now fulfilled.
      await page.getByRole('tab', { name: 'Sent Invitations' }).click();
      await expect(page.getByText('You have not sent any invitations.', { exact: true })).toBeVisible();
      await expect(page.getByText('0–0 of 0', { exact: true })).toBeVisible();

      // Accepting company-wide does NOT also add the invitee to the
      // SPECIFIC team they were invited through - that's a separate '+ Add Members' step from the team's own detail page.
      await page.goto(`${BASE_URL}/teams/list`);
      await expect(teamCard(page, 'My Team')).toBeVisible();
    });

    test("6.7b The pagination controls/count update correctly as real invitations are added, and a long email doesn't break the layout; the Email Address column header does NOT actually re-sort the rows (REAL BUG, same family as Payment History) @real-email", async ({
      page,
    }) => {
      test.setTimeout(180_000);

      // 1. Send 3 real invitations (one a deliberately long email), a full
      // page reload before every submission. Kept deliberately modest -
      // reliably exceeding the grid's own 10-per-page size to prove real
      // pagination was extensively attempted and never held up (see CLAUDE.md).
      const longEmail = `qa.very.long.exploratory.address.${'x'.repeat(80)}${Date.now()}@example.com`;
      const sentEmails = [longEmail, ...Array.from({ length: 2 }, () => generateUniqueEmailAlias())];
      for (const bulkEmail of sentEmails) {
        await page.goto(`${BASE_URL}/teams/members`);
        await openInviteMemberModal(page);
        await typeAndChipInviteEmail(page, bulkEmail);
        await page.getByRole('button', { name: 'Invite' }).click();
        // Generous timeout, not the 5s default - live-verified this exact
        // submission can still be showing its own disabled/loading spinner
        // state past 5s later in a full-file run (more real account
        // history/load by this point than an isolated run of just this test).
        await expect(page.getByText('Your invitation(s) have been sent.', { exact: true })).toBeVisible({ timeout: 15_000 });
      }

      // 2. The pagination text/controls correctly reflect the real count -
      // still under the page size, so 'Go to next page' stays disabled.
      await page.goto(`${BASE_URL}/teams/members?memberTab=sentInvitations`);
      await expect(page.getByText('1–3 of 3', { exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole('button', { name: 'Go to next page' })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Go to previous page' })).toBeDisabled();

      // 3. The long email's row doesn't overflow the page.
      await expect(invitationRow(page, longEmail).or(page.locator('body'))).toBeVisible();
      const { bodyScrollWidth, bodyClientWidth } = await page.evaluate(() => ({
        bodyScrollWidth: document.body.scrollWidth,
        bodyClientWidth: document.body.clientWidth,
      }));
      expect(bodyScrollWidth).toBe(bodyClientWidth);

      // 4. On page 1, clicking the 'Email Address' column header looks
      // sortable (cursor: pointer, per test 1.1's own snapshot) but does
      // NOT actually change row order - REAL BUG, the same "sortable-
      // looking headers that don't actually sort" pattern already
      // documented for Payment History's table (see CLAUDE.md/README).
      const grid = page.getByRole('grid');
      const emailsBefore = await grid.getByRole('gridcell').filter({ hasText: '@' }).allTextContents();
      await grid.getByRole('columnheader', { name: 'Email Address' }).click();
      await page.waitForTimeout(500);
      const emailsAfter = await grid.getByRole('gridcell').filter({ hasText: '@' }).allTextContents();
      expect(emailsAfter).toEqual(emailsBefore);

      // Cleanup: cancel every real invitation this test created. A bounded
      // count (not a `while` re-checking '0–0 of 0'), each iteration
      // confirming a row genuinely exists before clicking - a `while` loop
      // keyed off that text can misread a stale render and enter one
      // extra iteration with nothing left to cancel, hanging forever
      // waiting for a cancel button that will never appear.
      for (let i = 0; i < sentEmails.length; i++) {
        await page.goto(`${BASE_URL}/teams/members?memberTab=sentInvitations`);
        const anyRow = page
          .getByRole('row')
          .filter({ has: page.getByText('@', { exact: false }) })
          .first();
        if ((await anyRow.count()) === 0) break;
        const anyCancelIcon = anyRow.getByRole('button').filter({ hasText: /^$/ });
        await anyCancelIcon.click();
        await page.getByRole('button', { name: 'Yes, cancel' }).click();
        await expect(page.getByText('Invitation has been revoked successfully!', { exact: true })).toBeVisible();
      }
      await page.goto(`${BASE_URL}/teams/members?memberTab=sentInvitations`);
      await expect(page.getByText('0–0 of 0', { exact: true })).toBeVisible();
    });
  });

  test.describe('Teams — Adding an Existing Member to a Team, Permissions, and Leaving', () => {
    test("6.8 '+ Add Members' adds a real active member (6.7's invitee) to both the default team AND a second team, appearing correctly in each @real-email", async ({
      page,
    }) => {
      // Two stacked toPass() blocks below (30s each, for two DIFFERENT
      // documented eventual-consistency gaps) can together exceed
      // Playwright's 30s per-test default on a single retry - same fix as
      // 3.1c above, see its own comment for the live-verified failure mode.
      test.setTimeout(90_000);

      // 1. On My Team's detail page, open '+ Add Members' and select the real active member.
      await page.goto(`${BASE_URL}/teams/list`);
      await teamCard(page, 'My Team').click();
      await page.getByRole('button', { name: '+ Add Members' }).click();
      const combobox = page.getByRole('combobox', { name: 'Add team members' });
      await expect(combobox).toBeVisible();
      await page.getByRole('button', { name: 'Open' }).click();
      await page.getByRole('option', { name: 'QA Automation' }).click();
      const saveButton = page.getByRole('button', { name: 'Save' });
      await expect(saveButton).toBeEnabled();
      await saveButton.click();

      // The member row appears immediately, no reload needed.
      await expect(page.getByText('QA Automation', { exact: true })).toBeVisible();

      // 2. Create a second team and add the SAME member to it too - the
      // same real person genuinely belongs to two teams at once.
      await page.goto(`${BASE_URL}/teams/list`);
      await page.getByRole('button', { name: '+ Create Team' }).click();
      const nameField = page.getByRole('textbox', { name: 'Name' });
      await nameField.click();
      await nameField.pressSequentially('QA Multi-Team Test');
      await page.getByRole('button', { name: 'Create' }).click();
      await expect(page.getByText('Your team was created successfully!', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Continue' }).click();

      // Retries this view - viewing a JUST-created team's own detail page
      // within the same test can hit a real, transient "Unable to fetch
      // team information" error (see confirmRemoveTeam()'s own comment). A
      // fresh /teams/list load at the start of each attempt, not just a
      // re-click, since a failed attempt navigates away from the list.
      await expect(async () => {
        await page.goto(`${BASE_URL}/teams/list`);
        await teamCard(page, 'QA Multi-Team Test').click();
        await expect(page.getByText('Unable to fetch team information', { exact: false })).toHaveCount(0);
        await expect(page.getByRole('button', { name: '+ Add Members' })).toBeVisible();
      }).toPass({ timeout: 30_000 });
      await page.getByRole('button', { name: '+ Add Members' }).click();
      const combobox2 = page.getByRole('combobox', { name: 'Add team members' });
      await expect(combobox2).toBeVisible();
      await page.getByRole('button', { name: 'Open' }).click();
      await page.getByRole('option', { name: 'QA Automation' }).click();
      const saveButton2 = page.getByRole('button', { name: 'Save' });
      await expect(saveButton2).toBeEnabled();
      await saveButton2.click();
      await expect(page.getByText('QA Automation', { exact: true })).toBeVisible();

      // Both team cards now genuinely show 2 members each - the list's own
      // count can lag a genuine add by a moment (same eventual-consistency
      // family as this file's other "Teams (N)" heading lag).
      await expect(async () => {
        await page.goto(`${BASE_URL}/teams/list`);
        // Matches either role - see CLAUDE.md's card role-inconsistency gotcha.
        await expect(
          page.getByRole('link', { name: 'My Team 2 members QA' }).or(page.getByRole('button', { name: 'My Team 2 members QA' }))
        ).toBeVisible();
        await expect(
          page
            .getByRole('link', { name: 'QA Multi-Team Test 2 members QA' })
            .or(page.getByRole('button', { name: 'QA Multi-Team Test 2 members QA' }))
        ).toBeVisible();
      }).toPass({ timeout: 30_000 });
    });

    test("6.8b Both of the real member's teams show correctly and distinctly under their own 'Your Teams' section on their 'For You' page @real-email", async ({
      page,
    }) => {
      // loginAsInvitee() alone now carries a 90s retry budget - see its own comment.
      test.setTimeout(120_000);

      // Log in as the invitee (member of both teams since 6.8) and check
      // their own 'For You' aggregation view - not the owner's.
      await loginAsInvitee(page);
      await page.goto(`${BASE_URL}/teams`);

      // Both teams appear, each exactly once, with real current member
      // counts - matches either role (see CLAUDE.md's role-inconsistency
      // gotcha); teamCard() itself isn't reusable here since it hardcodes '1 member'.
      const anyRoleCard = (name: string) => page.getByRole('link', { name }).or(page.getByRole('button', { name }));
      await expect(anyRoleCard('My Team 2 members QA')).toBeVisible();
      await expect(anyRoleCard('QA Multi-Team Test 2 members QA')).toBeVisible();
      await expect(page.getByRole('link', { name: /member/ }).or(page.getByRole('button', { name: /member/ }))).toHaveCount(2);
    });

    test('6.9 A non-owner member cannot see any owner-only controls (Remove Team, Update Team Name) on a team they belong to @real-email', async ({
      page,
    }) => {
      // loginAsInvitee() alone now carries a 90s retry budget - see its own comment.
      test.setTimeout(120_000);

      // 1. Log in as the real member (6.8's invitee, not the owner) directly - overrides beforeEach's owner login.
      await loginAsInvitee(page);

      // 2. Open 'My Team' from this member's own perspective.
      await page.goto(`${BASE_URL}/teams/list`);
      await page
        .getByRole('link', { name: /^My Team 2 members/ })
        .or(page.getByRole('button', { name: /^My Team 2 members/ }))
        .click();
      await expect(page.getByRole('heading', { name: 'My Team', level: 4 })).toBeVisible();

      // No owner-only controls anywhere on the page for a non-owner member -
      // neither team-level (Remove Team, Update Team Name, + Add Members)
      // nor member-row-level ('Remove member', which IS available to the owner - see 6.9b).
      await expect(page.getByRole('button', { name: 'Remove Team' })).toHaveCount(0);
      await expect(updateTeamNameEditIcon(page)).toHaveCount(0);
      await expect(page.getByRole('button', { name: '+ Add Members' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Remove member' })).toHaveCount(0);

      // 3. A 'Leave Team' action IS available to a non-owner member, unlike the owner's own row (test 2.1).
      await expect(page.getByRole('button', { name: 'Leave Team' })).toBeVisible();
    });

    test("6.9b The owner can remove an individual member from ONE of their teams (not the whole team) via 'Remove member' - the member stays company-wide Active and in their other team @real-email", async ({
      page,
    }) => {
      test.setTimeout(60_000);

      // Acts on 'QA Multi-Team Test' specifically, not 'My Team' - 6.10
      // right after this still needs the invitee in 'My Team' for its own leave-flow.
      await page.goto(`${BASE_URL}/teams/list`);
      await teamCard(page, 'QA Multi-Team Test').click();
      const memberRow = page.locator('.MuiCardHeader-root').filter({ hasText: 'QA Automation' });
      await memberRow.getByRole('button', { name: 'Remove member' }).click();

      await expect(page.getByRole('heading', { name: 'Remove Member', exact: true })).toBeVisible();
      await expect(page.getByText('Are you sure you want to remove this member from the team?', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'No, go back' })).toBeVisible();
      await page.getByRole('button', { name: 'Yes, remove' }).click();

      // Removed from THIS team - back down to 1 member (the owner).
      await expect(page.getByRole('heading', { name: 'Member', exact: true })).toBeVisible();
      await expect(page.getByText('QA Automation', { exact: true })).toHaveCount(0);

      // Still company-wide Active, and still a member of 'My Team' - a
      // per-team removal, not a company-wide removal. Matches either role
      // (see CLAUDE.md's card/member-row role-inconsistency gotcha).
      await page.goto(`${BASE_URL}/teams/members`);
      await expect(page.getByRole('heading', { name: 'Member (1)', exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'QA Automation' }).or(page.getByRole('button', { name: 'QA Automation' }))).toBeVisible();
      await page.goto(`${BASE_URL}/teams/list`);
      await expect(
        page.getByRole('link', { name: 'My Team 2 members QA' }).or(page.getByRole('button', { name: 'My Team 2 members QA' }))
      ).toBeVisible();
    });

    test("6.10 A member can leave a team via 'Leave Team', removing them from ONLY that team - they stay a member of their other team and remain company-wide Active @real-email", async ({
      page,
    }) => {
      // loginAsInvitee() alone now carries a 90s retry budget, plus this
      // test's own cleanup call to confirmRemoveTeam() (another 30s
      // budget) - together need real headroom past Playwright's 30s
      // per-test default.
      test.setTimeout(180_000);

      // Still logged in as the invitee from 6.9 (beforeEach re-logs in as
      // the OWNER before every test, so re-authenticate as the member again here).
      await loginAsInvitee(page);

      // 1. On My Team's detail page, click 'Leave Team' and confirm.
      await page.goto(`${BASE_URL}/teams/list`);
      await page
        .getByRole('link', { name: /^My Team 2 members/ })
        .or(page.getByRole('button', { name: /^My Team 2 members/ }))
        .click();
      await page.getByRole('button', { name: 'Leave Team' }).click();
      const confirmButton = page.getByRole('button', { name: /Yes/ });
      await expect(confirmButton).toBeVisible();
      await confirmButton.click();

      // 2. Confirm the OTHER team (QA Multi-Team Test) is unaffected - this
      // member is still shown there. Matches either role (see CLAUDE.md's
      // card/member-row role-inconsistency gotcha).
      await page.goto(`${BASE_URL}/teams/list`);
      await expect(
        page
          .getByRole('link', { name: 'QA Multi-Team Test 2 members QA' })
          .or(page.getByRole('button', { name: 'QA Multi-Team Test 2 members QA' }))
      ).toBeVisible();

      // 3. Back as the owner: My Team genuinely shows only 1 member again,
      // and the ex-member is STILL company-wide Active (leaving a team
      // isn't the same as being removed from the company).
      await loginAsDisposableAndGoToCompany(page);
      await page.goto(`${BASE_URL}/teams/list`);
      await expect(teamCard(page, 'My Team')).toBeVisible();
      await page.goto(`${BASE_URL}/teams/members`);
      await expect(page.getByRole('heading', { name: 'Member (1)', exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'QA Automation' }).or(page.getByRole('button', { name: 'QA Automation' }))).toBeVisible();

      // Cleanup: delete the throwaway second team.
      await page.goto(`${BASE_URL}/teams/list`);
      await teamCard(page, 'QA Multi-Team Test').click();
      await openRemoveTeamDialog(page);
      await confirmRemoveTeam(page);
    });
  });

  test.describe("Teams — 'Select Teams & People' Global Search", () => {
    test("7.1 Typing a query filters live and groups matching teams under a 'Teams' heading; selecting a result navigates directly to that team's detail page @real-email", async ({
      page,
    }) => {
      // The toPass() block below (30s) plus this test's own preceding
      // create-team steps can together exceed Playwright's 30s per-test
      // default - same fix as 3.1c above.
      test.setTimeout(60_000);

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

      await expect(page.getByRole('heading', { name: 'Create Team' })).toBeHidden();
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

      // Navigates directly to that team's detail page - same deep-linkable
      // URL shape as test 1.2. Retries this check - viewing a JUST-created
      // team's own detail page within the same test can hit a real,
      // transient "Unable to fetch team information" error (see confirmRemoveTeam()'s own comment).
      await expect(page).toHaveURL(/\/teams\/list\?team=[a-f0-9]+&cardDetails=true$/);
      await expect(async () => {
        if ((await page.getByText('Unable to fetch team information', { exact: false }).count()) > 0) {
          await page.reload();
        }
        await expect(page.getByRole('heading', { name: 'QA Search Test Team', level: 4 })).toBeVisible();
      }).toPass({ timeout: 30_000 });

      // 4. Cleanup: delete the throwaway team so it doesn't linger.
      await openRemoveTeamDialog(page);
      await confirmRemoveTeam(page);
      await page.goto(`${BASE_URL}/teams/list`);
      await expect(page.getByRole('heading', { name: 'Teams (1)', exact: true })).toBeVisible();
    });

    test("7.2 The search box's 'People' grouping shows a real active company member, distinct from 'Teams' @real-email", async ({
      page,
    }) => {
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
      await expect(dropdown.getByText('Teams', { exact: true })).toBeHidden();
    });

    test("7.3 Searching by a real member's exact email address matches them too, not just their display name @real-email", async ({
      page,
    }) => {
      // 6.7's invitee is searchable by their real email, not just 'QA Automation'.
      await page.goto(`${BASE_URL}/teams/list`);
      const searchBox = page.getByRole('combobox', { name: 'Select Teams & People' });
      await searchBox.click();
      await searchBox.pressSequentially(inviteeEmail);

      const dropdown = page.getByRole('listbox', { name: 'Select Teams & People' });
      await expect(dropdown.getByText('People', { exact: true })).toBeVisible();
      await expect(dropdown.getByRole('option', { name: 'QA Automation', exact: true })).toBeVisible();
    });

    test('7.4 A query matching neither a team nor a person shows a clear no-results state, not an empty-looking dropdown @real-email', async ({
      page,
    }) => {
      await page.goto(`${BASE_URL}/teams/list`);
      const searchBox = page.getByRole('combobox', { name: 'Select Teams & People' });
      await searchBox.click();
      await searchBox.pressSequentially('zzzznonexistentqueryzzzz');

      const dropdown = page.getByRole('listbox', { name: 'Select Teams & People' });
      await expect(dropdown).toBeVisible();
      await expect(dropdown.getByText('Teams', { exact: true })).toBeHidden();
      await expect(dropdown.getByText('People', { exact: true })).toBeHidden();
      await expect(dropdown.getByText('No options', { exact: true })).toBeVisible();
    });

    test('7.5 A very long search query does not visually break the search box or its results dropdown @real-email', async ({ page }) => {
      await page.goto(`${BASE_URL}/teams/list`);
      const searchBox = page.getByRole('combobox', { name: 'Select Teams & People' });
      await searchBox.click();
      await searchBox.pressSequentially('a'.repeat(150));

      const { bodyScrollWidth, bodyClientWidth } = await page.evaluate(() => ({
        bodyScrollWidth: document.body.scrollWidth,
        bodyClientWidth: document.body.clientWidth,
      }));
      expect(bodyScrollWidth).toBe(bodyClientWidth);
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

  // Placed last on purpose: leaves 2 Active members sharing the same
  // display name, which would break Suite 7's exact-one-match assumptions if it ran earlier.
  test.describe('Teams — Duplicate Display Names', () => {
    test("6.12 REAL BUG: two real Active members who share the exact same display name ('QA Automation', from completeProfile()'s hardcoded values) are shown with ZERO distinguishing information (no email, no other identifier) in the company-wide Members list @real-email", async ({
      page,
      browser,
    }) => {
      // A second real registration + real email round-trip, on top of this
      // test's own invite/accept round-trip.
      test.setTimeout(300_000);

      // 1. Register and verify a second real, disposable member - every
      // account completeProfile() touches gets the identical hardcoded
      // 'QA'/'Automation' name, so this second member is indistinguishable
      // by name from 6.7's own invitee, already Active in this same company.
      const secondEmail = generateUniqueEmailAlias();
      const secondUsername = generateUsernameFromEmail(secondEmail);
      const secondPassword = requireEnv('TEST_REGISTER_PASSWORD');
      const registeredAt = new Date();
      const secondContext = await browser.newContext({ ...devices['Desktop Chrome'] });
      const secondPage = await secondContext.newPage();
      await registerNewAccount(secondPage, secondEmail);
      const verificationLink = await getVerificationLink(secondEmail, registeredAt, 240_000);
      await secondPage.goto(verificationLink);
      await expect(secondPage).toHaveURL(`${BASE_URL}/login`);
      await secondPage.getByRole('textbox', { name: 'Username or Email' }).fill(secondUsername);
      await secondPage.getByRole('textbox', { name: 'Password' }).fill(secondPassword);
      await secondPage.getByRole('button', { name: 'Log In' }).click();
      await expect(secondPage).toHaveURL(`${BASE_URL}/complete-profile`, { timeout: 15_000 });
      await completeProfile(secondPage);
      await expect(secondPage).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });

      // 2. Invite and accept, same pattern as 6.7 (inlined - the Invite
      // Member Flow describe's own openInviteMemberModal()/
      // typeAndChipInviteEmail() helpers are scoped to that block, not this one).
      await page.goto(`${BASE_URL}/teams/members`);
      await page.getByRole('button', { name: 'Invite Member' }).click();
      await expect(page.getByRole('heading', { name: 'Invite Member' })).toBeVisible();
      const inviteCombobox = page.getByRole('combobox', { name: 'Add People by Email' });
      await inviteCombobox.click();
      await inviteCombobox.pressSequentially(secondEmail);
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'Invite' }).click();
      await expect(page.getByText('Your invitation(s) have been sent.', { exact: true })).toBeVisible();
      const invitationLink = await getInvitationLink(secondEmail, 240_000);
      await secondPage.goto(invitationLink);
      await secondPage.getByTestId('accept-btn').click();
      await expect(secondPage).toHaveURL(`${BASE_URL}/company`, { timeout: 15_000 });
      await secondContext.close();

      // 3. The Members list now has 2 distinct real people, both rendered
      // identically as 'QA Automation' with no email/id/tooltip to tell them apart.
      await page.goto(`${BASE_URL}/teams/members`);
      await expect(page.getByRole('heading', { name: 'Member (2)', exact: true })).toBeVisible({ timeout: 20_000 });
      // Matches either role per member row (see CLAUDE.md's row role-
      // inconsistency gotcha) - the two rows could even mix roles.
      const memberRows = page.getByRole('link', { name: 'QA Automation' }).or(page.getByRole('button', { name: 'QA Automation' }));
      await expect(memberRows).toHaveCount(2);
      await expect(page.locator('[title*="@"], [aria-label*="@"]')).toHaveCount(0);
      await expect(page.getByText('@', { exact: false })).toHaveCount(0);
    });
  });
});
