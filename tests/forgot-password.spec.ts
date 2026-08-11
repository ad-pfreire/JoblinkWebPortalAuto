import { test, expect, Page } from '@playwright/test';
import { requireEnv } from './utils/env';
import { getVerificationLink, getPasswordResetCode } from './utils/email';
import { generateUniqueEmailAlias, generateUsernameFromEmail, registerNewAccount, completeProfile } from './utils/account';

const BASE_URL = requireEnv('BASE_URL');
const REGISTERED_EMAIL = `${requireEnv('TEST_EMAIL_USER')}+automation${requireEnv('TEST_EMAIL_DOMAIN')}`;
const INVALID_EMAIL = 'invalid-email';
const CASE_INSENSITIVE_EMAIL = REGISTERED_EMAIL.toUpperCase();
// A syntactically valid but never-registered address (same style of example
// the test plan verifies behaves identically to a registered one — see
// specs/forgot-password-test-plan.md section 2.4). Used for the
// reset-password page tests below so they don't depend on, or interfere
// with, the real REGISTERED_EMAIL inbox. Generated fresh per call (rather
// than a single shared literal) because parallel workers submitting the
// exact same address to /forgot-password at the same moment were
// occasionally left on /forgot-password instead of redirecting — the
// backend appears to debounce identical concurrent requests.
function generateUnregisteredEmail() {
  return `noexiste-qa-test-${Date.now().toString(36)}${Math.floor(Math.random() * 10000)}@crifa.com`;
}

// Drives the forgot-password form to reach /reset-password, the shared entry
// point for all of the reset-password page tests below.
async function goToResetPassword(page: Page, email: string) {
  await page.goto(`${BASE_URL}/forgot-password`);
  await page.locator('input[name="username"]').fill(email);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/.*\/reset-password$/);
}

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

test.describe('Reset Password page - UI and field validation', () => {
  test.beforeEach(async ({ page }) => {
    await goToResetPassword(page, generateUnregisteredEmail());
  });

  test('should display all required elements', async ({ page }) => {
    // 1. Verify the page title and every field/link described in the plan.
    await expect(page).toHaveTitle('Reset Password | Job Link');
    await expect(page.locator('input[name="code"]')).toHaveAttribute('placeholder', 'Enter code');
    await expect(page.locator('input[name="password"]')).toHaveAttribute('placeholder', 'Enter new password');
    await expect(page.locator('input[name="confirmPassword"]')).toHaveAttribute('placeholder', 'Re-enter new password');
    await expect(page.getByRole('button', { name: 'toggle password visibility' })).toHaveCount(2);

    // 2. The live password-strength checklist (identical to registration).
    await expect(page.locator('text=At least 8 characters')).toBeVisible();
    await expect(page.locator('text=At least 1 uppercase letter')).toBeVisible();
    await expect(page.locator('text=At least 1 lowercase letter')).toBeVisible();
    await expect(page.locator('text=At least 1 digit')).toBeVisible();
    await expect(page.locator('text=At least 1 special character')).toBeVisible();

    // 3. Back link and the Change password button's default disabled state.
    const backLink = page.locator('a[href="/forgot-password"]');
    await expect(backLink).toBeVisible();
    await expect(backLink).toHaveText('Back');
    await expect(page.locator('button[type="submit"]')).toBeDisabled();
  });

  test('should show "The field is required" when blurring the empty Code field', async ({ page }) => {
    // 1. Focus Code, then blur it by focusing New Password, without typing.
    await page.locator('input[name="code"]').click();
    await page.locator('input[name="password"]').click();

    // 2. The required-field message appears under Code.
    await expect(page.locator('text=The field is required')).toBeVisible();
  });

  test('should show "Passwords do not match" when New Password and Confirm New Password differ', async ({ page }) => {
    // 1. Fill a strong New Password and a different Confirm New Password.
    await page.locator('input[name="password"]').fill('NewStrongPass1!');
    await page.locator('input[name="confirmPassword"]').fill('DoesNotMatch1!');

    // 2. Blur Confirm New Password via a neutral element (not a link, so the
    // page doesn't navigate away).
    await page.getByRole('heading', { name: 'Job Link' }).click();

    // 3. The mismatch message appears under Confirm New Password.
    await expect(page.locator('text=Passwords do not match')).toBeVisible();
  });

  test('should show "The code is no longer valid." for a wrong reset code and not change the password', async ({ page }) => {
    const changePasswordButton = page.locator('button[type="submit"]');

    // 1. Fill an arbitrary wrong code with a matching strong password.
    await page.locator('input[name="code"]').fill('000000');
    await page.locator('input[name="password"]').fill('NewStrongPass1!');
    await page.locator('input[name="confirmPassword"]').fill('NewStrongPass1!');
    await expect(changePasswordButton).toBeEnabled();

    // 2. Submit and verify the error banner.
    await changePasswordButton.click();
    await expect(page.locator('text=The code is no longer valid.')).toBeVisible();

    // 3. The browser stays on /reset-password and the button reverts to
    // disabled after the failed attempt.
    await expect(page).toHaveURL(/.*\/reset-password$/);
    await expect(changePasswordButton).toBeDisabled();
  });
});

test.describe('Reset Password page - additional behaviors', () => {
  test.beforeEach(async ({ page }) => {
    await goToResetPassword(page, generateUnregisteredEmail());
  });

  test('should toggle New Password and Confirm New Password visibility independently', async ({ page }) => {
    const newPasswordInput = page.locator('input[name="password"]');
    const confirmPasswordInput = page.locator('input[name="confirmPassword"]');
    const toggleButtons = page.getByRole('button', { name: 'toggle password visibility' });

    // 1. New Password is masked by default; its own toggle reveals it.
    await newPasswordInput.fill('NewStrongPass1!');
    await expect(newPasswordInput).toHaveAttribute('type', 'password');
    await toggleButtons.nth(0).click();
    await expect(newPasswordInput).toHaveAttribute('type', 'text');

    // 2. Confirm New Password is still masked — the two toggles don't affect
    // each other.
    await confirmPasswordInput.fill('NewStrongPass1!');
    await expect(confirmPasswordInput).toHaveAttribute('type', 'password');
    await toggleButtons.nth(1).click();
    await expect(confirmPasswordInput).toHaveAttribute('type', 'text');

    // 3. New Password's own toggle state is unaffected by Confirm's toggle.
    await expect(newPasswordInput).toHaveAttribute('type', 'text');
  });

  test('should navigate back to the forgot password page, not login', async ({ page }) => {
    // 1. Click Back on /reset-password.
    const backLink = page.locator('a[href="/forgot-password"]');
    await backLink.click();

    // 2. It goes one step back in the flow, not all the way to login.
    await expect(page).toHaveURL(`${BASE_URL}/forgot-password`);
  });
});

// These two suites mutate real backend state (a real password change, a real
// account deletion) and each register their own disposable, run-unique
// account first — never the shared seed account
// (pfautomation / paul.freire+automation@crifa.com) that every other test
// file here depends on.
test.describe('Full end-to-end password reset (real email, real code)', () => {
  test.describe.configure({ retries: 1 });

  test('should complete a real reset with the emailed code and allow login with the new password @real-email', async ({ page, browserName }) => {
    // Backend-only flow; runs once to avoid tripling load on the real email
    // pipeline (same rationale as account-registration.spec.ts).
    test.skip(browserName !== 'chromium', 'Backend-only flow; runs once to avoid tripling load on the real email pipeline.');
    test.setTimeout(300_000);

    // 1. Register a new, run-unique disposable account and verify its email.
    const emailAlias = generateUniqueEmailAlias();
    const username = generateUsernameFromEmail(emailAlias);
    const registeredAt = new Date();
    await registerNewAccount(page, emailAlias);
    const verificationLink = await getVerificationLink(emailAlias, registeredAt);
    await page.goto(verificationLink);
    await expect(page).toHaveURL(`${BASE_URL}/login`);

    // 2. Request a password reset for the freshly-verified account.
    const resetRequestedAt = new Date();
    await page.goto(`${BASE_URL}/forgot-password`);
    await page.locator('input[name="username"]').fill(emailAlias);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/.*\/reset-password$/);

    // 3. Fetch the real 6-digit code from the "Password Recovery" email.
    const code = await getPasswordResetCode(emailAlias, resetRequestedAt);

    // 4. Submit the real code with a new password (different from the
    // original registration password).
    const newPassword = 'NewStrongPass1!';
    await page.locator('input[name="code"]').fill(code);
    await page.locator('input[name="password"]').fill(newPassword);
    await page.locator('input[name="confirmPassword"]').fill(newPassword);
    await page.locator('button[type="submit"]').click();

    // 5. A success banner appears and the browser redirects to /login.
    await expect(page.locator('text=Your password has been reset successfully.')).toBeVisible();
    await expect(page).toHaveURL(`${BASE_URL}/login`);

    // 6. Logging in with the NEW password proves it was genuinely changed in
    // the backend, not just a UI-only confirmation.
    await page.locator('input[name="username"]').fill(username);
    await page.locator('input[name="password"]').fill(newPassword);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/.*\/(complete-profile|company|teams\/list)$/, { timeout: 15_000 });
  });
});

test.describe('Account deletion (Profile settings)', () => {
  test.describe.configure({ retries: 1 });

  test('should delete the account via "Delete Account" and prevent it from logging in again @real-email', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Backend-only flow; runs once to avoid tripling load on the real email pipeline.');
    test.setTimeout(300_000);

    // 1. Register, verify, log in, and complete the profile for a new
    // disposable account.
    const emailAlias = generateUniqueEmailAlias();
    const username = generateUsernameFromEmail(emailAlias);
    const password = requireEnv('TEST_REGISTER_PASSWORD');
    const registeredAt = new Date();
    await registerNewAccount(page, emailAlias);
    const verificationLink = await getVerificationLink(emailAlias, registeredAt);
    await page.goto(verificationLink);
    await expect(page).toHaveURL(`${BASE_URL}/login`);

    await page.locator('input[name="username"]').fill(username);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(`${BASE_URL}/complete-profile`);
    await completeProfile(page);
    await expect(page).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });

    // 2. Open the account menu and go to Profile.
    await page.getByRole('button', { name: 'account of current user' }).click();
    await page.getByRole('menuitem', { name: 'Profile' }).click();
    await expect(page).toHaveURL(`${BASE_URL}/profile`);

    // 3. Open the delete confirmation dialog and verify its content,
    // including the known copy typo ("want o delete" — missing "t").
    await page.getByRole('button', { name: 'Delete Account' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Delete Account' })).toBeVisible();
    await expect(dialog.locator('text=Are you sure you want o delete your Job Link Account?')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'No, go back' })).toBeVisible();

    // 4. Confirm deletion.
    await dialog.getByRole('button', { name: 'Yes, delete' }).click();
    await expect(page).toHaveURL(`${BASE_URL}/login`);

    // 5. Extra strength check beyond the base plan: the deleted account can
    // no longer log in, proving the deletion is real and backend-confirmed.
    await page.locator('input[name="username"]').fill(username);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('text=Incorrect username or password.')).toBeVisible();
  });
});
