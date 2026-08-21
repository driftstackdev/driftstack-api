// V-1255 — the guard for the class V-1251, V-1252 and V-1253 fixed by hand.
//
// Three in-memory doubles mutated stored rows in place and returned those very objects from their
// reads, so a row the caller was already holding kept changing underneath it. Postgres cannot do
// that: a SELECT is a point-in-time copy and a later UPDATE does not reach into a result already
// returned.
//
// The damage is not a crash, it is a vacuous test. Any before/after comparison against such a
// double reads "nothing changed" whatever the code under test did, because `before` and `after`
// are one object, and the arm passes forever asserting nothing.
//
// Fixing three by hand and stopping is how the positional-cursor class survived for as long as it
// did — the fix existed in one double under a comment labelled "FIX 3" and nobody swept the rest.
// So: a guard.
//
// WHAT IS ALLOWED. `getAll`-style methods are NOT on the repo interfaces, model nothing in
// production, and fixtures use them to ARRANGE state as well as assert — snapshotting one turned
// two unrelated tombstone tests red in V-1251. They are hatches into the fixture's own state and
// are listed below by name with that reason. The list may only shrink.

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { codeOnly } from './_helpers/code-only.js';

const HELPERS = resolve(import.meta.dirname, '../integration/_helpers');

/**
 * Fixture seams: deliberately hand back live rows. Keyed `file::method`, each with the reason.
 * A seam is only allowed here because it is absent from the production interface the double
 * implements — if one of these ever becomes an interface method, this entry has to go.
 */
const LIVE_SEAMS = new Map<string, string>([
  [
    'in-memory-status-subscribers-repo.ts::getAll',
    'not on StatusSubscribersRepo; tombstone tests arrange state through it',
  ],
  [
    'in-memory-team-members-repo.ts::getAllInvites',
    'not on TeamMembersRepo; fixtures arrange invite state through it',
  ],
  [
    'in-memory-team-members-repo.ts::getAllMembers',
    'not on TeamMembersRepo; fixtures arrange membership state through it',
  ],
  ['in-memory-account-audit-repo.ts::getAll', 'not on AccountAuditRepo; assertion-only seam'],
  ['in-memory-probes-repo.ts::getAll', 'not on ProbesRepo; assertion-only seam'],
  [
    'in-memory-sessions-repo.ts::getEvents',
    'not on SessionRepo, and session events are append-only — nothing mutates a stored event ' +
      'in place, so a held reference cannot change underneath the caller',
  ],
  ['in-memory-admin-audit-repo.ts::getAll', 'not on AdminAuditLogRepo; assertion-only seam'],
]);

interface Hit {
  file: string;
  method: string;
  line: number;
  text: string;
}

/** The method a line sits inside — the nearest `  name(` / `  async name(` above it. */
function enclosingMethod(lines: readonly string[], index: number): string {
  for (let i = index; i >= 0; i -= 1) {
    const m = /^ {2}(?:async )?(?:private )?(?:readonly )?([A-Za-z_][\w]*)\s*\(/.exec(
      lines[i] ?? '',
    );
    if (m?.[1] !== undefined && m[1] !== 'constructor') return m[1];
  }
  return '<unknown>';
}

/** Reads that hand back a stored object rather than a copy of one. */
function aliasingReads(src: string, file: string): Hit[] {
  const lines = codeOnly(src).split('\n');

  // Locals bound straight off a stored collection: `const row = this.rows.find(…)`.
  const bound = new Set<string>();
  for (const line of lines) {
    const m = /const\s+(\w+)\s*=\s*this\.(\w+)\.find\(/.exec(line);
    if (m?.[1] !== undefined) bound.add(m[1]);
  }

  const out: Hit[] = [];
  for (const [i, line] of lines.entries()) {
    const t = line.trim();
    const bare = /^return\s+(\w+)\s*;$/.exec(t);
    // `return this.rows;` and `return [...this.rows];` are the same defect: the second copies
    // the ARRAY and hands back the very same row objects inside it. Only the elements matter.
    const whole = /^return\s+(?:\[\.\.\.)?this\.\w+\]?\s*;$/.test(t);
    // A filtered/sorted chain is fine ONLY if it ends by mapping each row through something.
    const chain = /^return\s+this\.\w+[\s\S]*\.(?:filter|sort)\(/.test(t) && !t.includes('.map(');

    if ((bare?.[1] !== undefined && bound.has(bare[1])) || whole || chain) {
      out.push({ file, method: enclosingMethod(lines, i), line: i + 1, text: t.slice(0, 80) });
    }
  }
  return out;
}

const doubles = (): string[] =>
  readdirSync(HELPERS).filter((f) => f.startsWith('in-memory-') && f.endsWith('.ts'));

describe('no in-memory double hands back the row it stores', () => {
  it('CRITICAL the scan reaches the doubles and still recognises an aliasing read. A guard reporting zero because its signature stopped matching reads exactly like one reporting zero because the defect is gone, and the two are worth telling apart.', () => {
    expect(doubles().length, 'no in-memory doubles were found to scan').toBeGreaterThan(20);

    const control = [
      '  async getById(id: string) {',
      '    const row = this.rows.find((r) => r.id === id);',
      '    return row;',
      '  }',
    ].join('\n');
    const hits = aliasingReads(control, 'control.ts');
    expect(hits.length, 'the signature no longer detects an aliasing read').toBe(1);
    expect(hits[0]?.method, 'the enclosing method was not resolved').toBe('getById');
  });

  it('CRITICAL a snapshotting read is NOT flagged, so the guard distinguishes the fix from the defect. Without this it fires on all three doubles that were already repaired and the output is noise.', () => {
    const fixed = [
      '  async getById(id: string) {',
      '    const row = this.rows.find((r) => r.id === id);',
      '    return snap(row);',
      '  }',
      '  async list() {',
      '    return this.rows.filter((r) => r.live).map((r) => snap(r));',
      '  }',
    ].join('\n');
    expect(aliasingReads(fixed, 'fixed.ts'), 'a snapshotting read was flagged').toEqual([]);
  });

  it('CRITICAL comments are stripped, and the reported line survives the stripping. Every repaired double explains the defect it used to have in prose that names the very shapes this scans for, and a block comment above a hit used to shift the reported line by its own height (V-1254).', () => {
    const src = [
      '  /* a header',
      '     mentioning return row; and this.rows;',
      '     across several lines */',
      '  async getById(id: string) {',
      '    const row = this.rows.find((r) => r.id === id);',
      '    return row;',
      '  }',
    ].join('\n');
    const hits = aliasingReads(src, 'commented.ts');
    expect(hits.length, 'prose was counted as code, or the read was missed').toBe(1);
    expect(hits[0]?.line, 'the reported line drifted by the height of the block comment').toBe(6);
  });

  it('CRITICAL no double hands back a stored row from an interface read. The caller must be holding a snapshot: a fixture whose rows keep changing underneath the caller makes every before/after comparison against it read "nothing changed", and the arm then passes forever asserting nothing.', () => {
    const flagged = doubles()
      .flatMap((f) => aliasingReads(readFileSync(resolve(HELPERS, f), 'utf8'), f))
      .filter((h) => !LIVE_SEAMS.has(`${h.file}::${h.method}`));

    expect(
      flagged.map((h) => `${h.file}::${h.method} (line ${String(h.line)})  ${h.text}`),
      'aliasing read — return a shallow copy, or add the method to LIVE_SEAMS with the reason ' +
        'it is not part of the production interface',
    ).toEqual([]);
  });

  it('CRITICAL every LIVE_SEAMS entry still names a real aliasing read. An exemption for a method that has since been snapshotted, renamed or deleted is a licence nobody is using, and it hides the next one that needs looking at.', () => {
    const present = new Set(
      doubles()
        .flatMap((f) => aliasingReads(readFileSync(resolve(HELPERS, f), 'utf8'), f))
        .map((h) => `${h.file}::${h.method}`),
    );
    const stale = [...LIVE_SEAMS.keys()].filter((k) => !present.has(k)).sort();
    expect(stale, 'stale seam exemption(s) — remove them').toEqual([]);
  });
});
