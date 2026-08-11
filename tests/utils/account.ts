import { Page, Locator, expect } from '@playwright/test';
import { requireEnv } from './env';

const BASE_URL = requireEnv('BASE_URL');
const BASE_EMAIL = requireEnv('TEST_EMAIL_USER');
const EMAIL_DOMAIN = requireEnv('TEST_EMAIL_DOMAIN');
export const TEST_ALIAS_PREFIX = 'autotest';

export function generateEmailAlias(suffix: string) {
  return `${BASE_EMAIL}+${suffix}${EMAIL_DOMAIN}`;
}

// Generates a suffix that is unique per test run (and per parallel browser
// project), so repeated CI runs never collide with a previously-registered
// email in the real pre-staging backend (Cognito rejects re-registering the same
// username/email with "User already exists"). The app also enforces a hard
// 20 character max length on the username field, and the derived username is
// `${BASE_EMAIL without dots}${suffix}` (10 chars for "paulfreire"), so the
// suffix itself must stay at or under 10 characters. We use 2 chars from
// TEST_ALIAS_PREFIX plus a base36 timestamp/random token to stay unique
// while respecting that budget.
export function generateUniqueEmailAlias() {
  const timePart = Date.now().toString(36).slice(-6); // 6 chars, cycles every ~25 days
  const randomPart = Math.floor(Math.random() * 1296).toString(36).padStart(2, '0'); // 2 chars
  const uniqueToken = `${TEST_ALIAS_PREFIX.slice(0, 2)}${timePart}${randomPart}`; // 10 chars total
  return generateEmailAlias(uniqueToken);
}

export function generateUsernameFromEmail(email: string) {
  const baseUsername = BASE_EMAIL.replace(/\./g, '');
  const localPart = email.split('@')[0];
  const normalized = localPart.replace(/\./g, '').replace(/\+/g, '');
  return normalized.startsWith(baseUsername) ? normalized : `${baseUsername}${normalized}`;
}

export async function registerNewAccount(page: Page, emailAlias: string) {
  const username = generateUsernameFromEmail(emailAlias);
  const password = requireEnv('TEST_REGISTER_PASSWORD');

  await page.goto(`${BASE_URL}/register`);
  await page.fill('input[name="email"]', emailAlias);
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', password);
  await page.fill('input[name="confirmPassword"]', password);
  await page.check('input[name="acceptTerms"]');

  await expect(page.locator('button[type="submit"]')).toBeEnabled();
  await page.click('button[type="submit"]');

  // The real pre-staging Cognito signup call can take longer than the default
  // 5s under concurrent load (e.g. all 3 browser projects registering at
  // once), so this redirect gets a more generous timeout.
  await expect(page).toHaveURL(/.*\/email-verification$/, { timeout: 15_000 });
  await expect(page.locator('text=Job Link Email Verification')).toBeVisible();
  await expect(page.locator('text=We send you a verification email')).toBeVisible();
}

// Selects a country in the phone widget by clicking the option's text
// content directly. The country dropdown renders a hidden native <select>
// alongside the visible popper list for accessibility, and
// getByRole('option', ...) can resolve to the hidden duplicate instead of
// the real one, silently failing to change the country. The combobox is
// scoped to the phone input's own container (not page-wide .first()) so it
// keeps resolving to the right element even if the page re-renders and adds
// other comboboxes earlier in the DOM.
async function selectPhoneCountry(page: Page, phoneInput: Locator, countryName: string) {
  const countryCombobox = phoneInput.locator('xpath=..').getByRole('combobox');
  await countryCombobox.click();
  await page.evaluate((name: string) => {
    const option = Array.from(document.querySelectorAll('[role="option"]')).find((el) =>
      el.textContent?.includes(name),
    ) as HTMLElement | undefined;
    option?.click();
  }, countryName);
}

// Resets the phone field to a clean "+<dial code>" state and types fresh
// digits. Re-selecting the SAME country is a no-op in MUI (onChange doesn't
// fire when the value doesn't change) and backspacing the stale digits still
// leaves the widget in a state where the next keystroke re-triggers its
// auto-country-detect-from-digits parsing instead of respecting the already
// selected country. Switching to a different country first forces a real
// onChange that actually resets the field, then switching back to the
// target country is itself a real change too, guaranteeing a clean start.
async function setPhoneNumber(page: Page, phoneInput: Locator, countryName: string, digits: string) {
  await selectPhoneCountry(page, phoneInput, 'Mexico');
  await selectPhoneCountry(page, phoneInput, countryName);
  await phoneInput.click();
  await phoneInput.pressSequentially(digits);
}

// Fills the "Complete Profile" step that a brand-new account is routed to
// right after its first login. First probes the required-field and
// phone-format validation messages, then fills everything correctly and
// submits. All values are arbitrary placeholders except the phone number,
// which the app validates as a real dialable number.
export async function completeProfile(page: Page) {
  const firstNameInput = page.locator('input[name="firstName"]');
  const lastNameInput = page.locator('input[name="lastName"]');
  const phoneInput = page.locator('input[placeholder="Enter your phone number"]');

  // 1. Leaving First Name and Last Name empty and blurring each shows
  // "The field is required" under both.
  await firstNameInput.click();
  await lastNameInput.click();
  await page.getByText('Please finish setting up your account').click();
  await expect(page.locator('text=The field is required')).toHaveCount(2);

  // 2. Filling only First/Last Name is enough to enable Finish — unlike the
  // Terms of Service checkbox on registration, Phone Number and the three
  // dropdowns don't block the button; their validity (or emptiness) is only
  // enforced when the form is actually submitted (see step 4).
  await firstNameInput.fill('QA');
  await lastNameInput.fill('Automation');
  await expect(page.getByRole('button', { name: 'Finish' })).toBeEnabled();

  // 3. Fill every field, but with an invalid phone area code, so submitting
  // triggers the phone-format validation instead of succeeding outright.
  await setPhoneNumber(page, phoneInput, 'United States', '5551234567');

  await page.getByRole('combobox', { name: /Do you currently own any Fieldpiece tools/ }).click();
  await page.getByRole('option', { name: 'Other Tools Not Listed' }).click();
  await page.keyboard.press('Escape');

  await page.getByRole('combobox', { name: /What market\(s\) do you serve/ }).click();
  await page.getByRole('option', { name: 'Other', exact: true }).click();
  await page.keyboard.press('Escape');

  await page.getByRole('combobox', { name: /What's your role at the company/ }).click();
  await page.getByRole('option', { name: 'Other', exact: true }).click();

  // 4. Submitting with the invalid area code shows "Invalid phone number"
  // and keeps the user on this page.
  await page.getByRole('button', { name: 'Finish' }).click();
  await expect(page.locator('text=Invalid phone number')).toBeVisible();
  await expect(page).toHaveURL(/\/complete-profile$/);

  // 5. Fix the phone number (see setPhoneNumber for why a full country
  // round-trip is needed instead of just clearing the stale digits) and
  // submit again.
  await setPhoneNumber(page, phoneInput, 'United States', '2125551234');
  await page.getByRole('button', { name: 'Finish' }).click();
}
