import { Page, expect } from '@playwright/test';

// The 'selected' state has no ARIA equivalent and MUI's class names are
// non-deterministic across loads, so plan-card state is read from the
// ancestor's computed background-color instead (see CLAUDE.md's
// DOM-inspection pattern for un-role-able state).
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
 * Selects a paid plan card and clicks 'Continue' - the shared first step to
 * reach 'Review Purchase' or 'Update Subscription'. Only clicks the card if it
 * is not already selected: clicking an already-selected card is a real toggle
 * that deselects it.
 *
 * Always click the target plan's own card at least once per fresh page load,
 * even when it is already the current plan - 'Continue' can look enabled and
 * click cleanly while its handler does nothing otherwise (see CLAUDE.md).
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
