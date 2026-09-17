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

/**
 * Moves focus off `field` by clicking `blurTarget`, then returns what the field
 * actually holds once its value settles.
 *
 * Read the value back instead of assuming it: a 2026-09-17 pre-staging deploy
 * made every text field in this app strip leading/trailing whitespace ON BLUR
 * (live-verified on Login's username, Profile's First Name and the Create Team
 * modal's Name - the value stays padded while the field still has focus, so a
 * read before the blur proves nothing). Staging still runs the older build that
 * keeps the padding, and the two environments lag each other by weeks, so a
 * test that hardcodes either outcome goes red on the other one - see CLAUDE.md's
 * "the suite has to tolerate both builds" rule.
 */
export async function blurAndReadValue(field: Locator, blurTarget: Locator): Promise<string> {
  await blurTarget.click();
  // The trim lands within a tick, but poll for two matching reads rather than
  // racing it - this decides which branch a test then asserts.
  let previous = await field.inputValue();
  for (let i = 0; i < 10; i++) {
    await field.page().waitForTimeout(150);
    const current = await field.inputValue();
    if (current === previous) return current;
    previous = current;
  }
  return previous;
}
