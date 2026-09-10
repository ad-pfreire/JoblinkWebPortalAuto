import { Page, Locator } from '@playwright/test';

/**
 * Clears a field via real Backspace keystrokes rather than `fill('')`.
 *
 * Two separate reasons, both live-verified (see CLAUDE.md): a form library's
 * validation can fire differently for a one-shot `fill()` than for real
 * per-character clearing, and `fill()` on some fields has been observed to
 * fail to clear the existing value at all, appending instead of replacing -
 * which once corrupted the real shared seed account in CI.
 */
export async function clearFieldWithBackspace(page: Page, field: Locator) {
  await field.click();
  await page.keyboard.press('End');
  const currentLength = (await field.inputValue()).length;
  for (let i = 0; i < currentLength; i++) {
    await page.keyboard.press('Backspace');
  }
}
