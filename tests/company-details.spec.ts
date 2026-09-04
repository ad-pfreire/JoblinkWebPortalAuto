// spec: specs/company-details-test-plan.md
// seed: tests/seed.spec.ts

import { test, expect, Page, Locator } from '@playwright/test';
import { requireEnv } from './utils/env';

const BASE_URL = requireEnv('BASE_URL');
const SEED_USERNAME = requireEnv('TEST_USERNAME');
const SEED_PASSWORD = requireEnv('TEST_LOGIN_PASSWORD');

/** Logs in as the shared seed account and lands on /company. */
async function loginAsSeedAndGoToCompany(page: Page) {
  await page.goto(`${BASE_URL}/login`);
  await page.locator('input[name="username"]').fill(SEED_USERNAME);
  await page.locator('input[name="password"]').fill(SEED_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });
  await page.goto(`${BASE_URL}/company`);
  await expect(page.getByRole('link', { name: 'Edit' })).toBeVisible();
}

/** Scopes to the real Company Details card, not its hidden duplicate heading. */
function companyDetailsCard(page: Page) {
  return page.locator('.MuiCard-root').filter({ has: page.getByRole('link', { name: 'Edit' }) });
}

/** Scopes to a phone field's wrapper - its country-flag combobox has no accessible name of its own. */
function phoneFieldContainer(page: Page, label: string) {
  return page.locator('.MuiFormControl-root').filter({ hasText: label });
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

/** Clicks 'Save', waits for the real 200 response, then the redirect - this flow has no success toast (see test 4.1). */
async function saveCompanyDetailsAndWaitForNavigation(page: Page) {
  const saveResponsePromise = page.waitForResponse(
    (response) => response.url().includes('/company?edit=true') && response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Save' }).click();
  const saveResponse = await saveResponsePromise;
  expect(saveResponse.status()).toBe(200);
  await expect(page).toHaveURL(`${BASE_URL}/company`);
}

// Reads/writes the shared seed account - serial + chromium-only avoids
// racing parallel browser projects on its Company Details state (see CLAUDE.md).
test.describe('Company Details', () => {
  // retries: 2 - test 2.4's real Google Places API can be slow; a serial
  // describe would otherwise skip every remaining test on one bad response (see CLAUDE.md).
  test.describe.configure({ mode: 'serial', retries: 2 });

  test.beforeEach(async ({ page, browserName }) => {
    test.skip(
      browserName !== 'chromium',
      'Shared seed account state; runs once serially on chromium to avoid cross-project races on the same account.'
    );
    await loginAsSeedAndGoToCompany(page);
  });

  test.describe('Company Details — Read-Only Default View', () => {
    test("1.1 Fresh/unconfigured company shows '-' for all five fields, plus a working Edit link", async ({ page }) => {
      // 1. Land on /company before making any edits (done by beforeEach).
      await expect(page).toHaveTitle('Company | Job Link');

      const card = companyDetailsCard(page);

      // 'Company Details' is the first card, before 'Logo Upload' - checked
      // via DOM order, not Y-coordinate, since cards can render side-by-side
      // at the same Y in this responsive grid.
      await expect(card.getByText('Company Details', { exact: true })).toBeVisible();
      const allCards = page.locator('.MuiCard-root');
      const cardTitles = await allCards.locator('.MuiCardHeader-title, [class*="CardHeader-title"]').allTextContents();
      const companyDetailsIndex = cardTitles.findIndex((t) => t.trim() === 'Company Details');
      const logoUploadIndex = cardTitles.findIndex((t) => t.trim() === 'Logo Upload');
      expect(companyDetailsIndex).toBeGreaterThanOrEqual(0);
      expect(logoUploadIndex).toBeGreaterThanOrEqual(0);
      expect(companyDetailsIndex).toBeLessThan(logoUploadIndex);

      // ADAPTED: required fields can never revert to '-' through the UI (see
      // CLAUDE.md), so this asserts structure/labels only, not the plan's "shows '-'" checks.
      await expect(card.getByText('Company Name', { exact: true })).toBeVisible();
      await expect(card.getByText('Location', { exact: true })).toBeVisible();
      await expect(card.getByText('Email', { exact: true })).toBeVisible();
      await expect(card.getByText('Phone Number', { exact: true })).toBeVisible();
      await expect(card.getByText('Contractor License', { exact: true })).toBeVisible();
      await expect(card.getByRole('heading', { level: 6 })).toHaveCount(5);

      // A single 'Edit' link is visible/enabled, no other action buttons on this card.
      const editLink = card.getByRole('link', { name: 'Edit' });
      await expect(editLink).toBeVisible();
      await expect(editLink).toBeEnabled();
      await expect(card.getByRole('button')).toHaveCount(0);
      await expect(card.getByRole('link')).toHaveCount(1);

      // 2. Inspect the 'Edit' link's underlying href/URL.
      await expect(editLink).toHaveAttribute('href', '/company?edit=true');
    });

    test('1.2 Clicking Edit performs a real URL navigation to /company?edit=true, not an inline state toggle', async ({ page }) => {
      // 1. Click the 'Edit' link - the URL genuinely changes to
      // /company?edit=true, not just an in-place DOM swap.
      await companyDetailsCard(page).getByRole('link', { name: 'Edit' }).click();
      await expect(page).toHaveURL(`${BASE_URL}/company?edit=true`);

      // 2. Navigate directly to /company?edit=true from a fresh session -
      // renders the same form, confirming this is a real, deep-linkable route.
      await page.goto(`${BASE_URL}/company?edit=true`);
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
      // Exact name, not /State/ - a regex would also match Country's accessible name ("...United States").
      await expect(page.getByRole('combobox', { name: 'State Select' })).toBeVisible();
      await expect(page.getByText('State *', { exact: true })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'City' })).toBeVisible();
      await expect(page.getByText('City *', { exact: true })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Zip Code' })).toBeVisible();
      await expect(page.getByText('Zip Code *', { exact: true })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Email' })).toBeVisible();
      await expect(page.getByText('Email *', { exact: true })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Office Phone Number' })).toBeVisible();
      // Office Phone Number is NOT required (no '*'), unlike every field above.
      await expect(page.getByText('Office Phone Number *', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('textbox', { name: 'Mobile Phone Number' })).toBeVisible();
      await expect(page.getByText('Mobile Phone Number *', { exact: true })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Company Website' })).toBeVisible();
      await expect(page.getByText('Company Website *', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('textbox', { name: 'Terms and Conditions' })).toBeVisible();
      await expect(page.getByText('Terms and Conditions *', { exact: true })).toHaveCount(0);

      await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
      const saveButton = page.getByRole('button', { name: 'Save' });
      await expect(saveButton).toBeVisible();

      // ADAPTED: disabled here not from empty fields, but the 'State' pre-fill bug (test 4.5) - it never re-hydrates on load.
      await expect(saveButton).toBeDisabled();
      await expect(page.getByRole('combobox', { name: 'State Select' })).toHaveText('Select');

      // 2. Country, Address 2, Office Phone Number, Company Website, and
      // Terms and Conditions are editable here but never shown on the read-only card (test 1.1).
    });

    test('2.2 Country dropdown displays the last-saved value on reload (adapted)', async ({ page }) => {
      // ADAPTED: this account now has a real saved Country ('United
      // States'), so tests the still-true behavior: reflects the last-saved value on reload, not a re-rolled default.
      await page.goto(`${BASE_URL}/company?edit=true`);
      const countryCombobox = page.getByRole('combobox', { name: /Country/ });
      await expect(countryCombobox).toHaveText('United States');

      // 1. Change Country without saving.
      await countryCombobox.click();
      await page.getByRole('option', { name: 'Canada', exact: true }).click();
      await expect(countryCombobox).toHaveText('Canada');

      // 2. Reload (do not Save) - reverts to the last-saved 'United States', confirming it's persisted backend state.
      await page.goto(`${BASE_URL}/company?edit=true`);
      await expect(page.getByRole('combobox', { name: /Country/ })).toHaveText('United States');
    });

    test('2.3 Terms and Conditions textarea is pre-filled with the generic legal boilerplate default', async ({ page }) => {
      // 1. This boilerplate is a fresh-company default, but still holds
      // true here since nothing in this suite has ever overwritten it.
      await page.goto(`${BASE_URL}/company?edit=true`);

      await expect(page.getByRole('textbox', { name: 'Terms and Conditions' })).toHaveValue(
        'I have the authority to order the above work and perform as outlined above. It is agreed that the seller will retain title to any equipment or material furnished until final and complete payment is made, and if settlement is not made as agreed, the seller shall have the right to remove such equipment and the seller will be held harmless for any damages resulting from the removal thereof.'
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

      // A real listbox appears (unmocked Google Places, unstable suggestion
      // order) - always selects the FIRST one, which reliably resolves to Santa Barbara County, CA, 93458.
      const suggestionsList = page.getByRole('listbox', { name: 'Address' });
      await expect(suggestionsList).toBeVisible({ timeout: 15_000 });
      const suggestion = page.getByRole('option').first();
      await expect(suggestion).toBeVisible();

      // 2. Click the first suggested option.
      await suggestion.click();

      // Address collapses to the street portion (toHaveValue, not
      // toHaveText - this combobox is a plain <input>), Zip auto-populates.
      await expect(addressCombobox).toHaveValue('1725 North Broadway');
      await expect(page.getByRole('textbox', { name: 'Zip Code' })).toHaveValue('93458');
      // REAL BUG: City auto-populates to 'Santa Barbara County' - a COUNTY
      // name, not the actual city 'Santa Maria' from the suggestion text.
      await expect(page.getByRole('textbox', { name: 'City' })).toHaveValue('Santa Barbara County');

      // State does NOT auto-populate (stays 'Select') despite City/Zip
      // updating - reproduced 3x, possibly intermittent, flagged for a dev check.
      await expect(page.getByRole('combobox', { name: 'State Select' })).toHaveText('Select');

      // Cleanup: reload instead of Save, so this test never mutates the shared account's persisted data.
      await page.goto(`${BASE_URL}/company?edit=true`);
    });

    test('2.5 Office Phone Number and Mobile Phone Number have independent country-flag selectors, and neither is synced to the main Country dropdown', async ({
      page,
    }) => {
      await page.goto(`${BASE_URL}/company?edit=true`);

      const officePhoneFlag = phoneFieldContainer(page, 'Office Phone Number').getByRole('combobox');
      const mobilePhoneFlag = phoneFieldContainer(page, 'Mobile Phone Number').getByRole('combobox');
      const officePhoneNumber = page.getByRole('textbox', { name: 'Office Phone Number' });
      const mobilePhoneNumber = page.getByRole('textbox', { name: 'Mobile Phone Number' });

      // Discovers current values rather than hardcoding them (see CLAUDE.md's
      // Portability section) - Office Phone Number was never actually saved, so its default is a client-side guess.
      const originalOfficePhone = await officePhoneNumber.inputValue();
      const originalMobilePhone = await mobilePhoneNumber.inputValue();

      // 1. On /company?edit=true, change the main 'Country' dropdown from
      // its default to a different value.
      const countryCombobox = page.getByRole('combobox', { name: /Country/ });
      await countryCombobox.click();
      await page.getByRole('option', { name: 'Canada', exact: true }).click();
      await expect(countryCombobox).toHaveText('Canada');

      // Both phone widgets remain unaffected - Country doesn't cascade to either's own country selection.
      await expect(officePhoneNumber).toHaveValue(originalOfficePhone);
      await expect(mobilePhoneNumber).toHaveValue(originalMobilePhone);

      // 2. Open the Mobile Phone Number widget's own country-flag selector
      // and independently select a different country.
      await mobilePhoneFlag.click();
      await page.getByRole('option', { name: 'United Kingdom' }).click();

      // Only Mobile Phone resets to the bare dial code - Office Phone is
      // unaffected, confirming these are two fully independent widgets.
      await expect(mobilePhoneNumber).toHaveValue('+44 ');
      await expect(officePhoneNumber).toHaveValue(originalOfficePhone);
      await expect(officePhoneFlag).toBeVisible();

      // Cleanup: reload instead of Save, to discard this test's unsaved changes.
      await page.goto(`${BASE_URL}/company?edit=true`);
    });
  });

  test.describe('Company Details — Validation', () => {
    test("3.1 Blurring a pristine empty required field shows 'The field is required' and keeps Save disabled (adapted)", async ({
      page,
    }) => {
      // ADAPTED: no field here is genuinely pristine-empty at load, so this
      // clears Company Name via keystrokes instead - near-identical to 3.2, which is expected.
      // 1. Clear Company Name, then blur it (click into Contractor License).
      await page.goto(`${BASE_URL}/company?edit=true`);
      const companyName = page.getByRole('textbox', { name: 'Company Name' });
      const contractorLicense = page.getByRole('textbox', { name: 'Contractor License' });
      await clearFieldWithBackspace(page, companyName);
      await contractorLicense.click();

      await expect(page.getByText('The field is required', { exact: true })).toBeVisible();
      await expect(companyName).toHaveAttribute('aria-invalid', 'true');
      await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

      // Cleanup: reload without saving (Save is disabled anyway, so nothing could have persisted).
      await page.goto(`${BASE_URL}/company?edit=true`);
      await expect(companyName).toHaveValue('QA Automation Test Co');
    });

    test("3.2 Clearing a previously-filled required field correctly re-triggers 'required' validation and blocks Save", async ({
      page,
    }) => {
      // CORRECTED: the original plan claimed this silently suppressed the
      // 'required' message - re-verification found it does NOT reproduce;
      // the message appears and Save disables correctly, same as 3.1.
      await page.goto(`${BASE_URL}/company?edit=true`);
      const companyName = page.getByRole('textbox', { name: 'Company Name' });
      const contractorLicense = page.getByRole('textbox', { name: 'Contractor License' });

      // 1. Fill 'Company Name', then clear it via real keystrokes, then blur it.
      await companyName.click();
      await companyName.fill('QA Automation Test Co');
      await clearFieldWithBackspace(page, companyName);
      await contractorLicense.click();

      await expect(page.getByText('The field is required', { exact: true })).toBeVisible();
      await expect(companyName).toHaveAttribute('aria-invalid', 'true');

      // 2. Attempt to click 'Save' while Company Name is still empty.
      const saveButton = page.getByRole('button', { name: 'Save' });
      await expect(saveButton).toBeDisabled();

      // 3. Cleanup: reload - confirms nothing was actually persisted.
      await page.goto(`${BASE_URL}/company?edit=true`);
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

    test('3.4 REAL BUG: Company Website has no client-side format validation at all, and a genuinely invalid value is silently rejected server-side with zero user-visible error feedback', async ({
      page,
    }) => {
      await page.goto(`${BASE_URL}/company?edit=true`);
      const website = page.getByRole('textbox', { name: 'Company Website' });
      const contractorLicense = page.getByRole('textbox', { name: 'Contractor License' });
      const saveButton = page.getByRole('button', { name: 'Save' });

      // Setup: re-select State to reach "every required field valid" (Save
      // is otherwise disabled due to the State pre-fill bug from test 2.1/4.5, not this test's own subject).
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

      // NO inline error appears and Save stays ENABLED - this field has no client-side format validation at all, unlike Email (3.3).
      await expect(website).not.toHaveAttribute('aria-invalid', 'true');
      await expect(saveButton).toBeEnabled();

      // 2. Click 'Save' with this invalid value still in place - a real POST IS sent (unlike 3.2's blocked submission) and returns 200.
      const saveResponsePromise = page.waitForResponse(
        (response) => response.url().includes('/company?edit=true') && response.request().method() === 'POST'
      );
      await saveButton.click();
      const saveResponse = await saveResponsePromise;
      expect(saveResponse.status()).toBe(200);

      // Stays on /company?edit=true, Save stays enabled, and NO toast/error
      // of any kind appears - not toHaveCount(0), since Next.js's own empty
      // route-announcer also carries role="alert" (see CLAUDE.md).
      await expect(page).toHaveURL(`${BASE_URL}/company?edit=true`);
      await expect(saveButton).toBeEnabled();
      await expect(page.getByRole('alert')).toHaveText('');
      await expect(page.getByText(/error/i)).toHaveCount(0);

      // 3. Reload - Company Website reverted to its last valid value
      // ('https://example.com'), proving the invalid save was genuinely
      // rejected server-side with zero indication given to the user.
      await page.goto(`${BASE_URL}/company?edit=true`);
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

      // Accepted with no truncation and no inline error, unlike some other length-capped fields elsewhere in this suite.
      await expect(companyName).toHaveValue(longName);
      expect(await companyName.inputValue()).toHaveLength(251);
      await expect(companyName).not.toHaveAttribute('aria-invalid', 'true');
      await expect(page.getByText('The field is required', { exact: true })).toHaveCount(0);

      // Cleanup: reload without saving - not persisted, to protect the shared account.
      await page.goto(`${BASE_URL}/company?edit=true`);
      await expect(companyName).toHaveValue('QA Automation Test Co');
    });
  });

  test.describe('Company Details — Save, Persistence, and Read-View Rendering', () => {
    test('4.1 A real, valid save persists genuinely to the backend, confirmed via reload — but shows NO success toast, unlike every other save flow in this app', async ({
      page,
    }) => {
      await page.goto(`${BASE_URL}/company?edit=true`);
      const companyName = page.getByRole('textbox', { name: 'Company Name' });
      const contractorLicense = page.getByRole('textbox', { name: 'Contractor License' });
      const email = page.getByRole('textbox', { name: 'Email' });
      const stateCombobox = page.getByRole('combobox', { name: 'State Select' });

      // Setup: Address/City/Zip/Country already hold valid values (2.4 has
      // its own coverage). State must still be re-selected (the pre-fill bug from 2.1/4.5).
      await stateCombobox.click();
      await page.getByRole('option', { name: 'California', exact: true }).click();

      // 1. Change Company Name/Contractor License/Email to new temporary
      // values, save, and confirm via reload they genuinely round-tripped -
      // then restore the baseline values the rest of this file depends on.
      await companyName.fill('QA Automation Test Co TEMP');
      await contractorLicense.fill('LIC-999999');
      await email.fill('qa-company-test-temp@crifa.com');

      await saveCompanyDetailsAndWaitForNavigation(page);

      // Unlike Profile Settings/Logo Upload/Change Password, this save shows
      // NO success toast - the silent navigation is the only confirmation.
      await expect(page.getByRole('alert')).toHaveText('');
      await expect(page.getByText(/updated successfully|uploaded successfully/i)).toHaveCount(0);

      const card = companyDetailsCard(page);
      await expect(card.getByRole('heading', { name: 'QA Automation Test Co TEMP' })).toBeVisible();
      await expect(card.getByRole('heading', { name: 'qa-company-test-temp@crifa.com' })).toBeVisible();
      await expect(card.getByRole('heading', { name: 'LIC-999999' })).toBeVisible();

      // 2. Reload (full navigation) - the values genuinely persisted, not just a client-side preview.
      await page.goto(`${BASE_URL}/company`);
      await expect(companyDetailsCard(page).getByRole('heading', { name: 'QA Automation Test Co TEMP' })).toBeVisible();
      await expect(companyDetailsCard(page).getByRole('heading', { name: 'qa-company-test-temp@crifa.com' })).toBeVisible();
      await expect(companyDetailsCard(page).getByRole('heading', { name: 'LIC-999999' })).toBeVisible();

      // Cleanup: restore the baseline values, confirmed via the real
      // response + reload (see CLAUDE.md's second-save-toast gotcha).
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
      // 1. Compare the card's 'Phone Number' against both phone fields'
      // underlying values - it's index 3 among test 1.1's 5 headings.
      const card = companyDetailsCard(page);
      await expect(card.getByText('Phone Number', { exact: true })).toBeVisible();
      const headings = card.getByRole('heading', { level: 6 });
      await expect(headings).toHaveCount(5);
      const cardPhoneNumberText = (await headings.nth(3).textContent())?.trim();

      // Discovers current values via the hidden underlying inputs (see CLAUDE.md's discover-don't-hardcode pattern).
      await page.goto(`${BASE_URL}/company?edit=true`);
      const mobilePhoneHidden = page.locator('input[name="mobilePhone.phoneNumber"]');
      const officePhoneHidden = page.locator('input[name="officePhone.phoneNumber"]');
      const mobilePhoneValue = await mobilePhoneHidden.inputValue();
      const officePhoneValue = await officePhoneHidden.inputValue();

      // Card shows exactly Mobile Phone Number, never Office Phone Number (consistent with 2.1's finding).
      expect(cardPhoneNumberText).toBe(mobilePhoneValue);
      expect(cardPhoneNumberText).not.toBe(officePhoneValue);
      await page.goto(`${BASE_URL}/company`); // `card` needs the read view's own 'Edit' link
      // Guard against a bare digit-less country code (e.g. '+1' with no
      // number) - trivially a substring of any US Mobile Phone Number, which'd false-positive this check.
      if (officePhoneValue.replace(/\D/g, '').length > 1) {
        await expect(card).not.toContainText(officePhoneValue);
      }
    });

    test("4.3 REAL BUG (corrected): the read-only card's 'Location' summary silently omits Address 2, though the Address/City segments render as two separate visual lines rather than one run-together word", async ({
      page,
    }) => {
      // CORRECTED: the plan claimed Address/City run together with no space,
      // but they're two <span>s split by a real <br> - a real user sees two
      // lines (see CLAUDE.md's innerText gotcha). Address 2 IS still omitted, though - that part reproduces.
      const card = companyDetailsCard(page);
      const locationHeading = card.getByRole('heading', { level: 6 }).nth(1);
      await expect(card.getByText('Location', { exact: true })).toBeVisible();

      // 1. Read via innerText() (respects real rendering, unlike textContent).
      const locationInnerText = await locationHeading.innerText();

      // Address and City-onward render on two separate lines, not run together.
      expect(locationInnerText).toContain('1725 North Broadway\n');
      expect(locationInnerText).not.toContain('BroadwaySanta');

      // Address 2 ('Suite 100') never appears - captured by the edit form but never surfaced on the read-only card.
      expect(locationInnerText).not.toContain('Suite 100');

      // Sanity-check the full expected content is otherwise present.
      expect(locationInnerText).toContain('Santa Barbara County, California, 93458, United States');
    });

    test("4.4 Company Email and Phone Number are fully independent of the logged-in user's own Profile Settings identity fields", async ({
      page,
    }) => {
      // 1. Capture the card's Email/Phone Number, then compare against /profile's own account-identity fields.
      const card = companyDetailsCard(page);
      const headings = card.getByRole('heading', { level: 6 });
      await expect(headings).toHaveCount(5);
      const companyEmail = (await headings.nth(2).textContent())?.trim();
      const companyPhoneNumber = (await headings.nth(3).textContent())?.trim();
      expect(companyEmail).not.toBe('-');
      expect(companyPhoneNumber).not.toBe('-');

      await page.goto(`${BASE_URL}/profile`);
      const profileEmail = page.getByRole('textbox', { name: 'Email Address' });
      const profilePhoneNumber = page.getByRole('textbox', { name: 'Phone Number' });

      // Profile's Email Address is unchanged, disabled, and genuinely different from Company Details' own Email.
      await expect(profileEmail).toHaveValue('paul.freire+automation@crifa.com');
      await expect(profileEmail).toBeDisabled();
      expect(companyEmail).not.toBe('paul.freire+automation@crifa.com');

      // Same for Phone Number - confirms these are wholly independent,
      // company-scoped fields, safe to edit without risking login identity.
      await expect(profilePhoneNumber).toHaveValue('+1 (212) 555-0100');
      const profilePhoneDigits = (await profilePhoneNumber.inputValue()).replace(/\D/g, '');
      const companyPhoneDigits = (companyPhoneNumber ?? '').replace(/\D/g, '');
      expect(companyPhoneDigits).not.toBe(profilePhoneDigits);
    });

    test("4.5 REAL BUG: re-entering the edit form after a save fails to pre-fill the 'State' dropdown, even though the read-only card's Location correctly reflects the saved state", async ({
      page,
    }) => {
      // 1. Save with State genuinely selected as 'California' first, so the backend holds it before re-entering the form.
      await page.goto(`${BASE_URL}/company?edit=true`);
      const stateCombobox = page.getByRole('combobox', { name: 'State Select' });
      await stateCombobox.click();
      await page.getByRole('option', { name: 'California', exact: true }).click();
      await saveCompanyDetailsAndWaitForNavigation(page);

      // The read-only card confirms State really persisted, setting up the real defect asserted next.
      await expect(companyDetailsCard(page).getByText(/California/)).toBeVisible();

      // 2. Navigate to /company?edit=true again.
      await page.goto(`${BASE_URL}/company?edit=true`);

      // REAL BUG: State shows empty 'Select' even though City/Zip/Address
      // all correctly pre-fill - isolated to just the State combobox.
      await expect(page.getByRole('combobox', { name: 'State Select' })).toHaveText('Select');
      await expect(page.locator('input[name="state"]')).toHaveValue('');
      await expect(page.getByRole('textbox', { name: 'City' })).toHaveValue('Santa Barbara County');
      await expect(page.getByRole('textbox', { name: 'Zip Code' })).toHaveValue('93458');
      await expect(page.getByRole('combobox', { name: 'Address' })).toHaveValue('1725 North Broadway');

      // 3. Save is disabled without touching State - the form genuinely
      // treats it as invalid, forcing the user to re-select it on every edit.
      await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
    });
  });

  test.describe('Company Details — Cancel and Discard Behavior', () => {
    test('5.1 Cancel on a pristine (non-dirtied) edit form navigates back to /company with no changes', async ({ page }) => {
      // Discovers the baseline live rather than hardcoding it (see CLAUDE.md) - earlier sections may have changed it.
      const card = companyDetailsCard(page);
      const headingsBefore = card.getByRole('heading', { level: 6 });
      await expect(headingsBefore).toHaveCount(5);
      const valuesBefore = await headingsBefore.allTextContents();

      // 1. Without touching any field, click 'Cancel' - navigates back to /company (URL loses '?edit=true').
      await page.goto(`${BASE_URL}/company?edit=true`);
      await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(page).toHaveURL(`${BASE_URL}/company`);

      // Read-only card shows exactly the same values as before entering edit mode - a clean, true no-op.
      const headingsAfter = companyDetailsCard(page).getByRole('heading', { level: 6 });
      await expect(headingsAfter).toHaveCount(5);
      const valuesAfter = await headingsAfter.allTextContents();
      expect(valuesAfter).toEqual(valuesBefore);
    });

    test('5.2 Cancel on a dirtied edit form discards all unsaved changes cleanly', async ({ page }) => {
      // Discovers the current value live, not hardcoded, before dirtying it.
      const card = companyDetailsCard(page);
      const originalCompanyName = (await card.getByRole('heading', { level: 6 }).first().textContent())?.trim();
      expect(originalCompanyName).toBeTruthy();

      // 1. Type a temporary value into 'Company Name', then click 'Cancel' instead of 'Save'.
      await page.goto(`${BASE_URL}/company?edit=true`);
      const companyName = page.getByRole('textbox', { name: 'Company Name' });
      await expect(companyName).toHaveValue(originalCompanyName!);
      await companyName.click();
      await companyName.fill('TEMP DIRTY VALUE');
      await expect(companyName).toHaveValue('TEMP DIRTY VALUE');
      await page.getByRole('button', { name: 'Cancel' }).click();

      // Navigates back to /company with the ORIGINAL value - 'TEMP DIRTY VALUE' was never persisted.
      await expect(page).toHaveURL(`${BASE_URL}/company`);
      await expect(companyDetailsCard(page).getByRole('heading', { name: originalCompanyName!, exact: true })).toBeVisible();
      await expect(companyDetailsCard(page).getByRole('heading', { name: 'TEMP DIRTY VALUE' })).toHaveCount(0);

      // Confirmed again by re-entering the edit form.
      await page.goto(`${BASE_URL}/company?edit=true`);
      await expect(page.getByRole('textbox', { name: 'Company Name' })).toHaveValue(originalCompanyName!);
    });
  });
});
