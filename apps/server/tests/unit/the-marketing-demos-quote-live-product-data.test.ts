// P-2 — the Wave 6 demos may not drift from what the product is.
//
// Its sibling `the-marketing-demo-cannot-show-a-verb-the-api-lacks` pins the
// agent-plan demo to the closed intent union. These two are the same argument for
// the other two demos: a marketing page that quotes a device version the product
// stopped shipping, or invents a proxy state the probe never returns, is a page
// that becomes false without anyone editing it.
//
// ⭐ The fingerprint demo READS the registry at build time rather than hardcoding
// a device, so the drift it is exposed to is the registry changing — which is the
// drift worth guarding. These arms pin that it still reads it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ARCHETYPE_REGISTRY, LOCKED_ARCHETYPE_ID } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf-8');

const FINGERPRINT = 'apps/marketing-site/src/components/FingerprintDemo.astro';
const PROXY = 'apps/marketing-site/src/components/ProxyHealthDemo.astro';
const BUILT = 'apps/marketing-site/dist/how-it-works/index.html';

describe('the marketing demos quote live product data', () => {
  it('CRITICAL the fingerprint demo DERIVES its device from the registry rather than naming one. A hardcoded label is the drift this exists to prevent, and it would look identical on the page.', () => {
    const src = read(FINGERPRINT);
    expect(src).toMatch(/ARCHETYPE_REGISTRY/);
    expect(src).toMatch(/LOCKED_ARCHETYPE_ID/);
    // The device string must NOT appear literally in the component.
    const locked = ARCHETYPE_REGISTRY.find((a) => a.id === LOCKED_ARCHETYPE_ID);
    expect(locked, 'the locked archetype resolves').toBeDefined();
    expect(
      src.includes(locked?.displayLabel ?? '__none__'),
      'the demo hardcodes the device label instead of reading it',
    ).toBe(false);
  });

  it('CRITICAL the BUILT page carries the registry value — proving the derivation actually ran, which reading the source cannot show', () => {
    const locked = ARCHETYPE_REGISTRY.find((a) => a.id === LOCKED_ARCHETYPE_ID);
    expect(read(BUILT)).toContain(locked?.displayLabel ?? '__none__');
  });

  it('CRITICAL the proxy demo shows only states the probe can actually return. `AccountProxyTestResultSchema` is ok-with-latency or failed-with-reason; staleness is the third real state because probes carry a timestamp and a TTL.', () => {
    const src = read(PROXY);
    for (const state of ['ok', 'stale', 'failed']) {
      expect(src, `the ${state} state is represented`).toContain(`'${state}'`);
    }
    // A failure must carry a reason — the union has no bare failure.
    expect(src).toMatch(/reason:/);
    // And an ok must carry a latency, which is what the union's ok member holds.
    expect(src).toMatch(/latencyMs:/);
  });

  it('neither demo claims a score, a percentage, or an undetectability verdict — the registry carries a per-archetype status, not a promise about any site', () => {
    // ⛔ Checked against the RENDERED TEXT, not the source. The first version read
    // the source and failed on `100%` — which appears in a CSS keyframe and in a
    // doc comment saying not to make that claim. A guard that cannot tell a
    // stylesheet from a promise fails on its author's own warning against the
    // thing it guards, which is a false positive with no route to a true one.
    const built = read(BUILT);
    const visible = built
      .replace(/<style[\s\S]*?<\/style>/g, ' ')
      .replace(/<script[\s\S]*?<\/script>/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .toLowerCase();
    for (const overclaim of ['100% undetectable', 'undetectable', 'guaranteed', 'bulletproof']) {
      expect(visible, `the page claims "${overclaim}"`).not.toContain(overclaim);
    }
    // Non-vacuity: the stripped text must still contain the demos' own copy, or
    // the assertions above pass against an empty string.
    expect(visible, 'the stripped text still contains the page').toContain('device profile');
  });

  it('CRITICAL no internal marker reaches the built page. `is:inline` styles and scripts ship VERBATIM, so a comment in one is customer-visible via View Source.', () => {
    const built = read(BUILT);
    expect(built.match(/\bP-\d+\b/g) ?? [], 'plan markers in the served HTML').toEqual([]);
    expect(built.match(/\bV-\d{3,4}\b/g) ?? [], 'verification markers').toEqual([]);
  });
});
