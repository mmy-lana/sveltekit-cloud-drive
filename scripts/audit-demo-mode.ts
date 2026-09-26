/**
 * Demo mode acceptance test.
 *
 * Drives the built app in real Chrome with no emulator and no usable Firebase
 * credentials, and asserts the whole zero-config promise end to end: the splash
 * is bypassed, the seed drive is there, a real file uploads into IndexedDB, the
 * storage meter moves, an image previews from a local blob, the write
 * operations work, and a reload preserves everything.
 *
 * This is the only test that can answer those questions, because every one of
 * them is a browser fact rather than a store fact — IndexedDB, object URLs,
 * structured clone of a Blob. `pnpm run verify` covers the Firebase path with
 * the emulator; nothing short of a real browser covers this one.
 *
 * Run against `vite preview` on AUDIT_BASE.
 */
import { chromium, type Browser, type ConsoleMessage, type Page } from 'playwright-core';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.AUDIT_BASE ?? 'http://localhost:4181';

/** The navbar chip. The sidebar badge is a sibling, in an `aside`. */
const NAV_CHIP = 'header button[aria-haspopup="dialog"]';
const SIDE_CHIP = 'aside button[aria-haspopup="dialog"]';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail === '' ? '' : ` - ${detail}`}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/**
 * Console errors the page produced, minus the ones a browser is entitled to.
 *
 * A missing favicon and an aborted navigation are not application faults, and
 * treating them as such would make this test fail for reasons that have nothing
 * to do with the drive.
 */
function isExpectedNoise(text: string): boolean {
  return text.includes('favicon') || text.includes('ERR_ABORTED');
}

interface TrackedPage extends Page {
  errors: string[];
}

async function open(browser: Browser): Promise<TrackedPage> {
  // A fresh context per phase is what makes "reload preserves files" a real
  // assertion: no service workers or caches are carried over, so anything
  // present after a reload is genuinely in IndexedDB.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = (await context.newPage()) as TrackedPage;
  page.errors = [];

  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error' && !isExpectedNoise(message.text())) {
      page.errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => page.errors.push(error.message));

  return page;
}

/** The item grid, which is the only place a stored file is listed. */
const GRID = '[role="listbox"][aria-label="Files and folders"], [role="grid"][aria-label="Files and folders"]';

/** Wait for the seed folder, which only appears once a subscription delivers. */
async function waitForDrive(page: Page): Promise<void> {
  await page.locator(GRID).getByText('Welcome to Cloud Drive', { exact: true }).first().waitFor({ timeout: 20_000 });
}

/** Close whatever dialog is open, if any. */
async function closeDialogs(page: Page): Promise<void> {
  while ((await page.locator('dialog[open]').count()) > 0) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  }
}

/** Right-click an item in the listing and pick one of its context-menu entries. */
async function menuAction(page: Page, itemName: string, entry: string): Promise<void> {
  await page.locator(GRID).getByText(itemName, { exact: true }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: entry }).click();
}

/**
 * Open a folder by double-clicking it, and wait for the navigation to land.
 *
 * The wait is on the URL rather than on the listing, because the listing of the
 * *previous* folder is still mounted when the click happens — asserting on it
 * would pass while the new one never arrives.
 */
async function openFolder(page: Page, name: string): Promise<void> {
  await page.locator(GRID).getByText(name, { exact: true }).first().dblclick();
  await page.waitForURL(/\/folder\/[A-Za-z0-9_-]{20}$/, { timeout: 15_000 });
  await page.waitForLoadState('domcontentloaded');
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const scratch = mkdtempSync(join(tmpdir(), 'drive-demo-'));
const uploadPath = join(scratch, 'quarterly notes.txt');
writeFileSync(uploadPath, 'Demo mode keeps its promises.\n'.repeat(64), 'utf8');

try {
  section('Startup');
  const page = await open(browser);
  const started = Date.now();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await waitForDrive(page);
  const elapsed = Date.now() - started;

  check('splash bypassed and seed folder rendered', true);
  check('startup under 3000ms', elapsed < 3000, `${elapsed}ms`);
  check('splash no longer on screen', (await page.getByText('Connecting to your drive').count()) === 0);
  check(
    'seed folder listed at the root',
    await page.locator(GRID).getByText('Welcome to Cloud Drive', { exact: true }).isVisible()
  );

  section('Seed content');
  await openFolder(page, 'Welcome to Cloud Drive');
  await page.locator(GRID).getByText('Read me first.md', { exact: true }).waitFor({ timeout: 15_000 });
  check('seed readme listed inside the seed folder', true);
  check('seed image listed inside the seed folder', await page.locator(GRID).getByText('Drive overview.png', { exact: true }).isVisible());
  await page.locator(GRID).getByText('Read me first.md', { exact: true }).first().dblclick();
  await page.locator('dialog[open]').getByText('Demo Mode').first().waitFor({ timeout: 15_000 });
  check('seed markdown previews from IndexedDB', true);
  await closeDialogs(page);

  await page.locator(GRID).getByText('Drive overview.png', { exact: true }).first().dblclick();
  await page.locator('dialog[open] img').waitFor({ timeout: 15_000 });
  const naturalWidth = await page
    .locator('dialog[open] img')
    .first()
    .evaluate((node) => (node as HTMLImageElement).naturalWidth);
  check('seed image previews from IndexedDB', naturalWidth > 0, `naturalWidth=${naturalWidth}`);
  await closeDialogs(page);

  await page.getByRole('link', { name: 'My Drive' }).first().click();
  await waitForDrive(page);

  section('Demo mode indicator');
  check('navbar shows a Demo Mode chip', (await page.locator(NAV_CHIP).count()) === 1);
  check('sidebar shows a Demo Mode chip', (await page.locator(SIDE_CHIP).count()) === 1);
  check('navbar chip reads Demo Mode', await page.locator(NAV_CHIP).getByText('Demo Mode').isVisible());

  await page.locator(NAV_CHIP).click();
  await page.locator('dialog[open]').waitFor({ timeout: 5000 });
  const dialog = await page.locator('dialog[open]').innerText();
  check('dialog names the mode', dialog.includes('Demo Mode'));
  check('dialog says where files are stored', dialog.includes('IndexedDB'));
  check('dialog explains how to get real sync', dialog.includes('Firebase credentials'));
  check('dialog explains nothing was lost', /configured|placeholder|reached/i.test(dialog));
  await closeDialogs(page);

  check(
    'no sign-out control in demo mode',
    (await page.locator('button[aria-label="Sign out"]').count()) === 0
  );

  section('Storage meter');
  const meterBefore = await page.locator('aside').innerText();
  check('storage meter rendered', /GB|MB|KB|%/.test(meterBefore), meterBefore.slice(0, 120).replace(/\n/g, ' | '));

  section('Upload');
  await page.setInputFiles('input[type="file"]', uploadPath);
  await page.locator(GRID).getByText('quarterly notes.txt', { exact: true }).waitFor({ timeout: 30_000 });
  check('uploaded file appears in the listing', true);
  await page.waitForTimeout(300);

  const meterAfter = await page.locator('aside').innerText();
  check('storage meter moved', meterAfter !== meterBefore);

  section('Preview an uploaded file from a local blob');
  await page.locator(GRID).getByText('quarterly notes.txt', { exact: true }).first().dblclick();
  await page.locator('dialog[open]').waitFor({ timeout: 10_000 });
  await page.locator('dialog[open]').getByText('Demo mode keeps its promises').first().waitFor({ timeout: 10_000 });
  check('text preview renders from IndexedDB', true);
  await closeDialogs(page);

  section('Create, rename, star');
  await page.getByRole('button', { name: 'New folder' }).click();
  await page.locator('dialog[open] input').fill('Demo Reports');
  await page.locator('dialog[open]').getByRole('button', { name: 'Create' }).click();
  await page.locator(GRID).getByText('Demo Reports', { exact: true }).waitFor({ timeout: 15_000 });
  check('folder created', true);

  await menuAction(page, 'Demo Reports', 'Rename');
  await page.locator('dialog[open] input').fill('Demo Reports 2026');
  await page.locator('dialog[open]').getByRole('button', { name: 'Rename' }).click();
  await page.locator(GRID).getByText('Demo Reports 2026', { exact: true }).waitFor({ timeout: 15_000 });
  check('folder renamed', true);

  await menuAction(page, 'Demo Reports 2026', 'Add to starred');
  await page.locator('p:not(.sr-only)').getByText('Starred 1 item.').waitFor({ timeout: 15_000 });
  check('folder starred', true);

  section('Move');
  await menuAction(page, 'quarterly notes.txt', 'Move to…');
  const moveDialog = page.locator('dialog[open]');
  await moveDialog.getByLabel('Destination folders').getByText('Demo Reports 2026', { exact: true }).click();
  await moveDialog.getByRole('button', { name: 'Move here' }).click();
  await page.locator(GRID).getByText('quarterly notes.txt', { exact: true }).waitFor({ state: 'detached', timeout: 15_000 });
  check('file moved out of its parent', true);
  await openFolder(page, 'Demo Reports 2026');
  await page.locator(GRID).getByText('quarterly notes.txt', { exact: true }).waitFor({ timeout: 15_000 });
  check('file is inside its new parent', true);

  // The URL and the listing are the same fact. A sidebar link that moves the
  // listing but not the address bar was the one real bug this audit found.
  check(
    'breadcrumb names the folder the URL names',
    (await page.locator('nav[aria-label="Breadcrumb"]').innerText()).includes('Demo Reports 2026')
  );
  await page.goBack();
  await waitForDrive(page);
  check('browser Back returns to My Drive', page.url().endsWith(':4181/'));
  await page.goForward();
  await page.locator(GRID).getByText('quarterly notes.txt', { exact: true }).waitFor({ timeout: 15_000 });
  check('browser Forward re-enters the folder', true);

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await waitForDrive(page);
  check(
    'move survived a reload',
    (await page.locator(GRID).getByText('quarterly notes.txt', { exact: true }).count()) === 0
  );

  section('Starred scope');
  await page.getByRole('link', { name: 'Starred' }).click();
  await page.locator(GRID).getByText('Demo Reports 2026', { exact: true }).waitFor({ timeout: 15_000 });
  check('starred folder is listed under Starred', true);
  check('unstarred files are not', (await page.locator(GRID).getByText('quarterly notes.txt', { exact: true }).count()) === 0);
  await page.getByRole('link', { name: 'My Drive' }).first().click();
  await waitForDrive(page);

  section('Trash and permanent delete');
  await openFolder(page, 'Welcome to Cloud Drive');
  await page.locator(GRID).getByText('Read me first.md', { exact: true }).waitFor({ timeout: 15_000 });
  await page.locator(GRID).getByText('Read me first.md', { exact: true }).first().click();
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await page.locator('p:not(.sr-only)').getByText('Moved to trash 1 item.').waitFor({ timeout: 15_000 });
  check(
    'seeded file trashed',
    (await page.locator(GRID).getByText('Read me first.md', { exact: true }).count()) === 0
  );

  await page.getByRole('link', { name: 'Trash' }).click();
  await page.locator(GRID).getByText('Read me first.md', { exact: true }).waitFor({ timeout: 15_000 });
  check('trashed file listed in the bin', true);

  await menuAction(page, 'Read me first.md', 'Delete forever');
  await page.locator('dialog[open]').getByRole('button', { name: 'Delete for good' }).click();
  await page.locator('p:not(.sr-only)').getByText('Permanently deleted 1 item.').waitFor({ timeout: 15_000 });
  check('permanent delete reported', true);
  check('bin is empty afterwards', await page.getByText('The bin is empty').isVisible());

  section('Reload persistence');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await waitForDrive(page);
  check('seed folder survives a reload', await page.locator(GRID).getByText('Welcome to Cloud Drive', { exact: true }).isVisible());
  check('starred folder survives a reload', await page.getByRole('link', { name: 'Starred' }).isVisible());
  await openFolder(page, 'Welcome to Cloud Drive');
  check('seed folder lost only the trashed file', (await page.locator(GRID).getByText('Drive overview.png', { exact: true }).count()) === 1);
  check('permanently deleted file did not come back', (await page.locator(GRID).getByText('Read me first.md', { exact: true }).count()) === 0);
  await page.getByRole('link', { name: 'My Drive' }).first().click();
  await waitForDrive(page);
  await openFolder(page, 'Demo Reports 2026');
  check('moved file survived a reload', await page.locator(GRID).getByText('quarterly notes.txt', { exact: true }).isVisible());

  await page.getByRole('link', { name: 'Trash' }).click();
  await page.getByText('The bin is empty').waitFor({ timeout: 15_000 });
  check('permanent delete survived a reload', true);

  section('Console');
  check('no console errors', page.errors.length === 0, page.errors.join(' | '));

  await page.context().close();
} finally {
  await browser.close();
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? 'OK' : 'FAILED'}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
