import { test, expect } from '@playwright/test';
import { requireEnv } from './utils/env';

const BASE_URL = requireEnv('BASE_URL');
const BASE_EMAIL = requireEnv('TEST_EMAIL_USER');
const EMAIL_DOMAIN = requireEnv('TEST_EMAIL_DOMAIN');
const TEST_ALIAS_PREFIX = 'autotest';
let aliasCounter = 0;

function generateEmailAlias(suffix: string) {
  return `${BASE_EMAIL}+${suffix}${EMAIL_DOMAIN}`;
}

function generateNextEmailAlias() {
  aliasCounter += 1;
  return generateEmailAlias(`${TEST_ALIAS_PREFIX}${aliasCounter}`);
}

function generateUsernameFromEmail(email: string) {
  const baseUsername = BASE_EMAIL.replace(/\./g, '');
  const localPart = email.split('@')[0];
  const normalized = localPart.replace(/\./g, '').replace(/\+/g, '');
  return normalized.startsWith(baseUsername) ? normalized : `${baseUsername}${normalized}`;
}

async function registerNewAccount(page: any, emailAlias: string) {
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

  await expect(page).toHaveURL(/.*\/email-verification$/);
  await expect(page.locator('text=Job Link Email Verification')).toBeVisible();
  await expect(page.locator('text=We send you a verification email')).toBeVisible();
}

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
    // 1. Generate a new alias and register the account.
    const emailAlias = generateNextEmailAlias();
    await registerNewAccount(page, emailAlias);
  });
});
