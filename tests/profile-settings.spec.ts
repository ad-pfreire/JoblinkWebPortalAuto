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

// The seed account's baseline values - NOT hardcoded. Portability: this
// suite is meant to run against whatever seed account a given developer/CI
// environment has configured in .env (TEST_USERNAME/TEST_LOGIN_PASSWORD),
// not specifically the maintainer's own pfautomation account. A different
// account almost certainly has a different name/phone already set, so
// hardcoding literal expected values here (as this file used to) would make
// it fail immediately against anyone else's seed account. Instead,
// discoverSeedBaseline() below reads whatever these fields ACTUALLY are on
// first run and uses that as the "restore point" every test returns to -
// works with any seed account's current state, sight unseen.
let SEED_FIRST_NAME: string;
let SEED_LAST_NAME: string;
let SEED_PHONE_FORMATTED: string;
let SEED_PHONE_DIGITS: string;

// Logs in as the shared seed account and lands on /profile, without
// asserting anything about the name fields' values - used both by
// discoverSeedBaseline() (before those values are known) and by
// loginAsSeedAndGoToProfile() below (after they are).
async function loginAsSeed(page: Page) {
  await page.goto(`${BASE_URL}/login`);
  await page.locator('input[name="username"]').fill(SEED_USERNAME);
  await page.locator('input[name="password"]').fill(SEED_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });
  await page.goto(`${BASE_URL}/profile`);
  await expect(page.locator('input[name="firstName"]')).not.toHaveValue('');
}

// Logs in as the shared seed account and lands on /profile, then confirms
// the page shows the discovered baseline first name - a sanity check, at
// the start of every test, that the account is in the same restored state
// this suite left it in (not a check against a fixed literal anymore, see
// SEED_FIRST_NAME above).
async function loginAsSeedAndGoToProfile(page: Page) {
  await loginAsSeed(page);
  await expect(page.locator('input[name="firstName"]')).toHaveValue(SEED_FIRST_NAME);
}

// Runs once before any test in this file: logs in, reads whatever this seed
// account's First Name / Last Name / Phone Number currently are, and uses
// those as SEED_FIRST_NAME/SEED_LAST_NAME/SEED_PHONE_FORMATTED/
// SEED_PHONE_DIGITS for the rest of the file. Phone digits are extracted
// from the formatted display value (e.g. "+1 (212) 555-0100" ->
// "2125550100") by stripping non-digits and dropping a leading US country
// code "1" if present, since setPhoneNumber() (tests/utils/account.ts)
// takes bare local digits with the country selected separately - this
// assumes a US-formatted number, consistent with every phone-editing test
// in this file already hardcoding country 'United States'.
async function discoverSeedBaseline(browser: import('@playwright/test').Browser) {
  const page = await browser.newPage();
  await loginAsSeed(page);
  SEED_FIRST_NAME = await page.locator('input[name="firstName"]').inputValue();
  SEED_LAST_NAME = await page.locator('input[name="lastName"]').inputValue();
  SEED_PHONE_FORMATTED = await page.getByRole('textbox', { name: 'Phone Number' }).inputValue();
  const digitsWithCountryCode = SEED_PHONE_FORMATTED.replace(/\D/g, '');
  SEED_PHONE_DIGITS = digitsWithCountryCode.length === 11 && digitsWithCountryCode.startsWith('1') ? digitsWithCountryCode.slice(1) : digitsWithCountryCode;
  await page.close();
}

// Clicks Save and waits for the real POST /profile response, rather than
// just the success toast text. Needed whenever a test performs two real
// saves close together (e.g. dirty a field, save, then immediately restore
// it and save again): the success toast from the first save can still be on
// screen when the second one fires, so asserting on the toast TEXT alone
// would trivially pass against that still-visible toast without proving the
// second save actually completed before a following reload/assertion.
async function saveAndWaitForSuccess(page: Page, saveButton: Locator) {
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/profile'),
    saveButton.click(),
  ]);
  expect(response.ok()).toBe(true);
}

// Injects a synthetic image file into the hidden #profilePicture input by
// drawing a canvas image, converting it to a Blob, and wiring it up via
// DataTransfer + a manual "change" event. Standard Playwright
// setInputFiles() with a Buffer is not reliably usable for synthetic images
// in every execution context here, but this in-page canvas+DataTransfer
// technique is live-verified to work and reliably opens the crop modal,
// exactly like a real file selection would.
async function injectCanvasImageFile(
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
      const input = document.querySelector<HTMLInputElement>('#profilePicture')!;
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { width, height, fileName, mimeType, color }
  );
}

// Same in-page canvas+DataTransfer technique as above, but fills the canvas
// with randomized noise blocks so the resulting PNG blob is a substantial,
// non-trivially-compressible size (used for the oversized-image scenario,
// so toBlob() doesn't optimize a large flat-color image away to almost
// nothing).
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

// Injects a plain-text (non-image) file the same way, to probe whether the
// app performs any real content-type validation on the selected "photo"
// beyond the file input's `accept` attribute (which is a browser/OS-level
// filename filter only, not a real security/validation boundary).
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

// Every test below reads or mutates the ONE shared seed account
// (pfautomation) that the rest of this suite also depends on for login -
// unlike registration/forgot-password, Profile Settings has no way to spin up
// a disposable account for most of its scenarios (Email/Username are
// read-only on this page). Running these across 3 parallel browser projects
// and multiple workers (the default locally; forgot-password.spec.ts and
// account-registration.spec.ts avoid this entirely by registering a
// fresh, run-unique account per test) would race on that single account's
// First Name/Phone/Save state and could leave it corrupted for every other
// spec file. Serial + chromium-only mirrors the same trade-off those other
// files already make for their own backend-mutating describes, just applied
// to the whole file instead of a single block.
test.describe('Profile Settings', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    await discoverSeedBaseline(browser);
  });

  test.beforeEach(async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Shared seed account state; runs once serially on chromium to avoid cross-project races on the same account.');
    await loginAsSeedAndGoToProfile(page);
  });

  test.describe('Page UI', () => {
    test('should display all required elements in their default state', async ({ page }) => {
      // 1. Log in with the seed account and navigate to /profile (done by
      // beforeEach). Page title and heading.
      await expect(page).toHaveTitle('Profile | Job Link');
      await expect(page.getByText('Profile Settings', { exact: true })).toBeVisible();

      // A circular avatar image is visible. The profilePicture file input is
      // wrapped by TWO separate <label for="profilePicture"> elements (one
      // around the avatar image, one around the pencil edit-icon badge) -
      // scope to the avatar itself to avoid a strict-mode ambiguity.
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

      // Notable finding: the "Save" button remains ENABLED even though the
      // field's current value is now byte-for-byte identical to its
      // original value. The button's enabled state tracks whether the
      // field was ever dirtied/touched during this page session, not
      // whether the current value differs from the original.
      await expect(saveButton).toBeEnabled();

      // 2. (Cleanup) Reload the page (do not click Save) to discard this
      // no-op dirty state. The page reloads with First Name back to "QA"
      // and the Save button disabled again, confirming nothing was
      // actually persisted.
      await page.goto(`${BASE_URL}/profile`);
      await expect(firstNameInput).toHaveValue(SEED_FIRST_NAME);
      await expect(saveButton).toBeDisabled();
    });

    test('should keep Email Address and Username genuinely non-editable', async ({ page }) => {
      // 1. On /profile, inspect the Email Address and Username inputs' DOM
      // `disabled` property directly (not just visual styling): both
      // inputs have `disabled === true` at the element level, and
      // `readOnly === false` - i.e. they rely on the native disabled
      // attribute, not a readonly/CSS-only trick.
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

      // Live-verified via DOM inspection: the input's raw value retains
      // the whitespace exactly as typed - the field does NOT auto-trim on
      // input, matching the same untrimmed behavior already documented for
      // the Login page's username/email field.
      await expect(firstNameInput).toHaveValue(paddedFirstName);

      // 2. Click "Save"; it succeeds with the standard success toast.
      await saveButton.click();
      await expect(page.locator('text=Your profile was updated successfully!')).toBeVisible();

      // Live-verified, notable finding that DIFFERS from the documented
      // plan expectation (specs/profile-settings-test-plan.md section
      // 2.6, which claims this round-trip trims the whitespace): reloading
      // the page shows the padded value round-trips through the backend
      // completely UNCHANGED - the whitespace is NOT trimmed client- or
      // server-side, so the field still reads "  QA  " after reload.
      await page.goto(`${BASE_URL}/profile`);
      await expect(firstNameInput).toHaveValue(paddedFirstName);

      // (Cleanup) Since the round-trip does not trim this on its own,
      // explicitly restore First Name back to the clean seed value. Reload
      // afterward (rather than trusting the toast/DOM state alone) to
      // confirm the restore genuinely round-tripped through the backend -
      // a lingering toast from the first save above could otherwise make a
      // toast-only check pass without the second save having landed yet.
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

      // The full 243-character value is accepted with no truncation and no
      // inline error message of any kind appears on blur; the "Save"
      // button becomes enabled.
      await expect(page.locator('text=The field is required')).toHaveCount(0);
      await expect(firstNameInput).toHaveValue(longFirstName);
      await expect(saveButton).toBeEnabled();

      // 2. Click "Save", then reload the page. The full 243-character
      // value is genuinely accepted and persisted by the backend - a
      // green success toast appears, and after reload the First Name
      // field still shows the complete, untruncated 243-character string.
      await saveButton.click();
      await expect(page.locator('text=Your profile was updated successfully!')).toBeVisible();
      await page.goto(`${BASE_URL}/profile`);
      await expect(firstNameInput).toHaveValue(longFirstName);

      // 3. (Cleanup) Restore First Name back to "QA" and click "Save"
      // again. The field reads "QA" and Save succeeds with the same
      // success toast, restoring the seed account's original First Name.
      // Reload afterward to confirm the restore genuinely persisted, not
      // just that the toast/DOM reflected the intended value.
      await firstNameInput.fill(SEED_FIRST_NAME);
      await saveAndWaitForSuccess(page, saveButton);
      await page.goto(`${BASE_URL}/profile`);
      await expect(firstNameInput).toHaveValue(SEED_FIRST_NAME);
    });

    test('should send only a single save request on a rapid double-click of Save', async ({ page }) => {
      const firstNameInput = page.locator('input[name="firstName"]');
      const saveButton = page.getByRole('button', { name: 'Save' });

      // 1. Make a small valid edit to First Name (e.g. "QAX") to enable
      // Save, then double-click the "Save" button rapidly (two clicks in
      // immediate succession). Track every POST request to the
      // profile-save endpoint (live-verified: `POST /profile`) sent as a
      // result of the double-click.
      await firstNameInput.fill(`${SEED_FIRST_NAME}X`);
      const saveRequests: string[] = [];
      page.on('request', (request) => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/profile') {
          saveRequests.push(request.url());
        }
      });

      await saveButton.dblclick();
      await expect(page.locator('text=Your profile was updated successfully!')).toBeVisible();

      // Only ONE POST request was actually sent as a result of the
      // double-click, and only one success toast appeared - the button
      // correctly guards against duplicate submissions rather than firing
      // two save requests.
      expect(saveRequests).toHaveLength(1);

      // 2. (Cleanup) Restore First Name back to "QA" and click "Save"
      // again. The success toast from the double-click above can still be
      // on screen at this point (it doesn't auto-dismiss instantly), so
      // asserting on the toast TEXT alone here would trivially pass against
      // that still-visible toast without proving this second save actually
      // completed - wait for the real POST /profile response instead, then
      // reload to confirm the restore genuinely persisted server-side.
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
      // 1. On /profile, inspect the underlying `<input type="file"
      // id="profilePicture">` element (wrapped by the visible avatar
      // label/pencil edit-icon that triggers the OS file chooser).
      await expect(page.locator('input#profilePicture')).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp');
    });

    test('should leave the page completely unchanged when the file chooser is dismissed with no file selected', async ({ page }) => {
      const saveButton = page.getByRole('button', { name: 'Save' });

      // 1. Click the avatar's edit pencil (the second of the two
      // <label for="profilePicture"> elements - the first wraps the avatar
      // image itself, this one wraps the pencil badge icon) to open the OS
      // file chooser, then cancel/dismiss it without selecting any file.
      const fileChooserPromise = page.waitForEvent('filechooser');
      await page.locator('label[for="profilePicture"]').last().click();
      await fileChooserPromise;
      // (Dismissed: intentionally never call setFiles() on the chooser,
      // simulating a user cancelling the native picker with nothing
      // selected.)

      // No "Change Profile Picture" modal ever appears (since no file was
      // selected, there is nothing to crop), and the "Save" button in
      // particular stays disabled - confirming this is a true no-op with
      // no partial/broken intermediate state.
      await expect(page.getByRole('heading', { name: 'Change Profile Picture' })).not.toBeVisible();
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

      // The modal closes immediately with no confirmation prompt, and the
      // "Save" button remains disabled - confirming Cancel-in-crop-modal is
      // a clean, no-op discard, with the newly selected file never even
      // reaching the live-preview/staged state that "Ok" would trigger.
      await expect(modalHeading).not.toBeVisible();
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
      await expect(modalHeading).not.toBeVisible();
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
      await expect(modalHeading).not.toBeVisible();
      await expect(saveButton).toBeEnabled();

      // 2. Reload the page instead of clicking "Save", to discard this
      // staged invalid change without finding out whether the backend
      // itself would reject a non-image upload (out of scope per the test
      // plan against the shared seed account).
      await page.goto(`${BASE_URL}/profile`);

      // The page reloads with the avatar and "Save" button back to their
      // prior (disabled) state, confirming the invalid selection was never
      // persisted.
      await expect(saveButton).toBeDisabled();
    });

    test('should accept a tiny low-resolution image and render it without error', async ({ page }) => {
      // 1. Select a tiny 5x5px PNG file.
      await injectCanvasImageFile(page, { width: 5, height: 5, fileName: 'tiny-photo.png', color: 'red' });

      // The crop modal opens normally with its zoom slider, rendering the
      // tiny image without any error, warning, or rejection - no minimum
      // source-dimension enforcement.
      const modalHeading = page.getByRole('heading', { name: 'Change Profile Picture' });
      await expect(modalHeading).toBeVisible();
      await expect(page.getByRole('slider')).toHaveValue('1');

      // 2. (No save needed for this scenario.) Click "Cancel" to discard.
      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(modalHeading).not.toBeVisible();
    });

    test('should always re-encode the stored photo to a small fixed-size JPEG regardless of the original image\'s size/dimensions', async ({ page, request }) => {
      const saveButton = page.getByRole('button', { name: 'Save' });

      // 1. Select a large 2000x2000px PNG, filled with randomized noise
      // blocks (visible content, so toBlob() doesn't optimize it away to
      // almost nothing) - standing in for the plan's ~15MB oversized
      // original, injected in-page to safely probe this without needing an
      // actual multi-MB file on disk.
      await injectNoisyCanvasImageFile(page, { width: 2000, height: 2000, fileName: 'large-photo.png' });

      // The crop modal opens normally, rendering the full large image with
      // no lag, warning, or size-related error of any kind, confirming
      // there is no client-side file-size check blocking this.
      const modalHeading = page.getByRole('heading', { name: 'Change Profile Picture' });
      await expect(modalHeading).toBeVisible();

      // 2. Click "Ok", then "Save", and inspect the actual network
      // response for the uploaded image.
      await page.getByRole('button', { name: 'Ok' }).click();
      await expect(saveButton).toBeEnabled();
      await saveButton.click();
      await expect(page.locator('text=Your profile was updated successfully!')).toBeVisible();
      await expect(saveButton).toBeDisabled();

      // 3. Reload the page and read the avatar `<img>`'s real stored S3
      // URL.
      await page.goto(`${BASE_URL}/profile`);
      const avatarSrc = await page.locator('label[for="profilePicture"] img').getAttribute('src');
      expect(avatarSrc).toBeTruthy();

      // 4. Fetch the actual stored object directly via an API request
      // (bypassing any browser image cache) and inspect its real HTTP
      // response headers: regardless of the original 2000x2000 PNG that
      // was selected, the crop tool's "Ok" step always canvas-renders the
      // crop selection down to a small, fixed-size JPEG client-side before
      // ever uploading.
      const response = await request.get(avatarSrc!);
      expect(response.headers()['content-type']).toBe('image/jpeg');
      const body = await response.body();
      expect(body.length).toBeLessThan(100_000);

      // Confirm the actual rendered pixel dimensions are exactly 250x250,
      // by loading the same stored URL into a page-side Image object.
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

      // (No cleanup possible or needed: same permanent, harmless avatar
      // side effect already documented in the valid-upload scenario above.)
    });
  });

  test.describe('Editing Phone Number', () => {
    test('should open a searchable country listbox with dial codes', async ({ page }) => {
      const phoneInput = page.getByRole('textbox', { name: 'Phone Number' });
      const countryCombobox = phoneInput.locator('xpath=..').getByRole('combobox');
      const saveButton = page.getByRole('button', { name: 'Save' });

      // 1. On /profile, click the country-flag combobox to the left of the
      // Phone Number field (default: US flag, "us").
      await countryCombobox.click();

      // A listbox opens showing every country alphabetically, each option
      // showing the country name and its dial code; spot-check two
      // entries. Live-verified via DOM inspection: unlike the quirk
      // documented for the Complete Profile page's phone widget in
      // tests/utils/account.ts, this page's getByRole('option', { name })
      // resolves to exactly ONE element per country (no hidden duplicate
      // native <select> option was found in the DOM here), so the specific
      // ambiguity workaround is not needed for this read-only spot-check.
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

    test('should combine rapid keystrokes into a multi-character type-ahead search, and jump fresh on a single letter after the reset window elapses', async ({ page }) => {
      const phoneInput = page.getByRole('textbox', { name: 'Phone Number' });
      const countryCombobox = phoneInput.locator('xpath=..').getByRole('combobox');
      const saveButton = page.getByRole('button', { name: 'Save' });
      const activeOption = page.locator(':focus');

      // 1. Open the country selector listbox and press the "g" key once.
      await countryCombobox.click();
      await page.keyboard.press('g');

      // Live-verified via DOM inspection: the listbox's active/highlighted
      // option is exposed as the real DOM focus - document.activeElement
      // resolves directly to the highlighted <li role="option"> itself
      // (not merely an aria-activedescendant pointer elsewhere), so it's
      // queryable via the standard :focus pseudo-class. The listbox jumps
      // to "Gabon", the first country alphabetically starting with "G".
      await expect(activeOption).toContainText('Gabon');

      // 2. Press "e" immediately afterward (no delay - the natural pace of
      // automated key presses). Live-verified, a real finding this
      // automated run surfaced that the original manual exploration in the
      // test plan (section 4.6) explicitly flagged as unconfirmed either
      // way: back-to-back keystrokes with no gap are NOT treated as two
      // independent single-letter jumps - they combine into a multi-
      // character search. "ge" jumps to "Georgia", not "Ecuador".
      await page.keyboard.press('e');
      await expect(activeOption).toContainText('Georgia');

      // 3. Waiting out the widget's type-ahead reset window before the next
      // keystroke DOES make it a fresh single-letter jump: "e" alone (after
      // the pause) jumps to "Ecuador", the first country starting with "E".
      await page.waitForTimeout(700);
      await page.keyboard.press('e');
      await expect(activeOption).toContainText('Ecuador');

      // 4. Close with Escape without selecting anything - no mutation.
      await page.keyboard.press('Escape');
      await expect(page.getByRole('listbox')).toBeHidden();
      await expect(phoneInput).toHaveValue(SEED_PHONE_FORMATTED);
      await expect(saveButton).toBeDisabled();
    });

    test('should reset Phone Number to the bare dial code when switching country, and allow restoring the original number', async ({ page }) => {
      const phoneInput = page.getByRole('textbox', { name: 'Phone Number' });
      const saveButton = page.getByRole('button', { name: 'Save' });

      // 1. With Phone Number showing "+1 (212) 555-0100" (US), open the
      // country selector and choose "Mexico".
      await selectPhoneCountry(page, phoneInput, 'Mexico');

      // The Phone Number field immediately resets to just "+52" (the bare
      // dial code) - all previously entered digits are discarded, not
      // preserved or reformatted - and the "Save" button becomes enabled
      // (the field is now dirtied).
      await expect(phoneInput).toHaveValue('+52 ');
      await expect(saveButton).toBeEnabled();

      // 2. (Cleanup) Switch the country back to "United States" and
      // retype the original digits "2125550100" (via the same helper the
      // Complete Profile page's own tests already rely on for this widget,
      // see tests/utils/account.ts), then click Save to restore the
      // original phone number and confirm the success toast appears again.
      await setPhoneNumber(page, phoneInput, 'United States', SEED_PHONE_DIGITS);
      await expect(phoneInput).toHaveValue(SEED_PHONE_FORMATTED);
      await saveButton.click();
      await expect(page.locator('text=Your profile was updated successfully!')).toBeVisible();
      // Reload to confirm the restore genuinely persisted server-side,
      // rather than trusting the toast/DOM state alone.
      await page.goto(`${BASE_URL}/profile`);
      await expect(phoneInput).toHaveValue(SEED_PHONE_FORMATTED);
    });

    test('should silently switch the detected country when typed digits look like another country\'s dial code, and reset (not preserve) the digits when the country is changed back', async ({ page }) => {
      const phoneInput = page.getByRole('textbox', { name: 'Phone Number' });
      const countryCodeField = page.locator('input[name="phone.countryCode"]');
      const saveButton = page.getByRole('button', { name: 'Save' });

      // With the country already "United States" (baseline), get to a
      // clean bare "+1" state first, exactly like the cleanup in the
      // previous test: switching to a different country and back forces a
      // real reset (re-selecting the SAME country alone is a no-op in MUI
      // - see setPhoneNumber()'s comment in tests/utils/account.ts).
      await selectPhoneCountry(page, phoneInput, 'Mexico');
      await selectPhoneCountry(page, phoneInput, 'United States');
      await expect(phoneInput).toHaveValue('+1 ');

      // 1. Type the digit sequence "5551234567" directly into the Phone
      // Number field in one action (fill(), a programmatic value-set like
      // a browser autofill/paste, rather than realistic key-by-key
      // typing). Live-verified: this specific interaction is what
      // triggers the widget's auto-detect reparse - the same digits typed
      // key-by-key via pressSequentially do NOT trigger it and instead
      // format straight into a US-shaped number (see the next test).
      await phoneInput.fill('5551234567');

      // Live-verified, notable finding: the widget's auto-country-
      // detection logic reparses the digits, recognizes the leading "55"
      // as Brazil's dial code, and silently switches the country selector
      // from "United States" ("us") to Brazil ("br") without any user
      // interaction with the country dropdown itself. The field ends up
      // reading exactly "+55 (51) 23456-7".
      await expect(countryCodeField).toHaveValue('br');
      await expect(phoneInput).toHaveValue('+55 (51) 23456-7');

      // 2. Re-select "United States" from the country dropdown again,
      // without clearing the digits first.
      await selectPhoneCountry(page, phoneInput, 'United States');

      // Live-verified, notable finding that DIFFERS from the documented
      // plan expectation (specs/profile-settings-test-plan.md section 4.3,
      // which claims the previously-entered digits carry over reformatted
      // into a US-shaped "+1 (555) 123-4567"): re-confirmed repeatedly and
      // consistently against the real pre-staging backend (via a direct
      // DOM option click, a real Playwright option click, and a keyboard
      // type-ahead + Enter selection - all three gave the same result),
      // switching the country back to United States here instead discards
      // the digits and resets the field to the bare "+1" dial code, exactly
      // like the ordinary country-switch behavior already covered in the
      // previous test - it does NOT preserve them.
      await expect(countryCodeField).toHaveValue('us');
      await expect(phoneInput).toHaveValue('+1 ');

      // (Cleanup) Nothing was ever saved here - Save is enabled purely
      // from the dirtied field, so reloading discards this harmless no-op
      // state without needing a real Save.
      await page.goto(`${BASE_URL}/profile`);
      await expect(phoneInput).toHaveValue(SEED_PHONE_FORMATTED);
      await expect(saveButton).toBeDisabled();
    });

    test('should reject an invalid US area code on Save with "Invalid phone number"', async ({ page }) => {
      const phoneInput = page.getByRole('textbox', { name: 'Phone Number' });
      const saveButton = page.getByRole('button', { name: 'Save' });

      // Recreate an invalid "+1 (555) 123-4567" number independently of
      // the previous test (every test in this suite is self-contained,
      // since beforeEach resets to the baseline before EVERY test, not
      // just the first). Live-verified: typing the same invalid-area-code
      // digit sequence used in the previous test via realistic, sequential
      // key-by-key typing (setPhoneNumber() below drives the field via
      // pressSequentially, not fill()) reaches the same final invalid
      // number, "+1 (555) 123-4567", but via a different, simpler path -
      // typed this way, the widget never reinterprets the leading "55" as
      // Brazil's dial code and stays on United States throughout, so this
      // needs no detour through Brazil at all, formatting straight into a
      // US-shaped number with an invalid area code.
      await setPhoneNumber(page, phoneInput, 'United States', '5551234567');
      await expect(phoneInput).toHaveValue('+1 (555) 123-4567');

      // 1. Click "Save".
      await saveButton.click();

      // A red inline message with the exact text "Invalid phone number"
      // appears beneath the Phone Number field, the field is marked
      // invalid (aria-invalid="true"), the "Save" button reverts to
      // disabled after the failed attempt, and the browser stays on
      // /profile (no navigation).
      await expect(page.locator('text=Invalid phone number')).toBeVisible();
      await expect(phoneInput).toHaveAttribute('aria-invalid', 'true');
      await expect(saveButton).toBeDisabled();
      await expect(page).toHaveURL(`${BASE_URL}/profile`);

      // 2. (Cleanup) Reset the field back to a clean state and retype the
      // original valid digits "2125550100" using realistic sequential
      // typing, then click Save.
      await setPhoneNumber(page, phoneInput, 'United States', SEED_PHONE_DIGITS);
      await expect(phoneInput).toHaveValue(SEED_PHONE_FORMATTED);
      await saveButton.click();

      // The field reads "+1 (212) 555-0100" again, matching the original
      // value exactly, and Save succeeds with the success toast. Reload to
      // confirm the restore genuinely persisted server-side.
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

      // Live-verified, notable finding: NO "The field is required" message
      // appears anywhere on the page, and the field's border/label do NOT
      // turn red or show any invalid styling - a genuine difference from
      // First Name and Last Name, which both show that message immediately
      // on blur when empty.
      await expect(page.locator('text=The field is required')).toHaveCount(0);

      // The "Save" button stays disabled while the field is completely
      // empty (an empty phone number does not, by itself, dirty/enable
      // Save the way typing a single digit does).
      await expect(saveButton).toBeDisabled();

      // 2. Type a single digit ("1") into the empty field.
      await phoneInput.click();
      await phoneInput.pressSequentially('1');

      // The field reformats to show just "+1" (the bare dial code, with no
      // actual subscriber digits), and the "Save" button becomes enabled -
      // confirming any non-empty content, even a bare dial-code prefix
      // with no real digits, is enough to dirty/enable Save.
      await expect(phoneInput).toHaveValue('+1 ');
      await expect(saveButton).toBeEnabled();

      // 3. Click "Save" with the field still showing only "+1".
      await saveButton.click();

      // Submitting shows the same "Invalid phone number" message
      // documented in the previous test (not a "required" message) -
      // confirming this field's only validation of any kind happens at
      // Save-submit time, never on blur, regardless of whether the field
      // is fully empty or just missing real digits.
      await expect(page.locator('text=Invalid phone number')).toBeVisible();
      await expect(page.locator('text=The field is required')).toHaveCount(0);
      await expect(saveButton).toBeDisabled();

      // 4. (Cleanup) Restore the field to the original valid number
      // "+1 (212) 555-0100" and click Save.
      await setPhoneNumber(page, phoneInput, 'United States', SEED_PHONE_DIGITS);
      await expect(phoneInput).toHaveValue(SEED_PHONE_FORMATTED);
      await saveButton.click();
      await expect(page.locator('text=Your profile was updated successfully!')).toBeVisible();
      // Reload to confirm the restore genuinely persisted server-side.
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
    // Live-verified via DOM inspection: each checklist item's paragraph
    // (and its preceding icon) is rendered in grey when its rule is not yet
    // satisfied, and switches to this exact green when it is - this color
    // is the real, live DOM signal used throughout this describe block
    // instead of guessing at a class name.
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

      // Live-verified: each checklist item's icon and text turn from grey
      // to this exact green as its corresponding rule is satisfied - all 5
      // items turn green simultaneously once a password meeting every rule
      // is typed.
      for (const item of CHECKLIST_ITEMS) {
        await expect(page.getByText(item, { exact: true })).toHaveCSS('color', SATISFIED_COLOR);
      }

      // End: click "Cancel".
      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByRole('heading', { name: 'Change Password' })).not.toBeVisible();
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
      const genericErrorBanner = page.getByText('An unexpected error occurred. Please try again later.', { exact: true });

      // 1. Fill Current Password with a deliberately wrong value, New
      // Password and Confirm New Password both with a matching strong
      // value so the "Update" button becomes enabled, then click "Update".
      await changePasswordButton.click();
      await currentPasswordInput.fill('WrongCurrentPass1!');
      await newPasswordInput.fill('NewStrongPass1!');
      await confirmPasswordInput.fill('NewStrongPass1!');
      await expect(updateButton).toBeEnabled();
      await updateButton.click();

      // Live-verified against the real backend (this genuinely calls
      // Cognito with the wrong current password): a red/pink alert banner
      // shows exactly this generic text - not the specific
      // "Incorrect username or password." error Cognito actually returns
      // (visible only in the browser console), unlike the equivalent
      // failure on the Login page.
      await expect(genericErrorBanner).toBeVisible();

      // "Update" reverts to disabled, the modal stays open, and the
      // browser stays on /profile.
      await expect(updateButton).toBeDisabled();
      await expect(page.getByRole('heading', { name: 'Change Password' })).toBeVisible();
      await expect(page).toHaveURL(`${BASE_URL}/profile`);

      // 2. Click "Cancel" to close the modal without any further
      // submission attempts, then click "Change Password" again.
      await cancelButton.click();
      await changePasswordButton.click();

      // All three fields are empty again and no leftover error banner is
      // shown, confirming the modal's state is NOT preserved/cached
      // between opens.
      await expect(currentPasswordInput).toHaveValue('');
      await expect(newPasswordInput).toHaveValue('');
      await expect(confirmPasswordInput).toHaveValue('');
      await expect(genericErrorBanner).not.toBeVisible();

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

      // Live-verified via DOM inspection: Current Password's `type`
      // attribute changes from "password" to "text", while the other two
      // fields' visibility is unaffected - each password field has its own
      // separate, independently-operating toggle button.
      await expect(currentPasswordInput).toHaveAttribute('type', 'text');
      await expect(newPasswordInput).toHaveAttribute('type', 'password');
      await expect(confirmPasswordInput).toHaveAttribute('type', 'password');

      // End: click "Cancel".
      await page.getByRole('button', { name: 'Cancel' }).click();
    });

    test('should show inconsistent blur validation across the three password fields — New Password never shows required, unlike Current and Confirm', async ({ page }) => {
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

      // Live-verified, notable finding: NO "The field is required" message
      // appears beneath New Password - the count stays at 1 (Current
      // Password only), a genuine inconsistency with the field one above it
      // in the exact same form.
      await expect(requiredMessage).toHaveCount(1);

      // 3. To rule out a simple "never been focused" explanation, type a
      // single character into New Password, delete it again (back to fully
      // empty), then blur it once more by clicking into Confirm New
      // Password. (Moving focus away from Confirm New Password here also
      // blurs IT for the first time while still empty, so its own required
      // message appears too - independent of New Password's behavior.)
      await newPasswordInput.click();
      await newPasswordInput.pressSequentially('a');
      await newPasswordInput.press('Backspace');
      await confirmPasswordInput.click();

      // Still NO required-field message for New Password, even after being
      // genuinely focused, typed into, and cleared - confirming this is a
      // real, consistent absence of validation feedback for this specific
      // field's empty state, not merely an untouched-field skip. (Current
      // Password and now Confirm New Password account for the 2 messages.)
      await expect(requiredMessage).toHaveCount(2);

      // 4. With focus now in the empty "Confirm New Password" field, blur
      // it (click into "Current Password") without typing anything.
      await currentPasswordInput.click();

      // "The field is required" DOES appear for Confirm New Password,
      // matching Current Password's behavior - confirming New Password is
      // the outlier of the three, not Current Password or Confirm New
      // Password.
      await expect(requiredMessage).toHaveCount(2);

      // 5. (Cleanup) Click "Cancel" to close the modal.
      await page.getByRole('button', { name: 'Cancel' }).click();
    });

    test('should keep Update disabled when New Password satisfies only some checklist rules, with no extra error text', async ({ page }) => {
      const changePasswordButton = page.getByRole('button', { name: 'Change Password' });
      const currentPasswordInput = page.locator('input[name="currentPassword"]');
      const newPasswordInput = page.locator('input[name="newPassword"]');
      const confirmPasswordInput = page.locator('input[name="confirmNewPassword"]');
      const updateButton = page.getByRole('button', { name: 'Update' });
      const satisfiedItems = CHECKLIST_ITEMS.slice(0, 3); // 8 chars, uppercase, lowercase
      const unsatisfiedItems = CHECKLIST_ITEMS.slice(3); // digit, special character

      // 1. Open "Change Password". Type a password with at least 8
      // characters, an uppercase letter, and a lowercase letter, but
      // deliberately missing a digit and a special character (e.g.
      // "WeakPassword") into New Password.
      await changePasswordButton.click();
      await newPasswordInput.fill('WeakPassword');

      // Exactly 3 of the 5 checklist items turn green (satisfied); the
      // remaining 2 stay grey (not satisfied), showing precisely which
      // rules are and are not satisfied.
      for (const item of satisfiedItems) {
        await expect(page.getByText(item, { exact: true })).toHaveCSS('color', SATISFIED_COLOR);
      }
      for (const item of unsatisfiedItems) {
        await expect(page.getByText(item, { exact: true })).toHaveCSS('color', UNSATISFIED_COLOR);
      }

      // 2. Fill Confirm New Password with the identical weak value (so it
      // matches exactly, ruling out a "passwords don't match" explanation)
      // and also fill Current Password with any value.
      await confirmPasswordInput.fill('WeakPassword');
      await currentPasswordInput.fill('SomeCurrentPasswordValue');

      // "Update" remains DISABLED - the password-strength checklist is a
      // real, enforced client-side gate on submission. No additional
      // inline error message (beyond the checklist's own coloring) appears
      // anywhere to explain why Update is disabled.
      await expect(updateButton).toBeDisabled();
      await expect(page.locator('text=Passwords do not match')).not.toBeVisible();
      await expect(page.locator('text=The field is required')).toHaveCount(0);

      // 3. (Cleanup) Click "Cancel" to close the modal.
      await page.getByRole('button', { name: 'Cancel' }).click();
    });

    test('should only close via the Cancel button — neither Escape nor clicking the backdrop works', async ({ page }) => {
      const changePasswordButton = page.getByRole('button', { name: 'Change Password' });
      const modalHeading = page.getByRole('heading', { name: 'Change Password' });

      // 1. Open "Change Password", then press the Escape key.
      await changePasswordButton.click();
      await page.keyboard.press('Escape');

      // Live-verified, notable finding: the modal remains fully open -
      // Escape does NOT close it, unlike the typical default behavior of
      // most MUI/standard modal dialogs.
      await expect(modalHeading).toBeVisible();

      // 2. With the modal still open, click directly on the modal's
      // backdrop (the dimmed overlay area outside the dialog box) at a
      // point not covered by the centered dialog itself.
      await page.locator('.MuiBackdrop-root').click({ position: { x: 5, y: 5 } });

      // Live-verified: the modal remains fully open - clicking the
      // backdrop does NOT close it either. Combined with the Escape
      // finding above, this modal only closes via its explicit "Cancel"
      // button.
      await expect(modalHeading).toBeVisible();

      // 3. Click the explicit "Cancel" button.
      await page.getByRole('button', { name: 'Cancel' }).click();

      // The modal closes cleanly, confirming Cancel remains the one
      // reliable way to dismiss this dialog.
      await expect(modalHeading).not.toBeVisible();
    });

    test('should not block submission client-side when New Password equals Current Password, but must never actually be submitted', async ({ page }) => {
      const changePasswordButton = page.getByRole('button', { name: 'Change Password' });
      const currentPasswordInput = page.locator('input[name="currentPassword"]');
      const newPasswordInput = page.locator('input[name="newPassword"]');
      const confirmPasswordInput = page.locator('input[name="confirmNewPassword"]');
      const updateButton = page.getByRole('button', { name: 'Update' });

      // 1. Open "Change Password". Fill Current Password, New Password,
      // AND Confirm New Password all with the seed account's real, actual
      // current password - i.e. attempting to "change" the password to the
      // exact same value it already is.
      await changePasswordButton.click();
      await currentPasswordInput.fill(SEED_PASSWORD);
      await newPasswordInput.fill(SEED_PASSWORD);
      await confirmPasswordInput.fill(SEED_PASSWORD);

      // Live-verified: the "Update" button becomes ENABLED - there is no
      // client-side check preventing a user from submitting an identical
      // new password.
      await expect(updateButton).toBeEnabled();

      // 2. Deliberately do NOT click "Update" - per the absolute rule
      // against ever really invoking the password-change endpoint against
      // the shared seed account, click "Cancel" instead.
      await page.getByRole('button', { name: 'Cancel' }).click();
    });

    test('should send only a single failed request on a rapid double-click of Update', async ({ page }) => {
      const changePasswordButton = page.getByRole('button', { name: 'Change Password' });
      const currentPasswordInput = page.locator('input[name="currentPassword"]');
      const newPasswordInput = page.locator('input[name="newPassword"]');
      const confirmPasswordInput = page.locator('input[name="confirmNewPassword"]');
      const updateButton = page.getByRole('button', { name: 'Update' });
      const genericErrorBanner = page.getByText('An unexpected error occurred. Please try again later.', { exact: true });

      // 1. Open "Change Password" and fill it with a deliberately wrong
      // Current Password (safe/guaranteed-to-fail combination) plus a
      // valid, matching strong New Password and Confirm New Password.
      await changePasswordButton.click();
      await currentPasswordInput.fill('WrongCurrentPass1!');
      await newPasswordInput.fill('NewStrongPass1!');
      await confirmPasswordInput.fill('NewStrongPass1!');

      // Track every request to the real Cognito ChangePassword endpoint
      // (live-verified: a POST to cognito-idp.us-east-1.amazonaws.com with
      // the x-amz-target header "AWSCognitoIdentityProviderService.ChangePassword").
      const changePasswordRequests: string[] = [];
      page.on('request', (request) => {
        if (request.method() === 'POST' && request.headers()['x-amz-target'] === 'AWSCognitoIdentityProviderService.ChangePassword') {
          changePasswordRequests.push(request.url());
        }
      });

      // then double-click "Update" rapidly (two clicks in immediate
      // succession).
      await updateButton.dblclick();
      await expect(genericErrorBanner).toBeVisible();

      // Live-verified via the browser's network log: only ONE Cognito
      // ChangePassword request was actually sent as a result of the
      // double-click, and only one generic error banner appeared -
      // confirming this button also guards against duplicate submissions,
      // consistent with the same protection already documented for the
      // outer page's "Save" button.
      expect(changePasswordRequests).toHaveLength(1);
      await expect(genericErrorBanner).toHaveCount(1);

      // 2. (Cleanup) Click "Cancel" to close the modal; the seed account's
      // real password remains unchanged.
      await page.getByRole('button', { name: 'Cancel' }).click();
    });
  });

  test.describe('Account Deletion (cross-reference)', () => {
    test('should show the delete confirmation dialog and safely cancel via "No, go back"', async ({ page }) => {
      const firstNameInput = page.locator('input[name="firstName"]');

      // 1. Click "Delete Account" to open its confirmation dialog.
      await page.getByRole('button', { name: 'Delete Account' }).click();

      // The dialog shows heading "Delete Account", the exact body text -
      // including the known, already-documented copy typo "want o delete"
      // (missing the "t" in "to"), reproduced here exactly rather than
      // "fixed" - plus the account-recovery warning text, and both
      // "No, go back" / "Yes, delete" buttons. This matches exactly what
      // tests/forgot-password.spec.ts's 'Account deletion (Profile
      // settings)' test already documents and automates for real (clicking
      // "Yes, delete") against a disposable account; this test never does
      // that, since it runs against the shared seed account.
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

      // 2. Click "No, go back" - never "Yes, delete" - so the shared seed
      // account is never actually deleted.
      await dialog.getByRole('button', { name: 'No, go back' }).click();

      // The dialog closes, the browser stays on /profile, and the seed
      // account's data is completely unchanged (First Name still reads
      // "QA") - proving this is a safe, reversible no-op, distinct from
      // the real deletion flow already tested end-to-end elsewhere.
      await expect(dialog).not.toBeVisible();
      await expect(page).toHaveURL(`${BASE_URL}/profile`);
      await expect(firstNameInput).toHaveValue(SEED_FIRST_NAME);
    });
  });
});

// Uses a fresh, disposable, run-unique account (never the shared seed
// account) so it's safe to actually complete a real password change against
// the live backend, exactly like forgot-password.spec.ts's own full
// end-to-end reset and account-deletion describes.
test.describe('Full end-to-end password change (real email, real code)', () => {
  test.describe.configure({ retries: 1 });

  test('should complete a real password change via the Change Password modal and allow login with the new password @real-email', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Backend-only flow; runs once to avoid tripling load on the real email pipeline.');
    test.setTimeout(300_000);

    // 1. Register a new, run-unique disposable account and verify its
    // email over IMAP, confirming the redirect to /login.
    const emailAlias = generateUniqueEmailAlias();
    const username = generateUsernameFromEmail(emailAlias);
    const originalPassword = requireEnv('TEST_REGISTER_PASSWORD');
    const registeredAt = new Date();
    await registerNewAccount(page, emailAlias);
    const verificationLink = await getVerificationLink(emailAlias, registeredAt);
    await page.goto(verificationLink);
    await expect(page).toHaveURL(`${BASE_URL}/login`);

    // 2. Log in with that account's username and its original
    // TEST_REGISTER_PASSWORD password.
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

    // 6. Live-verified against the real backend: a green success toast
    // appears with the exact text "Password updated successfully! Please
    // log in with your new password.", then - true to the modal's own
    // warning banner ("...will automatically log you out of all active
    // sessions...") - the browser is automatically redirected to /login
    // within a few seconds, with no further action needed.
    await expect(page.locator('text=Password updated successfully! Please log in with your new password.')).toBeVisible();
    await expect(page).toHaveURL(`${BASE_URL}/login`, { timeout: 15_000 });

    // 7. Logging in again with the SAME username and the NEW password
    // proves the change was genuinely persisted server-side, not just a
    // UI-only confirmation - mirroring the equivalent verification step in
    // forgot-password.spec.ts's real reset-password and account-deletion
    // tests.
    await page.locator('input[name="username"]').fill(username);
    await page.locator('input[name="password"]').fill(newPassword);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/.*\/(company|teams\/list)$/, { timeout: 15_000 });

    // 8. Extra strength check beyond the base plan (same pattern as
    // forgot-password.spec.ts's account-deletion test): log out, then
    // confirm the OLD original password no longer works, proving the
    // change was real rather than merely additive.
    await page.getByRole('button', { name: 'account of current user' }).click();
    await page.getByRole('menuitem', { name: 'Log Out' }).click();
    await expect(page).toHaveURL(`${BASE_URL}/login`);
    await page.locator('input[name="username"]').fill(username);
    await page.locator('input[name="password"]').fill(originalPassword);
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('text=Incorrect username or password.')).toBeVisible();
  });
});
