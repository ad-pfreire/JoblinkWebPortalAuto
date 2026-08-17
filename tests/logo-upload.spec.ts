// spec: specs/logo-upload-test-plan.md
// seed: tests/seed.spec.ts

import { test, expect, Page } from '@playwright/test';
import { requireEnv } from './utils/env';

const BASE_URL = requireEnv('BASE_URL');
const SEED_USERNAME = requireEnv('TEST_USERNAME');
const SEED_PASSWORD = requireEnv('TEST_LOGIN_PASSWORD');

// Logs in as the shared seed account and lands on /company - the first tab
// shown immediately after login, and the page hosting the Logo Upload card
// this file covers. Mirrors loginAsSeedAndGoToProfile() in
// tests/profile-settings.spec.ts, just targeting /company instead of
// /profile.
async function loginAsSeedAndGoToCompany(page: Page) {
  await page.goto(`${BASE_URL}/login`);
  await page.locator('input[name="username"]').fill(SEED_USERNAME);
  await page.locator('input[name="password"]').fill(SEED_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });
  await page.goto(`${BASE_URL}/company`);
  await expect(page.getByRole('button', { name: 'Upload' })).toBeVisible();
}

// The "Logo Upload" heading text appears TWICE in the DOM: once as a hidden
// (aria-expanded="false") mobile-layout accordion heading, and once as the
// real, visible desktop CardHeader title. Scoping every locator below to
// this specific card (identified by containing the Upload button, which is
// live-verified to be unique on the page) avoids strict-mode ambiguity
// against that hidden duplicate without relying on a raw MUI class name
// alone.
function logoUploadCard(page: Page) {
  return page.locator('.MuiCard-root').filter({ has: page.getByRole('button', { name: 'Upload' }) });
}

// Injects a synthetic image file into the hidden `<input name="logo">`
// element by drawing a canvas image, converting it to a Blob, and wiring it
// up via DataTransfer + a manual "change" event. Same in-page
// canvas+DataTransfer technique already used and documented in
// tests/profile-settings.spec.ts's injectCanvasImageFile() for the Profile
// Photo Upload crop-modal tests, just targeting this page's
// `input[name="logo"]` element instead of `#profilePicture`. Unlike Profile
// Photo Upload, there is no crop modal to interact with afterward here -
// live-verified: dispatching "change" is the entire upload trigger, and
// immediately fires the real POST /company request.
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

// Same in-page canvas+DataTransfer technique as injectLogoImageFile() above,
// but fills the canvas with per-pixel random noise so the resulting PNG
// blob is a large, non-trivially-compressible size well over the 500KB
// limit (used for the oversized-file scenario in test 3.1, so toBlob()
// doesn't optimize a large flat-color image away to almost nothing) -
// mirrors injectNoisyCanvasImageFile() in tests/profile-settings.spec.ts,
// just targeting this page's `input[name="logo"]` element.
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

// Injects a plain-text (non-image) file into the logo input the same
// DataTransfer-bypass way as injectLogoImageFile() above, but skipping the
// canvas/toBlob step entirely, to probe whether the app performs any real
// image-decoding-based validation on the selected "logo" beyond the file
// input's `accept` attribute (a browser/OS-level filename filter only, not
// a real validation boundary) - mirrors injectTextFile() in
// tests/profile-settings.spec.ts.
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

// Injects a file with a given filename/MIME type but whose actual byte
// content is either random garbage (to simulate a corrupted/malformed
// "image", or an arbitrary non-image file wearing a misleading extension
// like .pdf) or completely empty (a genuine 0-byte file, via the default
// byteLength of 0) - the random bytes are generated entirely in-page so no
// large byte array needs to cross the page.evaluate() serialization
// boundary.
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

// Live-verified real backend behavior (not a test flake): right after a
// successful upload, the card's <img src> is NOT its final value yet - the
// backend appears to asynchronously post-process the uploaded file (likely
// generating an optimized/resized variant), swapping the src to a DIFFERENT
// S3 URL, and this can keep changing for up to ~15s after the upload
// response resolves, even with no navigation at all (confirmed live via a
// standalone diagnostic script: waiting only ~10s and seeing two consecutive
// matching reads was NOT enough - it can plateau briefly then change again;
// waiting a full 15s produced a src that then stayed byte-identical across
// four separate full-page reloads). Polls every 1s for up to 25s, requiring
// THREE consecutive matching reads (3s of true stability, not just one
// lucky plateau) that also differ from `differentFrom` (if given), before
// treating the src as final - needed whenever a test wants to assert the
// upload's FINAL src (e.g. across a reload, or against the previous logo's
// src), since comparing too early would compare against a value the backend
// is still about to replace.
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

// Injects a logo file (see injectLogoImageFile() above) and waits for the
// real POST /company response it triggers, rather than just trusting the
// success toast text. There is no separate "Save" button on this page -
// unlike Profile Photo Upload's crop-modal + Save flow, selecting a valid
// file immediately uploads it - so this is the equivalent of
// saveAndWaitForSuccess() in tests/profile-settings.spec.ts, needed here
// because test 2.2 below performs a second real upload shortly after 2.1's,
// and this project's documented "don't trust the toast for a second save"
// gotcha applies equally to two close-together real uploads.
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

// The exact, generically-worded dialog body text that live verification
// confirmed is shared by every size/dimension/undecodable-file rejection in
// section 3 below - it never distinguishes which specific rule failed (too
// big, too small, or simply unparseable as an image at all).
const LOGO_ERROR_MESSAGE = 'Your logo needs to be at least 150x150 px and should not exceed 500KB. Please review your file and try again.';

// Locates the error dialog's own heading specifically. Live-verified via
// direct DOM inspection: the page ALSO contains two other, permanently
// hidden `<h3>`/`<h6>` elements elsewhere with the exact same "Logo Upload"
// text (the same hidden mobile-layout duplicates noted on logoUploadCard()
// above), so a plain `getByRole('heading', { name: 'Logo Upload' })` would
// be ambiguous (3 matches) the instant this dialog is open. The dialog's
// own heading is live-verified to always render as an `<h5>` - live-checked
// to be the ONLY `<h5>` on this page in both the default state (0 matches)
// and while the dialog is open (exactly 1 match) - so scoping by
// `level: 5` disambiguates it reliably without needing a `role="dialog"`
// container to scope into (this app's dialog is not exposed with that
// role).
function logoErrorDialogHeading(page: Page) {
  return page.getByRole('heading', { name: 'Logo Upload', exact: true, level: 5 });
}

// Asserts the generic size/dimension/unparseable-file error dialog (see
// LOGO_ERROR_MESSAGE above) is visible with its live-verified heading, body
// text, and single 'Continue' button, then dismisses it via that button -
// shared by every rejected-file sub-case in test 3.3 below, since live
// verification confirmed a non-image .txt file, a fake .pdf, a
// byte-corrupted "PNG", and a genuine 0-byte file all funnel into this
// exact same dialog.
async function expectLogoErrorDialogAndDismiss(page: Page) {
  const dialogHeading = logoErrorDialogHeading(page);
  await expect(dialogHeading).toBeVisible();
  await expect(page.getByText(LOGO_ERROR_MESSAGE)).toBeVisible();
  const continueButton = page.getByRole('button', { name: 'Continue' });
  await expect(continueButton).toBeVisible();
  await continueButton.click();
  await expect(dialogHeading).not.toBeVisible();
}

// Every test below reads (and, in later sections of this file, writes) the
// ONE shared seed account (pfautomation) that the rest of this suite also
// depends on for login. Same trade-off already documented and applied in
// tests/profile-settings.spec.ts: serial + chromium-only avoids racing
// parallel browser projects/workers on this single account's Logo Upload
// state.
test.describe('Logo Upload', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Shared seed account state; runs once serially on chromium to avoid cross-project races on the same account.');
    await loginAsSeedAndGoToCompany(page);
  });

  test.describe('Logo Upload — Empty/Default State', () => {
    test('1.1 Logo Upload card shows a placeholder image and expected caption/button when no logo has ever been uploaded', async ({ page }) => {
      // 1. Log in with the seed account (pfautomation / 123456Pp!) and land
      // on /company (the default first tab after login, done by
      // beforeEach).
      await expect(page).toHaveTitle('Company | Job Link');

      const card = logoUploadCard(page);

      // A 'Logo Upload' card heading is visible.
      await expect(card.getByText('Logo Upload', { exact: true })).toBeVisible();

      // NOTE: per the plan's own Application Overview caveat, the seed
      // account's company logo was left as a saved test PNG at the end of
      // the exploration session that produced this plan, so this account
      // is NOT reliably in the pristine "no logo ever uploaded" state at
      // test time (confirmed live: the card currently renders an <img>
      // pointing at a real saved S3 logo, not a placeholder icon). The
      // plan's "shows a dark-grey placeholder box with a generic image
      // icon" assertion is therefore intentionally NOT asserted here - it
      // would be a false/unreliable check against this shared account's
      // actual current state, not a genuine empty-state verification. Only
      // the state that holds true regardless of whether a logo currently
      // exists is asserted below.

      // Directly beneath the placeholder/logo, a caption reads exactly:
      // 'Make sure your logo has at least 150x150 px and no more than
      // 500KB'.
      await expect(card.getByRole('heading', { name: 'Make sure your logo has at least 150x150 px and no more than 500KB' })).toBeVisible();

      // Below the caption, a single blue 'Upload' button is visible and
      // enabled - there is no second button (no 'Remove', 'Delete', or
      // 'Cancel' button present in the default state).
      const uploadButton = card.getByRole('button', { name: 'Upload' });
      await expect(uploadButton).toBeVisible();
      await expect(uploadButton).toBeEnabled();
      await expect(card.getByRole('button')).toHaveCount(1);
    });

    test('1.2 Clicking Upload opens the native OS file chooser directly, restricted to image/jpeg and image/png only', async ({ page }) => {
      const uploadButton = logoUploadCard(page).getByRole('button', { name: 'Upload' });
      const fileInput = page.locator('input[name="logo"]');

      // 1. On /company, click the 'Upload' button in the Logo Upload card.
      const fileChooserPromise = page.waitForEvent('filechooser');
      await uploadButton.click();
      const fileChooser = await fileChooserPromise;

      // A native OS file chooser opens immediately - no intermediate
      // in-app modal, dropdown, or menu appears first.
      expect(fileChooser).toBeTruthy();

      // Live-verified via DOM inspection: the underlying
      // `<input type="file" name="logo">` has accept="image/jpeg,image/png"
      // and multiple=false - notably narrower than the equivalent Profile
      // Photo input on /profile, which additionally accepts image/webp.
      await expect(fileInput).toHaveAttribute('accept', 'image/jpeg,image/png');
      await expect(fileInput).toHaveJSProperty('multiple', false);

      // 2. Cancel/dismiss the native file chooser without selecting any
      // file.
      await fileChooser.setFiles([]);

      // Live-verified: the page remains completely unchanged - the
      // placeholder/logo image, caption, and 'Upload' button are all
      // exactly as before, with no error, no toast, and no partial/broken
      // intermediate state - a true no-op.
      await expect(uploadButton).toBeVisible();
      await expect(uploadButton).toBeEnabled();
    });
  });

  test.describe('Logo Upload — Valid Upload Flow (No Crop Modal)', () => {
    test('2.1 Selecting a valid image immediately uploads and saves it — no intermediate crop/preview modal exists', async ({ page }) => {
      // waitForStableImageSrc() below can take up to ~25s (real backend
      // post-processing delay, see its own comment) - triple the default
      // 30s test timeout so that wait isn't mistaken for a hang.
      test.slow();
      const card = logoUploadCard(page);
      const cardImage = card.locator('img');

      // 1. On /company, select a valid, small (e.g. 300x300px, well under
      // 500KB) PNG file via the Upload button's file chooser (injected
      // in-page; see injectLogoImageFile()). This also sends a real POST
      // request to /company (multipart/form-data, containing the selected
      // file) immediately, with no separate user confirmation step.
      await injectLogoImageFileAndWaitForUpload(page, { width: 300, height: 300, fileName: 'valid-logo.png', color: 'green' });

      // Notable finding, confirmed live: NO crop/zoom modal of any kind
      // appears (unlike Profile Photo Upload's 'Change Profile Picture'
      // modal with its zoom slider and Cancel/Ok buttons) - the file is
      // submitted directly, with no dialog and no slider ever rendered.
      await expect(page.getByRole('dialog')).not.toBeVisible();
      await expect(page.getByRole('slider')).toHaveCount(0);

      // A green/success toast appears with the exact text 'Your logo was
      // uploaded successfully'.
      await expect(page.locator('text=Your logo was uploaded successfully')).toBeVisible();

      // The Logo Upload card's placeholder/previous image is immediately
      // replaced with the newly uploaded image, displayed at the same
      // square dimensions as the placeholder. Wait for the backend's
      // async post-processing to settle (see waitForStableImageSrc() above)
      // before treating this as the image's real, final src.
      await expect(cardImage).toBeVisible();
      const uploadedSrc = await waitForStableImageSrc(cardImage);

      // 2. Reload the page (full navigation, not just a soft refresh).
      await page.goto(`${BASE_URL}/company`);

      // Live-verified: the newly uploaded logo persists after reload,
      // confirming this was a genuine backend save, not just a client-side
      // preview.
      await expect(cardImage).toBeVisible();
      await expect(cardImage).toHaveAttribute('src', uploadedSrc);

      // Live-verified, minor cosmetic quirk: the success toast text ('Your
      // logo was uploaded successfully') is also shown again immediately
      // after this reload - the toast appears to be re-shown on the very
      // next full page load after a successful upload, not just at the
      // moment of upload itself.
      await expect(page.locator('text=Your logo was uploaded successfully')).toBeVisible();
    });

    test("2.2 Uploading a new logo when one already exists replaces it in place — the button remains labeled 'Upload', not 'Replace'", async ({ page }) => {
      // See the test.slow() comment in 2.1 above - same waitForStableImageSrc() cost applies here.
      test.slow();
      const card = logoUploadCard(page);
      const uploadButton = card.getByRole('button', { name: 'Upload' });
      const cardImage = card.locator('img');

      // With a logo already saved from a previous upload (e.g. a green
      // square) - this describe runs serial against the one shared seed
      // account, so test 2.1's upload above is still saved server-side at
      // the start of this test.
      await expect(cardImage).toBeVisible();
      const previousSrc = await cardImage.getAttribute('src');
      expect(previousSrc).toBeTruthy();
      await expect(uploadButton).toHaveText('Upload');

      // 1. Select a different valid image (e.g. an orange 150x150px
      // square) via the same 'Upload' button.
      await injectLogoImageFileAndWaitForUpload(page, { width: 150, height: 150, fileName: 'replacement-logo.png', color: 'orange' });

      // Live-verified: the button's label and appearance never change to
      // 'Replace', 'Change', or similar at any point, before or after a
      // logo already exists - it is exactly the same 'Upload' button as
      // before this replacement, doing exactly the same immediate-upload
      // action.
      await expect(uploadButton).toHaveText('Upload');
      await expect(card.getByRole('button')).toHaveCount(1);

      // The new image immediately replaces the old one in the card, and
      // the same 'Your logo was uploaded successfully' toast appears,
      // confirming a clean overwrite/replace behavior with no separate
      // confirmation step ('are you sure you want to replace your existing
      // logo?') of any kind.
      await expect(page.locator('text=Your logo was uploaded successfully')).toBeVisible();
      await expect(cardImage).toBeVisible();
      const newSrc = await waitForStableImageSrc(cardImage, previousSrc);
      expect(newSrc).not.toBe(previousSrc);

      // 2. (Note, not a step) Look for any 'Remove logo' / 'Delete logo' /
      // 'Reset to default' affordance anywhere in the Logo Upload card, in
      // any hover state, or elsewhere on the Company page.
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

      // 1. Select an image file that is well over 500KB (e.g. an
      // in-browser-generated 1600x1600px PNG filled with per-pixel random
      // noise, several MB in size, chosen specifically to defeat PNG's
      // lossless compression and guarantee a large real byte size) but with
      // valid dimensions (well over 150x150px).
      await injectNoisyLogoImageFile(page, { width: 1600, height: 1600, fileName: 'oversized-logo.png' });

      // Live-verified, notable finding: a modal dialog appears, titled
      // 'Logo Upload', with body text reading exactly the generic
      // size/dimension message, and a single 'Continue' button - this
      // exact same generic message is used for size violations, dimension
      // violations, and files that cannot be parsed as an image at all
      // (see later tests).
      const dialogHeading = logoErrorDialogHeading(page);
      await expect(dialogHeading).toBeVisible();
      await expect(page.getByText(LOGO_ERROR_MESSAGE)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();

      // Live-verified via the browser's network request log: NO
      // POST /company request is ever sent as a result of selecting this
      // oversized file - the size check runs entirely client-side, before
      // any upload attempt, confirming the 500KB limit is a real, enforced
      // pre-upload gate, not a server-side rejection after the fact.
      expect(companyPostRequests).toHaveLength(0);

      // CORRECTION to the live-verified plan, found while automating this
      // exact scenario: the plan states the previous logo "remains visible
      // behind/before the modal". Live re-verification (isolated standalone
      // script, reproduced consistently) shows the card's <img> is actually
      // removed from the DOM entirely (locator resolves to 0 elements) for
      // as long as this error dialog is open - not merely hidden behind it.
      // It reliably reappears with the exact same, unmodified src once the
      // dialog is dismissed, so the underlying saved logo is never actually
      // lost or corrupted - this is a harmless render quirk (the card
      // apparently unmounts its <img> while showing the rejection dialog),
      // not a data-loss bug. Asserting the unchanged src is only meaningful
      // once the dialog is gone, so that check moves below, after Continue.
      await expect(cardImage).toHaveCount(0);

      // 2. Click the 'Continue' button to dismiss the dialog.
      await page.getByRole('button', { name: 'Continue' }).click();

      // The dialog closes cleanly, and the Logo Upload card is back to its
      // prior state (previous logo or placeholder, 'Upload' button
      // enabled) with no lingering error state - confirming the rejected
      // oversized file never actually overwrote or cleared the existing
      // saved logo.
      await expect(dialogHeading).not.toBeVisible();
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

      // 1. Select a valid, tiny-file-size (well under 500KB) image that is
      // exactly 149x149px.
      await injectLogoImageFile(page, { width: 149, height: 149, fileName: 'tiny-149.png', color: 'red' });

      // Live-verified: the exact same generic error dialog appears,
      // confirming the dimension check independently rejects a file that is
      // comfortably within the size limit but just 1px under the minimum
      // dimension on both axes.
      await expect(dialogHeading).toBeVisible();
      await expect(page.getByText(LOGO_ERROR_MESSAGE)).toBeVisible();

      // No POST /company request is sent.
      expect(companyPostRequests).toHaveLength(0);

      // 2. Dismiss the dialog (click 'Continue'), then select a new valid
      // image that is exactly 150x150px (the stated minimum, inclusive).
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(dialogHeading).not.toBeVisible();

      await injectLogoImageFileAndWaitForUpload(page, { width: 150, height: 150, fileName: 'exact-150.png', color: 'purple' });

      // Live-verified, confirms the boundary is inclusive: this exact
      // 150x150px image is ACCEPTED - no error dialog appears, a real
      // POST /company request is sent (awaited above), and the success
      // toast 'Your logo was uploaded successfully' appears, proving
      // '150x150px' in the stated constraint text means '150x150px or
      // larger', not 'larger than 150x150px'.
      await expect(dialogHeading).not.toBeVisible();
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

      // 1. Bypass the OS-level accept-attribute filter (via direct
      // DOM/DataTransfer manipulation) and supply a plain-text file (.txt,
      // content 'not an image') as the selected logo.
      await injectTextLogoFile(page, 'notes.txt', 'not an image');

      // Live-verified: the same generic 'Your logo needs to be at least
      // 150x150 px and should not exceed 500KB. Please review your file and
      // try again.' dialog appears (not a distinct 'unsupported file type'
      // or 'invalid image' message) - the app appears to attempt to read
      // the file's pixel dimensions to validate it, and when that fails
      // (because a .txt file has no image data), it falls back to this same
      // generic message rather than a more accurate one.
      await expectLogoErrorDialogAndDismiss(page);

      // 2. Dismiss the dialog. Supply a fake .pdf file (arbitrary bytes,
      // `.pdf` extension, `application/pdf` MIME type) as the selected
      // logo.
      await injectRawBytesLogoFile(page, { fileName: 'fake-document.pdf', mimeType: 'application/pdf', byteLength: 64 });

      // Live-verified: identical generic error dialog appears again.
      await expectLogoErrorDialogAndDismiss(page);

      // 3. Dismiss the dialog. Supply a file with a `.png` extension and
      // `image/png` MIME type, but whose actual byte content is
      // random/garbage data (not valid PNG image data) - simulating a
      // corrupted or malformed 'image' file.
      await injectRawBytesLogoFile(page, { fileName: 'corrupt-logo.png', mimeType: 'image/png', byteLength: 200 });

      // Live-verified: identical generic error dialog appears yet again,
      // confirming the validation is based on actually attempting to
      // decode/measure the file as an image (dimensions/renderability), not
      // merely trusting its extension or declared MIME type.
      await expectLogoErrorDialogAndDismiss(page);

      // 4. Dismiss the dialog. Supply a genuine 0-byte file with a `.png`
      // extension and `image/png` MIME type.
      await injectRawBytesLogoFile(page, { fileName: 'empty-logo.png', mimeType: 'image/png', byteLength: 0 });

      // Live-verified: identical generic error dialog appears, confirming a
      // completely empty file is handled the same as any other
      // non-parseable input.
      await expectLogoErrorDialogAndDismiss(page);

      // In all four of the above cases, no POST /company request is ever
      // sent, and the previously saved/displayed logo is left completely
      // undisturbed.
      expect(companyPostRequests).toHaveLength(0);
      await expect(cardImage).toHaveAttribute('src', previousSrc!);
    });

    test('3.4 REAL BUG: an unsupported-but-valid image format (WEBP) is silently ignored with ZERO user feedback — no error, no success, no visible change at all', async ({ page }) => {
      const cardImage = logoUploadCard(page).locator('img');
      const previousSrc = await cardImage.getAttribute('src');

      // 1. Bypass the OS-level accept-attribute filter and supply a
      // genuinely valid, well-formed WEBP image (valid pixel dimensions
      // well over 150x150px, valid small file size well under 500KB, real
      // WEBP-encoded bytes generated in-page via
      // canvas.toBlob(cb, 'image/webp'), an `image/webp` MIME type and
      // `.webp` filename extension) as the selected logo.
      // Intercepts the POST /company response via page.route() instead of
      // reading response.text() after the fact - live-verified this is
      // necessary here: even reading the body inside the very same
      // `.then()` as waitForResponse() intermittently throws "Response body
      // is not available for a response that was navigated away from"
      // (reproduced across repeated runs), apparently because this app's
      // client-side router does something (e.g. a background
      // refresh/navigation) racing against the browser's own buffering of
      // that response body. Routing lets us fetch the real response and
      // read its body ourselves, deterministically, before handing it back
      // to the page via route.fulfill() so the app still behaves normally.
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

      // CORRECTION to the live-verified plan, found while automating this
      // exact scenario: the plan states that NO network request at all is
      // sent for a WEBP selection. Careful, repeated live re-verification
      // here (inspecting the real fetch call and its response body, not
      // just a network-tab glance, and cross-checked against an unrelated
      // click to rule out coincidental background traffic) shows this part
      // of the plan is not accurate - a real POST /company request IS sent
      // and DOES receive a real 200 OK response, whose body is a Next.js
      // RSC-streamed payload containing
      // {"ok":false,"message":"Validation failed (current file type is
      // image/webp, expected type is image/(jpeg|png))"} - i.e. the backend
      // correctly identifies and rejects the WEBP file with a clear,
      // specific validation message. The real bug is therefore one level
      // "closer to the surface" than the plan describes: the frontend DOES
      // receive this explicit rejection from the backend, but completely
      // fails to surface it to the user in any way (no error dialog reusing
      // the generic modal from 3.1-3.3, no toast, nothing) - unlike every
      // other rejected-file case in this section, which all funnel into
      // that same visible generic dialog. The end-user-visible outcome
      // (total silence) matches the plan's headline finding exactly; only
      // the underlying network-level mechanism differs from what was
      // documented.
      expect(responseStatus).toBe(200);
      expect(responseBody).toContain('"ok":false');
      expect(responseBody).toContain('image/webp');

      // No error dialog of any kind appears (unlike every other
      // rejected-file case in section 3.3, which all show the generic
      // 150x150/500KB dialog).
      await expect(logoErrorDialogHeading(page)).not.toBeVisible();

      // No success toast appears either.
      await expect(page.locator('text=Your logo was uploaded successfully')).not.toBeVisible();

      // The Logo Upload card's displayed image is completely unchanged,
      // still showing whichever logo was previously saved.
      await expect(cardImage).toHaveAttribute('src', previousSrc!);

      // A real user selecting a modern, common, perfectly valid WEBP logo
      // image receives absolutely no indication that anything happened at
      // all - no confirmation of success, no explanation of failure,
      // nothing - despite the backend having explicitly told the frontend
      // why the file was rejected.
      await page.goto(`${BASE_URL}/company`);
      await expect(cardImage).toHaveAttribute('src', previousSrc!);
    });
  });

  test.describe('Logo Upload — Error Dialog Behavior', () => {
    test("4.1 Neither Escape nor clicking the backdrop closes the size/dimension error dialog — only the explicit 'Continue' button does", async ({ page }) => {
      const dialogHeading = logoErrorDialogHeading(page);

      // 1. Trigger the generic error dialog (e.g. by selecting an oversized
      // or undersized file per section 3), then press the Escape key.
      await injectNoisyLogoImageFile(page, { width: 1600, height: 1600, fileName: 'escape-test-oversized.png' });
      await expect(dialogHeading).toBeVisible();
      await expect(page.getByText(LOGO_ERROR_MESSAGE)).toBeVisible();

      await page.keyboard.press('Escape');

      // Live-verified: the dialog remains fully open - Escape does NOT
      // close it, matching the same pattern already documented for the
      // Change Password modal on /profile.
      await expect(dialogHeading).toBeVisible();

      // 2. With the dialog still open, click directly on the dialog's
      // backdrop (the dimmed overlay area outside the dialog box, e.g. via
      // the underlying `.MuiBackdrop-root` element) at a point not covered
      // by the centered dialog itself.
      await page.locator('.MuiBackdrop-root').click({ position: { x: 5, y: 5 } });

      // Live-verified: the dialog remains fully open - clicking the
      // backdrop does NOT close it either.
      await expect(dialogHeading).toBeVisible();

      // 3. Click the explicit 'Continue' button.
      await page.getByRole('button', { name: 'Continue' }).click();

      // The dialog closes cleanly, confirming 'Continue' is the one
      // reliable way to dismiss this dialog, consistent with the equivalent
      // Escape/backdrop-immune behavior already documented for the Change
      // Password modal.
      await expect(dialogHeading).not.toBeVisible();
    });
  });
});
