// The rendered product-status guard actually distinguishes an unshipped-feature
// promise from ordinary prose.
//
// The guard scans the BUILT html of all six customer-facing apps for
// aspirational copy ("coming soon", "not yet available", "on our roadmap") and
// for internal markers (`V-123`, `W456`, "until … lands", "Agent 1"). Shipping
// either is a customer-facing truthfulness problem.
//
// It carried its own inline `node:assert` checks — good instinct, wrong place:
// they only ran when the script ran, and NOTHING ran the script. It was defined
// in package.json and invoked by no CI job, no hook, and no other script. It was
// also FAILING, on a false positive in AUP billing copy ("invoices … are voided
// rather than deferred"), which is very likely why it was never wired up.
//
// The checks live here now so the suite runs them on every gate without needing
// a build, while CI runs the full scan against real `dist/` output after the
// build step.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import {
  ALLOWED_PHRASES,
  APPS,
  customerVisibleText,
  hasForbidden,
  hasInternalMarker,
  renderedText,
} from '../check-rendered-product-status.mjs';

const SCRIPT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'check-rendered-product-status.mjs',
);

describe('rendered product-status guard', () => {
  it('CRITICAL flags an unshipped-feature promise in customer-visible copy', () => {
    expect(hasForbidden(renderedText('<main>Feature coming soon</main>'))).toBe(true);
    expect(hasForbidden(renderedText('<main>This is not yet available</main>'))).toBe(true);
    expect(hasForbidden(renderedText('<main>It is on our roadmap</main>'))).toBe(true);
  });

  it('ignores the same words inside script and code blocks, which customers do not read as copy', () => {
    expect(hasForbidden(renderedText('<script>"coming soon"</script><main>Live</main>'))).toBe(
      false,
    );
    expect(hasForbidden(renderedText('<pre>deferred</pre><main>Live</main>'))).toBe(false);
  });

  it('CRITICAL allows the reviewed phrases — a forbidden WORD in a non-product sense', () => {
    // Request-timing semantics, not a promise about an unshipped feature.
    expect(
      hasForbidden(renderedText('<main>Authentication is deferred to the first request</main>')),
    ).toBe(false);
    // AUP billing copy. This exact sentence is what had the guard failing, so
    // it is the reason the guard could not be wired to anything.
    expect(
      hasForbidden(
        renderedText(
          '<main>invoices for the suspended period are voided rather than deferred</main>',
        ),
      ),
    ).toBe(false);
  });

  it('CRITICAL still flags "deferred" when it IS a product-status claim', () => {
    // The allowlist must exempt phrases, never the word — otherwise adding an
    // entry would blind the guard to the thing it exists to catch.
    expect(hasForbidden(renderedText('<main>That integration is deferred</main>'))).toBe(true);
  });

  it('flags internal markers that reach customer-visible text, and ignores them elsewhere', () => {
    expect(hasInternalMarker(customerVisibleText('<pre>V-666.BY</pre>'))).toBe(true);
    expect(hasInternalMarker(customerVisibleText("<main>until Agent 1's work lands</main>"))).toBe(
      true,
    );
    expect(
      hasInternalMarker(
        customerVisibleText('<!-- V-666 --><script>"W393"</script><main>Live</main>'),
      ),
    ).toBe(false);
    expect(
      hasInternalMarker(customerVisibleText('<!-- until Agent 2 work lands --><main>Live</main>')),
    ).toBe(false);
  });

  it('does not confuse the two scanners — an internal marker is not forbidden copy', () => {
    expect(hasForbidden(customerVisibleText('<main>Live</main><pre>V-666.BY</pre>'))).toBe(false);
  });

  it('CRITICAL pins the scanned apps, including the one deliberately left out', () => {
    // The set was unpinned, so an app could join or leave without anyone
    // deciding. Both directions matter: a dropped app stops being scanned
    // silently, and an added one can create false coverage.
    expect(
      [...APPS].sort(),
      'the scanned-app set changed — adding or dropping one must be deliberate',
    ).toEqual([
      'admin-panel',
      'customer-dashboard',
      'docs',
      'errors-site',
      'marketing-site',
      'status-site',
    ]);

    // gui-client is the one that looks like an oversight and is not. Its dist is
    // a Tauri shell — 7860 bytes of markup carrying 72 characters of visible
    // text — and the copy a customer reads lives in the JS bundle, which this
    // guard strips before scanning. Adding it would scan nothing and report the
    // desktop client as covered.
    expect(APPS, 'gui-client was added — it would scan a shell, not its copy').not.toContain(
      'gui-client',
    );
    const source = readFileSync(SCRIPT_PATH, 'utf8');
    expect(
      source,
      'the reason gui-client is excluded is gone, so the omission reads as an oversight again',
    ).toMatch(/gui-client is deliberately ABSENT/);
  });

  it('CRITICAL pins the allowlist size, so silencing the guard is a deliberate edit', () => {
    // Anti-vacuity. Without this, the cheapest way to make a real failure go
    // away is to append the offending sentence, and that is indistinguishable
    // from fixing the copy.
    expect(ALLOWED_PHRASES, 'every entry needs a reason comment beside it').toHaveLength(2);
  });
});
