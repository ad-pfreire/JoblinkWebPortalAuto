import { Page, expect } from '@playwright/test';
import { requireEnv } from './env';

const BASE_URL = requireEnv('BASE_URL');

/**
 * Logs in through the real login form and waits for the post-login landing.
 *
 * The landing URL is matched as `/company` OR `/teams/list` on purpose: which
 * one the app picks varies by account state, so pinning either one alone makes
 * the helper fail for the other kind of account.
 */
export async function login(page: Page, username: string, password: string): Promise<void> {
  await page.goto(`${BASE_URL}/login`);
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });
}

/** Logs in, then navigates to /company regardless of which page login landed on. */
export async function loginAndGoToCompany(page: Page, username: string, password: string): Promise<void> {
  await login(page, username, password);
  await page.goto(`${BASE_URL}/company`);
}
