import { test, expect } from '@playwright/test';
import { requireEnv } from './utils/env';

const BASE_URL = requireEnv('BASE_URL');
const REGISTERED_EMAIL = `${requireEnv('TEST_EMAIL_USER')}+sc1${requireEnv('TEST_EMAIL_DOMAIN')}`;
const INVALID_EMAIL = 'invalid-email';
const CASE_INSENSITIVE_EMAIL = REGISTERED_EMAIL.toUpperCase();

test.describe('Forgot Password flow', () => {
  test('should show forgot password link and navigate to forgot password page', async ({ page }) => {
    // 1. Open the login page.
    await page.goto(`${BASE_URL}/login`);

    // 2. Verify that the forgot password link is visible.
    const forgotLink = page.locator('a[href="/forgot-password"]');
    await expect(forgotLink).toBeVisible();
    await expect(forgotLink).toHaveText(/Forgot your Password\?/);

    // 3. Click the forgot password link.
    await forgotLink.click();

    // 4. Verify that it navigates to the forgot password page.
    await expect(page).toHaveURL(`${BASE_URL}/forgot-password`);
    await expect(page.locator('input[name="username"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });

  test('should keep Continue disabled when email is empty', async ({ page }) => {
    // 1. Open the forgot password page.
    await page.goto(`${BASE_URL}/forgot-password`);

    // 2. Verify that the email field is visible and the Continue button is disabled.
    await expect(page.locator('input[name="username"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeDisabled();
  });

  test('should navigate to reset password after submitting a registered email', async ({ page }) => {
    // 1. Open the forgot password page.
    await page.goto(`${BASE_URL}/forgot-password`);

    // 2. Enter a valid registered email.
    const emailInput = page.locator('input[name="username"]');
    const continueButton = page.locator('button[type="submit"]');
    await emailInput.click();
    await emailInput.fill(REGISTERED_EMAIL);

    // 3. Verify that the Continue button becomes enabled.
    await expect(continueButton).toBeEnabled();

    // 4. Submit the password recovery request.
    await continueButton.click();

    // 5. Verify that it redirects to reset-password and shows the confirmation message.
    await expect(page).toHaveURL(/.*\/reset-password$/);
    await expect(page.locator('text=We have sent a password reset code in an email message')).toBeVisible();
  });

  test('should navigate to reset password when submitting an invalid email format', async ({ page }) => {
    // 1. Open the forgot password page.
    await page.goto(`${BASE_URL}/forgot-password`);

    // 2. Enter an email value with an invalid format.
    const emailInput = page.locator('input[name="username"]');
    const continueButton = page.locator('button[type="submit"]');
    await emailInput.click();
    await emailInput.fill(INVALID_EMAIL);

    // 3. Verify that the Continue button becomes enabled.
    await expect(continueButton).toBeEnabled();

    // 4. Submit the request and validate the flow.
    await continueButton.click();
    await expect(page).toHaveURL(/.*\/reset-password$/);
    await expect(page.locator('text=We have sent a password reset code in an email message')).toBeVisible();
  });

  test('should navigate back to login from forgot password page', async ({ page }) => {
    // 1. Open the forgot password page.
    await page.goto(`${BASE_URL}/forgot-password`);

    // 2. Verify that the Back link is visible.
    const backLink = page.locator('a[href="/login"]');
    await expect(backLink).toBeVisible();
    await expect(backLink).toHaveText('Back');

    // 3. Click the back option.
    await backLink.click();

    // 4. Verify that it returns to the login page.
    await expect(page).toHaveURL(`${BASE_URL}/login`);
  });

  test('should accept case insensitive email on forgot password request', async ({ page }) => {
    // 1. Open the forgot password page.
    await page.goto(`${BASE_URL}/forgot-password`);

    // 2. Enter the registered email using mixed uppercase and lowercase.
    const emailInput = page.locator('input[name="username"]');
    const continueButton = page.locator('button[type="submit"]');
    await emailInput.click();
    await emailInput.fill(CASE_INSENSITIVE_EMAIL);
    await expect(continueButton).toBeEnabled();

    // 3. Submit the request.
    await continueButton.click();

    // 4. Verify that the flow continues and the confirmation is shown.
    await expect(page).toHaveURL(/.*\/reset-password$/);
    await expect(page.locator('text=We have sent a password reset code in an email message')).toBeVisible();
  });
});
