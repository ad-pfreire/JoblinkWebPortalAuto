import { Page, Locator, expect } from '@playwright/test';
import { requireEnv } from './env';

const BASE_URL = requireEnv('BASE_URL');
const BASE_EMAIL = requireEnv('TEST_EMAIL_USER');
const EMAIL_DOMAIN = requireEnv('TEST_EMAIL_DOMAIN');
export const TEST_ALIAS_PREFIX = 'autotest';

/** Builds a plus-addressed alias under the shared test mailbox. */
export function generateEmailAlias(suffix: string) {
  return `${BASE_EMAIL}+${suffix}${EMAIL_DOMAIN}`;
}

/**
 * Generates a unique email alias for this test run, avoiding collisions
 * with previously registered emails.
 *
 * @returns A unique email alias, ready to use with `registerNewAccount`.
 */
export function generateUniqueEmailAlias() {
  const timePart = Date.now().toString(36).slice(-6); // 6 chars, cycles every ~25 days
  const randomPart = Math.floor(Math.random() * 1296)
    .toString(36)
    .padStart(2, '0'); // 2 chars
  const uniqueToken = `${TEST_ALIAS_PREFIX.slice(0, 2)}${timePart}${randomPart}`; // 10 chars total
  return generateEmailAlias(uniqueToken);
}

/**
 * Derives a Cognito username from an email alias, normalizing dots/plus signs.
 *
 * @returns The username, prefixed with the base account's username if needed.
 */
export function generateUsernameFromEmail(email: string) {
  const baseUsername = BASE_EMAIL.replace(/\./g, '');
  const localPart = email.split('@')[0];
  const normalized = localPart.replace(/\./g, '').replace(/\+/g, '');
  return normalized.startsWith(baseUsername) ? normalized : `${baseUsername}${normalized}`;
}

/**
 * Registers a new account through the public /register form.
 *
 * @param page - Playwright page, not yet logged in.
 * @param emailAlias - Email to register; should be unique per run.
 * @returns Nothing; leaves `page` on the /email-verification screen.
 */
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

  await expect(page).toHaveURL(/.*\/email-verification$/, { timeout: 15_000 });
  await expect(page.locator('text=Job Link Email Verification')).toBeVisible();
  await expect(page.locator('text=We send you a verification email')).toBeVisible();
}

/**
 * Selects a country in the phone widget by clicking the option's visible text.
 *
 * The widget renders a hidden native `<select>` alongside the real popper
 * list; `getByRole('option')` can resolve to the hidden one, so this clicks
 * by text content instead, scoped to this phone input's own container.
 */
export async function selectPhoneCountry(page: Page, phoneInput: Locator, countryName: string) {
  const countryCombobox = phoneInput.locator('xpath=..').getByRole('combobox');
  await countryCombobox.click();
  await page.evaluate((name: string) => {
    const option = Array.from(document.querySelectorAll('[role="option"]')).find((el) => el.textContent?.includes(name)) as
      HTMLElement | undefined;
    option?.click();
  }, countryName);
}

/**
 * Resets the phone field and types a fresh number for the given country.
 *
 * Re-selecting the same country is a no-op in MUI, so this switches to a
 * throwaway country first to force a real reset before selecting the target.
 */
export async function setPhoneNumber(page: Page, phoneInput: Locator, countryName: string, digits: string) {
  await selectPhoneCountry(page, phoneInput, 'Mexico');
  await selectPhoneCountry(page, phoneInput, countryName);
  await phoneInput.click();
  await phoneInput.pressSequentially(digits);
}

/**
 * Completes the "Complete Profile" step a new account is routed to after
 * first login: probes validation, then fills every field and submits.
 */
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

  // Live-verified 2026-08-13: this dropdown's "other" option is currently
  // labeled "Other / Accessories" — it used to be "Other Tools Not Listed"
  // (that stale text was silently timing out every test that reached this
  // step, on every spec file that calls completeProfile(), for who knows
  // how long before this was caught).
  await page.getByRole('combobox', { name: /Do you currently own any Fieldpiece tools/ }).click();
  await page.getByRole('option', { name: 'Other / Accessories' }).click();
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
