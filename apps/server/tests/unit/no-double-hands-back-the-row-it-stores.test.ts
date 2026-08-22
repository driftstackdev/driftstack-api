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
  [
    'in-memory-incidents-repo.ts::getAll',
    'not on IncidentsRepo; returns both raw collections wrapped in an object, and fixtures ' +
      'arrange incident state through it as well as assert on it',
  ],
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
  // V-1285 — THREE binding forms, because the guard knew only one and it was the one nobody
  // uses. Measured per method scope: `this.x.find(` had ZERO live instances, while `this.x.get(`
  // had seven and `for (const r of this.x.values())` had three. Almost every double here is
  // Map-backed, so `.get()` is the ordinary way a row is bound — the guard was passing because
  // its signature no longer described the code, which is precisely the failure its own first arm
  // exists to catch on the OTHER side.
  // Binds are computed PER METHOD, not per file. A file-wide set taints every method that happens
  // to name a local `row`: `createAccount` builds a fresh row and was flagged because a DIFFERENT
  // method in the same file binds `row` out of a map. Six false positives, all from one shared
  // name — the scope is part of the signature.
  const spans: Array<{ start: number; end: number }> = [];
  for (const [i, l] of lines.entries()) {
    if (!/^ {2}(?:async )?(?:private )?[A-Za-z_]\w*\s*\(/.test(l)) continue;
    let e = i + 1;
    while (e < lines.length && lines[e] !== '  }') e += 1;
    spans.push({ start: i, end: e });
  }
  const BINDINGS = [
    /const\s+(\w+)\s*(?::[^=]*)?=\s*this\.\w+(?:\[[^\]]*\])?\.find\(/,
    /const\s+(\w+)\s*(?::[^=]*)?=\s*this\.\w+(?:\[[^\]]*\])?\.get\(/,
    /for \(const (\w+) of this\.\w+/,
  ];
  const boundAt = (index: number): ReadonlySet<string> => {
    const span = spans.find((sp) => index >= sp.start && index <= sp.end);
    const out = new Set<string>();
    for (const line of lines.slice(span?.start ?? 0, (span?.end ?? lines.length) + 1)) {
      for (const re of BINDINGS) {
        const m = re.exec(line);
        if (m?.[1] !== undefined) out.add(m[1]);
      }
    }
    return out;
  };

  // V-1272 — locals filled from a stored collection by a loop, then returned:
  //   const out: Row[] = [];
  //   for (const r of this.rows.values()) { if (…) out.push(r); }
  //   return out;
  // The original detector saw `return row;`, `return this.rows;` and filter/sort chains, and this
  // shape is none of them — three interface reads sat outside the rule the guard states. Nothing
  // was broken by it: none of the three mutates its rows in place, so the aliasing was not
  // observable. "Not currently observable" is a weaker property than the rule, which is why the
  // detector was widened rather than the finding written off.
  const accumulators = new Set<string>();
  for (const [i, line] of lines.entries()) {
    const decl = /const\s+(\w+)\s*:\s*[\w<>[\]|\s]+=\s*\[\]\s*;/.exec(line);
    if (decl?.[1] === undefined) continue;
    const rest = lines.slice(i, i + 30).join('\n');
    // Pushed a BARE identifier that the loop above took straight off a stored collection.
    if (new RegExp(`for \\(const (\\w+) of this\\.\\w+`).test(rest)) {
      const iterated = /for \(const (\w+) of this\.\w+/.exec(rest)?.[1];
      if (iterated !== undefined && new RegExp(`${decl[1]}\\.push\\(${iterated}\\)`).test(rest)) {
        accumulators.add(decl[1]);
      }
    }
  }

  // V-1274 — rows that leave INSIDE an object rather than alone:
  //   return { outcome: 'created', incident: row, update };
  // The incidents double did this from three methods while its reads had been snapshotted since
  // V-1251, and it mutates stored incidents in place — so a caller holding the result of a create
  // watched its status change when someone else resolved the incident. The row was never returned
  // bare, so every branch above walked past it. Rows pushed or set into a collection count as live
  // alongside rows bound off one, because `this.rows.push(row); return { row }` aliases just as
  // hard as looking one up does.
  // V-1281 — a local MATERIALISED straight off a stored collection, then returned:
  //   const rows = Array.from(this.byId.values()).filter(…).sort(…);
  //   return Promise.resolve(rows);
  // `Array.from` copies the ARRAY and not the row objects inside it, so every element is still
  // the stored row — the same defect as `return [...this.rows]`, which this guard has caught
  // since V-1255, wearing a local variable. Eight interface reads across five doubles sat
  // outside the rule the guard states. None was observable, because none of those five mutates
  // a stored row in place; that is a weaker property than the rule and it holds only until
  // someone adds a write that does, which is exactly what the incidents double turned out to be.
  const materialised = new Set<string>();
  for (const [i, line] of lines.entries()) {
    const m = /const\s+(\w+)\s*(?::[^=]*)?=\s*Array\.from\(this\.\w+\.values\(\)\)/.exec(line);
    if (m?.[1] === undefined) continue;
    // Only if nothing between here and the return maps the rows through anything.
    const upToReturn =
      lines
        .slice(i, i + 12)
        .join('\n')
        .split('return')[0] ?? '';
    if (!/\.map\(|\bsnap\w*\(/.test(upToReturn)) materialised.add(m[1]);
  }

  // A local BUILT as an object literal and then handed to a `set`/`push` on a stored collection:
  //   const row = { … };  this.accounts.set(row.id, { account: row, … });  return row;
  // The caller ends up holding the object the map holds, which is the same defect as binding one
  // out of the map. Keyed on the DECLARATION being an object literal, and on the name appearing in
  // the storing call — a first attempt matched every identifier inside the call arguments and
  // flagged seventy-two sites including `return Promise.resolve(true)`, because `true` is an
  // identifier to a regex that has not been told otherwise.
  const built = new Set<string>();
  for (const line of lines) {
    const m = /const\s+(\w+)\s*(?::[^=]*)?=\s*\{\s*$/.exec(line.trim());
    if (m?.[1] !== undefined) built.add(m[1]);
  }
  const stored = new Set<string>();
  for (const line of lines) {
    if (!/this\.\w+(?:\[[^\]]*\])?\.(?:set|push)\(/.test(line)) continue;
    for (const name of built) {
      if (new RegExp(`(?<![.\\w])${name}(?![\\w])`).test(line)) stored.add(name);
    }
    const direct = /this\.\w+\.(?:push\((\w+)\)|set\([\w.]+,\s*(\w+)\s*\))/.exec(line);
    const n = direct?.[1] ?? direct?.[2];
    if (n !== undefined) stored.add(n);
  }

  const out: Hit[] = [];
  for (const [i, line] of lines.entries()) {
    const t = line.trim();
    // A live row named as a property value or array element. The lookbehind is what keeps
    // `{ record: { ...row } }` — the FIX — from reading as the defect: after a spread the name is
    // preceded by a dot, and a copy is exactly what the rule asks for.
    // The whole RETURN STATEMENT, not the line. A snapshotting read is routinely written across
    // four lines ending `.map((r) => snap(r));`, and judging its first line alone reported the
    // repaired `listAll` in the status-subscribers double as a defect — the guard accusing the
    // fix. A statement that maps its rows through anything has already made copies.
    const stmt = ((): string => {
      const acc: string[] = [];
      for (let j = i; j < Math.min(lines.length, i + 8); j += 1) {
        const piece = (lines[j] ?? '').trim();
        acc.push(piece);
        if (piece.endsWith(';')) break;
      }
      return acc.join(' ');
    })();
    const copies = /\.map\(|\bsnap\w*\(/.test(stmt);
    const opensWrapper = /^return\s+(?:Promise\.resolve\()?[[{]/.test(t) && !copies;
    const wrapped =
      opensWrapper &&
      ([...t.matchAll(/(?<![.\w])(\w+)(?=\s*[,}\]])/g)].some(
        (m) => m[1] !== undefined && (boundAt(i).has(m[1]) || stored.has(m[1])),
      ) ||
        // `return { incidents: this.incidents, updates: this.updates };` — the whole collection,
        // wrapped. `whole` above only sees it returned alone, so this form walked past both.
        /this\.\w+\s*[,}\]]/.test(t));
    // `return out;` AND `return Promise.resolve(out);` — the doubles that use the accumulate
    // shape all return through the Promise form, so matching only the bare return meant the
    // widened branch below never fired. Its own mutation is what said so.
    const bare = /^return\s+(?:Promise\.resolve\()?(\w+)\)?\s*;$/.exec(t);
    // `return this.rows;` and `return [...this.rows];` are the same defect: the second copies
    // the ARRAY and hands back the very same row objects inside it. Only the elements matter.
    const whole = /^return\s+(?:\[\.\.\.)?this\.\w+\]?\s*;$/.test(t);
    // A filtered/sorted chain is fine ONLY if it ends by mapping each row through something.
    const chain = /^return\s+this\.\w+[\s\S]*\.(?:filter|sort)\(/.test(t) && !t.includes('.map(');

    if (
      (bare?.[1] !== undefined &&
        (boundAt(i).has(bare[1]) || accumulators.has(bare[1]) || materialised.has(bare[1]))) ||
      whole ||
      chain ||
      wrapped
    ) {
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

  it('CRITICAL a row handed back INSIDE an object is flagged, and the same row spread into a copy is not. This is the shape that survived V-1251 in the very file that had been repaired: three methods returned a live incident as an object property while the bare reads beside them had been snapshotted for months, and the guard passed the whole time.', () => {
    const defect = [
      '  async create(input: Input) {',
      '    const row = { id: input.id };',
      '    this.incidents.push(row);',
      "    return { outcome: 'created', incident: row };",
      '  }',
    ].join('\n');
    const hits = aliasingReads(defect, 'wrapped.ts');
    expect(hits.length, 'a stored row returned as an object property was not flagged').toBe(1);
    expect(hits[0]?.method, 'the enclosing method was not resolved').toBe('create');

    const fixed = defect.replace('incident: row', 'incident: { ...row }');
    expect(
      aliasingReads(fixed, 'wrapped-fixed.ts'),
      'a row spread into a copy was flagged as an aliasing return',
    ).toEqual([]);

    // The whole collection, wrapped. `return this.rows;` was already caught; the same array
    // leaving as an object property was not, and that is how the incidents assertion seam went
    // unregistered for as long as it did.
    expect(
      aliasingReads('  getAll() {\n    return { rows: this.rows };\n  }', 'coll.ts').length,
      'a stored collection returned as an object property was not flagged',
    ).toBe(1);
  });

  it('CRITICAL a snapshotting chain spread across several lines is NOT flagged. The widened branch judged only the line the return opened on, so `return [...this.rows]` reported as a defect while three lines below it mapped every row through snap — the guard accusing the repair. Both halves are asserted here because a detector that cannot tell them apart is worse than the narrower one it replaced.', () => {
    const multiline = [
      '  async listAll(opts: { limit: number }) {',
      '    return [...this.rows]',
      '      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())',
      '      .slice(0, opts.limit)',
      '      .map((r) => snap(r));',
      '  }',
    ].join('\n');
    expect(
      aliasingReads(multiline, 'multiline.ts'),
      'a multi-line chain that snapshots every row was flagged',
    ).toEqual([]);

    const unsnapped = multiline.replace('      .map((r) => snap(r));', '      .slice(0);');
    expect(
      aliasingReads(unsnapped, 'multiline-defect.ts').length,
      'the same chain WITHOUT the snapshot was not flagged — the exclusion is too broad',
    ).toBe(1);
  });

  it('CRITICAL all THREE ways a row gets bound are recognised — find, get, and a for-of over the stored values. The guard shipped knowing only `find`, and a per-scope measurement found zero live instances of that form against ten of the other two: it was passing because its signature had stopped describing the code rather than because the defect was gone. Each form is asserted separately so losing one cannot hide behind the others.', () => {
    const forms: ReadonlyArray<readonly [string, string]> = [
      ['find', '    const row = this.rows.find((r) => r.id === id);'],
      ['get', '    const row = this.rows.get(id);'],
      ['for-of', '    for (const row of this.rows.values()) {'],
    ];
    for (const [label, binding] of forms) {
      const src = ['  read(id: string) {', binding, '    return Promise.resolve(row);', '  }'].join(
        '\n',
      );
      expect(
        aliasingReads(src, `${label}.ts`).length,
        `a row bound via ${label} was not recognised as an aliasing read`,
      ).toBe(1);
    }

    // The keyed-collection form too: `this.tokensByKind[kind].get(...)`.
    const keyed = [
      '  read(kind: string, id: string) {',
      '    const row = this.tokensByKind[kind].get(id);',
      '    return Promise.resolve(row);',
      '  }',
    ].join('\n');
    expect(
      aliasingReads(keyed, 'keyed.ts').length,
      'a row bound off a keyed collection was not recognised',
    ).toBe(1);
  });

  it('CRITICAL a local materialised off a stored collection and then returned IS flagged, and the same local mapped through a copy is not. Array.from copies the array, never the rows inside it, so this is `return [...this.rows]` wearing a variable name — eight interface reads across five doubles were sitting outside the rule this guard states, invisible to every branch it had.', () => {
    const defect = [
      '  listKeys(accountId: string) {',
      '    const rows = Array.from(this.byId.values())',
      '      .filter((r) => r.accountId === accountId)',
      '      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());',
      '    return Promise.resolve(rows);',
      '  }',
    ].join('\n');
    const hits = aliasingReads(defect, 'materialised.ts');
    expect(hits.length, 'a materialised-then-returned local was not flagged').toBe(1);
    expect(hits[0]?.method, 'the enclosing method was not resolved').toBe('listKeys');

    const fixed = defect.replace(
      '    return Promise.resolve(rows);',
      '    return Promise.resolve(rows.map((r) => ({ ...r })));',
    );
    expect(
      aliasingReads(fixed, 'materialised-fixed.ts'),
      'copying each row on the way out was still flagged',
    ).toEqual([]);
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
