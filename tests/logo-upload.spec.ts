// spec: specs/logo-upload-test-plan.md
// seed: tests/seed.spec.ts

import { test, expect, Page } from '@playwright/test';
import { requireEnv } from './utils/env';

const BASE_URL = requireEnv('BASE_URL');
const SEED_USERNAME = requireEnv('TEST_USERNAME');
const SEED_PASSWORD = requireEnv('TEST_LOGIN_PASSWORD');

/** Logs in as the shared seed account and lands on /company. */
async function loginAsSeedAndGoToCompany(page: Page) {
  await page.goto(`${BASE_URL}/login`);
  await page.locator('input[name="username"]').fill(SEED_USERNAME);
  await page.locator('input[name="password"]').fill(SEED_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });
  await page.goto(`${BASE_URL}/company`);
  await expect(page.getByRole('button', { name: 'Upload' })).toBeVisible();
}

/** Scopes to the real Logo Upload card, not its hidden mobile-accordion duplicate heading. */
function logoUploadCard(page: Page) {
  return page.locator('.MuiCard-root').filter({ has: page.getByRole('button', { name: 'Upload' }) });
}

/** Injects a synthetic image via canvas + DataTransfer + "change" - unlike Profile Photo, no crop modal, fires the real POST immediately. */
async function injectLogoImageFile(
  page: Page,
  { width, height, fileName, mimeType = 'image/png', color = 'blue' }: { width: number; height: number; fileName: string; mimeType?: string; color?: string }
) {
  await page.evaluate(
    async ({ width, height, fileName, mimeType, color }) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, width, height);
      const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b!), mimeType));
      const file = new File([blob], fileName, { type: mimeType });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.querySelector<HTMLInputElement>('input[name="logo"]')!;
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { width, height, fileName, mimeType, color }
  );
}

/** Same as `injectLogoImageFile()` but fills the canvas with random noise, so the PNG can't compress away to almost nothing (used for oversized-file tests). */
async function injectNoisyLogoImageFile(page: Page, { width, height, fileName }: { width: number; height: number; fileName: string }) {
  await page.evaluate(
    async ({ width, height, fileName }) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;
      const imageData = ctx.createImageData(width, height);
      for (let i = 0; i < imageData.data.length; i++) imageData.data[i] = Math.floor(Math.random() * 256);
      ctx.putImageData(imageData, 0, 0);
      const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
      const file = new File([blob], fileName, { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.querySelector<HTMLInputElement>('input[name="logo"]')!;
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { width, height, fileName }
  );
}

/** Injects a plain-text file, bypassing the `accept` attribute, to probe whether the app validates beyond the filename filter. */
async function injectTextLogoFile(page: Page, fileName: string, content: string) {
  await page.evaluate(
    ({ fileName, content }) => {
      const file = new File([new Blob([content], { type: 'text/plain' })], fileName, { type: 'text/plain' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.querySelector<HTMLInputElement>('input[name="logo"]')!;
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { fileName, content }
  );
}

/** Injects a file with random byte content (or 0 bytes) under a given filename/MIME type, simulating a corrupted or empty file. */
async function injectRawBytesLogoFile(page: Page, { fileName, mimeType, byteLength = 0 }: { fileName: string; mimeType: string; byteLength?: number }) {
  await page.evaluate(
    ({ fileName, mimeType, byteLength }) => {
      const bytes = new Uint8Array(byteLength);
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
      const file = new File([bytes], fileName, { type: mimeType });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.querySelector<HTMLInputElement>('input[name="logo"]')!;
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { fileName, mimeType, byteLength }
  );
}

/** Polls for the logo `<img src>` to stop changing (3 matching reads) before treating it final - the backend can swap it for ~15s post-upload (see CLAUDE.md). */
async function waitForStableImageSrc(image: import('@playwright/test').Locator, differentFrom?: string | null): Promise<string> {
  let previous: string | null = null;
  let matchStreak = 0;
  for (let i = 0; i < 25; i++) {
    const current = await image.getAttribute('src');
    if (current && current === previous && current !== differentFrom) {
      matchStreak += 1;
      if (matchStreak >= 3) return current;
    } else {
      matchStreak = 0;
    }
    previous = current;
    await image.page().waitForTimeout(1000);
  }
  throw new Error(`Logo image src never stabilized after upload; last seen value: ${previous}`);
}

/** Injects a logo file and waits for the real POST /company response, not just the toast (needed since 2.2 uploads twice in close succession - see CLAUDE.md). */
async function injectLogoImageFileAndWaitForUpload(
  page: Page,
  options: { width: number; height: number; fileName: string; mimeType?: string; color?: string }
) {
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/company'),
    injectLogoImageFile(page, options),
  ]);
  expect(response.ok()).toBe(true);
}

// This generic dialog text is shared by every size/dimension/undecodable-file rejection - it never names which rule failed.
const LOGO_ERROR_MESSAGE = 'Your logo needs to be at least 150x150 px and should not exceed 500KB. Please review your file and try again.';

/** Locates the error dialog's heading - the only `<h5>` on the page, disambiguating it from two other hidden elements sharing the same text. */
function logoErrorDialogHeading(page: Page) {
  return page.getByRole('heading', { name: 'Logo Upload', exact: true, level: 5 });
}

/** Asserts the generic rejection dialog and dismisses it via 'Continue' - shared by every 3.3 sub-case. */
async function expectLogoErrorDialogAndDismiss(page: Page) {
  const dialogHeading = logoErrorDialogHeading(page);
  await expect(dialogHeading).toBeVisible();
  await expect(page.getByText(LOGO_ERROR_MESSAGE)).toBeVisible();
  const continueButton = page.getByRole('button', { name: 'Continue' });
  await expect(continueButton).toBeVisible();
  await continueButton.click();
  await expect(dialogHeading).toBeHidden();
}

// Reads/writes the shared seed account - serial + chromium-only avoids racing parallel browser projects (see CLAUDE.md).
test.describe('Logo Upload', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Shared seed account state; runs once serially on chromium to avoid cross-project races on the same account.');
    await loginAsSeedAndGoToCompany(page);
  });

  test.describe('Logo Upload — Empty/Default State', () => {
    test('1.1 Logo Upload card shows a placeholder image and expected caption/button when no logo has ever been uploaded', async ({ page }) => {
      // 1. Land on /company before making any edits (done by beforeEach).
      await expect(page).toHaveTitle('Company | Job Link');

      const card = logoUploadCard(page);
      await expect(card.getByText('Logo Upload', { exact: true })).toBeVisible();

      // ADAPTED: this account permanently has a saved logo (required-field
      // side effect, see CLAUDE.md), so this doesn't assert the plan's
      // "shows a placeholder" check - only what holds true regardless.
      await expect(card.getByRole('heading', { name: 'Make sure your logo has at least 150x150 px and no more than 500KB' })).toBeVisible();

      // A single 'Upload' button - no 'Remove'/'Delete'/'Cancel' in the default state.
      const uploadButton = card.getByRole('button', { name: 'Upload' });
      await expect(uploadButton).toBeVisible();
      await expect(uploadButton).toBeEnabled();
      await expect(card.getByRole('button')).toHaveCount(1);
    });

    test('1.2 Clicking Upload opens the native OS file chooser directly, restricted to image/jpeg and image/png only', async ({ page }) => {
      const uploadButton = logoUploadCard(page).getByRole('button', { name: 'Upload' });
      const fileInput = page.locator('input[name="logo"]');

      // 1. Click 'Upload' - a native OS file chooser opens immediately, no intermediate in-app modal.
      const fileChooserPromise = page.waitForEvent('filechooser');
      await uploadButton.click();
      const fileChooser = await fileChooserPromise;
      expect(fileChooser).toBeTruthy();

      // The input accepts only jpeg/png, single file - narrower than Profile Photo's (which also accepts webp).
      await expect(fileInput).toHaveAttribute('accept', 'image/jpeg,image/png');
      await expect(fileInput).toHaveJSProperty('multiple', false);

      // 2. Cancel the file chooser without selecting anything - a true no-op, no error/toast/partial state.
      await fileChooser.setFiles([]);
      await expect(uploadButton).toBeVisible();
      await expect(uploadButton).toBeEnabled();
    });
  });

  test.describe('Logo Upload — Valid Upload Flow (No Crop Modal)', () => {
    test('2.1 Selecting a valid image immediately uploads and saves it — no intermediate crop/preview modal exists', async ({ page }) => {
      test.slow(); // waitForStableImageSrc() can take up to ~25s (see CLAUDE.md)
      const card = logoUploadCard(page);
      const cardImage = card.locator('img');

      // 1. Select a valid, small PNG - immediately sends a real POST to /company, no confirmation step.
      await injectLogoImageFileAndWaitForUpload(page, { width: 300, height: 300, fileName: 'valid-logo.png', color: 'green' });

      // NO crop/zoom modal appears here, unlike Profile Photo Upload - the file submits directly.
      await expect(page.getByRole('dialog')).toBeHidden();
      await expect(page.getByRole('slider')).toHaveCount(0);

      await expect(page.locator('text=Your logo was uploaded successfully')).toBeVisible();

      // Image replaces the previous one immediately - wait for the backend's async post-processing to settle first.
      await expect(cardImage).toBeVisible();
      const uploadedSrc = await waitForStableImageSrc(cardImage);

      // 2. Reload (full navigation) - persists, confirming a genuine backend save.
      await page.goto(`${BASE_URL}/company`);
      await expect(cardImage).toBeVisible();
      await expect(cardImage).toHaveAttribute('src', uploadedSrc);

      // Minor quirk: the success toast is shown again on this reload too, not just at upload time.
      await expect(page.locator('text=Your logo was uploaded successfully')).toBeVisible();
    });

    test("2.2 Uploading a new logo when one already exists replaces it in place — the button remains labeled 'Upload', not 'Replace'", async ({ page }) => {
      test.slow(); // same waitForStableImageSrc() cost as 2.1
      const card = logoUploadCard(page);
      const uploadButton = card.getByRole('button', { name: 'Upload' });
      const cardImage = card.locator('img');

      // 2.1's upload is still saved server-side (this describe runs serial against the one shared account).
      await expect(cardImage).toBeVisible();
      const previousSrc = await cardImage.getAttribute('src');
      expect(previousSrc).toBeTruthy();
      await expect(uploadButton).toHaveText('Upload');

      // 1. Select a different valid image via the same 'Upload' button.
      await injectLogoImageFileAndWaitForUpload(page, { width: 150, height: 150, fileName: 'replacement-logo.png', color: 'orange' });

      // Button never relabels to 'Replace'/'Change' - same button, same immediate-upload action.
      await expect(uploadButton).toHaveText('Upload');
      await expect(card.getByRole('button')).toHaveCount(1);

      // New image replaces the old one with no separate 'are you sure' confirmation step.
      await expect(page.locator('text=Your logo was uploaded successfully')).toBeVisible();
      await expect(cardImage).toBeVisible();
      const newSrc = await waitForStableImageSrc(cardImage, previousSrc);
      expect(newSrc).not.toBe(previousSrc);

      // 2. No 'Remove logo'/'Delete logo'/'Reset' affordance exists anywhere, including on hover.
      await cardImage.hover();
      await expect(page.getByRole('button', { name: /remove/i })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /delete/i })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /reset/i })).toHaveCount(0);
      await expect(page.getByRole('link', { name: /remove|delete|reset/i })).toHaveCount(0);
    });
  });

  test.describe('Logo Upload — Size and Dimension Validation', () => {
    test('3.1 A file over 500KB is rejected client-side with a generic combined error dialog, and no network request is sent', async ({ page }) => {
      const cardImage = logoUploadCard(page).locator('img');
      const previousSrc = await cardImage.getAttribute('src');

      const companyPostRequests: string[] = [];
      page.on('request', (request) => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/company') {
          companyPostRequests.push(request.url());
        }
      });

      // 1. Select a noisy 1600x1600px PNG (defeats PNG compression, guaranteeing a large real size) with valid dimensions.
      await injectNoisyLogoImageFile(page, { width: 1600, height: 1600, fileName: 'oversized-logo.png' });

      // The same generic dialog used for size, dimension, and unparseable-file rejections.
      const dialogHeading = logoErrorDialogHeading(page);
      await expect(dialogHeading).toBeVisible();
      await expect(page.getByText(LOGO_ERROR_MESSAGE)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();

      // NO POST /company is ever sent - the 500KB check runs entirely client-side, before any upload attempt.
      expect(companyPostRequests).toHaveLength(0);

      // CORRECTED: the plan claimed the logo stays visible behind the modal
      // - it's actually removed from the DOM entirely while open (harmless render quirk, not data loss), reappearing after Continue.
      await expect(cardImage).toHaveCount(0);

      // 2. Click 'Continue' to dismiss.
      await page.getByRole('button', { name: 'Continue' }).click();

      // Back to prior state - the rejected file never overwrote the saved logo.
      await expect(dialogHeading).toBeHidden();
      await expect(cardImage).toHaveAttribute('src', previousSrc!);
      await expect(logoUploadCard(page).getByRole('button', { name: 'Upload' })).toBeEnabled();
    });

    test('3.2 An image under 150x150px is rejected with the same generic error dialog, and the exact 150x150px boundary is confirmed live', async ({ page }) => {
      const cardImage = logoUploadCard(page).locator('img');
      const dialogHeading = logoErrorDialogHeading(page);

      const companyPostRequests: string[] = [];
      page.on('request', (request) => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/company') {
          companyPostRequests.push(request.url());
        }
      });

      // 1. Select a tiny-file-size image that is exactly 149x149px - 1px under the minimum on both axes.
      await injectLogoImageFile(page, { width: 149, height: 149, fileName: 'tiny-149.png', color: 'red' });
      await expect(dialogHeading).toBeVisible();
      await expect(page.getByText(LOGO_ERROR_MESSAGE)).toBeVisible();
      expect(companyPostRequests).toHaveLength(0);

      // 2. Dismiss, then select exactly 150x150px (the stated minimum).
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(dialogHeading).toBeHidden();
      await injectLogoImageFileAndWaitForUpload(page, { width: 150, height: 150, fileName: 'exact-150.png', color: 'purple' });

      // ACCEPTED - confirms the boundary is inclusive ('150x150 or larger', not 'larger than 150x150').
      await expect(dialogHeading).toBeHidden();
      await expect(page.locator('text=Your logo was uploaded successfully')).toBeVisible();
      await expect(cardImage).toBeVisible();
    });

    test("3.3 A non-image file, a fake .pdf, and a byte-corrupted 'image' all fall back to the same generic dimension/size error — the app cannot distinguish 'wrong file type' from 'too small/too large'", async ({ page }) => {
      const cardImage = logoUploadCard(page).locator('img');
      const previousSrc = await cardImage.getAttribute('src');

      const companyPostRequests: string[] = [];
      page.on('request', (request) => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/company') {
          companyPostRequests.push(request.url());
        }
      });

      // 1. Bypass the `accept` filter with a plain-text file - same generic
      // dialog, consistent with the app decoding pixel dimensions and falling back on failure.
      await injectTextLogoFile(page, 'notes.txt', 'not an image');
      await expectLogoErrorDialogAndDismiss(page);

      // 2. A fake .pdf - identical dialog.
      await injectRawBytesLogoFile(page, { fileName: 'fake-document.pdf', mimeType: 'application/pdf', byteLength: 64 });
      await expectLogoErrorDialogAndDismiss(page);

      // 3. A .png with corrupt byte content - identical dialog, confirming
      // validation actually decodes the file, not just its extension/MIME type.
      await injectRawBytesLogoFile(page, { fileName: 'corrupt-logo.png', mimeType: 'image/png', byteLength: 200 });
      await expectLogoErrorDialogAndDismiss(page);

      // 4. A genuine 0-byte .png - identical dialog too.
      await injectRawBytesLogoFile(page, { fileName: 'empty-logo.png', mimeType: 'image/png', byteLength: 0 });
      await expectLogoErrorDialogAndDismiss(page);

      // None of the four sent a POST /company or disturbed the saved logo.
      expect(companyPostRequests).toHaveLength(0);
      await expect(cardImage).toHaveAttribute('src', previousSrc!);
    });

    test('3.4 REAL BUG: an unsupported-but-valid image format (WEBP) is silently ignored with ZERO user feedback — no error, no success, no visible change at all', async ({ page }) => {
      const cardImage = logoUploadCard(page).locator('img');
      const previousSrc = await cardImage.getAttribute('src');

      // 1. Select a valid WEBP image. Intercepts via page.route(), since a
      // plain waitForResponse().then(r => r.text()) here intermittently throws (see CLAUDE.md).
      let responseStatus = 0;
      let responseBody = '';
      await page.route('**/company', async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        const response = await route.fetch();
        responseStatus = response.status();
        responseBody = await response.text();
        await route.fulfill({ response });
      });
      await injectLogoImageFile(page, { width: 300, height: 300, fileName: 'valid-logo.webp', mimeType: 'image/webp', color: 'teal' });
      await expect.poll(() => responseStatus).toBe(200);
      await page.unroute('**/company');

      // CORRECTED: the plan claimed no request is sent for WEBP - a real
      // POST returns 200 with a body explicitly rejecting it. The bug is
      // closer to the surface: the frontend gets this rejection but never surfaces it (no dialog/toast at all).
      expect(responseStatus).toBe(200);
      expect(responseBody).toContain('"ok":false');
      expect(responseBody).toContain('image/webp');

      await expect(logoErrorDialogHeading(page)).toBeHidden();
      await expect(page.locator('text=Your logo was uploaded successfully')).toBeHidden();
      await expect(cardImage).toHaveAttribute('src', previousSrc!);

      // A real user gets zero indication anything happened, despite the backend explicitly explaining why it was rejected.
      await page.goto(`${BASE_URL}/company`);
      await expect(cardImage).toHaveAttribute('src', previousSrc!);
    });
  });

  test.describe('Logo Upload — Error Dialog Behavior', () => {
    test("4.1 Neither Escape nor clicking the backdrop closes the size/dimension error dialog — only the explicit 'Continue' button does", async ({ page }) => {
      const dialogHeading = logoErrorDialogHeading(page);

      // 1. Trigger the error dialog, then press Escape - stays open, same pattern as the Change Password modal.
      await injectNoisyLogoImageFile(page, { width: 1600, height: 1600, fileName: 'escape-test-oversized.png' });
      await expect(dialogHeading).toBeVisible();
      await expect(page.getByText(LOGO_ERROR_MESSAGE)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialogHeading).toBeVisible();

      // 2. Click the backdrop directly - also does not close it.
      await page.locator('.MuiBackdrop-root').click({ position: { x: 5, y: 5 } });
      await expect(dialogHeading).toBeVisible();

      // 3. Click 'Continue' - the one reliable way to dismiss it.
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(dialogHeading).toBeHidden();
    });
  });
});
