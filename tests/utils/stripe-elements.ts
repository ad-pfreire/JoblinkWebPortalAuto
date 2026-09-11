import { Page, FrameLocator } from '@playwright/test';

/**
 * Finds the one real `iframe[title="..."]` by looking inside each candidate for
 * `expectedFieldName`, then anchors to that iframe's own `name`.
 *
 * Stripe mounts decoy iframes sharing the exact same title, and can swap the
 * real one mid-test - so neither the title nor `.nth()` stays valid, but the
 * resolved `name` does. Polls because the iframes mount after `goto()` resolves.
 *
 * @throws If no candidate holds the expected field within `timeoutMs`.
 */
export async function resolveStripeFrameByContent(
  page: Page,
  iframeTitle: string,
  expectedFieldName: string,
  timeoutMs = 15_000
): Promise<FrameLocator> {
  const deadline = Date.now() + timeoutMs;
  let lastCandidateCount = 0;
  while (Date.now() < deadline) {
    const candidates = page.locator(`iframe[title="${iframeTitle}"]`);
    lastCandidateCount = await candidates.count();
    for (let i = 0; i < lastCandidateCount; i++) {
      const candidate = candidates.nth(i);
      // A swap mid-check detaches the candidate - just try the next one.
      try {
        if ((await candidate.contentFrame().getByRole('textbox', { name: expectedFieldName }).count()) > 0) {
          const frameName = await candidate.getAttribute('name');
          return page.frameLocator(`iframe[name="${frameName}"]`);
        }
      } catch {
        continue;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `No iframe titled "${iframeTitle}" (out of ${lastCandidateCount} candidate(s)) contained a "${expectedFieldName}" textbox within ${timeoutMs}ms.`
  );
}

/**
 * The Billing Address iframe, waiting for Address line 1 too - 'Full name'
 * being present does not mean the rest of the widget has mounted (CI-only gap).
 */
export async function billingAddressFrame(page: Page): Promise<FrameLocator> {
  const frame = await resolveStripeFrameByContent(page, 'Secure address input frame', 'Full name');
  await frame.locator('#billingAddress-addressLine1Input').waitFor({ state: 'attached', timeout: 15_000 });
  return frame;
}

/** The Card iframe. */
export async function cardElementFrame(page: Page): Promise<FrameLocator> {
  return resolveStripeFrameByContent(page, 'Secure payment input frame', 'Card number');
}
