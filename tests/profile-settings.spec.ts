import { test, expect, Page, Locator } from '@playwright/test';
import { requireEnv } from './utils/env';
import { getVerificationLink } from './utils/email';
import {
  generateUniqueEmailAlias,
  generateUsernameFromEmail,
  registerNewAccount,
  completeProfile,
  selectPhoneCountry,
  setPhoneNumber,
} from './utils/account';

const BASE_URL = requireEnv('BASE_URL');
const SEED_USERNAME = requireEnv('TEST_USERNAME');
const SEED_PASSWORD = requireEnv('TEST_LOGIN_PASSWORD');
const SEED_EMAIL = `${requireEnv('TEST_EMAIL_USER')}+automation${requireEnv('TEST_EMAIL_DOMAIN')}`;

// The seed account's baseline values - discovered live, not hardcoded, so
// this suite works against any developer/CI's own seed account (see CLAUDE.md's Portability section).
let SEED_FIRST_NAME: string;
let SEED_LAST_NAME: string;
let SEED_PHONE_FORMATTED: string;
let SEED_PHONE_DIGITS: string;

/** Logs in as the shared seed account and lands on /profile, without asserting the name fields' values (used before they're known too). */
async function loginAsSeed(page: Page) {
  await page.goto(`${BASE_URL}/login`);
  await page.locator('input[name="username"]').fill(SEED_USERNAME);
  await page.locator('input[name="password"]').fill(SEED_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });
  await page.goto(`${BASE_URL}/profile`);
  await expect(page.locator('input[name="firstName"]')).not.toHaveValue('');
}

/** Logs in as the seed account and confirms it shows the discovered baseline first name - a sanity check that the account is in the expected restored state. */
async function loginAsSeedAndGoToProfile(page: Page) {
  await loginAsSeed(page);
  await expect(page.locator('input[name="firstName"]')).toHaveValue(SEED_FIRST_NAME);
}

/**
 * Reads the seed account's current First/Last Name/Phone into the SEED_*
 * globals for the rest of the file. Phone digits are extracted by stripping
 * non-digits and dropping a leading US country code "1" - assumes a
 * US-formatted number, consistent with every phone test here hardcoding 'United States'.
 */
async function discoverSeedBaseline(browser: import('@playwright/test').Browser) {
  const page = await browser.newPage();
  await loginAsSeed(page);
  SEED_FIRST_NAME = await page.locator('input[name="firstName"]').inputValue();
  SEED_LAST_NAME = await page.locator('input[name="lastName"]').inputValue();
  SEED_PHONE_FORMATTED = await page.getByRole('textbox', { name: 'Phone Number' }).inputValue();
  const digitsWithCountryCode = SEED_PHONE_FORMATTED.replace(/\D/g, '');
  SEED_PHONE_DIGITS =
    digitsWithCountryCode.length === 11 && digitsWithCountryCode.startsWith('1') ? digitsWithCountryCode.slice(1) : digitsWithCountryCode;
  await page.close();
}

/** Clicks Save and waits for the real POST /profile response, not just the toast (a still-visible first-save toast can mask an incomplete second save - see CLAUDE.md). */
async function saveAndWaitForSuccess(page: Page, saveButton: Locator) {
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/profile'),
    saveButton.click(),
  ]);
  expect(response.ok()).toBe(true);
}

/**
 * Waits for the generic Change Password error banner after a real
 * wrong-password submission, but skips (not fails) if Cognito's own
 * too-many-attempts throttle fires instead - a real, transient hazard on
 * this shared seed account, not a defect in the app (see CLAUDE.md).
 */
async function expectGenericPasswordChangeError(page: Page): Promise<Locator> {
  const genericErrorBanner = page.getByText('An unexpected error occurred. Please try again later.', { exact: true });
  const rateLimitBanner = page.getByText('Attempt limit exceeded, please try after some time.', { exact: true });
  await expect(genericErrorBanner.or(rateLimitBanner)).toBeVisible();
  test.skip(
    await rateLimitBanner.isVisible(),
    "Seed account is currently throttled by Cognito's own too-many-failed-attempts limit - environmental, not a defect (see CLAUDE.md). Re-run later once the throttle clears."
  );
  return genericErrorBanner;
}

/** Injects a synthetic image into the hidden #profilePicture input via canvas + DataTransfer + "change" - reliably opens the crop modal like a real selection. */
async function injectCanvasImageFile(
  page: Page,
  {
    width,
    height,
    fileName,
    mimeType = 'image/png',
    color = 'blue',
  }: { width: number; height: number; fileName: string; mimeType?: string; color?: string }
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
      const input = document.querySelector<HTMLInputElement>('#profilePicture')!;
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { width, height, fileName, mimeType, color }
  );
}

/** Same as `injectCanvasImageFile()` but fills the canvas with noise blocks, so the PNG can't compress away to almost nothing (used for oversized-image tests). */
async function injectNoisyCanvasImageFile(page: Page, { width, height, fileName }: { width: number; height: number; fileName: string }) {
  await page.evaluate(
    async ({ width, height, fileName }) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;
      for (let y = 0; y < height; y += 10) {
        for (let x = 0; x < width; x += 10) {
          ctx.fillStyle = `rgb(${Math.floor(Math.random() * 255)},${Math.floor(Math.random() * 255)},${Math.floor(Math.random() * 255)})`;
          ctx.fillRect(x, y, 10, 10);
        }
      }
      const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
      const file = new File([blob], fileName, { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.querySelector<HTMLInputElement>('#profilePicture')!;
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { width, height, fileName }
  );
}

/** Injects a plain-text file, to probe whether the app validates content-type beyond the `accept` attribute's filename filter. */
async function injectTextFile(page: Page, fileName: string, content: string) {
  await page.evaluate(
    ({ fileName, content }) => {
      const file = new File([new Blob([content], { type: 'text/plain' })], fileName, { type: 'text/plain' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.querySelector<HTMLInputElement>('#profilePicture')!;
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { fileName, content }
  );
}

// Reads/writes the shared seed account (Email/Username are read-only, so no
// disposable-account escape hatch here) - serial + chromium-only avoids racing parallel browser projects (see CLAUDE.md).
test.describe('Profile Settings', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    await discoverSeedBaseline(browser);
  });

  test.beforeEach(async ({ page, browserName }) => {
    test.skip(
      browserName !== 'chromium',
      'Shared seed account state; runs once serially on chromium to avoid cross-project races on the same account.'
    );
    await loginAsSeedAndGoToProfile(page);
  });

  test.describe('Page UI', () => {
    test('should display all required elements in their default state', async ({ page }) => {
      // 1. Land on /profile (done by beforeEach). Page title and heading.
      await expect(page).toHaveTitle('Profile | Job Link');
      await expect(page.getByText('Profile Settings', { exact: true })).toBeVisible();

      // Scoped to the avatar itself - two separate <label for="profilePicture"> elements exist (avatar + pencil badge), a strict-mode ambiguity otherwise.
      await expect(page.locator('label[for="profilePicture"] .MuiAvatar-root')).toBeVisible();

      // First Name field: pre-filled, correct placeholder, not disabled.
      const firstNameInput = page.locator('input[name="firstName"]');
      await expect(firstNameInput).toHaveValue(SEED_FIRST_NAME);
      await expect(firstNameInput).toHaveAttribute('placeholder', 'Enter your first name');
      await expect(firstNameInput).toBeEnabled();

      // Last Name field: pre-filled, correct placeholder, not disabled.
      const lastNameInput = page.locator('input[name="lastName"]');
      await expect(lastNameInput).toHaveValue(SEED_LAST_NAME);
      await expect(lastNameInput).toHaveAttribute('placeholder', 'Enter your last name');
      await expect(lastNameInput).toBeEnabled();

      // Email Address field: pre-filled, genuinely disabled at the DOM level.
      const emailInput = page.locator('input[name="email"]');
      await expect(emailInput).toHaveValue(SEED_EMAIL);
      await expect(emailInput).toBeDisabled();

      // Phone Number field: pre-filled, not disabled, with its country
      // combobox visible alongside it.
      const phoneInput = page.getByRole('textbox', { name: 'Phone Number' });
      await expect(phoneInput).toHaveValue(SEED_PHONE_FORMATTED);
      await expect(phoneInput).toBeEnabled();
      await expect(page.getByRole('combobox')).toBeVisible();

      // Username field: pre-filled, genuinely disabled at the DOM level.
      const usernameInput = page.locator('input[name="username"]');
      await expect(usernameInput).toHaveValue(SEED_USERNAME);
      await expect(usernameInput).toBeDisabled();

      // Change Password button, Save button (disabled by default), and
      // Delete Account button.
      await expect(page.getByRole('button', { name: 'Change Password' })).toBeEnabled();
      await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Delete Account' })).toBeEnabled();
    });

    test('should redirect to the login page when visiting /profile while logged out', async ({ page }) => {
      // 1. With no authenticated session, navigate directly to /profile.
      await page.context().clearCookies();
      await page.goto(`${BASE_URL}/profile`);

      // 2. The app redirects to /login with the expected redirectUrl query
      // param, confirming this route is guarded by an authentication check.
      const expectedRedirectUrl = `${BASE_URL}/login?redirectUrl=${encodeURIComponent(`${BASE_URL}/profile`)}`;
      await expect(page).toHaveURL(expectedRedirectUrl);
      await expect(page).toHaveTitle('Log In | Job Link');
    });
  });

  test.describe('Editing Name Fields and the Save Button', () => {
    test('should show a required-field message when blurring an empty First Name field', async ({ page }) => {
      const firstNameInput = page.locator('input[name="firstName"]');
      const lastNameInput = page.locator('input[name="lastName"]');

      // 1. On /profile, clear the "First Name" field entirely and blur it
      // (click into another field, e.g. "Last Name").
      await firstNameInput.fill('');
      await lastNameInput.click();

      // A red inline "The field is required" message appears beneath First
      // Name, and the "Save" button stays disabled while the required
      // field is empty.
      await expect(page.locator('text=The field is required')).toHaveCount(1);
      await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

      // (Cleanup) Reload to discard the empty value rather than saving it.
      await page.goto(`${BASE_URL}/profile`);
      await expect(firstNameInput).toHaveValue(SEED_FIRST_NAME);
    });

    test('should show a required-field message when blurring an empty Last Name field', async ({ page }) => {
      const firstNameInput = page.locator('input[name="firstName"]');
      const lastNameInput = page.locator('input[name="lastName"]');

      // 1. On a fresh /profile load, clear the "Last Name" field entirely
      // and blur it (click into "First Name").
      await lastNameInput.fill('');
      await firstNameInput.click();

      // The same red inline "The field is required" message appears
      // beneath Last Name, independent of and identical in wording to the
      // First Name case, and the "Save" button stays disabled.
      await expect(page.locator('text=The field is required')).toHaveCount(1);
      await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

      // (Cleanup) Reload to discard the empty value rather than saving it.
      await page.goto(`${BASE_URL}/profile`);
      await expect(lastNameInput).toHaveValue(SEED_LAST_NAME);
    });

    test('should enable Save immediately on a keystroke without needing blur', async ({ page }) => {
      const firstNameInput = page.locator('input[name="firstName"]');
      const saveButton = page.getByRole('button', { name: 'Save' });
      await expect(saveButton).toBeDisabled();

      // 1. On a fresh /profile load, type a single extra character into the
      // "First Name" field (do not blur or click away).
      await firstNameInput.click();
      await firstNameInput.press('End');
      await firstNameInput.pressSequentially('X');

      // The "Save" button becomes enabled immediately on the keystroke
      // itself, with no blur or additional interaction required.
      await expect(saveButton).toBeEnabled();

      // (Cleanup) Reload to discard - Save was never clicked.
      await page.goto(`${BASE_URL}/profile`);
      await expect(firstNameInput).toHaveValue(SEED_FIRST_NAME);
    });

    test('should keep Save enabled even after manually reverting the field to its original value', async ({ page }) => {
      const firstNameInput = page.locator('input[name="firstName"]');
      const saveButton = page.getByRole('button', { name: 'Save' });

      // 1. On a fresh /profile load (Save disabled, First Name = "QA"),
      // type an extra character into First Name (e.g. making it "QAX"),
      // then delete that exact character so the value reads "QA" again,
      // exactly matching the original.
      await firstNameInput.click();
      await firstNameInput.press('End');
      await firstNameInput.pressSequentially('X');
      await expect(firstNameInput).toHaveValue(`${SEED_FIRST_NAME}X`);
      await firstNameInput.press('Backspace');
      await expect(firstNameInput).toHaveValue(SEED_FIRST_NAME);

      // Notable finding: 'Save' stays ENABLED even though the value is now
      // byte-identical to the original - tracks whether the field was ever dirtied, not whether the value actually differs.
      await expect(saveButton).toBeEnabled();

      // 2. Cleanup: reload (don't click Save) - confirms nothing was actually persisted.
      await page.goto(`${BASE_URL}/profile`);
      await expect(firstNameInput).toHaveValue(SEED_FIRST_NAME);
      await expect(saveButton).toBeDisabled();
    });

    test('should keep Email Address and Username genuinely non-editable', async ({ page }) => {
      // 1. Both inputs rely on the native `disabled` attribute (readOnly === false), not a readonly/CSS-only trick.
      const emailInput = page.locator('input[name="email"]');
      const usernameInput = page.locator('input[name="username"]');
      await expect(emailInput).toBeDisabled();
      await expect(usernameInput).toBeDisabled();
      expect(await emailInput.evaluate((el) => (el as HTMLInputElement).readOnly)).toBe(false);
      expect(await usernameInput.evaluate((el) => (el as HTMLInputElement).readOnly)).toBe(false);
    });

    test('should NOT trim leading/trailing whitespace from First Name even after a save round-trip', async ({ page }) => {
      const firstNameInput = page.locator('input[name="firstName"]');
      const saveButton = page.getByRole('button', { name: 'Save' });
      const paddedFirstName = '  QA  ';

      // 1. On /profile, type "  QA  " (two leading and two trailing
      // spaces) into the "First Name" field.
      await firstNameInput.fill(paddedFirstName);

      // The field does NOT auto-trim on input, same as the Login page's username/email field.
      await expect(firstNameInput).toHaveValue(paddedFirstName);

      // 2. Click "Save"; it succeeds with the standard success toast.
      await saveButton.click();
      await expect(page.locator('text=Your profile was updated successfully!')).toBeVisible();

      // CORRECTED (differs from specs/profile-settings-test-plan.md section
      // 2.6, which claims this trims): the padded value round-trips completely UNCHANGED, neither client- nor server-side.
      await page.goto(`${BASE_URL}/profile`);
      await expect(firstNameInput).toHaveValue(paddedFirstName);

      // Cleanup: restore the clean seed value, confirmed via the real
      // network response (not the toast) + reload - see CLAUDE.md's second-save gotcha.
      await firstNameInput.fill(SEED_FIRST_NAME);
      await saveAndWaitForSuccess(page, saveButton);
      await page.goto(`${BASE_URL}/profile`);
      await expect(firstNameInput).toHaveValue(SEED_FIRST_NAME);
    });

    test('should accept a very long First Name with no max length enforced, and remain able to restore it', async ({ page }) => {
      const firstNameInput = page.locator('input[name="firstName"]');
      const lastNameInput = page.locator('input[name="lastName"]');
      const saveButton = page.getByRole('button', { name: 'Save' });
      const longFirstName = 'A'.repeat(243);

      // 1. On /profile, type a 243-character value into "First Name" and
      // blur the field.
      await firstNameInput.fill(longFirstName);
      await lastNameInput.click();

      // Accepted with no truncation and no inline error; 'Save' becomes enabled.
      await expect(page.locator('text=The field is required')).toHaveCount(0);
      await expect(firstNameInput).toHaveValue(longFirstName);
      await expect(saveButton).toBeEnabled();

      // 2. Save, then reload - the full 243 characters genuinely persisted.
      await saveButton.click();
      await expect(page.locator('text=Your profile was updated successfully!')).toBeVisible();
      await page.goto(`${BASE_URL}/profile`);
      await expect(firstNameInput).toHaveValue(longFirstName);

      // 3. Cleanup: restore, confirmed via reload rather than the toast/DOM alone.
      await firstNameInput.fill(SEED_FIRST_NAME);
      await saveAndWaitForSuccess(page, saveButton);
      await page.goto(`${BASE_URL}/profile`);
      await expect(firstNameInput).toHaveValue(SEED_FIRST_NAME);
    });

    test('should send only a single save request on a rapid double-click of Save', async ({ page }) => {
      const firstNameInput = page.locator('input[name="firstName"]');
      const saveButton = page.getByRole('button', { name: 'Save' });

      // 1. Dirty First Name to enable Save, then double-click it rapidly, tracking every real POST /profile request it fires.
      await firstNameInput.fill(`${SEED_FIRST_NAME}X`);
      const saveRequests: string[] = [];
      page.on('request', (request) => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/profile') {
          saveRequests.push(request.url());
        }
      });

      await saveButton.dblclick();
      await expect(page.locator('text=Your profile was updated successfully!')).toBeVisible();

      // Only ONE POST was actually sent - the button correctly guards against duplicate submissions.
      expect(saveRequests).toHaveLength(1);

      // 2. Cleanup: restore, waiting for the real POST response rather than
      // the toast (the first save's toast can still be on screen, see CLAUDE.md).
      await firstNameInput.fill(SEED_FIRST_NAME);
      const [restoreResponse] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/profile'),
        saveButton.click(),
      ]);
      expect(restoreResponse.ok()).toBe(true);
      await page.goto(`${BASE_URL}/profile`);
      await expect(firstNameInput).toHaveValue(SEED_FIRST_NAME);
    });
  });

  test.describe('Profile Photo Upload', () => {
    test('should restrict the file chooser to image/jpeg, image/png, image/webp via the accept attribute', async ({ page }) => {
      // 1. Inspect the underlying `<input type="file">`, wrapped by the visible avatar/pencil edit-icon.
      await expect(page.locator('input#profilePicture')).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp');
    });

    test('should leave the page completely unchanged when the file chooser is dismissed with no file selected', async ({ page }) => {
      const saveButton = page.getByRole('button', { name: 'Save' });

      // 1. Click the pencil badge (the second of the two <label
      // for="profilePicture"> elements) to open the OS file chooser, then dismiss it without selecting a file.
      const fileChooserPromise = page.waitForEvent('filechooser');
      await page.locator('label[for="profilePicture"]').last().click();
      await fileChooserPromise;

      // A true no-op - no crop modal, Save stays disabled.
      await expect(page.getByRole('heading', { name: 'Change Profile Picture' })).toBeHidden();
      await expect(saveButton).toBeDisabled();
    });

    test('should cleanly discard the selected photo when Cancel is clicked in the crop modal', async ({ page }) => {
      const saveButton = page.getByRole('button', { name: 'Save' });

      // 1. Click the avatar's edit pencil and select a valid small PNG
      // file to open the "Change Profile Picture" crop modal.
      await injectCanvasImageFile(page, { width: 200, height: 200, fileName: 'cancel-test.png', color: 'blue' });
      const modalHeading = page.getByRole('heading', { name: 'Change Profile Picture' });
      await expect(modalHeading).toBeVisible();
      await expect(page.getByRole('slider')).toHaveValue('1');

      // 2. Click "Cancel" instead of "Ok".
      await page.getByRole('button', { name: 'Cancel' }).click();

      // Closes immediately with no prompt - a clean, no-op discard; the file never reaches the live-preview state 'Ok' would trigger.
      await expect(modalHeading).toBeHidden();
      await expect(saveButton).toBeDisabled();
    });

    test('should upload, crop, and save a valid photo successfully', async ({ page }) => {
      const saveButton = page.getByRole('button', { name: 'Save' });

      // 1. Select a valid small PNG file in the file chooser (injected
      // in-page; see injectCanvasImageFile()).
      await injectCanvasImageFile(page, { width: 200, height: 200, fileName: 'valid-photo.png', color: 'green' });

      // A "Change Profile Picture" modal opens with a zoom slider starting
      // at the default zoom level "1", and "Cancel" / "Ok" buttons.
      const modalHeading = page.getByRole('heading', { name: 'Change Profile Picture' });
      await expect(modalHeading).toBeVisible();
      await expect(page.getByRole('slider')).toHaveValue('1');

      // 2. Click "Ok".
      await page.getByRole('button', { name: 'Ok' }).click();

      // The modal closes, the avatar preview updates, and the "Save"
      // button becomes enabled.
      await expect(modalHeading).toBeHidden();
      await expect(saveButton).toBeEnabled();

      // 3. Click "Save".
      await saveButton.click();

      // A green success toast appears with the exact expected text, the
      // page stays on /profile, and "Save" reverts to disabled.
      await expect(page.locator('text=Your profile was updated successfully!')).toBeVisible();
      await expect(page).toHaveURL(/\/profile$/);
      await expect(saveButton).toBeDisabled();

      // (No cleanup possible or needed: per the test plan, there is no
      // "remove photo" affordance anywhere in the UI to revert the avatar
      // back to the blank placeholder - this is a known, permanent,
      // harmless cosmetic side effect of this scenario.)
    });

    test('should stage a non-image file in the crop modal without client-side rejection, but never persist it', async ({ page }) => {
      const saveButton = page.getByRole('button', { name: 'Save' });

      // 1. Bypass the OS-level accept-attribute filter (via direct
      // DOM/DataTransfer manipulation) and supply a plain-text file as the
      // selected "photo".
      await injectTextFile(page, 'notes.txt', 'not an image');

      // The app performs no additional client-side file-type or content
      // validation beyond the file input's `accept` attribute: the "Change
      // Profile Picture" crop modal still opens normally (with a blank
      // preview, since a text file has no renderable image data), with no
      // error message shown at this stage.
      const modalHeading = page.getByRole('heading', { name: 'Change Profile Picture' });
      await expect(modalHeading).toBeVisible();

      // Clicking "Ok" closes the modal and enables "Save" anyway - i.e. the
      // app is willing to stage an obviously-invalid "photo" for saving
      // without complaint.
      await page.getByRole('button', { name: 'Ok' }).click();
      await expect(modalHeading).toBeHidden();
      await expect(saveButton).toBeEnabled();

      // 2. Reload instead of Save - discards this staged change without
      // testing backend rejection (out of scope against the shared seed account).
      await page.goto(`${BASE_URL}/profile`);
      await expect(saveButton).toBeDisabled();
    });

    test('should accept a tiny low-resolution image and render it without error', async ({ page }) => {
      // 1. Select a tiny 5x5px PNG file.
      await injectCanvasImageFile(page, { width: 5, height: 5, fileName: 'tiny-photo.png', color: 'red' });

      // Opens normally with no error - no minimum source-dimension enforcement.
      const modalHeading = page.getByRole('heading', { name: 'Change Profile Picture' });
      await expect(modalHeading).toBeVisible();
      await expect(page.getByRole('slider')).toHaveValue('1');

      // 2. (No save needed for this scenario.) Click "Cancel" to discard.
      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(modalHeading).toBeHidden();
    });

    test("should always re-encode the stored photo to a small fixed-size JPEG regardless of the original image's size/dimensions", async ({
      page,
      request,
    }) => {
      const saveButton = page.getByRole('button', { name: 'Save' });

      // 1. Select a large 2000x2000px noisy PNG (stands in for a real ~15MB oversized original, injected in-page to avoid needing a real file on disk).
      await injectNoisyCanvasImageFile(page, { width: 2000, height: 2000, fileName: 'large-photo.png' });

      // Opens normally with no lag/error - no client-side file-size check blocking this.
      const modalHeading = page.getByRole('heading', { name: 'Change Profile Picture' });
      await expect(modalHeading).toBeVisible();

      // 2. Click "Ok", then "Save", and inspect the real network response.
      await page.getByRole('button', { name: 'Ok' }).click();
      await expect(saveButton).toBeEnabled();
      await saveButton.click();
      await expect(page.locator('text=Your profile was updated successfully!')).toBeVisible();
      await expect(saveButton).toBeDisabled();

      // 3. Reload and read the avatar's real stored S3 URL.
      await page.goto(`${BASE_URL}/profile`);
      const avatarSrc = await page.locator('label[for="profilePicture"] img').getAttribute('src');
      expect(avatarSrc).toBeTruthy();

      // 4. Fetch the stored object directly (bypassing browser cache) -
      // regardless of the original 2000x2000 PNG, the crop tool's 'Ok' step always canvas-renders down to a small fixed-size JPEG first.
      const response = await request.get(avatarSrc!);
      expect(response.headers()['content-type']).toBe('image/jpeg');
      const body = await response.body();
      expect(body.length).toBeLessThan(100_000);

      // Confirm the real rendered pixel dimensions via a page-side Image object.
      const dimensions = await page.evaluate(
        (src) =>
          new Promise<{ width: number; height: number }>((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
            img.onerror = reject;
            img.src = src;
          }),
        avatarSrc!
      );
      expect(dimensions).toEqual({ width: 250, height: 250 });
      // No cleanup possible or needed - a permanent, harmless avatar side effect.
    });
  });

  test.describe('Editing Phone Number', () => {
    test('should open a searchable country listbox with dial codes', async ({ page }) => {
      const phoneInput = page.getByRole('textbox', { name: 'Phone Number' });
      const countryCombobox = phoneInput.locator('xpath=..').getByRole('combobox');
      const saveButton = page.getByRole('button', { name: 'Save' });

      // 1. Click the country-flag combobox left of Phone Number (default: US).
      await countryCombobox.click();

      // Unlike the Complete Profile phone widget's quirk (see
      // tests/utils/account.ts), getByRole('option', {name}) resolves to
      // exactly ONE element per country here - no ambiguity workaround needed for this read-only spot-check.
      await expect(page.getByRole('option', { name: 'United States' })).toBeVisible();
      await expect(page.getByRole('option', { name: 'Mexico' })).toBeVisible();

      // The currently-selected country ("United States") is shown as the
      // active/selected option (aria-selected="true").
      await expect(page.getByRole('option', { name: 'United States' })).toHaveAttribute('aria-selected', 'true');

      // 2. Close the listbox with Escape without changing anything - no
      // mutation, nothing to restore.
      await page.keyboard.press('Escape');
      await expect(page.getByRole('listbox')).toBeHidden();
      await expect(phoneInput).toHaveValue(SEED_PHONE_FORMATTED);
      await expect(saveButton).toBeDisabled();
    });

    test('should combine rapid keystrokes into a multi-character type-ahead search, and jump fresh on a single letter after the reset window elapses', async ({
      page,
    }) => {
      const phoneInput = page.getByRole('textbox', { name: 'Phone Number' });
      const countryCombobox = phoneInput.locator('xpath=..').getByRole('combobox');
      const saveButton = page.getByRole('button', { name: 'Save' });
      const activeOption = page.locator(':focus');

      // 1. Open the listbox and press "g" once - jumps to 'Gabon' (the
      // active option is exposed as real DOM focus, queryable via :focus).
      await countryCombobox.click();
      await page.keyboard.press('g');
      await expect(activeOption).toContainText('Gabon');

      // 2. Press "e" immediately after, with no delay - back-to-back
      // keystrokes combine into a multi-character search ("ge" -> 'Georgia'), not two independent single-letter jumps.
      await page.keyboard.press('e');
      await expect(activeOption).toContainText('Georgia');

      // 3. Waiting out the reset window before the next keystroke DOES make it a fresh jump: "e" alone -> 'Ecuador'.
      await page.waitForTimeout(700);
      await page.keyboard.press('e');
      await expect(activeOption).toContainText('Ecuador');

      // 4. Close with Escape without selecting anything - no mutation.
      await page.keyboard.press('Escape');
      await expect(page.getByRole('listbox')).toBeHidden();
      await expect(phoneInput).toHaveValue(SEED_PHONE_FORMATTED);
      await expect(saveButton).toBeDisabled();
    });

    test('should reset Phone Number to the bare dial code when switching country, and allow restoring the original number', async ({
      page,
    }) => {
      const phoneInput = page.getByRole('textbox', { name: 'Phone Number' });
      const saveButton = page.getByRole('button', { name: 'Save' });

      // 1. Open the country selector and choose "Mexico".
      await selectPhoneCountry(page, phoneInput, 'Mexico');

      // Resets to just the bare dial code "+52" - digits discarded, not preserved or reformatted; Save becomes enabled.
      await expect(phoneInput).toHaveValue('+52 ');
      await expect(saveButton).toBeEnabled();

      // 2. Cleanup: switch back and retype the original digits, then save and confirm via reload it genuinely persisted.
      await setPhoneNumber(page, phoneInput, 'United States', SEED_PHONE_DIGITS);
      await expect(phoneInput).toHaveValue(SEED_PHONE_FORMATTED);
      await saveButton.click();
      await expect(page.locator('text=Your profile was updated successfully!')).toBeVisible();
      await page.goto(`${BASE_URL}/profile`);
      await expect(phoneInput).toHaveValue(SEED_PHONE_FORMATTED);
    });

    test("should silently switch the detected country when typed digits look like another country's dial code, and reset (not preserve) the digits when the country is changed back", async ({
      page,
    }) => {
      const phoneInput = page.getByRole('textbox', { name: 'Phone Number' });
      const countryCodeField = page.locator('input[name="phone.countryCode"]');
      const saveButton = page.getByRole('button', { name: 'Save' });

      // Get to a clean bare "+1" state first - switching country and back
      // forces a real reset (re-selecting the SAME country is a MUI no-op, see tests/utils/account.ts).
      await selectPhoneCountry(page, phoneInput, 'Mexico');
      await selectPhoneCountry(page, phoneInput, 'United States');
      await expect(phoneInput).toHaveValue('+1 ');

      // 1. fill() the digits in one action (a programmatic value-set,
      // unlike realistic key-by-key typing) - this specific interaction is
      // what triggers the widget's auto-detect reparse (see the next test for the pressSequentially() contrast).
      await phoneInput.fill('5551234567');

      // Notable finding: auto-country-detection reparses the digits,
      // recognizes the leading "55" as Brazil's dial code, and silently switches the country selector with no user interaction with the dropdown.
      await expect(countryCodeField).toHaveValue('br');
      await expect(phoneInput).toHaveValue('+55 (51) 23456-7');

      // 2. Re-select "United States" without clearing the digits first.
      await selectPhoneCountry(page, phoneInput, 'United States');

      // CORRECTED (differs from specs/profile-settings-test-plan.md section
      // 4.3, which claims the digits carry over reformatted): switching back
      // instead discards them and resets to the bare dial code, same as ordinary country-switch behavior - it does NOT preserve them.
      await expect(countryCodeField).toHaveValue('us');
      await expect(phoneInput).toHaveValue('+1 ');

      // Cleanup: nothing was ever saved - reloading discards this harmless dirtied-but-unsaved state.
      await page.goto(`${BASE_URL}/profile`);
      await expect(phoneInput).toHaveValue(SEED_PHONE_FORMATTED);
      await expect(saveButton).toBeDisabled();
    });

    test('should reject an invalid US area code on Save with "Invalid phone number"', async ({ page }) => {
      const phoneInput = page.getByRole('textbox', { name: 'Phone Number' });
      const saveButton = page.getByRole('button', { name: 'Save' });

      // Recreates the same invalid number independently (beforeEach resets
      // baseline before every test) - but via realistic key-by-key typing
      // (setPhoneNumber() uses pressSequentially, not fill()), which never
      // reinterprets "55" as Brazil's code, formatting straight into a US-shaped number instead.
      await setPhoneNumber(page, phoneInput, 'United States', '5551234567');
      await expect(phoneInput).toHaveValue('+1 (555) 123-4567');

      // 1. Click "Save".
      await saveButton.click();

      await expect(page.locator('text=Invalid phone number')).toBeVisible();
      await expect(phoneInput).toHaveAttribute('aria-invalid', 'true');
      await expect(saveButton).toBeDisabled();
      await expect(page).toHaveURL(`${BASE_URL}/profile`);

      // 2. Cleanup: retype the original valid digits via realistic typing, then Save.
      await setPhoneNumber(page, phoneInput, 'United States', SEED_PHONE_DIGITS);
      await expect(phoneInput).toHaveValue(SEED_PHONE_FORMATTED);
      await saveButton.click();
      await expect(page.locator('text=Your profile was updated successfully!')).toBeVisible();
      await page.goto(`${BASE_URL}/profile`);
      await expect(phoneInput).toHaveValue(SEED_PHONE_FORMATTED);
    });

    test('should show no required-field message when Phone Number is cleared and blurred, unlike First/Last Name', async ({ page }) => {
      const phoneInput = page.getByRole('textbox', { name: 'Phone Number' });
      const firstNameInput = page.locator('input[name="firstName"]');
      const saveButton = page.getByRole('button', { name: 'Save' });

      // 1. Click into the Phone Number field and backspace every
      // character, including the bare "+1" dial-code prefix, so the field
      // is completely empty, then blur it (click into another field).
      await phoneInput.click();
      await phoneInput.press('ControlOrMeta+a');
      await phoneInput.press('Backspace');
      await expect(phoneInput).toHaveValue('');
      await firstNameInput.click();

      // Notable finding: NO "The field is required" message or invalid
      // styling appears - a genuine difference from First/Last Name, which show it immediately on blur.
      await expect(page.locator('text=The field is required')).toHaveCount(0);

      // Save stays disabled - an empty phone doesn't dirty/enable it the way typing a digit does.
      await expect(saveButton).toBeDisabled();

      // 2. Type a single digit ("1") into the empty field - reformats to bare "+1", which does dirty/enable Save.
      await phoneInput.click();
      await phoneInput.pressSequentially('1');
      await expect(phoneInput).toHaveValue('+1 ');
      await expect(saveButton).toBeEnabled();

      // 3. Click "Save" - shows the same "Invalid phone number" message
      // (not "required") - validation only ever happens at submit time, never on blur.
      await saveButton.click();
      await expect(page.locator('text=Invalid phone number')).toBeVisible();
      await expect(page.locator('text=The field is required')).toHaveCount(0);
      await expect(saveButton).toBeDisabled();

      // 4. Cleanup: restore the original valid number and Save.
      await setPhoneNumber(page, phoneInput, 'United States', SEED_PHONE_DIGITS);
      await expect(phoneInput).toHaveValue(SEED_PHONE_FORMATTED);
      await saveButton.click();
      await expect(page.locator('text=Your profile was updated successfully!')).toBeVisible();
      await page.goto(`${BASE_URL}/profile`);
      await expect(phoneInput).toHaveValue(SEED_PHONE_FORMATTED);
    });
  });

  test.describe('Change Password', () => {
    const CHECKLIST_ITEMS = [
      'At least 8 characters',
      'At least 1 uppercase letter',
      'At least 1 lowercase letter',
      'At least 1 digit',
      'At least 1 special character',
    ];
    // Each checklist item switches from grey to this exact green when
    // satisfied - the real DOM signal used throughout, instead of a class name.
    const SATISFIED_COLOR = 'rgb(46, 125, 50)';
    const UNSATISFIED_COLOR = 'rgb(158, 158, 158)';

    test('should open an in-page modal with the expected fields and a live-updating strength checklist', async ({ page }) => {
      const changePasswordButton = page.getByRole('button', { name: 'Change Password' });
      const currentPasswordInput = page.locator('input[name="currentPassword"]');
      const newPasswordInput = page.locator('input[name="newPassword"]');
      const confirmPasswordInput = page.locator('input[name="confirmNewPassword"]');
      const toggleButtons = page.getByRole('button', { name: 'toggle password visibility' });
      const updateButton = page.getByRole('button', { name: 'Update' });

      // 1. On /profile, click "Change Password".
      await changePasswordButton.click();

      // This opens an in-page modal dialog - the URL does NOT change (stays
      // on /profile), confirming it is a modal, not a navigation to a
      // separate route.
      await expect(page).toHaveURL(`${BASE_URL}/profile`);

      // The modal heading reads exactly "Change Password", with an
      // info-style alert banner showing the exact expected text.
      await expect(page.getByRole('heading', { name: 'Change Password' })).toBeVisible();
      await expect(
        page.locator(
          'text=Changing your password will automatically log you out of all active sessions. You will need to sign in again on all devices using your new credentials.'
        )
      ).toBeVisible();

      // The three password fields are visible with correct placeholders,
      // each with its own toggle-visibility button (3 total).
      await expect(currentPasswordInput).toHaveAttribute('placeholder', 'Enter your current password');
      await expect(newPasswordInput).toHaveAttribute('placeholder', 'Enter new password');
      await expect(confirmPasswordInput).toHaveAttribute('placeholder', 'Re-enter new password');
      await expect(toggleButtons).toHaveCount(3);

      // Directly beneath New Password, a live strength checklist lists
      // exactly the 5 expected rules, in order.
      for (const item of CHECKLIST_ITEMS) {
        await expect(page.getByText(item, { exact: true })).toBeVisible();
      }

      // "Update" is disabled by default.
      await expect(updateButton).toBeDisabled();

      // 2. Type a strong password (e.g. "NewStrongPass1!") into New
      // Password.
      await newPasswordInput.fill('NewStrongPass1!');

      // All 5 items turn green simultaneously once a password meeting every rule is typed.
      for (const item of CHECKLIST_ITEMS) {
        await expect(page.getByText(item, { exact: true })).toHaveCSS('color', SATISFIED_COLOR);
      }

      // End: click "Cancel".
      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByRole('heading', { name: 'Change Password' })).toBeHidden();
    });

    test('should show "Passwords do not match" when Confirm New Password differs from New Password', async ({ page }) => {
      const changePasswordButton = page.getByRole('button', { name: 'Change Password' });
      const currentPasswordInput = page.locator('input[name="currentPassword"]');
      const newPasswordInput = page.locator('input[name="newPassword"]');
      const confirmPasswordInput = page.locator('input[name="confirmNewPassword"]');
      const updateButton = page.getByRole('button', { name: 'Update' });

      // 1. Open modal, fill New Password with a strong value, fill Confirm
      // New Password with a different value, blur it.
      await changePasswordButton.click();
      await newPasswordInput.fill('NewStrongPass1!');
      await confirmPasswordInput.fill('DoesNotMatch1!');
      await currentPasswordInput.click();

      // "Passwords do not match" appears beneath Confirm New Password, and
      // "Update" stays disabled while the mismatch persists.
      await expect(page.locator('text=Passwords do not match')).toBeVisible();
      await expect(updateButton).toBeDisabled();

      // End: click "Cancel".
      await page.getByRole('button', { name: 'Cancel' }).click();
    });

    test('should show a generic error (not the specific Cognito error) for a wrong Current Password', async ({ page }) => {
      const changePasswordButton = page.getByRole('button', { name: 'Change Password' });
      const currentPasswordInput = page.locator('input[name="currentPassword"]');
      const newPasswordInput = page.locator('input[name="newPassword"]');
      const confirmPasswordInput = page.locator('input[name="confirmNewPassword"]');
      const updateButton = page.getByRole('button', { name: 'Update' });
      const cancelButton = page.getByRole('button', { name: 'Cancel' });

      // 1. Fill Current Password with a deliberately wrong value, New
      // Password and Confirm New Password both with a matching strong
      // value so the "Update" button becomes enabled, then click "Update".
      await changePasswordButton.click();
      await currentPasswordInput.fill('WrongCurrentPass1!');
      await newPasswordInput.fill('NewStrongPass1!');
      await confirmPasswordInput.fill('NewStrongPass1!');
      await expect(updateButton).toBeEnabled();
      await updateButton.click();

      // This genuinely calls Cognito with the wrong password - shows this
      // generic text, not Cognito's own specific error (unlike the Login
      // page's equivalent failure). Skips instead if Cognito is throttled (see expectGenericPasswordChangeError()).
      const genericErrorBanner = await expectGenericPasswordChangeError(page);
      await expect(updateButton).toBeDisabled();
      await expect(page.getByRole('heading', { name: 'Change Password' })).toBeVisible();
      await expect(page).toHaveURL(`${BASE_URL}/profile`);

      // 2. Click "Cancel" to close the modal without any further
      // submission attempts, then click "Change Password" again.
      await cancelButton.click();
      await changePasswordButton.click();

      // All three fields are empty again and no leftover error - modal state is NOT preserved/cached between opens.
      await expect(currentPasswordInput).toHaveValue('');
      await expect(newPasswordInput).toHaveValue('');
      await expect(confirmPasswordInput).toHaveValue('');
      await expect(genericErrorBanner).toBeHidden();

      // (Cleanup) Close the modal.
      await cancelButton.click();
    });

    test('should toggle password visibility independently across all three fields', async ({ page }) => {
      const changePasswordButton = page.getByRole('button', { name: 'Change Password' });
      const currentPasswordInput = page.locator('input[name="currentPassword"]');
      const newPasswordInput = page.locator('input[name="newPassword"]');
      const confirmPasswordInput = page.locator('input[name="confirmNewPassword"]');
      const toggleButtons = page.getByRole('button', { name: 'toggle password visibility' });

      // 1. Type a value into "Current Password" and click its own eye-icon
      // toggle (the first of the three, in DOM order: Current, New,
      // Confirm).
      await changePasswordButton.click();
      await currentPasswordInput.fill('SomeValue123!');
      await toggleButtons.nth(0).click();

      // Current Password's `type` changes to "text" - the other two are unaffected, each has its own independent toggle.
      await expect(currentPasswordInput).toHaveAttribute('type', 'text');
      await expect(newPasswordInput).toHaveAttribute('type', 'password');
      await expect(confirmPasswordInput).toHaveAttribute('type', 'password');

      // End: click "Cancel".
      await page.getByRole('button', { name: 'Cancel' }).click();
    });

    test('should show inconsistent blur validation across the three password fields — New Password never shows required, unlike Current and Confirm', async ({
      page,
    }) => {
      const changePasswordButton = page.getByRole('button', { name: 'Change Password' });
      const currentPasswordInput = page.locator('input[name="currentPassword"]');
      const newPasswordInput = page.locator('input[name="newPassword"]');
      const confirmPasswordInput = page.locator('input[name="confirmNewPassword"]');
      const requiredMessage = page.locator('text=The field is required');

      // 1. Open "Change Password" on a fresh modal instance. Click into
      // "Current Password", then blur it (click into "New Password") while
      // it is still empty.
      await changePasswordButton.click();
      await currentPasswordInput.click();
      await newPasswordInput.click();

      // A red inline "The field is required" message appears beneath
      // Current Password - same pattern as the login/register pages.
      await expect(requiredMessage).toHaveCount(1);

      // 2. With focus now in the empty "New Password" field, blur it
      // (click into "Confirm New Password") without typing anything.
      await confirmPasswordInput.click();

      // Notable finding: NO message appears beneath New Password - count
      // stays at 1, a genuine inconsistency with the field above it in the same form.
      await expect(requiredMessage).toHaveCount(1);

      // 3. Type then delete a character (rules out "never focused"), then blur again - this also blurs Confirm New Password for the first time.
      await newPasswordInput.click();
      await newPasswordInput.pressSequentially('a');
      await newPasswordInput.press('Backspace');
      await confirmPasswordInput.click();

      // Still NO required-field message for New Password even after being
      // focused/typed/cleared - a real, consistent absence, not merely an untouched-field skip.
      await expect(requiredMessage).toHaveCount(2);

      // 4. Blur the empty Confirm New Password field too.
      await currentPasswordInput.click();

      // "The field is required" DOES appear for Confirm New Password - New Password is the outlier of the three.
      await expect(requiredMessage).toHaveCount(2);

      // 5. Cleanup: close the modal.
      await page.getByRole('button', { name: 'Cancel' }).click();
    });

    test('should keep Update disabled when New Password satisfies only some checklist rules, with no extra error text', async ({
      page,
    }) => {
      const changePasswordButton = page.getByRole('button', { name: 'Change Password' });
      const currentPasswordInput = page.locator('input[name="currentPassword"]');
      const newPasswordInput = page.locator('input[name="newPassword"]');
      const confirmPasswordInput = page.locator('input[name="confirmNewPassword"]');
      const updateButton = page.getByRole('button', { name: 'Update' });
      const satisfiedItems = CHECKLIST_ITEMS.slice(0, 3); // 8 chars, uppercase, lowercase
      const unsatisfiedItems = CHECKLIST_ITEMS.slice(3); // digit, special character

      // 1. Type a password missing a digit and a special character.
      await changePasswordButton.click();
      await newPasswordInput.fill('WeakPassword');

      // Exactly 3 of the 5 checklist items turn green; the remaining 2 stay grey.
      for (const item of satisfiedItems) {
        await expect(page.getByText(item, { exact: true })).toHaveCSS('color', SATISFIED_COLOR);
      }
      for (const item of unsatisfiedItems) {
        await expect(page.getByText(item, { exact: true })).toHaveCSS('color', UNSATISFIED_COLOR);
      }

      // 2. Fill Confirm New Password identically (rules out "don't match") and Current Password with any value.
      await confirmPasswordInput.fill('WeakPassword');
      await currentPasswordInput.fill('SomeCurrentPasswordValue');

      // Remains DISABLED - the checklist is a real, enforced client-side gate, with no extra error text explaining why.
      await expect(updateButton).toBeDisabled();
      await expect(page.locator('text=Passwords do not match')).toBeHidden();
      await expect(page.locator('text=The field is required')).toHaveCount(0);

      // 3. Cleanup: close the modal.
      await page.getByRole('button', { name: 'Cancel' }).click();
    });

    test('should only close via the Cancel button — neither Escape nor clicking the backdrop works', async ({ page }) => {
      const changePasswordButton = page.getByRole('button', { name: 'Change Password' });
      const modalHeading = page.getByRole('heading', { name: 'Change Password' });

      // 1. Open "Change Password", then press the Escape key.
      await changePasswordButton.click();
      await page.keyboard.press('Escape');

      // Remains fully open - Escape does NOT close it, unlike typical MUI modal default behavior.
      await expect(modalHeading).toBeVisible();

      // 2. Click the backdrop directly - also does NOT close it.
      await page.locator('.MuiBackdrop-root').click({ position: { x: 5, y: 5 } });
      await expect(modalHeading).toBeVisible();

      // 3. Click 'Cancel' - the one reliable way to dismiss it.
      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(modalHeading).toBeHidden();
    });

    test('should not block submission client-side when New Password equals Current Password, but must never actually be submitted', async ({
      page,
    }) => {
      const changePasswordButton = page.getByRole('button', { name: 'Change Password' });
      const currentPasswordInput = page.locator('input[name="currentPassword"]');
      const newPasswordInput = page.locator('input[name="newPassword"]');
      const confirmPasswordInput = page.locator('input[name="confirmNewPassword"]');
      const updateButton = page.getByRole('button', { name: 'Update' });

      // 1. Fill all three fields with the seed account's real current password - attempting to "change" it to the same value.
      await changePasswordButton.click();
      await currentPasswordInput.fill(SEED_PASSWORD);
      await newPasswordInput.fill(SEED_PASSWORD);
      await confirmPasswordInput.fill(SEED_PASSWORD);

      // Becomes ENABLED - no client-side check prevents submitting an identical new password.
      await expect(updateButton).toBeEnabled();

      // 2. Deliberately never click "Update" against the shared seed account - click "Cancel" instead.
      await page.getByRole('button', { name: 'Cancel' }).click();
    });

    test('should send only a single failed request on a rapid double-click of Update', async ({ page }) => {
      const changePasswordButton = page.getByRole('button', { name: 'Change Password' });
      const currentPasswordInput = page.locator('input[name="currentPassword"]');
      const newPasswordInput = page.locator('input[name="newPassword"]');
      const confirmPasswordInput = page.locator('input[name="confirmNewPassword"]');
      const updateButton = page.getByRole('button', { name: 'Update' });

      // 1. Fill a deliberately wrong (safe, guaranteed-to-fail) Current Password plus a valid matching New Password.
      await changePasswordButton.click();
      await currentPasswordInput.fill('WrongCurrentPass1!');
      await newPasswordInput.fill('NewStrongPass1!');
      await confirmPasswordInput.fill('NewStrongPass1!');

      // Tracks every real request to Cognito's ChangePassword endpoint.
      const changePasswordRequests: string[] = [];
      page.on('request', (request) => {
        if (request.method() === 'POST' && request.headers()['x-amz-target'] === 'AWSCognitoIdentityProviderService.ChangePassword') {
          changePasswordRequests.push(request.url());
        }
      });

      // Double-click "Update" rapidly (skips instead if Cognito is throttled - see expectGenericPasswordChangeError()).
      await updateButton.dblclick();
      const genericErrorBanner = await expectGenericPasswordChangeError(page);

      // Only ONE request was actually sent - this button also guards against duplicate submissions, like the outer 'Save' button.
      expect(changePasswordRequests).toHaveLength(1);
      await expect(genericErrorBanner).toHaveCount(1);

      // 2. Cleanup: close the modal - the seed account's real password remains unchanged.
      await page.getByRole('button', { name: 'Cancel' }).click();
    });
  });

  test.describe('Account Deletion (cross-reference)', () => {
    test('should show the delete confirmation dialog and safely cancel via "No, go back"', async ({ page }) => {
      const firstNameInput = page.locator('input[name="firstName"]');

      // 1. Click "Delete Account" to open its confirmation dialog.
      await page.getByRole('button', { name: 'Delete Account' }).click();

      // Includes the known copy typo "want o delete" (missing "t"),
      // reproduced exactly. forgot-password.spec.ts's own test already
      // automates the real "Yes, delete" click against a disposable account - this one never does, since it's the shared seed account.
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: 'Delete Account' })).toBeVisible();
      await expect(dialog.locator('text=Are you sure you want o delete your Job Link Account?')).toBeVisible();
      await expect(
        dialog.locator(
          'text=Your account can not be recovered if deleted. All history will be inaccessible and your subscription will not be renewed.'
        )
      ).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'No, go back' })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Yes, delete' })).toBeVisible();

      // 2. Click "No, go back" - never "Yes, delete" - so the shared seed account is never actually deleted.
      await dialog.getByRole('button', { name: 'No, go back' }).click();

      // A safe, reversible no-op - dialog closes, data completely unchanged.
      await expect(dialog).toBeHidden();
      await expect(page).toHaveURL(`${BASE_URL}/profile`);
      await expect(firstNameInput).toHaveValue(SEED_FIRST_NAME);
    });
  });
});

// Uses a fresh disposable account (never the shared seed account), safe for a real password change against the live backend.
test.describe('Full end-to-end password change (real email, real code)', () => {
  test.describe.configure({ retries: 1 });

  test('should complete a real password change via the Change Password modal and allow login with the new password @real-email', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'Backend-only flow; runs once to avoid tripling load on the real email pipeline.');
    test.setTimeout(300_000);

    // 1. Register a new disposable account and verify its email, confirming the redirect to /login.
    const emailAlias = generateUniqueEmailAlias();
    const username = generateUsernameFromEmail(emailAlias);
    const originalPassword = requireEnv('TEST_REGISTER_PASSWORD');
    const registeredAt = new Date();
    await registerNewAccount(page, emailAlias);
    const verificationLink = await getVerificationLink(emailAlias, registeredAt);
    await page.goto(verificationLink);
    await expect(page).toHaveURL(`${BASE_URL}/login`);

    // 2. Log in with the account's original password.
    await page.locator('input[name="username"]').fill(username);
    await page.locator('input[name="password"]').fill(originalPassword);
    await page.locator('button[type="submit"]').click();

    // 3. It's a brand-new account, so it lands on /complete-profile;
    // complete it, then confirm it reaches /company or /teams/list.
    await expect(page).toHaveURL(`${BASE_URL}/complete-profile`);
    await completeProfile(page);
    await expect(page).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });

    // 4. Navigate to /profile via the account avatar menu, exactly like the
    // account-deletion flow above.
    await page.getByRole('button', { name: 'account of current user' }).click();
    await page.getByRole('menuitem', { name: 'Profile' }).click();
    await expect(page).toHaveURL(`${BASE_URL}/profile`);

    // 5. Open "Change Password". Fill Current Password with the account's
    // REAL original password, and New Password / Confirm New Password both
    // with a genuinely different new strong password, then click "Update".
    const newPassword = 'NewStrongPass1!';
    await page.getByRole('button', { name: 'Change Password' }).click();
    await page.locator('input[name="currentPassword"]').fill(originalPassword);
    await page.locator('input[name="newPassword"]').fill(newPassword);
    await page.locator('input[name="confirmNewPassword"]').fill(newPassword);
    const updateButton = page.getByRole('button', { name: 'Update' });
    await expect(updateButton).toBeEnabled();
    await updateButton.click();

    // 6. True to the modal's own warning banner, the browser auto-redirects to /login within a few seconds.
    await expect(page.locator('text=Password updated successfully! Please log in with your new password.')).toBeVisible();
    await expect(page).toHaveURL(`${BASE_URL}/login`, { timeout: 15_000 });

    // 7. Logging in with the NEW password proves it was genuinely persisted, not just a UI-only confirmation.
    await page.locator('input[name="username"]').fill(username);
    await page.locator('input[name="password"]').fill(newPassword);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });

    // 8. Extra strength check: log out and confirm the OLD password no longer works, proving the change was real, not merely additive.
    await page.getByRole('button', { name: 'account of current user' }).click();
    await page.getByRole('menuitem', { name: 'Log Out' }).click();
    await expect(page).toHaveURL(`${BASE_URL}/login`);
    await page.locator('input[name="username"]').fill(username);
    await page.locator('input[name="password"]').fill(originalPassword);
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('text=Incorrect username or password.')).toBeVisible();
  });
});
