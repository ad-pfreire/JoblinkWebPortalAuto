import { Page, Locator } from '@playwright/test';

/**
 * Clears a field with real Backspace keystrokes.
 *
 * Never use `fill('')` for this: it has been caught appending instead of
 * replacing (which corrupted the real seed account in CI), and validation can
 * fire differently for a one-shot fill than for per-character clearing.
 */
export async function clearFieldWithBackspace(page: Page, field: Locator) {
  await field.click();
  await page.keyboard.press('End');
  const currentLength = (await field.inputValue()).length;
  for (let i = 0; i < currentLength; i++) {
    await page.keyboard.press('Backspace');
  }
}
