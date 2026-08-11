import { test, expect } from '@playwright/test';
import { requireEnv } from './utils/env';

// App base URL and test account credentials, loaded from .env.
const BASE_URL = requireEnv('BASE_URL');
const PASSWORD = requireEnv('TEST_LOGIN_PASSWORD');
// Intentionally wrong password, used only to test the error message.
const WRONG_PASSWORD = 'WrongPass1!';

const TEST_USERNAME = requireEnv('TEST_USERNAME');
// Test account email, built from the username + domain in .env.
const REGISTERED_EMAIL = `${requireEnv('TEST_EMAIL_USER')}+automation${requireEnv('TEST_EMAIL_DOMAIN')}`;

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

  test('should display all required elements in their default state', async ({ page }) => {
    // 1. Page-level branding and no error banner.
    await expect(page).toHaveTitle('Log In | Job Link');
    await expect(page.getByRole('img', { name: 'logo' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Job Link', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your right-hand man.' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Welcome back! Please login to your account.' })).toBeVisible();
    await expect(page.getByRole('alert')).toBeEmpty();

    // 2. Username or Email field, empty by default.
    const usernameInput = page.locator('input[name="username"]');
    await expect(usernameInput).toBeVisible();
    await expect(usernameInput).toHaveAttribute('placeholder', 'Enter your username or email');
    await expect(usernameInput).toHaveValue('');

    // 3. Password field, masked by default, with its own eye-icon toggle.
    const passwordInput = page.locator('input[name="password"]');
    await expect(passwordInput).toBeVisible();
    await expect(passwordInput).toHaveAttribute('placeholder', 'Enter your password');
    await expect(passwordInput).toHaveAttribute('type', 'password');
    await expect(page.getByRole('button', { name: 'toggle password visibility' })).toBeVisible();

    // 4. Log In button disabled while both fields are empty.
    await expect(page.locator('button[type="submit"]')).toBeDisabled();

    // 5. Forgot Password and Sign Up links.
    await expect(page.locator('a[href="/forgot-password"]')).toBeVisible();
    await expect(page.locator('a[href="/register"]')).toBeVisible();
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
      // The app now also renders a hidden dialog whose title is "Company
      // Details", which makes that text ambiguous — the selected "Company"
      // tab is a stable, unambiguous signal that the page loaded correctly.
      await expect(page).toHaveURL(/.*\/(company|teams\/list)$/);
      await expect(page.getByRole('tab', { name: 'Company', selected: true })).toBeVisible();
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

    // 4. The button reverts to disabled after a failed attempt, even though
    // both fields still contain the values that were just submitted.
    await expect(loginButton).toBeDisabled();
  });

  test('should display error for a username that does not exist', async ({ page }) => {
    const usernameInput = page.locator('input[name="username"]');
    const passwordInput = page.locator('input[name="password"]');
    const loginButton = page.locator('button[type="submit"]');

    // 1. Fill in a username that isn't registered, with any password.
    await usernameInput.fill('nonexistentuser999');
    await passwordInput.fill(PASSWORD);
    await expect(loginButton).toBeEnabled();

    // 2. Attempt to log in.
    await loginButton.click();

    // 3. The app shows the same generic error as a wrong password — it
    // never reveals whether the username itself exists.
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

  test('should navigate to the registration page when clicking Sign Up', async ({ page }) => {
    // 1. Click the Sign Up link.
    await page.locator('a[href*="register"]').click();

    // 2. Verify the browser actually navigated to the registration page.
    await expect(page).toHaveURL(`${BASE_URL}/register`);
  });
});

test.describe('Login flow - field validation messages', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
  });

  test('should show "The field is required" when blurring an empty username field', async ({ page }) => {
    // 1. Focus the username field, then blur it by focusing password
    // (still empty), without typing anything.
    await page.locator('input[name="username"]').click();
    await page.locator('input[name="password"]').click();

    // 2. Only the username field's message is shown at this point.
    await expect(page.locator('text=The field is required')).toHaveCount(1);
    await expect(page.locator('button[type="submit"]')).toBeDisabled();
  });

  test('should show "The field is required" when blurring an empty password field', async ({ page }) => {
    // 1. Focus the password field, then blur it by clicking elsewhere,
    // without typing anything (and without ever touching username).
    await page.locator('input[name="password"]').click();
    await page.getByRole('heading', { name: 'Welcome back! Please login to' }).click();

    // 2. Only the password field's message is shown at this point.
    await expect(page.locator('text=The field is required')).toHaveCount(1);
    await expect(page.locator('button[type="submit"]')).toBeDisabled();
  });

  test('should show independent required messages for both fields when tabbed through empty', async ({ page }) => {
    // 1. Tab into username, then Tab again to move to password (blurring
    // username while it's still empty).
    await page.locator('input[name="username"]').click();
    await page.keyboard.press('Tab');
    await expect(page.locator('text=The field is required')).toHaveCount(1);

    // 2. Tab again to move focus away from password (blurring it too).
    await page.keyboard.press('Tab');
    await expect(page.locator('text=The field is required')).toHaveCount(2);
  });
});

test.describe('Login flow - additional behaviors', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
  });

  test('should toggle password visibility', async ({ page }) => {
    const passwordInput = page.locator('input[name="password"]');
    const toggleButton = page.getByRole('button', { name: 'toggle password visibility' });

    // 1. Type a password; it's masked by default.
    await passwordInput.fill(PASSWORD);
    await expect(passwordInput).toHaveAttribute('type', 'password');

    // 2. Clicking the eye icon reveals it as plain text.
    await toggleButton.click();
    await expect(passwordInput).toHaveAttribute('type', 'text');

    // 3. Clicking it again hides it once more.
    await toggleButton.click();
    await expect(passwordInput).toHaveAttribute('type', 'password');
  });

  test('should submit login by pressing Enter with valid credentials', async ({ page }) => {
    // 1. Fill valid credentials.
    await page.locator('input[name="username"]').fill(TEST_USERNAME);
    const passwordInput = page.locator('input[name="password"]');
    await passwordInput.fill(PASSWORD);

    // 2. Press Enter instead of clicking Log In.
    await passwordInput.press('Enter');

    // 3. Enter triggers a real submission, producing the same result as
    // clicking the Log In button.
    await expect(page).toHaveURL(/.*\/(company|teams\/list)$/);
    await expect(page.getByRole('tab', { name: 'Company', selected: true })).toBeVisible();
  });

  test('should submit login by pressing Enter with invalid credentials', async ({ page }) => {
    // 1. Fill an incorrect password.
    await page.locator('input[name="username"]').fill(TEST_USERNAME);
    const passwordInput = page.locator('input[name="password"]');
    await passwordInput.fill(WRONG_PASSWORD);

    // 2. Press Enter instead of clicking Log In.
    await passwordInput.press('Enter');

    // 3. Enter still triggers a real submission (not just a focus change),
    // so the same error appears as clicking Log In would produce.
    await expect(page.locator('text=Incorrect username or password.')).toBeVisible();
    await expect(page).toHaveURL(`${BASE_URL}/login`);
  });

  test('should not trim leading/trailing whitespace and should fail login', async ({ page }) => {
    const usernameInput = page.locator('input[name="username"]');
    const paddedUsername = `  ${TEST_USERNAME}  `;

    // 1. Enter a valid username padded with spaces and the correct password.
    await usernameInput.fill(paddedUsername);
    await page.locator('input[name="password"]').fill(PASSWORD);

    // 2. The raw input value keeps the whitespace — it isn't auto-trimmed.
    await expect(usernameInput).toHaveValue(paddedUsername);

    // 3. Submitting fails: the padded value doesn't match the stored username.
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('text=Incorrect username or password.')).toBeVisible();
  });

  test('should redirect away from /login when already authenticated', async ({ page }) => {
    // 1. Log in normally.
    await page.locator('input[name="username"]').fill(TEST_USERNAME);
    await page.locator('input[name="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/.*\/(company|teams\/list)$/);

    // 2. Visiting /login again while still authenticated redirects away
    // instead of showing the login form.
    await page.goto(`${BASE_URL}/login`);
    await expect(page).toHaveURL(/.*\/(company|teams\/list)$/);
  });
});
