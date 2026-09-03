import { test, expect } from '@playwright/test';
import { requireEnv } from './utils/env';
import { getVerificationLink } from './utils/email';
import {
  TEST_ALIAS_PREFIX,
  generateEmailAlias,
  generateUniqueEmailAlias,
  generateUsernameFromEmail,
  registerNewAccount,
  completeProfile,
} from './utils/account';

const BASE_URL = requireEnv('BASE_URL');
const BASE_EMAIL = requireEnv('TEST_EMAIL_USER');
const EMAIL_DOMAIN = requireEnv('TEST_EMAIL_DOMAIN');

test.describe('Account Registration', () => {
  test('should display registration form and keep Register disabled until data is valid', async ({ page }) => {
    // 1. Open the registration page in Job Link.
    await page.goto(`${BASE_URL}/register`);

    // 2. Verify that the registration form shows the required fields.
    await expect(page.locator('input[name="email"]')).toBeVisible();
    await expect(page.locator('input[name="username"]')).toBeVisible();
    await expect(page.locator('input[name="password"]')).toBeVisible();
    await expect(page.locator('input[name="confirmPassword"]')).toBeVisible();
    await expect(page.locator('input[name="acceptTerms"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeDisabled();

    // 3. Verify that the Register button remains disabled with incomplete data.
    await page.fill('input[name="email"]', generateEmailAlias(`${TEST_ALIAS_PREFIX}1`));
    await expect(page.locator('button[type="submit"]')).toBeDisabled();
  });

  test('should generate username correctly from a dynamic plus-address email', async () => {
    // 1. Generate a simple dynamic email alias like +autotest1.
    const alias = generateEmailAlias(`${TEST_ALIAS_PREFIX}1`);
    const username = generateUsernameFromEmail(alias);

    // 2. Verify the transformation rules from alias to username.
    expect(alias).toBe(`${BASE_EMAIL}+${TEST_ALIAS_PREFIX}1${EMAIL_DOMAIN}`);
    expect(username).toBe(`${BASE_EMAIL.replace(/\./g, '')}${TEST_ALIAS_PREFIX}1`);
    expect(username).toMatch(/^[a-zA-Z0-9_.-]+$/);
    expect(username.length).toBeLessThanOrEqual(20);
  });

  test('should register a new account with a dynamic alias and show email verification page', async ({ page }) => {
    // 1. Generate a new, run-unique alias and register the account (a fixed
    // alias would collide with a previous run against the real pre-staging
    // backend and fail with "User already exists").
    const emailAlias = generateUniqueEmailAlias();
    await registerNewAccount(page, emailAlias);
  });
});

// The only test here reading a real email over IMAP - kept in its own
// describe with a local retry, since delivery timing is outside this test's
// control and the rest of the file should never need a retry to pass.
test.describe('Account Registration - full flow with real email', () => {
  test.describe.configure({ retries: 1 });

  test('should verify email, validate and complete the profile form, and log in after registering @real-email', async ({ page, browserName }) => {
    // Browser-agnostic backend flow - runs once on chromium, not 3x, to avoid tripling load on the shared email pipeline.
    test.skip(browserName !== 'chromium', 'Backend-only flow; runs once to avoid tripling load on the real email pipeline.');
    test.setTimeout(240_000);

    // 1. Register a new, run-unique account.
    const emailAlias = generateUniqueEmailAlias();
    const username = generateUsernameFromEmail(emailAlias);
    const password = requireEnv('TEST_REGISTER_PASSWORD');
    const registeredAt = new Date();
    await registerNewAccount(page, emailAlias);

    // 2. Fetch the verification email over IMAP and follow the link it contains.
    const verificationLink = await getVerificationLink(emailAlias, registeredAt);
    await page.goto(verificationLink);

    // 3. Verifying the email redirects to login with a success message.
    await expect(page).toHaveURL(`${BASE_URL}/login`);
    await expect(page.locator('text=Your email address was successfully verified.')).toBeVisible();

    // 4. Log in with the newly verified account.
    await page.fill('input[name="username"]', username);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]');

    // 5. A brand-new account without a profile is routed to Complete Profile.
    // completeProfile() also probes the required-field and invalid-phone
    // validation messages before filling the form correctly.
    await expect(page).toHaveURL(`${BASE_URL}/complete-profile`);
    await completeProfile(page);

    // 6. Logs in - checks the selected tab, not "Company Details" text (a hidden dialog shares that title on a brand-new account).
    await expect(page).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });
    await expect(page.getByRole('tab', { name: 'Company', selected: true })).toBeVisible();
  });
});

// Each case types an invalid value into one field and checks the inline
// error message the app renders under that field. None of these submit the
// form, so they don't touch the real backend and don't need a unique email.
const fieldValidationCases = [
  {
    label: 'invalid email format',
    field: 'email',
    value: 'not-an-email',
    message: 'Invalid email address',
  },
  {
    label: 'username with disallowed characters',
    field: 'username',
    value: 'bad user!',
    message: 'Usernames can only use letters, numbers, _, - and . characters',
  },
  {
    label: 'username longer than 20 characters',
    field: 'username',
    value: 'thisusernameiswaytoolongforvalidation',
    message: 'Text must contain at most 20 characters',
  },
];

test.describe('Account Registration - field validation', () => {
  for (const { label, field, value, message } of fieldValidationCases) {
    test(`should show "${message}" for ${label}`, async ({ page }) => {
      // 1. Open the registration page and type the invalid value into the field.
      await page.goto(`${BASE_URL}/register`);
      const input = page.locator(`input[name="${field}"]`);
      await input.fill(value);

      // 2. Blur the field so the inline validation runs.
      await input.blur();

      // 3. Verify the exact error message is shown and Register stays disabled.
      await expect(page.locator(`text=${message}`)).toBeVisible();
      await expect(page.locator('button[type="submit"]')).toBeDisabled();
    });
  }

  test('should show "Passwords do not match" when confirm password differs from password', async ({ page }) => {
    // 1. Open the registration page.
    await page.goto(`${BASE_URL}/register`);

    // 2. Fill a password that meets all strength requirements.
    await page.fill('input[name="password"]', 'StrongPass1!');

    // 3. Fill a different value in Confirm Password.
    await page.fill('input[name="confirmPassword"]', 'DoesNotMatch1!');
    await page.locator('input[name="confirmPassword"]').blur();

    // 4. Verify the mismatch message is shown and Register stays disabled.
    await expect(page.locator('text=Passwords do not match')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeDisabled();
  });

  test('should keep Register disabled when Terms of Service is not accepted', async ({ page }) => {
    // 1. Open the registration page and fill every field with valid data,
    // deliberately leaving the Terms of Service checkbox unchecked.
    await page.goto(`${BASE_URL}/register`);
    await page.fill('input[name="email"]', generateEmailAlias(`${TEST_ALIAS_PREFIX}validterms`));
    await page.fill('input[name="username"]', 'paulfreirevalidterms');
    await page.fill('input[name="password"]', 'StrongPass1!');
    await page.fill('input[name="confirmPassword"]', 'StrongPass1!');

    // 2. Verify Register stays disabled purely because the checkbox isn't checked
    // (the app shows no inline error text for this — it just keeps the button disabled).
    await expect(page.locator('input[name="acceptTerms"]')).not.toBeChecked();
    await expect(page.locator('button[type="submit"]')).toBeDisabled();
  });
});

test.describe('Account Registration - server responses', () => {
  test('should show "Email already exists" when registering with an already-registered email', async ({ page }) => {
    // 1. Reuse the permanently-registered seed account's email (the one
    // login-cases.spec.ts and forgot-password.spec.ts already rely on) so
    // this test needs no new account and carries no rate-limit risk.
    const registeredEmail = `${BASE_EMAIL}+automation${EMAIL_DOMAIN}`;

    await page.goto(`${BASE_URL}/register`);
    const password = requireEnv('TEST_REGISTER_PASSWORD');
    await page.fill('input[name="email"]', registeredEmail);
    await page.fill('input[name="username"]', 'duptest12345');
    await page.fill('input[name="password"]', password);
    await page.fill('input[name="confirmPassword"]', password);
    await page.check('input[name="acceptTerms"]');

    // 2. Submitting hits the real backend, which rejects the duplicate email.
    await page.click('button[type="submit"]');
    await expect(page.locator('text=Email already exists')).toBeVisible();
    await expect(page).toHaveURL(`${BASE_URL}/register`);
  });

  test('should show "The code is no longer valid." for a wrong confirmation code', async ({ page }) => {
    // 1. Register a new, run-unique account to reach the pending-verification
    // state (no need to wait for the real email — this test never uses it).
    const emailAlias = generateUniqueEmailAlias();
    await registerNewAccount(page, emailAlias);

    // 2. Visit the verify-email URL with a bogus confirmation code.
    const username = generateUsernameFromEmail(emailAlias);
    await page.goto(`${BASE_URL}/verify-email?username=${username}&confirmationCode=000000`);

    // 3. It still redirects to login (same as a real code), but with a
    // "no longer valid" message instead of a success one.
    await expect(page).toHaveURL(`${BASE_URL}/login`);
    await expect(page.locator('text=The code is no longer valid.')).toBeVisible();
  });
});
