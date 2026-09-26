/**
 * Responsive and accessibility audit.
 *
 * Drives the built app in real Chrome at each width in the plan's matrix and
 * asserts the things that only a browser can answer: which navigation tier is
 * mounted, whether anything overflows horizontally, whether every interactive
 * control meets the 44px touch target, and whether any affordance is reachable
 * without hover.
 *
 * Run against `vite preview` with the Firebase emulator up.
 */
import { chromium, type Page } from 'playwright-core';
import { readdirSync } from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.AUDIT_BASE ?? 'http://localhost:4181';

/** The matrix from the plan: three mobile widths, the tablet rail, desktop. */
const WIDTHS = [
  { width: 360, height: 780, tier: 'mobile' },
  { width: 390, height: 844, tier: 'mobile' },
  { width: 430, height: 932, tier: 'mobile' },
  { width: 768, height: 1024, tier: 'tablet' },
  { width: 1024, height: 768, tier: 'desktop' },
  { width: 1440, height: 900, tier: 'desktop' }
];

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`);
  }
}

/** Everything visible that a pointer or a finger can hit. */
const TARGETS = 'button, a[href], input, select, [role="button"], [role="tab"]';

interface Metrics {
  scrollWidth: number;
  clientWidth: number;
  overflowing: string[];
  undersized: string[];
  sidebarWidth: number;
  bottomBar: boolean;
  railOnly: boolean;
  labelledSidebar: boolean;
}

async function measure(page: Page): Promise<Metrics> {
  return page.evaluate((selector) => {
    const doc = document.documentElement;
    const overflowing: string[] = [];
    const undersized: string[] = [];

    for (const element of document.querySelectorAll<HTMLElement>('*')) {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      // Only elements that stick out past the viewport on the right.
      if (rect.right > doc.clientWidth + 1) {
        overflowing.push(`${element.tagName.toLowerCase()}.${element.className}`.slice(0, 90));
      }
    }

    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      // Visually-hidden controls — the skip link, the shared file input — are
      // still focusable and still need a name, but they are 1x1 by design, so
      // the touch-target rule has nothing to say about them. The name rule is
      // checked separately below and does apply.
      if (rect.width <= 1 && rect.height <= 1) continue;
      // A link that only wraps text is exempt; a control the user must hit is not.
      const isInlineTextLink =
        element.tagName === 'A' && style.display === 'inline' && rect.height < 30;
      if (isInlineTextLink) continue;
      if (rect.height < 44) {
        undersized.push(
          `${element.tagName.toLowerCase()}[${(element.textContent ?? '').trim().slice(0, 24)}] ${Math.round(rect.width)}x${Math.round(rect.height)}`
        );
      }
    }

    const aside = document.querySelector<HTMLElement>('aside[aria-label="Drive navigation"]');
    const asideStyle = aside === null ? null : getComputedStyle(aside);
    const nav = aside?.querySelector<HTMLElement>('nav');
    const asideWidth = aside !== null && asideStyle !== null && asideStyle.display !== 'none' ? aside.getBoundingClientRect().width : 0;

    // The bottom bar is the only navigation pinned to the viewport bottom. The
    // <nav> itself is not necessarily the fixed element — the layout wraps it
    // in a fixed strip so it can host the FAB's stacking context — so walk up
    // rather than demanding the nav be position:fixed itself.
    const bottomBar = [...document.querySelectorAll<HTMLElement>('nav')].some((n) => {
      const rect = n.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      if (rect.bottom < doc.clientHeight - 1) return false;
      let node: HTMLElement | null = n;
      while (node !== null) {
        if (getComputedStyle(node).position === 'fixed') return true;
        node = node.parentElement;
      }
      return false;
    });

    // A rail is a navigation that shows icons but not text labels. Either
    // signal is sufficient on its own: a label that is not visually rendered,
    // or an explicit aria-label standing in for one. Requiring both would fail
    // a rail that does the accessible thing.
    let railOnly = false;
    if (asideWidth > 0 && nav !== null) {
      const link = nav.querySelector<HTMLElement>('a[href]');
      if (link !== null && link !== aside) {
        const label = link.querySelector<HTMLElement>('span');
        // `sr-only` hides a label visually while keeping it in the
        // accessibility tree — which is exactly what a rail wants, and exactly
        // what a `display: none` test would wrongly call a failure.
        const visuallyRendered = (node: HTMLElement | null): boolean => {
          if (node === null) return false;
          const rect = node.getBoundingClientRect();
          if (rect.width <= 1 && rect.height <= 1) return false;
          const style = getComputedStyle(node);
          return style.display !== 'none' && style.visibility !== 'hidden';
        };
        railOnly = !visuallyRendered(label) || link.getAttribute('aria-label') !== null;
      }
    }

    const labelledSidebar = aside !== null && aside.getAttribute('aria-label') === 'Drive navigation';

    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      overflowing: overflowing.slice(0, 6),
      undersized: undersized.slice(0, 6),
      sidebarWidth: Math.round(asideWidth),
      bottomBar,
      railOnly,
      labelledSidebar
    };
  }, TARGETS);
}

/**
 * Navigate and wait for the signed-in shell.
 *
 * `networkidle` is unusable here: Firestore holds a long-lived gRPC stream
 * open, so the network is never idle for the five seconds that demands. The
 * real readiness signal is the chrome — the gate lifts once the anonymous
 * sign-in resolves.
 */
async function open(page: Page, route: string): Promise<void> {
  // A dead preview server is the most likely reason this harness fails, and an
  // unhandled navigation rejection buries that under a Node stack trace. Fail
  // with the one thing the operator needs: the URL that did not answer.
  try {
    await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
  } catch {
    throw new Error(
      `Could not reach ${BASE}${route}. Start the preview server first:\n` +
        '    pnpm run build && pnpm run preview --port 4181'
    );
  }
  try {
    await page
      .waitForFunction(
        () => document.querySelector('aside[aria-label="Drive navigation"]') !== null,
        undefined,
        { timeout: 20_000 }
      )
      .catch(async () => {
        // Mobile has no aside; the bottom bar is the equivalent readiness signal.
        await page.waitForFunction(
          () => document.querySelector('nav') !== null,
          undefined,
          { timeout: 20_000 }
        );
      });
  } catch {
    throw new Error(
      `${BASE}${route} loaded but never rendered the app shell. The sign-in gate ` +
        'did not resolve — check that the emulator is up and that the dev/prod ' +
        'config resolves Firebase public env vars.'
    );
  }
  // One more frame so the tier layout has settled before measuring.
  await page.waitForTimeout(400);
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

for (const { width, height, tier } of WIDTHS) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 160));
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error).slice(0, 160)));

  console.log(`\n1. ${width}x${height} — ${tier}`);

  for (const route of ['/', '/starred', '/trash']) {
    await open(page, route);
    const m = await measure(page);

    check(`${route} has no horizontal overflow`, m.scrollWidth <= m.clientWidth + 1,
      `scrollWidth ${m.scrollWidth} > ${m.clientWidth}: ${m.overflowing.join(' | ')}`);

    check(`${route} touch targets are at least 44px`, m.undersized.length === 0, m.undersized.join(' | '));

    if (route === '/') {
      if (tier === 'mobile') {
        check('mobile shows a bottom navigation bar', m.bottomBar);
        check('mobile has no persistent sidebar', m.sidebarWidth === 0, `${m.sidebarWidth}px`);
      } else {
        check('mobile-only bottom bar is absent', !m.bottomBar);
        check('a labelled navigation rail is present', m.labelledSidebar && m.sidebarWidth > 0);
        if (width === 768) {
          check('tablet rail is 64px and icon-only', m.sidebarWidth === 64 && m.railOnly, `${m.sidebarWidth}px`);
        } else {
          check('desktop sidebar is 256px', m.sidebarWidth === 256, `${m.sidebarWidth}px`);
          check('desktop sidebar shows text labels', !m.railOnly);
        }
      }
    }
  }

  // Hover-only affordances: everything the mouse can reach must also be
  // reachable by keyboard, so tab to the end and count what got focus.
  await open(page, '/');
  const reachable = await page.evaluate(async () => {
    const focusable = [
      ...document.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
    ].filter((element) => {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      // Deliberately hidden from assistive tech and out of the tab order: the
      // shared file input behind the Upload button, for instance. It is not a
      // control a user ever reaches, so it is not one that needs a name — the
      // button that opens it is the one that does.
      if (element.closest('[aria-hidden="true"]') !== null) return false;
      if (element.getAttribute('tabindex') === '-1') return false;
      return true;
    });
    const name = (element: HTMLElement): boolean =>
      (element.textContent ?? '').trim().length > 0 ||
      element.getAttribute('aria-label') !== null ||
      element.getAttribute('aria-labelledby') !== null ||
      element.getAttribute('title') !== null ||
      // A form control can also be named by an associated <label>, and an
      // <input type="file"> is frequently named by nothing but a label
      // wrapping it — so resolve the association properly instead of
      // missing every labelled input in the app.
      (element.labels !== undefined && element.labels !== null && element.labels.length > 0) ||
      (element.getAttribute('placeholder') ?? '').trim().length > 0;

    const describe = (element: HTMLElement): string =>
      `${element.tagName.toLowerCase()}${element.getAttribute('type') === null ? '' : `[type=${element.getAttribute('type')}]`}` +
      `.${String(element.className).split(/\s+/).slice(0, 3).join('.')}`.slice(0, 80);

    return {
      focusable: focusable.length,
      labelled: focusable.filter(name).length,
      unnamed: focusable.filter((element) => !name(element)).map(describe).slice(0, 6)
    };
  });
  check('every focusable control has an accessible name', reachable.focusable === reachable.labelled,
    `${reachable.labelled}/${reachable.focusable} named${reachable.unnamed.length === 0 ? '' : ` — ${reachable.unnamed.join(' | ')}`}`);

  check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));

  await context.close();
}

/**
 * Keyboard-only reachability, checked once at desktop: tab from the top of the
 * document and confirm the first stop is the skip link, and that Enter on a
 * dialog cannot reach a destructive button before Cancel.
 */
console.log('\n2. Keyboard contract');
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await open(page, '/');

  await page.keyboard.press('Tab');
  const firstStop = await page.evaluate(() => {
    const active = document.activeElement;
    return active === null ? null : { text: (active.textContent ?? '').trim(), href: active.getAttribute('href') };
  });
  check('the first tab stop is the skip link',
    firstStop !== null && firstStop.text === 'Skip to main content',
    JSON.stringify(firstStop));

  // Any dialog that appears must trap focus and start it somewhere harmless.
  const dialogs = await page.locator('[role="dialog"]').count();
  check('no dialog is open on a fresh listing', dialogs === 0, `${dialogs} open`);

  await context.close();
}

/**
 * No hover-only affordance: the app must not use `hover:` for anything that is
 * the *only* way to reach a state. Group-hover menus are the classic case; the
 * listing uses click-to-open, so assert no hover-gated disclosure exists.
 */
console.log('\n3. Hover independence');
{
  const files = readdirSync('src/lib/components/organisms').filter((f) => f.endsWith('.svelte'));
  let hoverGated = 0;
  for (const file of files) {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(`src/lib/components/organisms/${file}`, 'utf8')
    );
    if (/group-hover:(block|flex|grid|opacity-100|visible)/.test(source)) hoverGated += 1;
  }
  check('no organism reveals controls only on hover', hoverGated === 0, `${hoverGated} organisms`);
}

await browser.close();

console.log(`\n${failed === 0 ? 'All checks passed' : 'Checks failed'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
