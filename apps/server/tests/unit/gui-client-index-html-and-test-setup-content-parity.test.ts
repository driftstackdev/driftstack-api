// W791 — apps/gui-client/index.html + apps/gui-client/tests/setup.ts
// content parity. One-hundred-seventeenth in the cross-SDK drift-
// guard series. Pins the two gui-client surface files that had no
// parity guard.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const INDEX_HTML = resolve(REPO_ROOT, 'apps/gui-client/index.html');
const TEST_SETUP = resolve(REPO_ROOT, 'apps/gui-client/tests/setup.ts');

describe('W791 gui-client index.html + tests/setup.ts content parity', () => {
  it('both files exist at canonical paths', () => {
    expect(existsSync(INDEX_HTML)).toBe(true);
    expect(existsSync(TEST_SETUP)).toBe(true);
  });

  // ─── index.html ───────────────────────────────────────────────

  it('CRITICAL <html data-mode/data-accent> Fleet token axes pinned (light+violet default, founder-locked 2026-06-12). dark: variants + the semantic palette key off [data-mode=dark].', () => {
    const p = read(INDEX_HTML);

    expect(p).toMatch(/<html lang="en" data-mode="dark" data-accent="oxblood">/);
  });

  it('CRITICAL color-scheme meta pinned: "light dark" — the actual scheme is set per data-mode in styles/index.css (light default).', () => {
    const p = read(INDEX_HTML);

    expect(p).toMatch(/<meta name="color-scheme" content="light dark" \/>/);
  });

  it('CRITICAL <title>Driftstack</title> pinned. No site/window-context suffix — Tauri window titlebar appends context separately via the V-NNN TitleBar component.', () => {
    const p = read(INDEX_HTML);

    expect(p).toMatch(/<title>Driftstack<\/title>/);
  });

  it('CRITICAL body classes pinned — bg-surface-base + text-ink-primary + font-sans + antialiased. The 4-class set matches the W775 SDK index dark-mode brand atom contract.', () => {
    const p = read(INDEX_HTML);

    expect(p).toMatch(/<body class="bg-surface-base text-ink-primary font-sans antialiased">/);
  });

  it('CRITICAL React root + Vite ESM main.tsx pinned. The \'div id="root"\' + \'script type="module" src="/src/main.tsx"\' pair is the canonical Vite-React-Tauri bootstrap.', () => {
    const p = read(INDEX_HTML);

    expect(p).toMatch(/<div id="root"><\/div>/);
    expect(p).toMatch(/<script type="module" src="\/src\/main\.tsx"><\/script>/);
  });

  it('CRITICAL boot/fatal UI uses listener-bound actions so the enforced desktop CSP needs no inline-handler escape hatch', () => {
    const p = read(INDEX_HTML);

    expect(p).not.toMatch(/\son[a-z]+\s*=/i);
    expect(p).toMatch(/<button id="ds-fatal-reload"/);
    expect(p).toMatch(
      /reloadButton\.addEventListener\('click', function \(\) \{\s*\n?\s*location\.reload\(\);/,
    );
  });

  it('CRITICAL no extra meta-tags (no robots, no description). The gui-client is a desktop binary not a web page; SEO meta is intentionally absent.', () => {
    const p = read(INDEX_HTML);

    // Confirm canonical minimal head — 3 meta tags (charset + viewport + color-scheme) + 1 title.
    expect(p).not.toMatch(/<meta name="description"/);
    expect(p).not.toMatch(/<meta name="robots"/);
  });

  it('CRITICAL no favicon link pinned. Tauri/macOS uses the bundled .icns; webview-page-level favicons would be ignored anyway.', () => {
    const p = read(INDEX_HTML);

    expect(p).not.toMatch(/<link[^>]*rel="icon"/);
  });

  // ─── tests/setup.ts ───────────────────────────────────────────

  it("CRITICAL V-288 setup-file framing pinned. The 'V-288 — Vitest setup file for the gui-jsdom project. Runs once per worker before any test in apps/gui-client/tests/**/*.test.tsx. Loaded via setupFiles in apps/gui-client/vitest.config.ts' wording matches V-288 jsdom-project anchor.", () => {
    const p = read(TEST_SETUP);

    expect(p).toMatch(/\/\/ V-288 — Vitest setup file for the gui-jsdom project\./);
    expect(p).toMatch(
      /\/\/ Runs once per worker before any test in `apps\/gui-client\/tests\/\*\*\/\*\.test\.tsx`\./,
    );
    expect(p).toMatch(/\/\/ Loaded via `setupFiles` in `apps\/gui-client\/vitest\.config\.ts`\./);
  });

  it('CRITICAL 2-responsibility framing pinned. (1) Extend Vitest expect with @testing-library/jest-dom matchers + (2) afterEach cleanup() unmounts rendered tree. The numbered responsibilities are the load-bearing setup contract.', () => {
    const p = read(TEST_SETUP);

    expect(p).toMatch(
      /\/\/\s+1\. Extends Vitest's `expect` with @testing-library\/jest-dom matchers\s*\n?\/\/\s+\(toBeInTheDocument \/ toHaveTextContent \/ etc\)\./,
    );
    expect(p).toMatch(
      /\/\/\s+2\. Registers an afterEach\(\) hook that calls @testing-library\/react's\s*\n?\/\/\s+cleanup\(\) — unmounts any rendered tree so the next test starts\s*\n?\/\/\s+with a clean DOM\./,
    );
  });

  it("CRITICAL safe-to-run-when-nothing-rendered framing pinned. The 'Safe to run even when no component was rendered.' wording explains why the afterEach is unconditional.", () => {
    const p = read(TEST_SETUP);

    expect(p).toMatch(/Safe to run even when no component was rendered\./);
  });

  it("CRITICAL 3-import set pinned — afterEach from 'vitest' + cleanup from '@testing-library/react' + side-effect '@testing-library/jest-dom/vitest'. Drift to dropping the side-effect-only import would break jest-dom matcher registration.", () => {
    const p = read(TEST_SETUP);

    // `vi` joined the vitest import when the afterEach began restoring real
    // timers — the named import set is what matters, not its exact spelling.
    expect(p).toMatch(/import \{ afterEach, vi \} from 'vitest';/);
    expect(p).toMatch(/import \{ cleanup \} from '@testing-library\/react';/);
    expect(p).toMatch(/import '@testing-library\/jest-dom\/vitest';/);
  });

  it('CRITICAL afterEach(cleanup) shape pinned. Drift to a bare `afterEach(cleanup)` (which works) is fine, but the named-arrow form `afterEach(() => { cleanup(); })` is what we ship — pinning the shape so it stays consistent with other setup files.', () => {
    const p = read(TEST_SETUP);

    // The hook now does two things, and the ORDER is the load-bearing part:
    // cleanup() unmounts under whatever timer mode the test chose, then real
    // timers are restored so a spec that installed fake ones cannot leak them
    // into whatever runs next. Reversing these would unmount under real timers
    // in a fake-timer test; dropping the restore reopens the shuffle
    // order-dependence in simulator-window-frozen.
    expect(p).toMatch(
      /afterEach\(\(\) => \{[\s\S]*?cleanup\(\);[\s\S]*?vi\.useRealTimers\(\);[\s\S]*?\}\);/,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/gui-client-index-html-and-test-setup-content-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
