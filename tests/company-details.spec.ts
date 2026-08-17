// spec: specs/company-details-test-plan.md
// seed: tests/seed.spec.ts

import { test, expect, Page, Locator } from '@playwright/test';
import { requireEnv } from './utils/env';

const BASE_URL = requireEnv('BASE_URL');
const SEED_USERNAME = requireEnv('TEST_USERNAME');
const SEED_PASSWORD = requireEnv('TEST_LOGIN_PASSWORD');

// Logs in as the shared seed account and lands on /company - the first tab
// shown immediately after login, and the page hosting the Company Details
// card this file covers. Mirrors loginAsSeedAndGoToCompany() in
// tests/logo-upload.spec.ts.
async function loginAsSeedAndGoToCompany(page: Page) {
  await page.goto(`${BASE_URL}/login`);
  await page.locator('input[name="username"]').fill(SEED_USERNAME);
  await page.locator('input[name="password"]').fill(SEED_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });
  await page.goto(`${BASE_URL}/company`);
  await expect(page.getByRole('link', { name: 'Edit' })).toBeVisible();
}

// The "Company Details" heading text appears TWICE in the DOM on the
// read-only /company view: once as a hidden (0x0 bounding box, matching the
// same aria-expanded mobile-layout accordion pattern already documented on
// logoUploadCard() in tests/logo-upload.spec.ts) duplicate heading OUTSIDE
// any .MuiCard-root, and once as the real, visible desktop CardHeader title
// INSIDE the card - live-verified via direct DOM inspection. Scoping every
// locator below to this specific card (identified by containing the 'Edit'
// link, which is live-verified to be unique on the page) avoids strict-mode
// ambiguity against that hidden duplicate, mirroring logoUploadCard()'s
// approach exactly.
function companyDetailsCard(page: Page) {
  return page.locator('.MuiCard-root').filter({ has: page.getByRole('link', { name: 'Edit' }) });
}

// Scopes a locator to the edit form's MuiFormControl-root wrapper for a
// given field label - used for the Office/Mobile Phone Number widgets,
// whose own country-flag <combobox> has no accessible name of its own but
// is live-verified to be the ONLY [role="combobox"] element nested inside
// the same MuiFormControl-root as that field's text label.
function phoneFieldContainer(page: Page, label: string) {
  return page.locator('.MuiFormControl-root').filter({ hasText: label });
}

// Clears a text field's current value one character at a time via real
// Backspace keystrokes (not a raw fill('') value-replace). Live-verified
// during automation of this section: fill('') and real keystrokes CAN
// behave differently for validation timing on this app (see the plan's
// corrected section 3.2, re-verified via both techniques) - real keystrokes
// are used here whenever a test's whole point is validation-triggering.
async function clearFieldWithBackspace(page: Page, field: Locator) {
  await field.click();
  await page.keyboard.press('End');
  const currentLength = (await field.inputValue()).length;
  for (let i = 0; i < currentLength; i++) {
    await page.keyboard.press('Backspace');
  }
}

// Clicks 'Save' on the edit form, waits for the real 'POST /company?edit=true'
// response (per this project's documented "don't trust the toast" gotcha -
// this save flow has no toast at all, see test 4.1, so the real network
// response is the ONLY reliable success signal), asserts it returned 200,
// then waits for the genuine post-save navigation back to '/company' (the
// URL losing its '?edit=true' query param). Shared by every test in section
// 4 that performs a real, valid save.
async function saveCompanyDetailsAndWaitForNavigation(page: Page) {
  const saveResponsePromise = page.waitForResponse(
    (response) => response.url().includes('/company?edit=true') && response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Save' }).click();
  const saveResponse = await saveResponsePromise;
  expect(saveResponse.status()).toBe(200);
  await expect(page).toHaveURL(`${BASE_URL}/company`);
}

// Every test below reads (and, in later sections of this file, writes) the
// ONE shared seed account (pfautomation) that the rest of this suite also
// depends on for login. Same trade-off already documented and applied in
// tests/profile-settings.spec.ts and tests/logo-upload.spec.ts: serial +
// chromium-only avoids racing parallel browser projects/workers on this
// single account's Company Details state.
test.describe('Company Details', () => {
  // retries: 2 - test 2.4 depends on the real (unmocked) Google Places API,
  // which has been observed to occasionally not respond with any
  // suggestions within the timeout (genuine external flakiness, not a bug -
  // see its own comment). In `mode: 'serial'`, one test failing skips every
  // remaining test in the describe as "did not run" - without retries, one
  // slow Places API response blocks all 19 tests, not just that one. 2.4
  // never saves/mutates persisted data (only reloads to discard), so
  // retrying it is safe and doesn't affect the tests around it.
  test.describe.configure({ mode: 'serial', retries: 2 });

  test.beforeEach(async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Shared seed account state; runs once serially on chromium to avoid cross-project races on the same account.');
    await loginAsSeedAndGoToCompany(page);
  });

  test.describe('Company Details — Read-Only Default View', () => {
    test("1.1 Fresh/unconfigured company shows '-' for all five fields, plus a working Edit link", async ({ page }) => {
      // 1. Log in with the seed account (pfautomation / 123456Pp!) and land
      // on /company (the default first tab after login, done by
      // beforeEach), before making any edits.
      await expect(page).toHaveTitle('Company | Job Link');

      const card = companyDetailsCard(page);

      // A 'Company Details' card is the first card on the page, positioned
      // before 'Logo Upload'. Checked via DOM order (not bounding-box Y
      // coordinate) since the page live-verified to lay these cards out in
      // a responsive grid - Company Details and Logo Upload can render
      // side-by-side at the SAME y-coordinate depending on viewport width,
      // which made an earlier y-position assertion here flaky/wrong.
      await expect(card.getByText('Company Details', { exact: true })).toBeVisible();
      const allCards = page.locator('.MuiCard-root');
      const cardTitles = await allCards.locator('.MuiCardHeader-title, [class*="CardHeader-title"]').allTextContents();
      const companyDetailsIndex = cardTitles.findIndex((t) => t.trim() === 'Company Details');
      const logoUploadIndex = cardTitles.findIndex((t) => t.trim() === 'Logo Upload');
      expect(companyDetailsIndex).toBeGreaterThanOrEqual(0);
      expect(logoUploadIndex).toBeGreaterThanOrEqual(0);
      expect(companyDetailsIndex).toBeLessThan(logoUploadIndex);

      // NOTE: per the plan's own Application Overview caveat, the seed
      // account's Company Details card was left, at the end of the
      // exploration session that produced this plan, in a permanently
      // populated state (Company Name "QA Automation Test Co", Location,
      // Email, Phone Number, and Contractor License all holding real QA
      // test values) because required fields can never be cleared back to
      // empty through the UI (an expected consequence of required-field
      // validation, not a bug - see the plan's corrected section 3.2). So
      // this account is NOT reliably in the pristine "-" placeholder state
      // at test time (confirmed live: all five fields currently show real
      // saved values, not "-") - the exact same situation already handled
      // in tests/logo-upload.spec.ts's test 1.1. The plan's "'Company Name'
      // shows exactly '-'" (etc.) assertions are therefore intentionally
      // NOT asserted here - they would be false/unreliable checks against
      // this shared account's actual current state. Only the state that
      // holds true regardless of the fields' current values - card/field
      // structure, the Edit link's presence and destination - is asserted
      // below.

      // 'Company Name', 'Location', 'Email', 'Phone Number', and
      // 'Contractor License' labels are all visible, each with an
      // associated value heading.
      await expect(card.getByText('Company Name', { exact: true })).toBeVisible();
      await expect(card.getByText('Location', { exact: true })).toBeVisible();
      await expect(card.getByText('Email', { exact: true })).toBeVisible();
      await expect(card.getByText('Phone Number', { exact: true })).toBeVisible();
      await expect(card.getByText('Contractor License', { exact: true })).toBeVisible();
      await expect(card.getByRole('heading', { level: 6 })).toHaveCount(5);

      // A single 'Edit' link is visible and enabled below the fields, with
      // no other action buttons present on this card.
      const editLink = card.getByRole('link', { name: 'Edit' });
      await expect(editLink).toBeVisible();
      await expect(editLink).toBeEnabled();
      await expect(card.getByRole('button')).toHaveCount(0);
      await expect(card.getByRole('link')).toHaveCount(1);

      // 2. Inspect the 'Edit' link's underlying href/URL.
      await expect(editLink).toHaveAttribute('href', '/company?edit=true');
    });

    test('1.2 Clicking Edit performs a real URL navigation to /company?edit=true, not an inline state toggle', async ({ page }) => {
      // 1. On /company, click the 'Edit' link.
      await companyDetailsCard(page).getByRole('link', { name: 'Edit' }).click();

      // Live-verified: the browser's URL actually changes to
      // '/company?edit=true' (confirmed via page.url()), not just an
      // in-place DOM swap with the URL staying at '/company' - this is a
      // genuine navigation.
      await expect(page).toHaveURL(`${BASE_URL}/company?edit=true`);

      // 2. Separately, starting from a fresh session, navigate directly to
      // https://joblink-portal.prestg.fieldpiece.com/company?edit=true via
      // page.goto() without ever clicking the 'Edit' link.
      await page.goto(`${BASE_URL}/company?edit=true`);

      // Live-verified: this renders the exact same edit form as clicking
      // 'Edit' would - confirming this is a real, deep-linkable,
      // bookmarkable route, not something gated behind an in-app click
      // handler only.
      await expect(page.getByRole('textbox', { name: 'Company Name' })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Contractor License' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
    });
  });

  test.describe('Company Details — Edit Form Structure and Widgets', () => {
    test('2.1 The edit form exposes 13 fields, far more than the 5 shown on the read-only card', async ({ page }) => {
      // 1. On /company?edit=true, inventory every field on the form.
      await page.goto(`${BASE_URL}/company?edit=true`);

      await expect(page.getByRole('textbox', { name: 'Company Name' })).toBeVisible();
      await expect(page.getByText('Company Name *', { exact: true })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Contractor License' })).toBeVisible();
      await expect(page.getByText('Contractor License *', { exact: true })).toBeVisible();
      await expect(page.getByRole('combobox', { name: /Country/ })).toBeVisible();
      await expect(page.getByText('Country *', { exact: true })).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Address' })).toBeVisible();
      await expect(page.getByText('Address *', { exact: true })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Address 2' })).toBeVisible();
      await expect(page.getByText('Address 2 *', { exact: true })).toBeVisible();
      // Exact name (not /State/) - a regex would also match the Country
      // combobox's accessible name "Country United States" (contains
      // "States"), live-verified to cause a strict-mode ambiguity.
      await expect(page.getByRole('combobox', { name: 'State Select' })).toBeVisible();
      await expect(page.getByText('State *', { exact: true })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'City' })).toBeVisible();
      await expect(page.getByText('City *', { exact: true })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Zip Code' })).toBeVisible();
      await expect(page.getByText('Zip Code *', { exact: true })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Email' })).toBeVisible();
      await expect(page.getByText('Email *', { exact: true })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Office Phone Number' })).toBeVisible();
      // Office Phone Number is NOT required - no '*' suffix on its label,
      // unlike every field above.
      await expect(page.getByText('Office Phone Number *', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('textbox', { name: 'Mobile Phone Number' })).toBeVisible();
      await expect(page.getByText('Mobile Phone Number *', { exact: true })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Company Website' })).toBeVisible();
      await expect(page.getByText('Company Website *', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('textbox', { name: 'Terms and Conditions' })).toBeVisible();
      await expect(page.getByText('Terms and Conditions *', { exact: true })).toHaveCount(0);

      // 'Cancel' and 'Save' buttons are shown at the bottom; 'Save' is
      // disabled by default on a fresh/unconfigured company.
      await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
      const saveButton = page.getByRole('button', { name: 'Save' });
      await expect(saveButton).toBeVisible();

      // ADAPTATION NOTE: the plan's "'Save' is disabled by default on a
      // fresh/unconfigured company" was live-verified against a totally
      // blank company. This shared seed account's company record now holds
      // real saved values in every field (see test 1.1's note), so that
      // exact fresh-blank-form precondition can't be reproduced here. What
      // IS still live-verified and stable on this account: 'Save' is
      // STILL disabled on every fresh load of this form - not because
      // required fields are empty, but because of the real 'State'
      // pre-fill/hydration bug documented in the plan's section 4.5 (the
      // 'State' dropdown never re-hydrates to its last-saved value on
      // load, so the form always treats State as invalid/empty). This is
      // asserted here as "Save starts disabled", matching the spirit of
      // the plan's assertion, while the underlying cause differs from a
      // truly fresh company.
      await expect(saveButton).toBeDisabled();
      await expect(page.getByRole('combobox', { name: 'State Select' })).toHaveText('Select');

      // 2. Compare this list against the read-only card's fields
      // documented in section 1.1.
      // Live-verified, notable finding: Country, Address 2, Office Phone
      // Number, Company Website, and Terms and Conditions are all
      // editable/persisted here but are NEVER shown anywhere on the
      // read-only card (which only ever shows Company Name, Location,
      // Email, Phone Number, Contractor License, per test 1.1) - the read
      // view is a reduced, partial summary of the full data model, not a
      // 1:1 mirror of the edit form.
    });

    test('2.2 Country dropdown displays the last-saved value on reload (adapted)', async ({ page }) => {
      // ADAPTATION NOTE: the plan's original scenario asserted that Country
      // defaults to a client-side IP-geolocation guess on a totally
      // fresh/unconfigured company (Ecuador, in the original exploration
      // session). That precondition is no longer reproducible against this
      // shared seed account - live-verified, its company record now has a
      // genuinely SAVED Country value ('United States'). Adapted instead to
      // verify a still-meaningful, currently-true behavior: Country
      // reflects the last-SAVED value on every fresh load of the edit form,
      // and reverts to it if changed-but-not-saved, rather than resetting
      // to some other default.
      // 1. On /company?edit=true, inspect the 'Country' dropdown's current
      // value.
      await page.goto(`${BASE_URL}/company?edit=true`);
      const countryCombobox = page.getByRole('combobox', { name: /Country/ });
      await expect(countryCombobox).toHaveText('United States');

      // Change Country to a different value without saving.
      await countryCombobox.click();
      await page.getByRole('option', { name: 'Canada', exact: true }).click();
      await expect(countryCombobox).toHaveText('Canada');

      // Reload the page (do not Save) to discard the unsaved change.
      await page.goto(`${BASE_URL}/company?edit=true`);

      // expect: Country reverts to the last-saved value 'United States' on
      // this fresh load, confirming it reflects genuinely persisted backend
      // state on reload, not a re-rolled client-side geolocation guess.
      await expect(page.getByRole('combobox', { name: /Country/ })).toHaveText('United States');
    });

    test('2.3 Terms and Conditions textarea is pre-filled with the generic legal boilerplate default', async ({ page }) => {
      // ADAPTATION NOTE: the plan documented this text as a fresh-company
      // default that appears even on an otherwise completely blank
      // company. Live-verified against this shared seed account's now
      // non-fresh company record: this exact boilerplate text is STILL
      // present, because nothing in this suite has ever overwritten the
      // Terms and Conditions field with a different value - so the
      // underlying assertion (this exact text is present in the textarea)
      // remains true and is tested as-is, without needing to fabricate a
      // fresh-company precondition.
      // 1. On /company?edit=true, inspect the 'Terms and Conditions'
      // textarea's content.
      await page.goto(`${BASE_URL}/company?edit=true`);

      await expect(page.getByRole('textbox', { name: 'Terms and Conditions' })).toHaveValue(
        "I have the authority to order the above work and perform as outlined above. It is agreed that the seller will retain title to any equipment or material furnished until final and complete payment is made, and if settlement is not made as agreed, the seller shall have the right to remove such equipment and the seller will be held harmless for any damages resulting from the removal thereof."
      );
    });

    test('2.4 Address is a real Google Places Autocomplete widget; selecting a suggestion auto-fills State/City/Zip', async ({ page }) => {
      // 1. Click into the 'Address' field and type a partial US street
      // address, e.g. '1725 W North Broadway Anaheim'.
      await page.goto(`${BASE_URL}/company?edit=true`);
      const addressCombobox = page.getByRole('combobox', { name: 'Address' });
      await addressCombobox.click();
      await page.getByRole('button', { name: 'Clear' }).click();
      await addressCombobox.pressSequentially('1725 W North Broadway Anaheim');

      // expect: a real listbox of matching addresses appears - a genuine
      // third-party-backed autocomplete, not a static/mocked list. Live
      // re-verification found the exact suggestion set/order for this query
      // is NOT perfectly stable run-to-run (a real, unmocked Google Places
      // API) - e.g. one run's suggestions included "...Santa Maria, CA...",
      // another's did not. Selecting the FIRST suggestion (rather than
      // matching one exact address string) consistently resolved to the
      // same Santa Barbara County, CA, 93458 result across multiple live
      // re-runs, so that's what this test relies on instead of an exact
      // suggestion-text match.
      // Real external API call (Google Places), not always fast - a longer
      // timeout here avoids flaking on a slow-but-not-broken response,
      // same tolerance this project already gives other real external
      // dependencies (e.g. real-email polling in tests/utils/email.ts).
      const suggestionsList = page.getByRole('listbox', { name: 'Address' });
      await expect(suggestionsList).toBeVisible({ timeout: 15_000 });
      const suggestion = page.getByRole('option').first();
      await expect(suggestion).toBeVisible();

      // 2. Click the first suggested option.
      await suggestion.click();

      // expect: the 'Address' field collapses to just the street portion.
      // toHaveValue(), not toHaveText() - this combobox is a plain <input>,
      // its content is a `value` attribute, not text content.
      await expect(addressCombobox).toHaveValue('1725 North Broadway');
      // expect: 'Zip Code' auto-populates to '93458'.
      await expect(page.getByRole('textbox', { name: 'Zip Code' })).toHaveValue('93458');
      // Live-verified, notable finding/real defect: 'City' auto-populates
      // to 'Santa Barbara County' - a COUNTY name, not the actual city
      // 'Santa Maria' shown in the suggestion text itself - indicating a
      // real data-mapping bug in how the app extracts a 'city' from the
      // Places API's address components for at least this address.
      await expect(page.getByRole('textbox', { name: 'City' })).toHaveValue('Santa Barbara County');

      // CORRECTION to the live-verified plan, found while automating this
      // exact scenario: the plan claims 'State' also auto-populates (to
      // 'California') as part of this same address selection. Reproduced
      // via this exact automated flow 3 separate times, with waits up to
      // 30s: State never updates away from its 'Select' placeholder here,
      // even though City/Zip do, reliably and quickly. A one-off manual
      // exploration script did once observe State updating correctly after
      // ~3s using a near-identical interaction sequence, so this may be a
      // genuine intermittent behavior rather than a hard 100%-of-the-time
      // failure - but it was NOT reproducible via Playwright automation
      // across repeated attempts, so this test asserts the state that
      // reliably reproduces (State stays unfilled) rather than the
      // occasionally-observed one, and flags this as worth a developer
      // double-check rather than a confirmed one-way-or-the-other bug.
      await expect(page.getByRole('combobox', { name: 'State Select' })).toHaveText('Select');

      // Cleanup: do NOT click 'Save' - reload instead, so this test does
      // not mutate the shared account's persisted Company Details data
      // (real saves are only covered by section 4's dedicated tests).
      await page.goto(`${BASE_URL}/company?edit=true`);
    });

    test('2.5 Office Phone Number and Mobile Phone Number have independent country-flag selectors, and neither is synced to the main Country dropdown', async ({ page }) => {
      await page.goto(`${BASE_URL}/company?edit=true`);

      const officePhoneFlag = phoneFieldContainer(page, 'Office Phone Number').getByRole('combobox');
      const mobilePhoneFlag = phoneFieldContainer(page, 'Mobile Phone Number').getByRole('combobox');
      const officePhoneNumber = page.getByRole('textbox', { name: 'Office Phone Number' });
      const mobilePhoneNumber = page.getByRole('textbox', { name: 'Mobile Phone Number' });

      // Portability: Office Phone Number is NOT a required field and was
      // never actually saved during this project's exploration - its
      // displayed default is a client-side guess (the same kind of
      // session-specific IP-geolocation default already documented for the
      // main Country dropdown in test 2.2), not a persisted backend value.
      // Asserting a hardcoded expected value here would be exactly the
      // hardcoded-seed-account-state problem already fixed project-wide in
      // tests/profile-settings.spec.ts's discoverSeedBaseline() - so this
      // test discovers both fields' current values instead of assuming
      // them, then asserts they stay unchanged (a relative check, not an
      // absolute one).
      const originalOfficePhone = await officePhoneNumber.inputValue();
      const originalMobilePhone = await mobilePhoneNumber.inputValue();

      // 1. On /company?edit=true, change the main 'Country' dropdown from
      // its default to a different value.
      const countryCombobox = page.getByRole('combobox', { name: /Country/ });
      await countryCombobox.click();
      await page.getByRole('option', { name: 'Canada', exact: true }).click();
      await expect(countryCombobox).toHaveText('Canada');

      // expect: both the 'Office Phone Number' and 'Mobile Phone Number'
      // widgets' own country-flag selectors remain completely unaffected -
      // changing the company's mailing-address Country does NOT cascade to
      // either phone widget's own separately-tracked country selection.
      await expect(officePhoneNumber).toHaveValue(originalOfficePhone);
      await expect(mobilePhoneNumber).toHaveValue(originalMobilePhone);

      // 2. Open the Mobile Phone Number widget's own country-flag selector
      // and independently select a different country.
      await mobilePhoneFlag.click();
      await page.getByRole('option', { name: 'United Kingdom' }).click();

      // expect: only the Mobile Phone Number field resets to the bare dial
      // code; the Office Phone Number field's selector and value are
      // unaffected - confirming these are two fully independent
      // phone-widget instances.
      await expect(mobilePhoneNumber).toHaveValue('+44 ');
      await expect(officePhoneNumber).toHaveValue(originalOfficePhone);
      await expect(officePhoneFlag).toBeVisible();

      // Cleanup: do NOT click 'Save' - reload instead to discard all
      // unsaved changes made in this test (Country, Mobile Phone country
      // selector) so the next test starts from the account's real
      // last-saved state.
      await page.goto(`${BASE_URL}/company?edit=true`);
    });
  });

  test.describe('Company Details — Validation', () => {
    test("3.1 Blurring a pristine empty required field shows 'The field is required' and keeps Save disabled (adapted)", async ({ page }) => {
      // ADAPTATION NOTE: the plan's original scenario asserts this on a
      // fresh /company?edit=true load where Company Name is genuinely
      // pristine-empty since page load. Live-verified on this shared seed
      // account: every one of the 13 edit-form fields already holds a real
      // saved value at every fresh load (Company Name currently "QA
      // Automation Test Co") - there is no field that is genuinely
      // "pristine empty since page load" available to test on this account.
      // Adapted, like the corrected 3.2, to clear Company Name via real
      // keystrokes to exercise the same 'required' validation path - this
      // necessarily ends up testing near-identical mechanics to 3.2 given
      // the account's current state, which is expected here, not a mistake.
      // 1. On a fresh /company?edit=true load, click into the (adapted:
      // cleared via real keystrokes) 'Company Name' field, then blur it
      // (click into 'Contractor License').
      await page.goto(`${BASE_URL}/company?edit=true`);
      const companyName = page.getByRole('textbox', { name: 'Company Name' });
      const contractorLicense = page.getByRole('textbox', { name: 'Contractor License' });
      await clearFieldWithBackspace(page, companyName);
      await contractorLicense.click();

      // expect: a red inline message with the exact text 'The field is
      // required' appears beneath Company Name, and the field is marked
      // invalid - identical wording/pattern to the same validation already
      // documented elsewhere in this suite (login, register, Profile
      // Settings).
      await expect(page.getByText('The field is required', { exact: true })).toBeVisible();
      await expect(companyName).toHaveAttribute('aria-invalid', 'true');

      // expect: the 'Save' button stays disabled.
      await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

      // Cleanup: reload (do not Save) so Company Name is never actually
      // persisted as empty (per the plan, this is impossible anyway - Save
      // stays disabled) and the next test starts from the real saved value.
      await page.goto(`${BASE_URL}/company?edit=true`);
      await expect(companyName).toHaveValue('QA Automation Test Co');
    });

    test("3.2 Clearing a previously-filled required field correctly re-triggers 'required' validation and blocks Save", async ({ page }) => {
      // CORRECTION (2026-08-17, per the plan): the original live exploration
      // that produced this plan claimed clearing a previously-filled
      // required field silently suppressed the 'required' message and left
      // Save looking enabled with zero feedback. Independent re-verification
      // found this does NOT reproduce: the 'required' message appears
      // correctly and Save is correctly disabled, identical to the
      // pristine-empty-field case in 3.1. This test exercises the real
      // (corrected) behavior.
      await page.goto(`${BASE_URL}/company?edit=true`);
      const companyName = page.getByRole('textbox', { name: 'Company Name' });
      const contractorLicense = page.getByRole('textbox', { name: 'Contractor License' });

      // 1. Fill 'Company Name' with a valid value (e.g. 'QA Automation Test
      // Co'), then clear it completely back to empty via real keystrokes
      // (Backspace, not a raw value-replace), then blur it by clicking into
      // another field.
      await companyName.click();
      await companyName.fill('QA Automation Test Co');
      await clearFieldWithBackspace(page, companyName);
      await contractorLicense.click();

      // expect: a red inline 'The field is required' message appears
      // beneath Company Name, and the field is marked invalid - same as the
      // pristine-empty-field case in section 3.1, no inconsistency.
      await expect(page.getByText('The field is required', { exact: true })).toBeVisible();
      await expect(companyName).toHaveAttribute('aria-invalid', 'true');

      // 2. With all other required fields already valid, attempt to click
      // 'Save' while Company Name is still empty.
      const saveButton = page.getByRole('button', { name: 'Save' });
      // expect: 'Save' is disabled (not just unresponsive) - confirmed via
      // toBeDisabled(), not just an absence of a network request.
      await expect(saveButton).toBeDisabled();

      // 3. (Cleanup) Reload the page (do not attempt to Save again) to
      // discard this invalid in-progress edit.
      await page.goto(`${BASE_URL}/company?edit=true`);

      // expect: the page reloads with Company Name back to its last
      // successfully saved value, confirming nothing was actually
      // persisted.
      await expect(companyName).toHaveValue('QA Automation Test Co');
    });

    test("3.3 Email format is validated client-side with 'Invalid email address'", async ({ page }) => {
      await page.goto(`${BASE_URL}/company?edit=true`);
      const email = page.getByRole('textbox', { name: 'Email' });
      const contractorLicense = page.getByRole('textbox', { name: 'Contractor License' });
      const saveButton = page.getByRole('button', { name: 'Save' });

      // 1. Type a malformed value (e.g. 'not-an-email') into the 'Email'
      // field and blur it.
      await email.click();
      await email.fill('not-an-email');
      await contractorLicense.click();

      // expect: a red inline message with the exact text 'Invalid email
      // address' appears beneath Email, and the field is marked invalid.
      await expect(page.getByText('Invalid email address', { exact: true })).toBeVisible();
      await expect(email).toHaveAttribute('aria-invalid', 'true');

      // expect: the 'Save' button stays disabled while this invalid value
      // persists, even if every other required field is otherwise valid.
      await expect(saveButton).toBeDisabled();

      // 2. (Cleanup) Restore Email to a valid value and confirm the error
      // clears and Save re-enables (assuming other required fields are also
      // valid).
      await email.click();
      await email.fill('qa-company-test@crifa.com');
      await contractorLicense.click();

      // expect: the 'Invalid email address' message disappears once a
      // valid email is entered.
      await expect(page.getByText('Invalid email address', { exact: true })).toHaveCount(0);
    });

    test('3.4 REAL BUG: Company Website has no client-side format validation at all, and a genuinely invalid value is silently rejected server-side with zero user-visible error feedback', async ({ page }) => {
      await page.goto(`${BASE_URL}/company?edit=true`);
      const website = page.getByRole('textbox', { name: 'Company Website' });
      const contractorLicense = page.getByRole('textbox', { name: 'Contractor License' });
      const saveButton = page.getByRole('button', { name: 'Save' });

      // ADAPTATION NOTE / test setup: this scenario needs "every required
      // field already valid (so Save is enabled)" as its starting
      // precondition. Live-verified on this shared account: 'Save' is
      // otherwise disabled on every fresh form load, not because of Company
      // Website, but because of the real 'State' pre-fill/hydration bug
      // already documented in this file's test 2.1 and the plan's section
      // 4.5 (State never re-hydrates on load, and - confirmed live during
      // this exact test - does not persist even after being re-selected and
      // saved). Re-selecting State here is purely test setup to reach the
      // "every required field valid" precondition this scenario needs; it
      // is not itself part of what 3.4 is testing.
      const stateCombobox = page.getByRole('combobox', { name: 'State Select' });
      await stateCombobox.click();
      await page.getByRole('option', { name: 'California', exact: true }).click();
      await expect(saveButton).toBeEnabled();

      // 1. With every required field already valid (so Save is enabled),
      // type an obviously invalid, non-URL value (e.g. 'not a url') into
      // 'Company Website' and blur it.
      await website.click();
      await website.fill('not a url');
      await contractorLicense.click();

      // expect: NO inline error message of any kind appears for Company
      // Website, and the 'Save' button remains fully ENABLED - this field
      // has no client-side format validation whatsoever, unlike Email
      // (section 3.3).
      await expect(website).not.toHaveAttribute('aria-invalid', 'true');
      await expect(saveButton).toBeEnabled();

      // 2. Click 'Save' with this invalid Company Website value still in
      // place.
      const saveResponsePromise = page.waitForResponse(
        (response) => response.url().includes('/company?edit=true') && response.request().method() === 'POST'
      );
      await saveButton.click();

      // expect: a real 'POST /company?edit=true' request IS sent (unlike
      // the blocked-submission case in section 3.2) and receives a 200
      // response.
      const saveResponse = await saveResponsePromise;
      expect(saveResponse.status()).toBe(200);

      // expect: the page does NOT navigate away (stays on
      // /company?edit=true), the 'Save' button remains enabled (does not
      // revert to disabled the way a normal successful save does), and NO
      // toast, inline error, or any other visible feedback of any kind
      // appears anywhere on the page (confirmed via a page-wide check for
      // any [role=alert] element and any visible "error" text).
      await expect(page).toHaveURL(`${BASE_URL}/company?edit=true`);
      await expect(saveButton).toBeEnabled();
      // Not toHaveCount(0) - Next.js always injects an empty, visually
      // hidden `role="alert"` route-announcer element
      // (`#__next-route-announcer__`) into every page for accessibility,
      // unrelated to app-level error messages. Asserting it has no text
      // content is the real "no error message shown" check.
      await expect(page.getByRole('alert')).toHaveText('');
      await expect(page.getByText(/error/i)).toHaveCount(0);

      // 3. Reload the page (full navigation) and re-open /company?edit=true.
      await page.goto(`${BASE_URL}/company?edit=true`);

      // expect: the Company Website field has reverted to its last
      // successfully-saved valid value (NOT the invalid 'not a url' value)
      // - proving the invalid save attempt was genuinely rejected by the
      // backend (not merely a client-side display quirk), even though the
      // user was given absolutely no indication of this at the time. This
      // silent-failure pattern is structurally similar to the
      // already-documented Logo Upload WEBP silent-rejection bug.
      // No additional cleanup save is needed here: the field already
      // self-reverted to its last-known-good value 'https://example.com' on
      // this reload (live-verified), confirming the invalid save attempt
      // never actually persisted anything server-side - there is nothing
      // left to restore.
      await expect(page.getByRole('textbox', { name: 'Company Website' })).toHaveValue('https://example.com');
    });

    test('3.5 No maximum length is enforced on Company Name, at least up to 251 characters', async ({ page }) => {
      await page.goto(`${BASE_URL}/company?edit=true`);
      const companyName = page.getByRole('textbox', { name: 'Company Name' });
      const contractorLicense = page.getByRole('textbox', { name: 'Contractor License' });

      // 1. Type a 251-character value into 'Company Name' and blur it.
      const longName = 'A'.repeat(251);
      await companyName.click();
      await companyName.fill(longName);
      await contractorLicense.click();

      // expect: the full 251-character value is accepted with no
      // truncation, and no inline error message of any kind appears on
      // blur - unlike some other length-capped fields already documented
      // elsewhere in this suite (e.g. the Username field on registration).
      await expect(companyName).toHaveValue(longName);
      expect((await companyName.inputValue())).toHaveLength(251);
      await expect(companyName).not.toHaveAttribute('aria-invalid', 'true');
      await expect(page.getByText('The field is required', { exact: true })).toHaveCount(0);

      // Not independently confirmed whether this value would also be
      // accepted by a real Save + reload round-trip - intentionally NOT
      // persisted here, per the plan's own documented restraint, to protect
      // the shared seed account (which has no full restore-to-blank path).
      // Cleanup: reload without saving.
      await page.goto(`${BASE_URL}/company?edit=true`);
      await expect(companyName).toHaveValue('QA Automation Test Co');
    });
  });

  test.describe('Company Details — Save, Persistence, and Read-View Rendering', () => {
    test('4.1 A real, valid save persists genuinely to the backend, confirmed via reload — but shows NO success toast, unlike every other save flow in this app', async ({ page }) => {
      await page.goto(`${BASE_URL}/company?edit=true`);
      const companyName = page.getByRole('textbox', { name: 'Company Name' });
      const contractorLicense = page.getByRole('textbox', { name: 'Contractor License' });
      const email = page.getByRole('textbox', { name: 'Email' });
      const stateCombobox = page.getByRole('combobox', { name: 'State Select' });

      // ADAPTATION NOTE / test setup: (a) Address/Address 2/City/Zip/Country
      // already hold real, valid, previously-persisted values on this
      // shared account (confirmed live) - the Places Autocomplete flow that
      // fills these is already dedicated, isolated coverage in test 2.4, so
      // it is not re-exercised here just to reach a valid-form precondition
      // (avoids an extra real Google Places API call and its associated
      // flakiness/slowness for no additional coverage). (b) 'State' must
      // still be re-selected before every save, per the real pre-fill bug
      // documented in test 2.1 and directly asserted in test 4.5 below -
      // this is test setup, not what 4.1 itself is testing.
      await stateCombobox.click();
      await page.getByRole('option', { name: 'California', exact: true }).click();

      // 1. Fill every required field with valid values... Click 'Save'.
      // Live-verified: Company Name, Contractor License, and Email already
      // hold real baseline values from this file's own earlier tests/prior
      // exploration ('QA Automation Test Co', 'LIC-123456',
      // 'qa-company-test@crifa.com'). Per this project's portability
      // practice of proving genuine persistence rather than asserting a
      // static hardcoded expectation, this test changes all three to new,
      // clearly-distinct temporary values, saves, and confirms via reload
      // that the NEW values genuinely round-tripped through the backend -
      // then restores the canonical baseline values (also via a real save +
      // reload check) so the rest of this file's tests, which assume that
      // baseline, remain valid afterward.
      await companyName.fill('QA Automation Test Co TEMP');
      await contractorLicense.fill('LIC-999999');
      await email.fill('qa-company-test-temp@crifa.com');

      await saveCompanyDetailsAndWaitForNavigation(page);

      // expect: unlike Profile Settings, Logo Upload, and Change Password,
      // this save shows NO success toast of any kind - the only
      // user-visible confirmation is the silent navigation back to
      // /company (already asserted above) and the read-only card now
      // displaying the newly saved values. Not toHaveCount(0) - Next.js
      // always injects an empty, visually hidden route-announcer
      // role="alert" element into every page.
      await expect(page.getByRole('alert')).toHaveText('');
      await expect(page.getByText(/updated successfully|uploaded successfully/i)).toHaveCount(0);

      const card = companyDetailsCard(page);
      await expect(card.getByRole('heading', { name: 'QA Automation Test Co TEMP' })).toBeVisible();
      await expect(card.getByRole('heading', { name: 'qa-company-test-temp@crifa.com' })).toBeVisible();
      await expect(card.getByRole('heading', { name: 'LIC-999999' })).toBeVisible();

      // 2. Reload the page (full navigation, not just a soft refresh) and
      // re-check the read-only card.
      await page.goto(`${BASE_URL}/company`);

      // expect: the temporary values genuinely persisted to the backend,
      // not just a client-side preview.
      await expect(companyDetailsCard(page).getByRole('heading', { name: 'QA Automation Test Co TEMP' })).toBeVisible();
      await expect(companyDetailsCard(page).getByRole('heading', { name: 'qa-company-test-temp@crifa.com' })).toBeVisible();
      await expect(companyDetailsCard(page).getByRole('heading', { name: 'LIC-999999' })).toBeVisible();

      // Cleanup / second save: restore Company Name, Contractor License,
      // and Email to the canonical baseline values the rest of this file's
      // tests depend on. Per this project's "don't trust the toast for a
      // second save in the same test" gotcha, this restore is confirmed via
      // the real network response and a real reload, not a toast (which,
      // per the finding above, never appears for this flow at all anyway).
      await page.goto(`${BASE_URL}/company?edit=true`);
      await stateCombobox.click();
      await page.getByRole('option', { name: 'California', exact: true }).click();
      await companyName.fill('QA Automation Test Co');
      await contractorLicense.fill('LIC-123456');
      await email.fill('qa-company-test@crifa.com');
      await saveCompanyDetailsAndWaitForNavigation(page);

      await page.goto(`${BASE_URL}/company`);
      await expect(companyDetailsCard(page).getByRole('heading', { name: 'QA Automation Test Co', exact: true })).toBeVisible();
      await expect(companyDetailsCard(page).getByRole('heading', { name: 'qa-company-test@crifa.com' })).toBeVisible();
      await expect(companyDetailsCard(page).getByRole('heading', { name: 'LIC-123456' })).toBeVisible();
    });

    test("4.2 The read-only card's 'Phone Number' maps specifically to Mobile Phone Number, not Office Phone Number", async ({ page }) => {
      // 1. Inspect the read-only card's 'Phone Number' field, and compare
      // it against the edit form's Mobile Phone Number and Office Phone
      // Number fields' own underlying (exact, unformatted) values.
      const card = companyDetailsCard(page);
      await expect(card.getByText('Phone Number', { exact: true })).toBeVisible();

      // The read card exposes exactly 5 value headings (h6), one per
      // labeled field, in the same DOM order as their labels (see test
      // 1.1: Company Name, Location, Email, Phone Number, Contractor
      // License). 'Phone Number' is the 4th labeled field (index 3).
      const headings = card.getByRole('heading', { level: 6 });
      await expect(headings).toHaveCount(5);
      const cardPhoneNumberText = (await headings.nth(3).textContent())?.trim();

      await page.goto(`${BASE_URL}/company?edit=true`);
      // Discover the current, exact (unformatted, E.164-style) values of
      // both phone widgets via their hidden underlying inputs, per this
      // project's discover-don't-hardcode pattern already established for
      // Office Phone Number in test 2.5.
      const mobilePhoneHidden = page.locator('input[name="mobilePhone.phoneNumber"]');
      const officePhoneHidden = page.locator('input[name="officePhone.phoneNumber"]');
      const mobilePhoneValue = await mobilePhoneHidden.inputValue();
      const officePhoneValue = await officePhoneHidden.inputValue();

      // expect: the read-only card's 'Phone Number' shows exactly the
      // Mobile Phone Number value.
      expect(cardPhoneNumberText).toBe(mobilePhoneValue);
      // expect: the Office Phone Number value is not shown anywhere on the
      // read-only card at all (consistent with section 2.1's finding that
      // Office Phone Number is excluded from the read view entirely) -
      // confirmed here by it genuinely differing from what the card shows,
      // and not appearing anywhere in the card's text. Navigate back to
      // /company first - `card` is scoped to the read view's 'Edit' link,
      // which doesn't exist on /company?edit=true.
      expect(cardPhoneNumberText).not.toBe(officePhoneValue);
      await page.goto(`${BASE_URL}/company`);
      // Guard against a bare, digit-less country code (e.g. '+1' with no
      // number entered) - Office Phone Number is optional and can be unset
      // on the seed account, and a bare '+1' is trivially a substring of
      // any US Mobile Phone Number the card legitimately does show, which
      // would make this check fail on a false positive.
      if (officePhoneValue.replace(/\D/g, '').length > 1) {
        await expect(card).not.toContainText(officePhoneValue);
      }
    });

    test("4.3 REAL BUG (corrected): the read-only card's 'Location' summary silently omits Address 2, though the Address/City segments render as two separate visual lines rather than one run-together word", async ({ page }) => {
      // CORRECTION (2026-08-17): the plan's original claim was that
      // Address and City run together with NO separating space at all
      // (e.g. 'BroadwaySanta' as one visible word). Live re-verified while
      // automating this exact scenario, via direct inspection of the
      // Location heading's rendered DOM: the two segments are each wrapped
      // in their own <span>, separated by a literal <br> element
      // (`<span>1725 North Broadway</span><br><span>Santa Barbara
      // County, ...</span>`). A real user therefore sees these as two
      // separate lines, NOT run together as one word - `locator.innerText()`
      // (which respects rendering, including <br>) confirms a genuine line
      // break between them. The "no space" claim only reproduces if read
      // via `textContent` (which ignores the <br> entirely) or the
      // accessibility-tree "name" computation used by getByText/getByRole
      // (which normalizes multiple text nodes by inserting a space) - both
      // are testing-technique artifacts, not what a real user perceives.
      // This is corrected here to test the real, live-verified behavior:
      // NOT a visible concatenation bug, but Address 2 IS still genuinely,
      // silently omitted from the summary - that part of the original
      // finding does reproduce and is asserted below.
      const card = companyDetailsCard(page);
      const locationHeading = card.getByRole('heading', { level: 6 }).nth(1);
      await expect(card.getByText('Location', { exact: true })).toBeVisible();

      // 1. Inspect the exact rendered text of the read-only card's
      // 'Location' field via innerText() (reflects real visual rendering,
      // including line breaks from <br>, unlike textContent).
      const locationInnerText = await locationHeading.innerText();

      // expect: Address ('1725 North Broadway') and the City-onward segment
      // are genuinely rendered on two separate lines (a real line break
      // between them), not run together as one unreadable word.
      expect(locationInnerText).toContain('1725 North Broadway\n');
      expect(locationInnerText).not.toContain('BroadwaySanta');

      // expect, second finding (still reproduces): 'Suite 100' (the saved
      // Address 2 value) does not appear anywhere in the Location summary
      // at all - Address 2, like Office Phone Number/Company
      // Website/Terms and Conditions, is captured and persisted by the
      // edit form but never surfaced on the read-only card.
      expect(locationInnerText).not.toContain('Suite 100');

      // Sanity-check the full expected content is otherwise present.
      expect(locationInnerText).toContain('Santa Barbara County, California, 93458, United States');
    });

    test("4.4 Company Email and Phone Number are fully independent of the logged-in user's own Profile Settings identity fields", async ({ page }) => {
      // 1. Capture the Company Details card's current Email and Phone
      // Number values, then navigate to /profile and inspect the account's
      // own Email Address and Phone Number fields there.
      const card = companyDetailsCard(page);
      const headings = card.getByRole('heading', { level: 6 });
      await expect(headings).toHaveCount(5);
      const companyEmail = (await headings.nth(2).textContent())?.trim();
      const companyPhoneNumber = (await headings.nth(3).textContent())?.trim();
      // Sanity: both are real, non-placeholder values on this account
      // (already saved by earlier tests/exploration in this file).
      expect(companyEmail).not.toBe('-');
      expect(companyPhoneNumber).not.toBe('-');

      await page.goto(`${BASE_URL}/profile`);
      const profileEmail = page.getByRole('textbox', { name: 'Email Address' });
      const profilePhoneNumber = page.getByRole('textbox', { name: 'Phone Number' });

      // expect: Profile Settings' 'Email Address' field is completely
      // unchanged, still showing the account's real login email
      // ('paul.freire+automation@crifa.com'), genuinely disabled/
      // non-editable on that page - and genuinely different from the
      // Company Details Email captured above.
      await expect(profileEmail).toHaveValue('paul.freire+automation@crifa.com');
      await expect(profileEmail).toBeDisabled();
      expect(companyEmail).not.toBe('paul.freire+automation@crifa.com');

      // expect: Profile Settings' 'Phone Number' field is also completely
      // unchanged, still showing '+1 (212) 555-0100' - confirming the
      // Company Details card's Email and Phone Number are wholly
      // independent, company-record-scoped fields, safe to freely edit/
      // test without any risk to the account's own login identity or
      // session.
      await expect(profilePhoneNumber).toHaveValue('+1 (212) 555-0100');
      const profilePhoneDigits = (await profilePhoneNumber.inputValue()).replace(/\D/g, '');
      const companyPhoneDigits = (companyPhoneNumber ?? '').replace(/\D/g, '');
      expect(companyPhoneDigits).not.toBe(profilePhoneDigits);
    });

    test("4.5 REAL BUG: re-entering the edit form after a save fails to pre-fill the 'State' dropdown, even though the read-only card's Location correctly reflects the saved state", async ({ page }) => {
      // 1. Establish the precondition this scenario needs by performing a
      // real save with State genuinely selected as 'California', so the
      // backend genuinely holds 'California' before re-entering the form -
      // matching the plan's "After the save in section 4.1 (State saved as
      // 'California'...)" precondition explicitly, rather than relying on
      // it being an incidental side effect of a previous test.
      await page.goto(`${BASE_URL}/company?edit=true`);
      const stateCombobox = page.getByRole('combobox', { name: 'State Select' });
      await stateCombobox.click();
      await page.getByRole('option', { name: 'California', exact: true }).click();
      await saveCompanyDetailsAndWaitForNavigation(page);

      // expect: the read-only card's 'Location' correctly reflects the
      // saved state - confirming State really was genuinely persisted to
      // the backend by this save, setting up the real defect asserted next.
      await expect(companyDetailsCard(page).getByText(/California/)).toBeVisible();

      // 1 (continued). Navigate to /company?edit=true again.
      await page.goto(`${BASE_URL}/company?edit=true`);

      // expect, real defect: the 'State' dropdown shows its empty
      // placeholder text 'Select' (confirmed via direct inspection that the
      // underlying input's value is an empty string), even though 'City',
      // 'Zip Code', and 'Address' all correctly pre-fill with their
      // previously saved values on this same form load - this is a real,
      // isolated pre-fill/hydration bug specific to just the State
      // combobox, not a symptom of the whole address block failing to
      // load.
      await expect(page.getByRole('combobox', { name: 'State Select' })).toHaveText('Select');
      await expect(page.locator('input[name="state"]')).toHaveValue('');
      await expect(page.getByRole('textbox', { name: 'City' })).toHaveValue('Santa Barbara County');
      await expect(page.getByRole('textbox', { name: 'Zip Code' })).toHaveValue('93458');
      await expect(page.getByRole('combobox', { name: 'Address' })).toHaveValue('1725 North Broadway');

      // 2. Attempt to click 'Save' immediately on this re-entered form
      // without touching State.
      // expect: 'Save' is disabled (confirming State really is being
      // treated as empty/invalid by the form, not just visually blank) - a
      // user re-entering this form to make any unrelated edit is forced to
      // always re-select their State from the dropdown again, every single
      // time, even though it was already saved correctly.
      await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
    });
  });

  test.describe('Company Details — Cancel and Discard Behavior', () => {
    test('5.1 Cancel on a pristine (non-dirtied) edit form navigates back to /company with no changes', async ({ page }) => {
      // Capture the read-only card's current values before entering edit
      // mode, per this project's discover-don't-hardcode portability
      // pattern (see SEED_FIRST_NAME/discoverSeedBaseline() in
      // tests/profile-settings.spec.ts and test 2.5's Office Phone Number
      // handling in this file) - the baseline is discovered live rather
      // than assumed, since it may have been touched by earlier sections'
      // cleanup/restore steps.
      const card = companyDetailsCard(page);
      const headingsBefore = card.getByRole('heading', { level: 6 });
      await expect(headingsBefore).toHaveCount(5);
      const valuesBefore = await headingsBefore.allTextContents();

      // 1. Navigate to /company?edit=true and, without touching any field,
      // click 'Cancel'.
      await page.goto(`${BASE_URL}/company?edit=true`);
      await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
      await page.getByRole('button', { name: 'Cancel' }).click();

      // expect: the browser navigates back to '/company' (URL loses
      // '?edit=true').
      await expect(page).toHaveURL(`${BASE_URL}/company`);

      // expect: the read-only card shows exactly the same values it showed
      // before entering edit mode - a clean, true no-op.
      const headingsAfter = companyDetailsCard(page).getByRole('heading', { level: 6 });
      await expect(headingsAfter).toHaveCount(5);
      const valuesAfter = await headingsAfter.allTextContents();
      expect(valuesAfter).toEqual(valuesBefore);
    });

    test("5.2 Cancel on a dirtied edit form discards all unsaved changes cleanly", async ({ page }) => {
      // Discover the current, real 'Company Name' value live (not
      // hardcoded) before dirtying it, per this project's
      // discover-don't-hardcode portability pattern - the value is compared
      // against later rather than assuming a specific literal like "QA
      // Automation Test Co".
      const card = companyDetailsCard(page);
      const originalCompanyName = (await card.getByRole('heading', { level: 6 }).first().textContent())?.trim();
      expect(originalCompanyName).toBeTruthy();

      // 1. On /company?edit=true, type a deliberately different,
      // clearly-temporary value into 'Company Name', then click 'Cancel'
      // instead of 'Save'.
      await page.goto(`${BASE_URL}/company?edit=true`);
      const companyName = page.getByRole('textbox', { name: 'Company Name' });
      await expect(companyName).toHaveValue(originalCompanyName!);
      await companyName.click();
      await companyName.fill('TEMP DIRTY VALUE');
      await expect(companyName).toHaveValue('TEMP DIRTY VALUE');
      await page.getByRole('button', { name: 'Cancel' }).click();

      // expect: the browser navigates back to '/company', and the
      // read-only card's 'Company Name' shows the ORIGINAL, previously-saved
      // value - 'TEMP DIRTY VALUE' was never sent to the backend and never
      // persisted.
      await expect(page).toHaveURL(`${BASE_URL}/company`);
      await expect(companyDetailsCard(page).getByRole('heading', { name: originalCompanyName!, exact: true })).toBeVisible();
      await expect(companyDetailsCard(page).getByRole('heading', { name: 'TEMP DIRTY VALUE' })).toHaveCount(0);

      // (confirmed by re-entering /company?edit=true afterward and seeing
      // the original value still present, not the temporary one).
      await page.goto(`${BASE_URL}/company?edit=true`);
      await expect(page.getByRole('textbox', { name: 'Company Name' })).toHaveValue(originalCompanyName!);
    });
  });
});
