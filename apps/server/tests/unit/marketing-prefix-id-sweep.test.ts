// W249.D — workspace-wide sweep for id-prefix consistency in
// marketing-site docs. Every Driftstack resource has a stable id
// prefix (ses_ session, prof_ profile, psnap_ snapshot, whk_
// webhook endpoint, wdl_ delivery, ord_ order, key_ api key, mem_
// team membership, inv_ team invite, oac_/oas_/oat_ oauth client/
// secret/token, acc_ account, sub_ subscription, inc_ incident).
// This guard fails if any doc example uses a legacy non-prefixed
// id (e.g. `id: "abc123"` for a session, which would not be a real
// session id today).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const PAGES = join(REPO, 'apps', 'marketing-site', 'src', 'pages');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (entry.endsWith('.astro') || entry.endsWith('.md')) out.push(p);
  }
  return out;
}

// Pages we trust as the source of truth that DO use modern prefixes.
// Any page in this sweep that uses an old (raw) id format for a
// known resource is flagged.
describe('W249.D marketing-site id-prefix sweep', () => {
  const pages = walk(PAGES);
  // Vacuity arm. Every assertion below reports an ABSENCE, and an absence is
  // vacuously true over an empty scan — so a filter that stops matching (a
  // rename, a new extension, a moved page root) would make this guard report
  // clean forever while checking nothing. Measured, not hypothetical: pointing
  // the extension filter at a non-existent suffix left this file GREEN.
  it('CRITICAL the scan found real pages, so a clean result means checked rather than not looked.', () => {
    // V-939 — floor raised to just under the measured 68; it stood at 5, so this
    // scan could have lost 93% of its corpus and still called itself non-vacuous.
    expect(pages.length, 'marketing-site pages scanned').toBeGreaterThan(60);
  });

  it('no doc references a raw (unprefixed) session_id placeholder', () => {
    // Forbidden patterns: bare hex / uuid placeholders for sessions.
    // We allow placeholders that ARE prefixed (e.g. ses_…) and
    // placeholders that are obvious documentation tokens (e.g.
    // "<session_id>"). The drift is the unprefixed JSON envelope
    // value like `"session_id": "abc123def456"`.
    const offenders: string[] = [];
    for (const p of pages) {
      const body = readFileSync(p, 'utf8');
      // `"session_id": "..."` where the value lacks the ses_ prefix
      // AND doesn't look like a doc placeholder (<...>, …).
      for (const m of body.matchAll(/"session_id"\s*:\s*"([^"]+)"/g)) {
        const v = m[1]!;
        if (/^[<{]/.test(v) || v === 'string') continue;
        if (!v.startsWith('ses_')) {
          offenders.push(`${p.replace(REPO + '/', '')}: ${v}`);
        }
      }
      for (const m of body.matchAll(/"order_id"\s*:\s*"([^"]+)"/g)) {
        const v = m[1]!;
        if (/^[<{]/.test(v) || v === 'string') continue;
        if (!v.startsWith('ord_')) {
          offenders.push(`${p.replace(REPO + '/', '')}: order_id=${v}`);
        }
      }
      for (const m of body.matchAll(/"webhook_id"\s*:\s*"([^"]+)"/g)) {
        const v = m[1]!;
        if (/^[<{]/.test(v) || v === 'string') continue;
        if (!v.startsWith('whk_')) {
          offenders.push(`${p.replace(REPO + '/', '')}: webhook_id=${v}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no doc uses the placeholder "id": "abc" form for prefixed resources', () => {
    // Catch the bare `"id": "abc"` form WITHIN crypto-order doc
    // context (the most-common drift class). We scope to .astro
    // pages mentioning crypto-orders.
    const offenders: string[] = [];
    for (const p of pages) {
      if (!p.endsWith('.astro')) continue;
      const body = readFileSync(p, 'utf8');
      if (!/crypto-order/.test(body)) continue;
      for (const m of body.matchAll(/"id"\s*:\s*"([a-zA-Z0-9]{4,})"/g)) {
        const v = m[1]!;
        if (v.startsWith('ord_') || v.startsWith('key_') || v.startsWith('acc_')) continue;
        // Allow standard documentation placeholders.
        if (v === 'string' || v === 'cs_test_abc' || v === 'cs_live_abc') continue;
        offenders.push(`${p.replace(REPO + '/', '')}: id=${v}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
