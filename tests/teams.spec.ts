// spec: specs/teams-test-plan.md
// seed: tests/seed.spec.ts

import { test, expect, Page, Locator, devices } from '@playwright/test';
import { requireEnv } from './utils/env';
import { getVerificationLink, getInvitationLink } from './utils/email';
import { generateUniqueEmailAlias, generateUsernameFromEmail, registerNewAccount, completeProfile } from './utils/account';

const BASE_URL = requireEnv('BASE_URL');

let disposableUsername: string;
let disposablePassword: string;

// Logs in with the one disposable account registered once in beforeAll below
// and lands on /company - the default first tab after login. Same pattern
// as loginAsDisposableAndGoToCompany() in tests/payments.spec.ts.
async function loginAsDisposableAndGoToCompany(page: Page) {
  await page.goto(`${BASE_URL}/login`);
  await page.locator('input[name="username"]').fill(disposableUsername);
  await page.locator('input[name="password"]').fill(disposablePassword);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });
  await page.goto(`${BASE_URL}/company`);
}

// Matches a team card's own accessible name shape ('<team name> <count>
// member(s) <owner's first name>') the same way tests 1.1/1.2 above already
// do inline for 'My Team' - pulled out here since Suites 2-4 below click
// into several different (and, for 4.2, renamed) non-default teams by name
// too. Every team in this file belongs to the one disposable owner
// registered in beforeAll and always has exactly 1 member (itself), so
// '1 member' is hardcoded rather than parameterized. getByRole's default
// (non-exact) name matching is substring-based, so this deliberately does
// NOT clash with e.g. a later '<name> Renamed' card - the un-renamed
// substring is never contiguous inside the renamed one, since the inserted
// text sits between the name and ' 1 member'.
function teamCard(page: Page, teamName: string) {
  return page.getByRole('button', { name: `${teamName} 1 member QA` });
}

// Clears a text field's current value one character at a time via real
// Backspace keystrokes (not a raw fill('') value-replace) - same technique,
// and same reasoning (fill() vs. real-keystrokes validation-timing gaps),
// as clearFieldWithBackspace() in company-details.spec.ts and the matching
// CLAUDE.md gotcha, confirmed live during this file's own Suite 2/3
// exploration to matter for Team Name too. Duplicated here rather than
// imported since this file doesn't currently share a common utils module
// for it with that file.
async function clearFieldWithBackspace(page: Page, field: Locator) {
  await field.click();
  await page.keyboard.press('End');
  const currentLength = (await field.inputValue()).length;
  for (let i = 0; i < currentLength; i++) {
    await page.keyboard.press('Backspace');
  }
}

// Opens the 'Update Team Name' modal via the unlabeled edit icon beside the
// team name heading - assumes the page is already on a team's detail view
// (/teams/list?team=<id>&cardDetails=true). Live-verified: this icon is the
// only button with an empty accessible name inside <main> on that page - a
// simpler locator than scoping via the heading's own wrapping container div.
function updateTeamNameEditIcon(page: Page) {
  return page.getByRole('main').getByRole('button').filter({ hasText: /^$/ });
}

// Clicks 'Remove Team' on a team's detail page to open its confirmation
// dialog - assumes the page is already on that team's detail view. Split
// from confirmRemoveTeam() below so test 4.3 can assert the dialog's own
// title/body/buttons in between (the whole point of that scenario), while
// test 3.2's cleanup step can skip straight through without re-asserting
// text 4.3 already covers.
async function openRemoveTeamDialog(page: Page) {
  await page.getByRole('button', { name: 'Remove Team' }).click();
}

// Confirms the 'Remove Team' dialog via 'Yes, remove' and waits for the real
// success toast - shared by test 4.3 and test 3.2's cleanup step (see
// openRemoveTeamDialog() above).
async function confirmRemoveTeam(page: Page) {
  await page.getByRole('button', { name: 'Yes, remove' }).click();
  await expect(page.locator('text=Your team was deleted successfully!')).toBeVisible();
}

// Same trade-off already documented and applied in
// company-details.spec.ts/logo-upload.spec.ts/profile-settings.spec.ts/
// payments.spec.ts: serial + chromium-only avoids racing parallel browser
// projects/workers on the one disposable company's Teams state built up
// sequentially across this file (teams created/renamed/deleted in later
// suites, invitations sent/cancelled, etc.).
test.describe('Teams', () => {
  // retries: 2 - this file's beforeAll depends on real Mandrill/SES email
  // delivery via getVerificationLink(), the same real external dependency
  // already live-verified (in tests/payments.spec.ts) to occasionally
  // exceed generous timeouts. Without this, one slow/failed delivery blocks
  // every test in the file, not just the one that hit it.
  test.describe.configure({ mode: 'serial', retries: 2 });

  // Teams does not touch the shared seed account: following the same
  // account-isolation reasoning already established for Payments (see
  // CLAUDE.md's "Account/company isolation" section and
  // specs/teams-test-plan.md's own Application Overview) - every
  // self-registered account gets its own fully isolated Company record, and
  // Suite 1 below specifically depends on a genuinely FRESH company (a
  // single default 'My Team' with 1 member, zero company-wide members,
  // zero invitations) - state the long-lived shared seed account cannot
  // reliably guarantee. Register ONE disposable account ONCE here, then run
  // every scenario in this file serially against that one throwaway
  // company.
  test.beforeAll(async ({ browser, browserName }) => {
    // `test.skip(browserName !== 'chromium', ...)` in the beforeEach below
    // only skips individual TESTS - it does nothing to gate this beforeAll
    // hook, which runs once per project regardless, BEFORE any test-level
    // skip ever gets a chance to apply. See the identical guard (and the
    // real CI failure it fixes) in tests/payments.spec.ts's own beforeAll.
    test.skip(
      browserName !== 'chromium',
      'Disposable single-company state built up sequentially across this file; runs once serially on chromium to avoid cross-project races, redundant registrations, and extra real-email load on the other 2 projects.'
    );

    // Generous budget - see the describe-level `retries: 2` comment above
    // for why this hook's own timeout is set well above
    // getVerificationLink's explicit budget rather than relying on the
    // default.
    test.setTimeout(300_000);

    // `browser.newPage()` alone creates a page in a bare default context,
    // WITHOUT this project's configured `devices['Desktop Chrome']` context
    // options - live-verified (see tests/payments.spec.ts and CLAUDE.md) to
    // break real verification-email delivery, since a bare context's
    // default user agent contains "HeadlessChrome". Passing the same device
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

  test.describe('Teams — Navigation Structure, Default State, and Auth Guard', () => {
    test("1.1 Fresh/isolated company's 'For You' tab shows an empty 'Members you work with' section and a default 'My Team' (Owner, 1 member) @real-email", async ({ page }) => {
      // 1. Log in with a fresh, profile-complete, isolated-company account
      // and land on /company (done by beforeEach), then click the 'Teams'
      // top-level tab. Only one tab named 'Teams' exists on /company (the
      // Teams area's own sub-tab of the same name only exists once already
      // inside /teams), so this is unambiguous here.
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

      // Exactly one team card, labeled 'My Team' / '1 member' with the
      // owner's avatar. Live-verified against a real run's failure snapshot
      // that the avatar's accessible text is only the FIRST name ('QA' -
      // completeProfile()'s fixed firstName value), not 'QA Automation' -
      // the accessible-name computation for this avatar element doesn't
      // include the last name. Matched by a '<team> <count> member(s)'
      // shaped accessible name rather than a scoped container locator -
      // live-verified while writing this file that a naive
      // `.filter({ has: heading }).last()` container scope here actually
      // resolves to the innermost div wrapping ONLY the heading+link header
      // row, not the sibling team-card button below it - so matching
      // directly by the card button's own distinctive accessible-name shape
      // is both simpler and more reliable.
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

      // The detail panel shows a 'Go Back' link, the team name as an h4
      // heading, an unlabeled edit icon button beside it, a 'Member'
      // heading with a '+ Add Members' button, and a single row 'You' /
      // 'Owner'.
      await expect(page.getByRole('button', { name: 'Go Back' })).toBeVisible();
      const teamNameHeading = page.getByRole('heading', { name: 'My Team', level: 4 });
      await expect(teamNameHeading).toBeVisible();

      // The unlabeled edit icon sits two DOM levels up from the h4 heading
      // (live-verified via direct DOM inspection: the heading's immediate
      // parent div wraps ONLY the heading itself - zero buttons - while its
      // own parent wraps both the heading and the single edit-icon button).
      // A single `.filter({ has: teamNameHeading }).last()` would resolve
      // to that innermost, heading-only div (matching Playwright's
      // documented pre-order "last = deepest" filter semantics), NOT the
      // div that also has the button - so this also filters for "contains
      // a button", same double-filter technique already used by
      // rewardsBalancesCard() in tests/payments.spec.ts, to correctly land
      // on the innermost div that contains BOTH.
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

      // Heading reads 'Member (0)' even though the SAME account is shown as
      // '1 member'/'Owner' inside 'My Team' on the Teams sub-tab (test
      // 1.1/1.2 above) - confirming /teams/members tracks company-wide
      // members who accepted an invitation (nobody yet, on a fresh
      // company), NOT team membership (which does include the owner).
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

      // 2. Navigate directly to /teams, then separately to /teams/list,
      // then separately to /teams/members, each via a fresh page.goto()
      // while logged out.
      await page.goto(`${BASE_URL}/teams`);
      await expect(page).toHaveURL(`${BASE_URL}/login?redirectUrl=${encodeURIComponent(`${BASE_URL}/teams`)}`);

      await page.goto(`${BASE_URL}/teams/list`);
      await expect(page).toHaveURL(`${BASE_URL}/login?redirectUrl=${encodeURIComponent(`${BASE_URL}/teams/list`)}`);

      await page.goto(`${BASE_URL}/teams/members`);
      await expect(page).toHaveURL(`${BASE_URL}/login?redirectUrl=${encodeURIComponent(`${BASE_URL}/teams/members`)}`);

      // 3. From the last redirected login page (/teams/members's redirect),
      // log in with valid credentials.
      await page.locator('input[name="username"]').fill(disposableUsername);
      await page.locator('input[name="password"]').fill(disposablePassword);
      await page.locator('button[type="submit"]').click();

      // After a successful login, the browser lands directly on the
      // originally-requested '/teams/members' page, not the default
      // '/company' landing page - confirming the redirectUrl deep-link is
      // honored for Teams routes too.
      await expect(page).toHaveURL(`${BASE_URL}/teams/members`, { timeout: 15_000 });
    });
  });

  test.describe('Teams — Default Team (\'My Team\') Detail Page', () => {
    test("2.1 The default team's sole member row ('You' / 'Owner') has no visible remove or role-change action, and the page has NO 'Remove Team' button anywhere @real-email", async ({ page }) => {
      // 1. On My Team's detail page (a fresh company with no other
      // members), inspect the 'You' / 'Owner' row and the whole page for
      // any delete/remove-team control.
      await page.goto(`${BASE_URL}/teams/list`);
      await teamCard(page, 'My Team').click();
      await expect(page).toHaveURL(/\/teams\/list\?team=[a-f0-9]+&cardDetails=true$/);

      // The row shows only 'You' and 'Owner' text with an avatar icon - no
      // button, icon, or menu of any kind is present on that row. Scoped
      // via the row's own stable MUI class name (live-verified via direct
      // DOM inspection - and confirmed unique on this page: a
      // MuiCardHeader-root wrapping an avatar img and a 'You'/'Owner' text
      // pair) rather than a generic div/text filter - the whole detail
      // panel ALSO contains 'You' and 'Owner' as descendants, so a broad
      // ancestor filter risks resolving to that panel (which DOES have
      // other buttons - 'Go Back', the edit icon, '+ Add Members') instead
      // of just this one row.
      const memberRow = page.locator('.MuiCardHeader-root');
      await expect(memberRow.getByText('You', { exact: true })).toBeVisible();
      await expect(memberRow.getByText('Owner', { exact: true })).toBeVisible();
      await expect(memberRow.getByRole('button')).toHaveCount(0);

      // No 'Remove Team'/'Delete Team' button or icon exists anywhere on
      // this specific team's detail page - see Suite 4 for confirmation
      // this is specific to the default team, not a general 'can't delete
      // a team' rule.
      await expect(page.getByRole('button', { name: 'Remove Team' })).toHaveCount(0);
    });

    test("2.2 REAL BUG: the 'Update Team Name' modal's Name field accepts a whitespace-only value with the Update button becoming enabled and no validation shown @real-email", async ({ page }) => {
      // 1. Click the unlabeled edit icon beside the team name heading to
      // open 'Update Team Name'. Select all text in the pre-filled 'Name'
      // field and clear it via real Backspace keystrokes, then blur the
      // field.
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

      // A red inline 'The field is required' message appears, and 'Update'
      // stays disabled - matching this app's normal required-field
      // pattern.
      await expect(page.getByText('The field is required', { exact: true })).toBeVisible();
      await expect(nameField).toHaveAttribute('aria-invalid', 'true');
      await expect(updateButton).toBeDisabled();

      // 2. Click back into 'Name' and type exactly three spaces using real
      // keystrokes (pressSequentially, not fill()).
      await nameField.click();
      await nameField.pressSequentially('   ');

      // Live-verified, REAL BUG: 'Update' becomes ENABLED with the field
      // holding only whitespace, and no inline error message of any kind
      // appears - the same fill() vs. real-keystrokes validation-timing
      // gap already documented in CLAUDE.md, confirmed here to affect Team
      // Name too.
      await expect(updateButton).toBeEnabled();
      await expect(page.getByText('The field is required', { exact: true })).not.toBeVisible();

      // 3. Click 'Cancel' without submitting this whitespace value (to
      // avoid corrupting the default team's name mid-exploration).
      await page.getByRole('button', { name: 'Cancel' }).click();

      // The modal closes and 'My Team''s name is unchanged - see test 3.2
      // for confirmation that submitting a whitespace-only name via
      // 'Create Team' is genuinely accepted and persisted server-side,
      // which this test intentionally did not repeat against the
      // pre-existing default team.
      await expect(page.getByRole('heading', { name: 'Update Team Name' })).not.toBeVisible();
      await expect(page.getByRole('heading', { name: 'My Team', level: 4 })).toBeVisible();
    });

    test("2.3 '+ Add Members' shows a bare 'Select' placeholder as if it were a real option, instead of a proper empty-state message, when the company has no other active members @real-email", async ({ page }) => {
      // 1. Click '+ Add Members' on My Team's detail page (a company with
      // only the owner as an active member), then open the 'Add team
      // members' combobox's dropdown.
      await page.goto(`${BASE_URL}/teams/list`);
      await teamCard(page, 'My Team').click();
      await page.getByRole('button', { name: '+ Add Members' }).click();

      const combobox = page.getByRole('combobox', { name: 'Add team members' });
      await expect(combobox).toBeVisible();
      const saveButton = page.getByRole('button', { name: 'Save' });
      await expect(saveButton).toBeDisabled();
      await page.getByRole('button', { name: 'Open' }).click();

      // The dropdown opens showing a single row reading literally 'Select'
      // - the SAME text as the field's own placeholder - rather than a
      // real 'No options'/'No members to add' message. Live-verified via
      // direct DOM inspection: this is a plain, non-interactive <p> (no
      // 'option' role) inside the dropdown's popper, not a real selectable
      // option.
      await expect(page.getByText('Select', { exact: true })).toBeVisible();

      // 'Save' stays disabled throughout, since nothing can be selected.
      await expect(saveButton).toBeDisabled();
    });
  });

  test.describe('Teams — Create Team', () => {
    test("3.1 The Create Team modal's structure: required Name, optional Add Teams Members, Create disabled until Name holds a value @real-email", async ({ page }) => {
      // 1. Click '+ Create Team' from any Teams sub-tab.
      await page.goto(`${BASE_URL}/teams/list`);
      await page.getByRole('button', { name: '+ Create Team' }).click();

      // A modal titled 'Create Team' opens with a required 'Name *' text
      // field, an optional 'Add Teams Members' combobox (with its own
      // 'Open' dropdown-toggle button), and 'Cancel'/'Create' buttons -
      // 'Create' is disabled by default on the pristine, empty form.
      await expect(page.getByRole('heading', { name: 'Create Team' })).toBeVisible();
      const nameField = page.getByRole('textbox', { name: 'Name' });
      await expect(nameField).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Add Teams Members' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Open' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
      const createButton = page.getByRole('button', { name: 'Create' });
      await expect(createButton).toBeDisabled();

      // 2. Type a normal team name (e.g. 'QA Second Team') via real
      // keystrokes.
      await nameField.click();
      await nameField.pressSequentially('QA Second Team');

      // 'Create' becomes enabled.
      await expect(createButton).toBeEnabled();

      // Cleanup: close without submitting - this scenario only verifies
      // the form's own structure/enabled-state; test 3.4 covers a real
      // successful submission.
      await page.getByRole('button', { name: 'Cancel' }).click();
    });

    test('3.2 REAL BUG: submitting Create Team with a whitespace-only Name is accepted client-side and genuinely PERSISTS a blank-looking team to the backend @real-email', async ({ page }) => {
      // 1. Open 'Create Team', type exactly three spaces into 'Name' via
      // real keystrokes (pressSequentially), leave 'Add Teams Members'
      // empty, and click 'Create'.
      await page.goto(`${BASE_URL}/teams/list`);
      await expect(page.getByRole('heading', { name: 'Teams (1)', exact: true })).toBeVisible();
      await page.getByRole('button', { name: '+ Create Team' }).click();
      const nameField = page.getByRole('textbox', { name: 'Name' });
      await nameField.click();
      await nameField.pressSequentially('   ');
      await page.getByRole('button', { name: 'Create' }).click();

      // Live-verified, REAL BUG: the modal shows an in-modal success screen
      // - 'Your team was created successfully!' + a 'Continue' button -
      // exactly like a normal valid submission; there is no server-side
      // rejection either.
      await expect(page.getByText('Your team was created successfully!', { exact: true })).toBeVisible();
      const continueButton = page.getByRole('button', { name: 'Continue' });
      await expect(continueButton).toBeVisible();

      // 2. Click 'Continue' and inspect the resulting team card in
      // 'Teams (N)'.
      await continueButton.click();

      // A genuinely new team now exists, incrementing 'Teams (N)' by one,
      // whose card shows a completely EMPTY heading (no visible text at
      // all) alongside '1 member' and the owner's avatar. Located by
      // process of elimination (there are now exactly 2 team-card buttons,
      // and the new one is the one that does NOT contain 'My Team's text)
      // rather than by accessible name, since the blank heading's own
      // contribution to the card button's composite accessible name isn't
      // predictable.
      await expect(page.getByRole('heading', { name: 'Teams (2)', exact: true })).toBeVisible();
      const allTeamCards = page.getByRole('button', { name: /member/ });
      await expect(allTeamCards).toHaveCount(2);
      const blankTeamCard = allTeamCards.filter({ hasNotText: 'My Team' });
      await expect(blankTeamCard).toHaveCount(1);
      await expect(blankTeamCard.getByText('1 member', { exact: true })).toBeVisible();

      // 3. Directly inspect the raw DOM textContent of that team's name
      // heading (not just the rendered/visual appearance).
      const blankNameHeading = blankTeamCard.locator('h6').first();
      // Visually, the heading renders as empty (Playwright's toHaveText
      // normalizes/trims whitespace by default).
      await expect(blankNameHeading).toHaveText('');
      // Live-verified via direct DOM inspection: the heading's raw
      // textContent is exactly three literal space characters - confirming
      // the whitespace value was genuinely accepted and persisted
      // server-side, not merely a client-side rendering quirk.
      const rawTextContent = await blankNameHeading.evaluate((el) => el.textContent);
      expect(rawTextContent).toBe('   ');

      // 4. (Cleanup) Delete this blank-named team via its own 'Remove
      // Team' button so it doesn't linger as leftover clutter and the next
      // test starts from a clean 'Teams (1)' state.
      await blankTeamCard.click();
      await expect(page).toHaveURL(/\/teams\/list\?team=[a-f0-9]+&cardDetails=true$/);
      await openRemoveTeamDialog(page);
      await confirmRemoveTeam(page);

      // The team is removed and 'Teams (N)' decrements back down.
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

      // After a real submit attempt, an inline error appears directly
      // beneath 'Name' reading exactly 'Team with that name already
      // exists', the field is marked invalid, and 'Create' re-disables -
      // no new duplicate-named team is created. A genuine, working
      // validation, in deliberate contrast to test 3.2's whitespace-name
      // gap: SOME name validation exists (duplicate detection), just not
      // blank/whitespace rejection.
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
      // 1. Open 'Create Team', type a valid unique name (e.g. 'QA Second
      // Team'), leave 'Add Teams Members' empty (a single-member company
      // has no other candidates to add - see test 2.3), and click
      // 'Create'.
      await page.goto(`${BASE_URL}/teams/list`);
      await page.getByRole('button', { name: '+ Create Team' }).click();
      const nameField = page.getByRole('textbox', { name: 'Name' });
      await nameField.click();
      await nameField.pressSequentially('QA Second Team');
      await page.getByRole('button', { name: 'Create' }).click();

      // An in-modal success screen appears: 'Your team was created
      // successfully!' + 'Continue'.
      await expect(page.getByText('Your team was created successfully!', { exact: true })).toBeVisible();
      const continueButton = page.getByRole('button', { name: 'Continue' });

      // 2. Click 'Continue'.
      await continueButton.click();

      // The modal closes; 'Teams (N)' on the Teams sub-tab increments by
      // one and shows a new card for the new team / '1 member'; the same
      // team also appears under 'Your Teams' on the 'For you' sub-tab.
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
      // 1. Open the detail page of a team created during this exploration
      // (e.g. 'QA Second Team', created alongside the still-existing
      // default 'My Team' - so 2 teams exist at this point).
      await page.goto(`${BASE_URL}/teams/list`);
      await expect(page.getByRole('heading', { name: 'Teams (2)', exact: true })).toBeVisible();
      await teamCard(page, 'QA Second Team').click();
      await expect(page).toHaveURL(/\/teams\/list\?team=[a-f0-9]+&cardDetails=true$/);

      // A 'Remove Team' button IS present on this team's detail page.
      await expect(page.getByRole('button', { name: 'Remove Team' })).toBeVisible();

      // 2. Navigate back and open 'My Team''s detail page again, with the
      // same 2 teams still existing.
      await page.getByRole('button', { name: 'Go Back' }).click();
      await teamCard(page, 'My Team').click();
      await expect(page.getByRole('heading', { name: 'My Team', level: 4 })).toBeVisible();

      // 'My Team' STILL has no 'Remove Team' button, even though the
      // company now has more than one team - proving this is NOT a 'you
      // can't delete your only/last team' rule, but specifically
      // hardcoded to the seeded default team itself, regardless of how
      // many other teams exist alongside it.
      await expect(page.getByRole('button', { name: 'Remove Team' })).toHaveCount(0);
    });

    test("4.2 A genuine, real 'Update Team Name' save on a non-default team persists correctly end-to-end @real-email", async ({ page }) => {
      // 1. On a non-default team's detail page (e.g. 'QA Second Team'),
      // open 'Update Team Name', replace the Name with a new valid value
      // via real keystrokes (e.g. 'QA Second Team Renamed'), and click
      // 'Update'.
      await page.goto(`${BASE_URL}/teams/list`);
      await teamCard(page, 'QA Second Team').click();
      await updateTeamNameEditIcon(page).click();

      const nameField = page.getByRole('textbox', { name: 'Name' });
      await expect(nameField).toHaveValue('QA Second Team');
      await clearFieldWithBackspace(page, nameField);
      await nameField.pressSequentially('QA Second Team Renamed');
      await page.getByRole('button', { name: 'Update' }).click();

      // An in-modal success screen appears reading "Your team's name have
      // been changed successfully!" (grammar note: 'have' should be 'has'
      // to agree with the singular 'name' - a minor copy defect, not
      // functional) + a 'Continue' button.
      await expect(page.getByText("Your team's name have been changed successfully!", { exact: true })).toBeVisible();
      const continueButton = page.getByRole('button', { name: 'Continue' });

      // 2. Click 'Continue'.
      await continueButton.click();

      // The team detail page's heading immediately reflects the new name,
      // with no manual reload needed.
      await expect(page.getByRole('heading', { name: 'QA Second Team Renamed', level: 4 })).toBeVisible();

      // 3. Navigate away (e.g. to the Teams list) and back into this
      // team's detail page.
      await page.getByRole('button', { name: 'Go Back' }).click();
      await expect(page.getByRole('heading', { name: 'Teams (2)', exact: true })).toBeVisible();
      await teamCard(page, 'QA Second Team Renamed').click();

      // The new name persists after re-navigation, confirming a genuine
      // backend save, not just optimistic client-side state.
      await expect(page.getByRole('heading', { name: 'QA Second Team Renamed', level: 4 })).toBeVisible();
    });

    test("4.3 'Remove Team' opens a dialog titled 'Delete Team' (a label inconsistency with the triggering button) with a grammar defect in its body copy, and confirming genuinely deletes the team @real-email", async ({ page }) => {
      // 1. On a non-default team's detail page, click 'Remove Team'.
      await page.goto(`${BASE_URL}/teams/list`);
      await teamCard(page, 'QA Second Team Renamed').click();
      await openRemoveTeamDialog(page);

      // A confirmation dialog opens - its TITLE reads 'Delete Team', not
      // 'Remove Team' (the exact text of the button that opened it) - a
      // minor label inconsistency worth noting, in the same general
      // family as Payments' already-documented loose 'Remove'/'Delete'
      // phrasing (not itself a functional bug).
      await expect(page.getByRole('heading', { name: 'Delete Team', exact: true })).toBeVisible();

      // The body copy reads exactly "Are you sure you want to delete this
      // team? If you choose to delete the team, all of the team's data
      // will permanently deleted." - a grammar defect (missing 'be':
      // should read '...will be permanently deleted').
      // Live-verified: the app renders a typographic right single quote
      // (U+2019, '’') in "team's", not a plain ASCII apostrophe -
      // an exact-text match needs to use the real character.
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

      // A toast reads 'Your team was deleted successfully!' (asserted
      // inside confirmRemoveTeam() above). Re-navigating to the Teams list
      // confirms the deletion was genuinely persisted server-side (not
      // just an optimistic client-side removal that would still show on a
      // fresh load) - 'Teams (N)' decrements by one and the card is gone.
      await page.goto(`${BASE_URL}/teams/list`);
      await expect(page.getByRole('heading', { name: 'Teams (1)', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: /QA Second Team/ })).toHaveCount(0);

      // It is also gone from 'Your Teams' on the 'For you' sub-tab.
      await page.goto(`${BASE_URL}/teams`);
      await expect(page.getByRole('button', { name: /QA Second Team/ })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'My Team 1 member QA' })).toBeVisible();
    });
  });

  test.describe('Teams — Members Page (/teams/members): Active and Sent Invitations Tabs', () => {
    test("5.1 A fresh/isolated company's Active tab and Sent Invitations tab each show their own distinct empty state @real-email", async ({ page }) => {
      // 1. On /teams/members with no invitations ever sent and no accepted
      // members, inspect the 'Active' tab (selected by default).
      await page.goto(`${BASE_URL}/teams/members`);

      // Heading reads 'Member (0)'; body shows the placeholder text 'Add
      // some members to be displayed here' with no table/grid rendered.
      await expect(page.getByRole('heading', { name: 'Member (0)', exact: true })).toBeVisible();
      const activeTab = page.getByRole('tab', { name: 'Active' });
      await expect(activeTab).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByText('Add some members to be displayed here', { exact: true })).toBeVisible();
      await expect(page.getByRole('grid')).toHaveCount(0);

      // 2. Click the 'Sent Invitations' tab.
      await page.getByRole('tab', { name: 'Sent Invitations' }).click();

      // Live-verified: the URL gains '?memberTab=sentInvitations' - a real,
      // deep-linkable query param; a genuine grid renders (unlike the
      // Active tab's plain placeholder text) with 'Email Address'/'Date
      // Sent'/'Actions' column headers, a single row reading 'You have not
      // sent any invitations.', and a pagination footer '0–0 of 0' with
      // both page buttons disabled.
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
      // 1. (Documentation step.) Test 6.7 below (Suite 6) now implements
      // and verifies the full invite -> real email -> accept -> appears as
      // 'Active' member flow end-to-end, including asserting the Active
      // tab's 'Member (1)' non-empty state directly. It cannot be verified
      // HERE instead, purely because of this file's serial execution
      // order: this test runs chronologically before 6.7 ever creates a
      // real accepted member, so the Active tab genuinely still has zero
      // members at this specific point in the sequence - not because the
      // flow itself is unverified anywhere in this file.
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

    // The cancel-invitation icon button in a given row carries no
    // accessible name at all (this same gap has its own dedicated
    // coverage in test 8.1) - scoped the same way updateTeamNameEditIcon()
    // above scopes the Team Name edit icon: the only OTHER button in this
    // row is 'Resend', so filtering for an empty accessible name inside
    // the row isolates it.
    function cancelInvitationIcon(page: Page, email: string) {
      return invitationRow(page, email).getByRole('button').filter({ hasText: /^$/ });
    }

    // Navigates to the Sent Invitations tab via a real page.goto() (a full
    // reload, never a soft client-side tab click) and returns the parsed
    // body of the GET /api/invitations request that load fires - used
    // wherever this suite needs to prove something about the REAL backend
    // state, not just the client's current in-memory grid (test 6.2's
    // false-positive-success bug, and test 6.5's real updatedAt change).
    //
    // Intercepts the response via page.route() instead of reading
    // response.json() after waitForResponse() - live-verified via a real
    // failed CI-equivalent run that the plain waitForResponse().then(r =>
    // r.json()) approach intermittently throws "Response body is not
    // available for a response that was navigated away from" (reproduced
    // 3/3 times on test 6.5 in one run, exhausting all retries and
    // cascading to skip every later test in this serial file). Same root
    // cause and same fix already established in logo-upload.spec.ts's own
    // POST /company interception (see CLAUDE.md's matching gotcha): this
    // app's client-side router appears to do something that races the
    // browser's own buffering of the response body. Routing lets us fetch
    // the real response and read its body ourselves, deterministically,
    // before handing it back to the page via route.fulfill() so the app
    // still behaves normally.
    async function gotoSentInvitationsAndGetResponse(page: Page): Promise<InvitationsResponse> {
      // `{ times: 1 }` self-detaches this route after exactly one matched
      // request, instead of a manual page.unroute() afterward - live-verified
      // this matters: this function gets called twice in the same test
      // (6.5's before/after comparison), and a manual unroute() timed right
      // after the first call's own expect.poll() raced a request that had
      // already been matched by that same handler, throwing "route.fulfill:
      // Route is already handled!" on a later call. Self-detaching after one
      // match removes that race entirely.
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
      // 1. Click 'Invite Member' from any Teams sub-tab, then type an
      // invalid value (e.g. 'not-an-email') into 'Add People by Email' and
      // press Enter.
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
      // 1. Clear the invalid value, type the currently logged-in account's
      // own email address, press Enter to chip it, then click 'Invite'.
      // The account's own email is discovered from /profile's read-only
      // Email Address field rather than hardcoded, per this project's
      // documented discover-don't-hardcode Portability convention - this
      // makes the test work against whichever disposable account this
      // file's own beforeAll actually registered.
      await page.goto(`${BASE_URL}/profile`);
      const ownEmail = await page.locator('input[name="email"]').inputValue();
      expect(ownEmail).toBeTruthy();

      await page.goto(`${BASE_URL}/teams/members`);
      await openInviteMemberModal(page);
      await typeAndChipInviteEmail(page, ownEmail);

      // 'Invite' becomes enabled once the email is chipped (a
      // syntactically valid, existing email passes client-side
      // validation).
      const inviteButton = page.getByRole('button', { name: 'Invite' });
      await expect(inviteButton).toBeEnabled();
      await inviteButton.click();

      // Live-verified, REAL BUG: a success toast still appears ('Your
      // invitation(s) have been sent.'), and the POST request itself
      // returns success.
      await expect(page.getByText('Your invitation(s) have been sent.', { exact: true })).toBeVisible();

      // But a subsequent GET /api/invitations call - fired by a full page
      // reload (page.goto(), not a soft refresh) onto the Sent
      // Invitations tab - returns total 0 / empty data, and the tab
      // remains genuinely empty. A real, silent, false-positive success -
      // not merely a UI-refresh lag.
      const invitationsResponse = await gotoSentInvitationsAndGetResponse(page);
      expect(invitationsResponse.metadata.total).toBe(0);
      expect(invitationsResponse.data).toEqual([]);
      await expect(page.getByText('You have not sent any invitations.', { exact: true })).toBeVisible();
      await expect(page.getByText('0–0 of 0', { exact: true })).toBeVisible();
    });

    test('6.3 A brand-new never-used email, AND an email already tied to a not-yet-verified pending registration, both create genuine invitations — and multiple emails can be invited in a single submission @real-email', async ({ page, browser }) => {
      // A real second-account registration plus a real multi-email invite
      // round-trip - comfortably possible to exceed the default 30s test
      // timeout on a slower run.
      test.slow();

      // 1. (Setup) Register a second disposable email alias and stop
      // right after its 'Job Link Email Verification' pending screen
      // appears - do NOT click the real verification link, and never log
      // into this account for the rest of this test. Done in a separate
      // browser context/tab (browser.newContext(), not this test's own
      // `page`) so the inviter's own logged-in session is never disturbed
      // - mirrors this file's own beforeAll isolation technique above.
      pendingEmail = generateUniqueEmailAlias();
      const registerContext = await browser.newContext({ ...devices['Desktop Chrome'] });
      const registerPage = await registerContext.newPage();
      await registerNewAccount(registerPage, pendingEmail);
      await registerContext.close();

      // 2. Back in the inviter's session, open 'Invite Member', chip a
      // completely new/never-used email address, then also chip the
      // unconfirmed email from step 1, and click 'Invite' once with both
      // chips present.
      freshEmail = generateUniqueEmailAlias();
      await page.goto(`${BASE_URL}/teams/members`);
      await openInviteMemberModal(page);
      await typeAndChipInviteEmail(page, freshEmail);
      await typeAndChipInviteEmail(page, pendingEmail);
      const inviteButton = page.getByRole('button', { name: 'Invite' });
      await expect(inviteButton).toBeEnabled();
      await inviteButton.click();

      // The success toast appears, and this time it is a real,
      // non-phantom result - the 'Sent Invitations' grid immediately shows
      // BOTH rows ('1-2 of 2'), each with a real 'Date Sent' timestamp and
      // 'Resend'/cancel actions.
      await expect(page.getByText('Your invitation(s) have been sent.', { exact: true })).toBeVisible();
      await page.getByRole('tab', { name: 'Sent Invitations' }).click();
      await expect(page.getByText('1–2 of 2', { exact: true })).toBeVisible();
      await expect(invitationRow(page, freshEmail)).toBeVisible();
      await expect(invitationRow(page, pendingEmail)).toBeVisible();
      await expect(invitationRow(page, freshEmail).getByRole('button', { name: 'Resend' })).toBeVisible();
      await expect(invitationRow(page, pendingEmail).getByRole('button', { name: 'Resend' })).toBeVisible();

      // 3. Inspect the GET /api/invitations response.
      const invitationsResponse = await gotoSentInvitationsAndGetResponse(page);

      // The response contains two real invitation objects with distinct
      // MongoDB-style ids and the exact two email addresses submitted -
      // confirming genuine backend records were created for both in a
      // single submission, unlike test 6.2's self-invite/existing-active-
      // user case. This differentiates the false-positive bug in 6.2
      // specifically to 'inviting an email tied to an ALREADY-ACTIVE
      // company user account' - an email merely tied to an unconfirmed,
      // never-logged-into pending sign-up is treated as a legitimate new
      // invitee, not an existing user.
      expect(invitationsResponse.metadata.total).toBe(2);
      const emails = invitationsResponse.data.map((invitation) => invitation.email);
      expect(emails).toContain(freshEmail);
      expect(emails).toContain(pendingEmail);
      const ids = invitationsResponse.data.map((invitation) => invitation.id);
      expect(new Set(ids).size).toBe(2);
    });

    test('6.4 The invite combobox client-side blocks re-inviting an email that already has a pending invitation, preventing duplicate rows @real-email', async ({ page }) => {
      // 1. With a pending invitation already sent to a given email (from
      // test 6.3), open 'Invite Member' again and type/chip that SAME
      // email address.
      await page.goto(`${BASE_URL}/teams/members`);
      await openInviteMemberModal(page);
      await typeAndChipInviteEmail(page, freshEmail);

      // The combobox is marked invalid with an inline message reading
      // exactly "You've already invited this email address." (the app
      // renders a typographic right single quote, U+2019, not a plain
      // ASCII apostrophe - live-verified via direct DOM inspection) and
      // 'Invite' stays disabled - a genuine, working client-side
      // duplicate-prevention guard.
      const combobox = page.getByRole('combobox', { name: 'Add People by Email' });
      await expect(combobox).toHaveAttribute('aria-invalid', 'true');
      await expect(page.getByText('You’ve already invited this email address.', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Invite' })).toBeDisabled();

      // Cleanup: close without submitting - the pending invitations from
      // 6.3 stay untouched for tests 6.5/6.6 below.
      await page.getByRole('button', { name: 'Cancel' }).click();
    });

    test("6.5 'Resend' on a pending invitation shows a success toast and genuinely updates the invitation server-side — even though the UI's minute-granularity 'Date Sent' column can look visually unchanged @real-email", async ({ page }) => {
      // Establish the real 'before' state via a full reload, capturing the
      // target invitation's own server-side updatedAt timestamp.
      const beforeResponse = await gotoSentInvitationsAndGetResponse(page);
      const beforeInvitation = beforeResponse.data.find((invitation) => invitation.email === freshEmail);
      expect(beforeInvitation).toBeTruthy();

      // 1. On the 'Sent Invitations' tab, click 'Resend' on a pending
      // invitation row.
      await invitationRow(page, freshEmail).getByRole('button', { name: 'Resend' }).click();

      // A toast reads exactly 'Invitation has been resent successfully!'.
      await expect(page.getByText('Invitation has been resent successfully!', { exact: true })).toBeVisible();

      // 2. Inspect the GET /api/invitations response before (captured
      // above) and after the resend, via a fresh full reload.
      const afterResponse = await gotoSentInvitationsAndGetResponse(page);
      const afterInvitation = afterResponse.data.find((invitation) => invitation.email === freshEmail);
      expect(afterInvitation).toBeTruthy();

      // The invitation's updatedAt timestamp genuinely changed server-side
      // (confirmed by comparing the exact ISO timestamp before/after) -
      // but since the UI's visible 'Date Sent' column only displays
      // minute-level precision (no seconds), a resend that lands within
      // the same minute as the original send can visually LOOK unchanged
      // in the grid even though it worked correctly. Not a functional bug
      // - a display-precision limitation worth knowing before mistaking an
      // unchanged-looking 'Date Sent' cell for a broken Resend.
      expect(afterInvitation!.updatedAt).not.toBe(beforeInvitation!.updatedAt);
      expect(new Date(afterInvitation!.updatedAt).getTime()).toBeGreaterThan(new Date(beforeInvitation!.updatedAt).getTime());
    });

    test("6.6 'Cancel Invitation' opens a confirmation dialog, and confirming genuinely revokes the invitation @real-email", async ({ page }) => {
      // 1. Click the unlabeled cancel-invitation icon button on a pending
      // invitation row.
      await page.goto(`${BASE_URL}/teams/members?memberTab=sentInvitations`);
      await expect(page.getByText('1–2 of 2', { exact: true })).toBeVisible();
      await cancelInvitationIcon(page, freshEmail).click();

      // A dialog titled 'Cancel Invitation' opens with body text 'Are you
      // sure you want to cancel the invitation for this member?' and 'No,
      // go back'/'Yes, cancel' buttons.
      await expect(page.getByRole('heading', { name: 'Cancel Invitation', exact: true })).toBeVisible();
      await expect(page.getByText('Are you sure you want to cancel the invitation for this member?', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'No, go back' })).toBeVisible();
      const confirmButton = page.getByRole('button', { name: 'Yes, cancel' });
      await expect(confirmButton).toBeVisible();

      // 2. Click 'Yes, cancel'.
      await confirmButton.click();

      // A toast reads exactly 'Invitation has been revoked successfully!',
      // the row disappears from the grid immediately (pagination count
      // decrements, e.g. '1-2 of 2' -> '1-1 of 1'), with no manual reload
      // needed.
      await expect(page.getByText('Invitation has been revoked successfully!', { exact: true })).toBeVisible();
      await expect(invitationRow(page, freshEmail)).toHaveCount(0);
      await expect(page.getByText('1–1 of 1', { exact: true })).toBeVisible();

      // (Cleanup) Test 6.3 above created TWO real pending invitations
      // (freshEmail and pendingEmail); this scenario's own dialog only
      // exercises cancelling one of them. Cancel the other one too here so
      // NO pending invitation is left over on this file's disposable
      // company once this suite finishes - later suites added to this
      // file need to start from a clean Sent Invitations state.
      await cancelInvitationIcon(page, pendingEmail).click();
      await page.getByRole('button', { name: 'Yes, cancel' }).click();
      await expect(page.getByText('Invitation has been revoked successfully!', { exact: true })).toBeVisible();
      await expect(page.getByText('You have not sent any invitations.', { exact: true })).toBeVisible();
      await expect(page.getByText('0–0 of 0', { exact: true })).toBeVisible();
    });

    test("6.7 The full invite → real email → accept → appears as 'Active' member flow works end-to-end @real-email", async ({ page, browser }) => {
      // A second full account registration plus two separate real-email
      // round-trips (getInvitationLink's up to 150s + getVerificationLink's
      // up to 240s, on top of the registration/profile-completion UI steps)
      // - live-verified this comfortably exceeds even test.slow()'s 3x
      // multiplier (90s default -> still timed out at 90s twice in a row on
      // a real run). Use an explicit, generous timeout instead, matching
      // this file's own beforeAll's same reasoning.
      test.setTimeout(480_000);

      // 1. Invite a brand-new, never-used email from the inviter's own
      // session (this test's own `page`, already logged in as this file's
      // beforeAll account).
      const inviteeEmail = generateUniqueEmailAlias();
      await page.goto(`${BASE_URL}/teams/members`);
      await openInviteMemberModal(page);
      await typeAndChipInviteEmail(page, inviteeEmail);
      await page.getByRole('button', { name: 'Invite' }).click();
      await expect(page.getByText('Your invitation(s) have been sent.', { exact: true })).toBeVisible();

      // 2. Read the real invitation email. Live-verified while writing this
      // test: subject is exactly 'New Invitation!' - a DIFFERENT template
      // from the 'Job Link Registration Confirmation' email
      // getVerificationLink() reads, confirming the plan's own warning not
      // to assume they share a template. See getInvitationLink()'s own
      // comment in tests/utils/email.ts for why it doesn't need Mandrill
      // click-unwrapping or a `since` filter here. Explicit generous
      // timeout (matching getVerificationLink's own 240_000 elsewhere in
      // this file) - live-verified this default (150_000) genuinely wasn't
      // enough on 2 separate real runs under heavy same-day mailbox load;
      // this test's own overall 480_000 budget comfortably absorbs it.
      const invitationLink = await getInvitationLink(inviteeEmail, 240_000);

      // 3. Act as the invitee in a SEPARATE browser context, so the
      // inviter's own session is never disturbed - same isolation
      // technique this file's beforeAll and test 6.3 already use.
      const inviteeContext = await browser.newContext({ ...devices['Desktop Chrome'] });
      const inviteePage = await inviteeContext.newPage();

      // Visiting the invitation link while logged out redirects to /login
      // with the invitee's email pre-filled in 'Username or Email', and a
      // 'Sign Up' link that itself carries the same email as a ?email=
      // query param to pre-fill registration.
      await inviteePage.goto(invitationLink);
      await expect(inviteePage).toHaveURL(new RegExp(`^${BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/login\\?redirectUrl=`));
      await expect(inviteePage.getByRole('textbox', { name: 'Username or Email' })).toHaveValue(inviteeEmail);
      const inviteeUsername = generateUsernameFromEmail(inviteeEmail);
      const inviteePassword = requireEnv('TEST_REGISTER_PASSWORD');
      await inviteePage.getByRole('link', { name: 'Sign Up' }).click();
      await expect(inviteePage).toHaveURL(`${BASE_URL}/register?email=${encodeURIComponent(inviteeEmail)}`);

      // 4. Register for real - a genuinely new account, reached via the
      // invitation link's 'Sign Up' link rather than a direct /register
      // visit, with Email Address already pre-filled read-only.
      const registeredAt = new Date();
      await inviteePage.getByRole('textbox', { name: 'Username' }).fill(inviteeUsername);
      await inviteePage.getByRole('textbox', { name: 'Password', exact: true }).fill(inviteePassword);
      await inviteePage.getByRole('textbox', { name: 'Confirm Password' }).fill(inviteePassword);
      await inviteePage
        .getByRole('checkbox', { name: 'By checking the box you confirm you have read and agree to our Terms of Service' })
        .check();
      await inviteePage.getByRole('button', { name: 'Register' }).click();
      await expect(inviteePage).toHaveURL(`${BASE_URL}/email-verification`, { timeout: 15_000 });

      // 5. Verify the invitee's own registration-confirmation email - a
      // completely separate email/link from the invitation email in step 2
      // - then log in and complete the profile (reusing completeProfile()
      // exactly like this file's own beforeAll does for the inviter).
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
      // logged in - completing registration does NOT auto-redirect back to
      // it, so whoever lands here for real needs to keep the link handy.
      await inviteePage.goto(invitationLink);
      await expect(inviteePage.getByText('You’ve been invited!', { exact: true })).toBeVisible();
      // completeProfile() hardcodes 'QA'/'Automation' as first/last name for
      // every account it completes - including this file's own beforeAll
      // account (the inviter) - so the invited-by name below is
      // deterministic, not a placeholder.
      await expect(inviteePage.getByText('We found your invitation to QA Automation Job Link team!', { exact: true })).toBeVisible();
      await inviteePage.getByTestId('accept-btn').click();

      // Accepting redirects to /company - the invitee's OWN separate
      // company (created for them at registration), still blank -
      // confirming acceptance does NOT switch the invitee's active company
      // context to the inviter's company.
      await expect(inviteePage).toHaveURL(`${BASE_URL}/company`, { timeout: 15_000 });
      await inviteeContext.close();

      // 7. Back in the inviter's own session: the invitee now appears as a
      // real, company-wide 'Active' member (not just gone from 'Sent
      // Invitations').
      await page.goto(`${BASE_URL}/teams/members`);
      await expect(page.getByRole('heading', { name: 'Member (1)', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'QA Automation' })).toBeVisible();

      // The invitation also disappears from 'Sent Invitations' entirely
      // (not merely moved) now that it has been fulfilled.
      await page.getByRole('tab', { name: 'Sent Invitations' }).click();
      await expect(page.getByText('You have not sent any invitations.', { exact: true })).toBeVisible();
      await expect(page.getByText('0–0 of 0', { exact: true })).toBeVisible();

      // Accepting a company-wide invitation does NOT also add the invitee
      // to the SPECIFIC team they were invited through ('My Team' still
      // shows only the owner) - confirming the plan's own open question:
      // becoming an 'Active' company member and being added to a team are
      // two separate steps (the latter would need its own '+ Add Members'
      // action from the team's own detail page, now possible since a real
      // Active member finally exists - see test 2.3's empty-state coverage
      // of the SAME dropdown for the 'before' state).
      await page.goto(`${BASE_URL}/teams/list`);
      await expect(teamCard(page, 'My Team')).toBeVisible();
    });
  });

  test.describe("Teams — 'Select Teams & People' Global Search", () => {
    test("7.1 Typing a query filters live and groups matching teams under a 'Teams' heading; selecting a result navigates directly to that team's detail page @real-email", async ({ page }) => {
      // 1. (Setup) By this point in the file, only the default 'My Team'
      // remains - Suite 4 deletes the team it created, so this test
      // cannot reuse that leftover state. Create one throwaway second
      // team first (e.g. '+ Create Team' -> 'QA Search Test Team') so 2
      // teams genuinely exist at once.
      await page.goto(`${BASE_URL}/teams/list`);
      await expect(page.getByRole('heading', { name: 'Teams (1)', exact: true })).toBeVisible();
      await page.getByRole('button', { name: '+ Create Team' }).click();
      const nameField = page.getByRole('textbox', { name: 'Name' });
      await nameField.click();
      await nameField.pressSequentially('QA Search Test Team');
      await page.getByRole('button', { name: 'Create' }).click();
      await expect(page.getByText('Your team was created successfully!', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Continue' }).click();

      // 'Teams (2)' on the Teams sub-tab, confirming both teams exist
      // simultaneously.
      await expect(page.getByRole('heading', { name: 'Create Team' })).not.toBeVisible();
      await expect(page.getByRole('heading', { name: 'Teams (2)', exact: true })).toBeVisible();

      // 2. Type a partial match common to both team names (e.g. 'Team')
      // into the 'Select Teams & People' search box.
      const searchBox = page.getByRole('combobox', { name: 'Select Teams & People' });
      await searchBox.click();
      await searchBox.pressSequentially('Team');

      // Live-verified (read-only, against the seed account's own single
      // 'My Team' - nothing was created or deleted there while confirming
      // this structure): a dropdown opens showing matching results inside
      // a listbox, grouped by category under a plain paragraph of text
      // reading the category name (not a real ARIA heading role - the
      // accessibility tree reports it as "paragraph", so this is matched
      // by text rather than getByRole('heading', ...)). For a team-name
      // query, that grouping paragraph reads exactly 'Teams', filtering
      // live as typed with no separate submit action needed. With this
      // test's own 2 real teams now existing, BOTH should appear as
      // selectable options under it.
      const dropdown = page.getByRole('listbox', { name: 'Select Teams & People' });
      await expect(dropdown.getByText('Teams', { exact: true })).toBeVisible();
      const myTeamOption = dropdown.getByRole('option', { name: 'My Team', exact: true });
      const searchTeamOption = dropdown.getByRole('option', { name: 'QA Search Test Team', exact: true });
      await expect(myTeamOption).toBeVisible();
      await expect(searchTeamOption).toBeVisible();

      // 3. Click one of the team options in the dropdown.
      await searchTeamOption.click();

      // The browser navigates directly to that specific team's detail
      // page (/teams/list?team=<that team's id>&cardDetails=true) - the
      // same deep-linkable URL shape already confirmed in test 1.2 (and
      // re-confirmed live, read-only, against the seed account's own 'My
      // Team' while authoring this suite).
      await expect(page).toHaveURL(/\/teams\/list\?team=[a-f0-9]+&cardDetails=true$/);
      await expect(page.getByRole('heading', { name: 'QA Search Test Team', level: 4 })).toBeVisible();

      // 4. (Cleanup) Delete 'QA Search Test Team' via its own 'Remove
      // Team' button so it doesn't linger as leftover clutter.
      await openRemoveTeamDialog(page);
      await confirmRemoveTeam(page);

      // The team is removed and 'Teams (N)' decrements back down to just
      // 'My Team'.
      await page.goto(`${BASE_URL}/teams/list`);
      await expect(page.getByRole('heading', { name: 'Teams (1)', exact: true })).toBeVisible();
    });

    test("7.2 The search box's 'People' grouping shows a real active company member, distinct from 'Teams' @real-email", async ({ page }) => {
      // 1. Suite 6's test 6.7 above already left one real, company-wide
      // 'Active' member in this file's disposable company - 'QA
      // Automation' (completeProfile()'s fixed first/last name, the SAME
      // display name as this file's own inviter/owner account, per test
      // 6.7's own comment above). Search for that name in 'Select Teams &
      // People'.
      //
      // Unlike test 7.1 above, this specific grouping could NOT be
      // independently re-verified read-only against the seed account
      // while authoring this suite: the seed account (pfautomation)
      // genuinely has zero real Active members at the time of writing
      // (confirmed live: /teams/members there reads 'Member (0)'), so
      // there was no real person to search for there. This assertion is
      // this file's first real check of the 'People' grouping, made by
      // analogy to test 7.1's already-confirmed 'Teams' grouping (same
      // combobox/listbox component, same plain-paragraph-group-heading-
      // then-option shape). If a real run of this file finds different
      // actual text/structure here, correct this assertion to match what
      // is actually observed rather than leaving it as originally
      // written.
      await page.goto(`${BASE_URL}/teams/list`);
      const searchBox = page.getByRole('combobox', { name: 'Select Teams & People' });
      await searchBox.click();
      await searchBox.pressSequentially('QA Automation');

      const dropdown = page.getByRole('listbox', { name: 'Select Teams & People' });
      await expect(dropdown.getByText('People', { exact: true })).toBeVisible();
      await expect(dropdown.getByRole('option', { name: 'QA Automation', exact: true })).toBeVisible();

      // The 'Teams' grouping is NOT also shown here, since 'My Team'
      // doesn't match the 'QA Automation' query text - confirming
      // 'People' is a genuinely separate grouping from 'Teams', not a
      // rename or merge of it.
      await expect(dropdown.getByText('Teams', { exact: true })).not.toBeVisible();
    });
  });

  test.describe('Teams — Accessibility Notes', () => {
    test('8.1 Two icon-only action buttons in this area have no accessible name @real-email', async ({ page }) => {
      // 1. Inspect the DOM of the unlabeled edit-icon button beside a
      // team's name heading (opens 'Update Team Name'), and separately
      // the unlabeled cancel-icon button in each 'Sent Invitations' row's
      // Actions column (opens 'Cancel Invitation').
      await page.goto(`${BASE_URL}/teams/list`);
      await teamCard(page, 'My Team').click();
      const editIcon = updateTeamNameEditIcon(page);
      await expect(editIcon).toBeVisible();

      // Live-verified via direct DOM inspection (both against this file's
      // own disposable company here, and separately re-confirmed
      // read-only against the seed account's 'My Team' while authoring
      // this suite): the edit icon carries neither an aria-label nor a
      // title attribute of any kind.
      await expect(editIcon).not.toHaveAttribute('aria-label');
      await expect(editIcon).not.toHaveAttribute('title');

      // The cancel-invitation icon needs a real pending invitation to
      // inspect - Suite 6 above leaves none behind (it cancels every
      // invitation it creates), so create one disposable invitation here
      // and cancel it again at the end, leaving this file's disposable
      // company back at zero pending invitations for any later test.
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

      // Neither button carries an aria-label or title attribute of any
      // kind - a screen-reader user would hear no meaningful name for
      // either control, unlike this same page's OTHER icon-adjacent
      // controls (e.g. the pagination buttons, which DO carry a proper
      // aria-label/title such as 'Go to previous page' - live-verified
      // via direct DOM inspection: both attributes read exactly 'Go to
      // previous page' there).
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
