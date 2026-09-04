// W260.C — drift-guard for docs.driftstack.io/api/email-preferences. Pins:
// 1. GET + PUT /v1/account/email-preferences match the live routes.
// 2. Every event_type in the opt-outable table is a real
//    OptOutableEmailEventSchema enum value (and vice versa — no live
//    enum value is missing from the doc).
// 3. Source-of-truth file paths cited exist on disk.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OptOutableEmailEventSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/api/email-preferences.md');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/email-preferences.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W260.C docs/api/email-preferences ↔ live OptOutableEmailEventSchema parity', () => {
  const doc = read(DOC);
  const route = read(ROUTE);
  const liveEvents = new Set(OptOutableEmailEventSchema.options);

  it('GET + PUT /v1/account/email-preferences match live routes', () => {
    expect(doc).toMatch(/GET \/v1\/account\/email-preferences/);
    expect(doc).toMatch(/PUT \/v1\/account\/email-preferences/);
    expect(route).toContain(`'/v1/account/email-preferences'`);
  });

  it('every event_type in the opt-outable table is a real OptOutableEmailEventSchema value', () => {
    const docEvents = [...doc.matchAll(/\|\s*`([a-z][\w-]*)`\s*\|[^\n]*\|\s*opt-in/g)].map(
      (m) => m[1]!,
    );
    expect(docEvents.length).toBeGreaterThan(3);
    const offenders = docEvents.filter((e) => !liveEvents.has(e as never));
    expect(offenders).toEqual([]);
  });

  it('every live OptOutableEmailEventSchema value appears in the doc', () => {
    for (const e of liveEvents) {
      expect(doc).toMatch(new RegExp(`\`${e}\``));
    }
  });

  it('list-response example reproduces a complete opt-outable set', () => {
    const responseEvents = [...doc.matchAll(/"event_type":\s*"([a-z][\w-]*)"/g)].map((m) => m[1]!);
    const requiredCount = liveEvents.size;
    // The example must include >= every live category at least once.
    const seen = new Set(responseEvents);
    const missing: string[] = [];
    for (const e of liveEvents) {
      if (!seen.has(e)) missing.push(e);
    }
    expect(missing).toEqual([]);
    // And the count of live categories in the doc should match.
    expect(responseEvents.length).toBeGreaterThanOrEqual(requiredCount);
  });

  it('Source-of-truth file paths exist on disk', () => {
    const paths = [...doc.matchAll(/`((?:apps|packages)\/[\w./-]+\.ts)/g)].map((m) => m[1]!);
    expect(paths.length).toBeGreaterThan(0);
    const missing = paths.filter((p) => !existsSync(resolve(REPO_ROOT, p)));
    expect(missing).toEqual([]);
  });

  it('operational (non-opt-outable) categories are absent from OptOutableEmailEventSchema', () => {
    // These appear in the "What's NOT opt-outable" section. Verify the
    // doc's claim that they're NOT in the live enum. (S44 2026-07-07
    // founder-approved trim deleted the never-wired subscription-
    // cancellation + support-ack templates — the doc must no longer
    // list them at all, and they must stay out of the enum.)
    const operational = ['signup-verification', 'password-reset', 'billing-failure'];
    for (const op of operational) {
      expect(liveEvents.has(op as never)).toBe(false);
      expect(doc).toMatch(new RegExp(`\`${op}\``));
    }
    for (const deleted of ['subscription-cancellation', 'support-ack']) {
      expect(liveEvents.has(deleted as never)).toBe(false);
      expect(doc).not.toMatch(new RegExp(`\`${deleted}\``));
    }
  });
});
