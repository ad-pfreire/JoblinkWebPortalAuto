import { Page, expect } from '@playwright/test';

// Read by computed background-color because 'selected' has no ARIA equivalent
// and MUI's class names change between loads.
const SELECTED_CARD_BACKGROUND = 'rgba(255, 196, 0, 0.25)';

export async function getPlanCardState(page: Page, planName: string): Promise<{ selected: boolean; cursor: string; text: string }> {
  return page.evaluate(
    ({ name, selectedBg }) => {
      const heading = Array.from(document.querySelectorAll('h4')).find((h) => h.textContent === name);
      if (!heading) throw new Error(`No plan card heading found for "${name}"`);
      const card = heading.parentElement?.parentElement;
      if (!card) throw new Error(`Could not find card ancestor for "${name}"`);
      const style = getComputedStyle(card);
      return { selected: style.backgroundColor === selectedBg, cursor: style.cursor, text: card.textContent || '' };
    },
    { name: planName, selectedBg: SELECTED_CARD_BACKGROUND }
  );
}

export async function clickPlanCard(page: Page, planName: string) {
  await page.getByRole('heading', { name: planName, exact: true }).click();
}

/**
 * Selects a plan and clicks 'Continue' - the first step toward 'Review
 * Purchase' or 'Update Subscription'.
 *
 * Skips the click when the card is already selected, since clicking it again
 * toggles it OFF. But some card must be clicked at least once per page load:
 * otherwise 'Continue' looks enabled, clicks fine, and silently does nothing.
 */
export async function selectPlanAndContinue(page: Page, planName: string) {
  const state = await getPlanCardState(page, planName);
  if (!state.selected) {
    await clickPlanCard(page, planName);
  }
  const continueButton = page.getByRole('button', { name: 'Continue', exact: true });
  await expect(continueButton).toBeEnabled();
  await continueButton.click();
}

/** Opens 'Cancel Subscription' and clicks 'Finish Cancellation', asserting the resulting lapse notice. */
export async function cancelSubscriptionAndFinish(page: Page) {
  await page.getByRole('button', { name: 'Cancel Subscription', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Cancel Subscription', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Finish Cancellation' }).click();
  await expect(
    page.getByText(/^You are currently on the .+ plan\. You will lose these features on .+ unless you resubscribe\.$/)
  ).toBeVisible();
}
