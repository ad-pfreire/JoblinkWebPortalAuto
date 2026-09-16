// Repair script, NOT a test. Run it explicitly:
//
//   PROVISION=1 npx playwright test --project=provision --grep "restore the seed"
//
// Puts the shared seed account's Company Name back to its baseline after a run
// died between company-details 4.1/4.1b's temporary value and its own restore
// step. CLAUDE.md documented that recovery as "do it by hand"; this is the same
// steps, done the way the tests themselves do it (real keystrokes, never
// fill(), and verified through a genuine reload).
//
// Live-verified 2026-09-16, when two CI runs raced on the same seed account and
// left it holding 'QA Automation Test Co TEMP'.
import { test, expect } from '@playwright/test';
import { requireEnv } from '../utils/env';
import { clearFieldWithBackspace } from '../utils/forms';
import { loginAndGoToCompany } from '../utils/auth';

const BASE_URL = requireEnv('BASE_URL');
const BASELINE = 'QA Automation Test Co';

test('restore the seed account Company Name to its baseline', async ({ page }) => {
  test.skip(
    !process.env.PROVISION,
    'Repair script: it writes to the shared seed account, so it only runs when asked for deliberately - PROVISION=1 npx playwright test --project=provision'
  );
  test.setTimeout(240_000);
  await loginAndGoToCompany(page, requireEnv('TEST_USERNAME'), requireEnv('TEST_LOGIN_PASSWORD'));
  await page.goto(`${BASE_URL}/company?edit=true`);

  const companyName = page.getByRole('textbox', { name: 'Company Name' });
  await expect(companyName).not.toHaveValue('');
  const current = await companyName.inputValue();
  console.log(`[restore] valor actual: ${JSON.stringify(current)}`);
  if (current === BASELINE) {
    console.log('[restore] ya esta en su valor correcto, no se toca nada');
    return;
  }

  // Real keystrokes, never fill(): fill() has a live-verified race on this
  // exact field that appends instead of replacing (see CLAUDE.md).
  await clearFieldWithBackspace(page, companyName);
  await companyName.pressSequentially(BASELINE);
  await expect(companyName).toHaveValue(BASELINE);

  const saveResponse = page.waitForResponse((r) => r.url().includes('/company?edit=true') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save' }).click();
  expect((await saveResponse).status()).toBe(200);
  await expect(page).toHaveURL(`${BASE_URL}/company`, { timeout: 30_000 });

  // Confirm through a genuine reload, not just the in-page state.
  await page.goto(`${BASE_URL}/company?edit=true`);
  await expect(companyName).toHaveValue(BASELINE, { timeout: 20_000 });
  console.log(`[restore] restaurado y verificado tras recarga: ${JSON.stringify(BASELINE)}`);
});
