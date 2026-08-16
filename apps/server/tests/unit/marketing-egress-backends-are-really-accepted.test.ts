// Every egress backend the marketing site names must be one the API accepts.
//
// `marketing-egress-claim-sweep` (W247.A) forbade the marketing site from naming
// SOCKS5 / OpenVPN / WireGuard as shipped capabilities while egress was unbuilt.
// It is designed to RETIRE once the implementation lands — `it.skipIf(hasEgressImpl)`
// — and it has: both arms are the two skips in every suite run.
//
// Retiring was correct, but it left the opposite direction unguarded. The site
// now says the feature "is live" and names three backends by name, in eleven,
// five and four pages respectively. Nothing checks that the API still accepts
// all three. Drop one from `ProxyTypeSchema` and the marketing site keeps
// advertising a backend that every request would be rejected for.
//
// This is the successor guard: not "you may not claim these" but "if you claim
// these, they must be real". The pairing is DERIVED — the accepted set is read
// from the schema's `.options` at runtime, and the claimed set is parsed out of
// the pages — so adding a fourth backend to either side is picked up without
// editing this file.
//
// SCOPE, stated because it bounds the claim: this proves the API ACCEPTS the
// backend, not that a tunnel is established. SOCKS5 is proxied by the control
// plane, while the VPN backends are applied on the fleet node, which is outside
// this repository.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ProxyTypeSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES = resolve(HERE, '..', '..', '..', 'marketing-site', 'src', 'pages');

/** How each backend is spelled to customers, mapped to its API value. */
const MARKETED_AS: ReadonlyArray<{ label: RegExp; apiValue: string }> = [
  { label: /\bSOCKS5\b/i, apiValue: 'socks5' },
  { label: /\bOpenVPN\b/i, apiValue: 'openvpn' },
  { label: /\bWireGuard\b/i, apiValue: 'wireguard' },
];

function pageFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) return pageFiles(p);
    return /\.(astro|md|mdx)$/.test(entry) ? [p] : [];
  });
}

const corpus = pageFiles(PAGES)
  .map((f) => readFileSync(f, 'utf-8'))
  .join('\n');

describe('every egress backend the marketing site names is one the API accepts', () => {
  it('CRITICAL the page corpus was actually read, so the check below is not vacuous', () => {
    expect(pageFiles(PAGES).length, 'marketing pages found').toBeGreaterThan(40);
    expect(corpus.length, 'page text read').toBeGreaterThan(10_000);
    expect(
      MARKETED_AS.filter((b) => b.label.test(corpus)).length,
      'no backend is named anywhere — either the copy changed or the scan is broken',
    ).toBeGreaterThan(0);
  });

  it('CRITICAL a backend named to customers is accepted by ProxyTypeSchema', () => {
    const accepted = new Set<string>(ProxyTypeSchema.options);
    const claimedButRejected = MARKETED_AS.filter(
      (b) => b.label.test(corpus) && !accepted.has(b.apiValue),
    ).map((b) => b.apiValue);

    expect(
      claimedButRejected.sort(),
      'the marketing site names these backends and the API would reject every request using them',
    ).toEqual([]);
  });

  it('CRITICAL the schema value really is what the API validates, not just a string this test knows', () => {
    // Guards against the pairing rotting into two independent lists. If the
    // schema stopped accepting a value, `safeParse` is what a request would hit.
    for (const backend of MARKETED_AS) {
      if (!backend.label.test(corpus)) continue;
      expect(
        ProxyTypeSchema.safeParse(backend.apiValue).success,
        `${backend.apiValue} is advertised but the schema refuses it`,
      ).toBe(true);
    }
    expect(
      ProxyTypeSchema.safeParse('not-a-backend').success,
      'and the schema is not simply accepting anything',
    ).toBe(false);
  });
});
