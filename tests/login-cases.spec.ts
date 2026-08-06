import { test, expect } from '@playwright/test';
import { requireEnv } from './utils/env';

// App base URL and test account credentials, loaded from .env.
const BASE_URL = requireEnv('BASE_URL');
const PASSWORD = requireEnv('TEST_LOGIN_PASSWORD');
// Intentionally wrong password, used only to test the error message.
const WRONG_PASSWORD = 'WrongPass1!';

const TEST_USERNAME = requireEnv('TEST_USERNAME');
// Test account email, built from the username + domain in .env.
const REGISTERED_EMAIL = `${requireEnv('TEST_EMAIL_USER')}+sc1${requireEnv('TEST_EMAIL_DOMAIN')}`;

// Successful login cases: same username/email tested in lowercase and uppercase,
// to validate that login is case-insensitive.
const loginSuccessCases = [
  { label: `username ${TEST_USERNAME}`, identifier: TEST_USERNAME },
  { label: `username ${TEST_USERNAME.toUpperCase()}`, identifier: TEST_USERNAME.toUpperCase() },
  { label: `email ${REGISTERED_EMAIL}`, identifier: REGISTERED_EMAIL },
  { label: `email ${REGISTERED_EMAIL.toUpperCase()}`, identifier: REGISTERED_EMAIL.toUpperCase() },
];

test.describe('Login flow', () => {
  // Before each test, open the login page.
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
  });

  test('should keep Log In disabled when credentials are empty', async ({ page }) => {
    // 1. Verify that the username and password fields are visible.
    await expect(page.locator('input[name="username"]')).toBeVisible();
    await expect(page.locator('input[name="password"]')).toBeVisible();

    // 2. Verify that the Log In button is disabled with no data.
    const loginButton = page.locator('button[type="submit"]');
    await expect(loginButton).toBeDisabled();
  });

  test('should keep Log In disabled when only username is provided', async ({ page }) => {
    // 1. Fill in only the username field.
    await page.locator('input[name="username"]').fill(TEST_USERNAME);

    // 2. Verify that the Log In button remains disabled.
    const loginButton = page.locator('button[type="submit"]');
    await expect(loginButton).toBeDisabled();
  });

  test('should keep Log In disabled when only password is provided', async ({ page }) => {
    // 1. Fill in only the password field.
    await page.locator('input[name="password"]').fill(PASSWORD);

    // 2. Verify that the Log In button remains disabled.
    const loginButton = page.locator('button[type="submit"]');
    await expect(loginButton).toBeDisabled();
  });

  // This loop generates an independent test for each case defined in loginSuccessCases
  // (username/email in lowercase and uppercase).
  for (const { label, identifier } of loginSuccessCases) {
    test(`should login successfully with ${label}`, async ({ page }) => {
      const usernameInput = page.locator('input[name="username"]');
      const passwordInput = page.locator('input[name="password"]');
      const loginButton = page.locator('button[type="submit"]');

      // 1. Fill in a valid username/email and password.
      await usernameInput.fill(identifier);
      await passwordInput.fill(PASSWORD);
      await expect(loginButton).toBeEnabled();

      // 2. Log in.
      await loginButton.click();

      // 3. Verify that login succeeded (redirects and shows company data).
      await expect(page).toHaveURL(/.*\/(company|teams\/list)$/);
      await expect(page.locator('text=Company Details')).toBeVisible();
    });
  }

  test('should display error for invalid password', async ({ page }) => {
    const usernameInput = page.locator('input[name="username"]');
    const passwordInput = page.locator('input[name="password"]');
    const loginButton = page.locator('button[type="submit"]');

    // 1. Fill in a valid email with an incorrect password.
    await usernameInput.fill(REGISTERED_EMAIL);
    await passwordInput.fill(WRONG_PASSWORD);
    await expect(loginButton).toBeEnabled();

    // 2. Attempt to log in.
    await loginButton.click();

    // 3. Verify that the error is shown and the user stays on the login page.
    await expect(page.locator('text=Incorrect username or password.')).toBeVisible();
    await expect(page).toHaveURL(`${BASE_URL}/login`);
  });

  test('should show forgot password and sign up links', async ({ page }) => {
    const forgotLink = page.locator('a[href*="forgot-password"]');
    const signUpLink = page.locator('a[href*="register"]');

    // 1. Verify that the "Forgot password" and "Sign up" links are visible.
    await expect(forgotLink).toBeVisible();
    await expect(signUpLink).toBeVisible();

    // 2. Verify that each link points to the correct page.
    await expect(forgotLink).toHaveAttribute('href', /forgot-password/);
    await expect(signUpLink).toHaveAttribute('href', /register/);
  });
});
