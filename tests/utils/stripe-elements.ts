import { Page, FrameLocator } from '@playwright/test';

/**
 * Resolves an ambiguous `iframe[title="..."]` selector to the one candidate
 * containing `expectedFieldName`, polling until it mounts.
 *
 * Resolving by CONTENT rather than by attribute or DOM order is load-bearing:
 * Stripe can mount several iframes sharing the exact same title (a hidden
 * autocomplete accessory frame, or Link's own WebAuthn frame), and the real
 * interactive frame can be SWAPPED for a new instance mid-test. The returned
 * FrameLocator is rebuilt from the resolved candidate's own `name` attribute,
 * which is stable for that mounted instance's lifetime, unlike a title-based
 * or `.nth()` selector that Playwright re-evaluates on every later action.
 * See CLAUDE.md's Stripe iframe-swap gotcha for the full investigation.
 *
 * @throws If no candidate contains the expected field within `timeoutMs`.
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
      // A candidate can detach between count() and getAttribute() if Stripe swaps it mid-check.
      try {
        if ((await candidate.contentFrame().getByRole('textbox', { name: expectedFieldName }).count()) > 0) {
          const frameName = await candidate.getAttribute('name');
          return page.frameLocator(`iframe[name="${frameName}"]`);
        }
      } catch {
        // Fall through to the next poll iteration.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `No iframe titled "${iframeTitle}" (out of ${lastCandidateCount} candidate(s)) contained a "${expectedFieldName}" textbox within ${timeoutMs}ms.`
  );
}

/**
 * Resolves the Billing Address iframe (probes 'Full name'), also waiting for
 * Address line 1's id to attach - the sentinel field mounting does NOT mean
 * the rest of the widget has (a CI-only gap, see CLAUDE.md).
 */
export async function billingAddressFrame(page: Page): Promise<FrameLocator> {
  const frame = await resolveStripeFrameByContent(page, 'Secure address input frame', 'Full name');
  await frame.locator('#billingAddress-addressLine1Input').waitFor({ state: 'attached', timeout: 15_000 });
  return frame;
}

/** Resolves the Card CardElement iframe, probing for 'Card number'. */
export async function cardElementFrame(page: Page): Promise<FrameLocator> {
  return resolveStripeFrameByContent(page, 'Secure payment input frame', 'Card number');
}
