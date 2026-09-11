import { Page, expect } from '@playwright/test';
import { requireEnv } from './env';

const BASE_URL = requireEnv('BASE_URL');

/**
 * Logs in and waits for the landing page.
 *
 * Accepts `/company` OR `/teams/list`: the app picks one based on account
 * state, so pinning either alone breaks for the other kind of account.
 */
export async function login(page: Page, username: string, password: string): Promise<void> {
  await page.goto(`${BASE_URL}/login`);
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });
}

/** Logs in and lands on /company, whichever page login itself landed on. */
export async function loginAndGoToCompany(page: Page, username: string, password: string): Promise<void> {
  await login(page, username, password);
  await page.goto(`${BASE_URL}/company`);
}
