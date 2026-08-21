// V-1018 — a test title that states a field count must be counting something.
//
// The corpus is full of arms shaped `CRITICAL <Interface> has N fields — a + b +
// c`, and the body then asserts each named field with its own `toMatch`. Every
// one of those assertions is real. The NUMBER is not: nothing counts the
// interface, so a field added later passes every arm while the title keeps
// advertising the old shape.
//
// It has already happened, measured across the corpus before this file existed:
//
//   ProfileRecord          claimed  8, has 15  (folder, tags, icon, note,
//                                               sizeBytes, lastSavedAt, deletedAt)
//   WebhookEndpointRow     claimed 15, has 20
//   ProfileRecord's siblings and twelve more, listed in V-1018's log entry.
//
// `deletedAt` is the recycle bin and `sizeBytes` is the storage a customer is
// quoted for. A reader trusting "8 fields" is reading a shape that stopped being
// true several slices ago.
//
// V-794 already bounds this class — it counts pin files that freeze a
// hand-maintained number and holds a one-way ceiling — but a ceiling stops the
// population growing without saying whether the numbers still hold. This asks
// that question instead, and it is derivable, so it should never have been prose.
//
// Scope: titles of the exact `X has N fields` shape, resolved against either an
// `interface` declaration or a literal `z.object({ … })`. V-1018 shipped this
// covering interfaces only and named the schema gap out loud; V-1019 closed it,
// and three of those sixteen schema claims were wrong too — including one that
// omitted the field carrying the amount a customer has to pay. A schema composed
// with `.extend()` or `.merge()` would be counted from its literal half only, so
// an arm below asserts none of the covered claims is built that way.
//
// V-1020 added the method half. `X has N methods` titles are counted the same
// way, and the property counter's blindness to `foo(args): ret` is now an
// asserted precondition rather than a silent undercount: `ProfilesRepo` was
// documented with 8 methods and has 18, and `BillingProvider` with 3 and has 5 —
// the two it omitted being the ones that make the acceptable-use policy true
// where it says suspending an account pauses its billing.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const WORDS: Readonly<Record<string, number>> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (entry === 'node_modules' || entry === 'dist') continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) out.push(p);
    }
  };
  walk(resolve(REPO_ROOT, 'apps/server/src'));
  walk(resolve(REPO_ROOT, 'packages'));
  return out;
}

/** The body of `interface <name> { … }`, brace-matched. */
function interfaceBody(src: string, name: string): string | null {
  const decl = new RegExp(`(?:export\\s+)?interface\\s+${name}\\s*(?:extends[^{]+)?\\{`).exec(src);
  if (decl === null) return null;
  const open = src.indexOf('{', decl.index);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * The literal `z.object({ … })` body of a schema declaration, brace-matched.
 *
 * V-1018 left these uncovered and V-1019 closes them: `z.object` keys are the
 * same claim in a different syntax, and three of the sixteen were wrong.
 */
function zodObjectBody(src: string, name: string): string | null {
  const decl = new RegExp(
    `(?:export\\s+)?const\\s+${name}\\s*(?::[^=]+)?=\\s*z\\s*\\.?\\s*object\\(\\s*\\{`,
  ).exec(src);
  if (decl === null) return null;
  const open = src.indexOf('{', decl.index + decl[0].length - 1);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

/** Top-level keys of a z.object body — comma-separated rather than semicolon. */
function zodKeys(body: string): string[] {
  // V-1256 — via the SHARED scanner. A private block-first pass cannot tell that the
  // `/*` in a line comment such as `// … /v1/agent-sessions/* routes` is inside one, and
  // models neither string nor regex literals. `code-only.ts` does both and keeps line
  // numbers.
  const code = codeOnly(body);
  const keys: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of code) {
    if ('{(['.includes(ch)) depth += 1;
    if ('})]'.includes(ch)) depth -= 1;
    if (ch === ',' && depth === 0) {
      keys.push(cur);
      cur = '';
    } else cur += ch;
  }
  keys.push(cur);
  return keys
    .map((k) => /^\s*['"]?([A-Za-z_]\w*)['"]?\s*:/.exec(k))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1] as string);
}

/**
 * Top-level member names of an interface body.
 *
 * Split on semicolons at depth zero so a member whose TYPE contains braces or a
 * function signature counts once, not once per inner token. Comments go first —
 * a JSDoc mentioning `foo:` would otherwise read as a member.
 */
function memberNames(body: string): string[] {
  const code = codeOnly(body);
  const members: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of code) {
    if ('{(['.includes(ch)) depth += 1;
    if ('})]'.includes(ch)) depth -= 1;
    if (ch === ';' && depth === 0) {
      members.push(cur);
      cur = '';
    } else cur += ch;
  }
  members.push(cur);
  return members
    .map((m) => /^\s*(?:readonly\s+)?([A-Za-z_]\w*)\??\s*:/.exec(m))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1] as string);
}

/**
 * Method members of an interface body — `foo(args): ret`, which `memberNames`
 * cannot see because it keys on the `name:` shape.
 *
 * V-1020: leaving this out made the field counter silently undercount any
 * interface carrying a method, and made `X has N methods` titles uncheckable.
 * `ProfilesRepo` was documented with 8 methods and has 18.
 */
function methodNames(body: string): string[] {
  const code = codeOnly(body);
  const members: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of code) {
    if ('{(['.includes(ch)) depth += 1;
    if ('})]'.includes(ch)) depth -= 1;
    if (ch === ';' && depth === 0) {
      members.push(cur);
      cur = '';
    } else cur += ch;
  }
  members.push(cur);
  return members
    .map((m) => /^\s*(?:readonly\s+)?([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/.exec(m))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1] as string);
}

interface Claim {
  readonly iface: string;
  readonly claimed: number;
  readonly testFile: string;
  /** Source file the arm reads, when it names one. */
  readonly readsPath: string | null;
  /** Whether the title counts properties or methods. */
  readonly kind: 'fields' | 'methods';
}

function claims(): Claim[] {
  const dir = resolve(HERE);
  const out: Claim[] = [];
  const RE =
    /\bit\(\s*['"`](?:CRITICAL\s+)?([A-Z]\w*) has (?:EXACTLY )?(\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve) (fields|methods)/g;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.test.ts'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    const arms = [...src.matchAll(RE)];
    for (const [i, m] of arms.entries()) {
      const raw = m[2] as string;
      // The source path the arm itself reads. Two interfaces in this corpus
      // share a name across the server and a package, so the file the arm pins
      // is the only non-arbitrary way to say which one its number describes.
      const end = i + 1 < arms.length ? (arms[i + 1]?.index ?? src.length) : src.length;
      const body = src.slice(m.index, end);
      const path = /resolve\(\s*REPO_ROOT,\s*'([^']+\.ts)'\s*\)/.exec(body);
      out.push({
        iface: m[1] as string,
        claimed: /^\d+$/.test(raw) ? Number(raw) : (WORDS[raw] as number),
        testFile: f,
        readsPath: path === null ? null : (path[1] as string),
        kind: (m[3] as string) === 'methods' ? 'methods' : 'fields',
      });
    }
  }
  return out;
}

/** Member count of a declaration — properties or methods — or a z.object's keys. */
function countIn(src: string, name: string, kind: 'fields' | 'methods'): number | null {
  const iface = interfaceBody(src, name);
  if (iface !== null) {
    return kind === 'methods' ? methodNames(iface).length : memberNames(iface).length;
  }
  if (kind === 'methods') return null;
  const zod = zodObjectBody(src, name);
  if (zod !== null) return zodKeys(zod).length;
  return null;
}

/** The source the claim is about: the file its arm reads, else a unique global match. */
function resolveCount(
  claim: Claim,
  sources: readonly (readonly [string, string])[],
): { count: number; ambiguous: boolean } | null {
  if (claim.readsPath !== null) {
    const hit = sources.find(([p]) => p.endsWith(claim.readsPath as string));
    if (hit !== undefined) {
      const c = countIn(hit[1], claim.iface, claim.kind);
      if (c !== null) return { count: c, ambiguous: false };
    }
  }
  const hits = sources.filter(([, s]) => countIn(s, claim.iface, claim.kind) !== null);
  if (hits.length === 0) return null;
  return {
    count: countIn(hits[0]?.[1] as string, claim.iface, claim.kind) as number,
    ambiguous: hits.length > 1,
  };
}

describe('V-1018 a field count in a test title is derived', () => {
  const sources = sourceFiles().map((p) => [p, readFileSync(p, 'utf8')] as const);
  const all = claims();

  it('CRITICAL the scan finds claims and the counter counts. A title regex that matched nothing, or a member parser returning zero, would make the arm below agree with any number in any title — which is exactly the state that let a 15-field interface be documented as 8.', () => {
    expect(all.length, 'field-count claims found in test titles').toBeGreaterThanOrEqual(20);
    expect(sources.length, 'source files walked').toBeGreaterThanOrEqual(300);

    // The parser counts members, not braces or comments.
    const sample = `
      id: string;
      /** a comment mentioning fake: string; */
      nested: { a: string; b: string };
      cb: (x: number) => void;
      opt?: string | null;
    `;
    expect(memberNames(sample)).toEqual(['id', 'nested', 'cb', 'opt']);
  });

  it('CRITICAL every interface named in a field-count title resolves to exactly one declaration. Two interfaces sharing a name would make the count below depend on which file the walk reached first, and a guard whose answer depends on directory order is worse than no guard.', () => {
    const ambiguous: string[] = [];
    const missing: string[] = [];
    for (const claim of all) {
      const r = resolveCount(claim, sources);
      if (r === null) missing.push(`${claim.iface} (${claim.testFile})`);
      else if (r.ambiguous) {
        const where = sources
          .filter(([, s]) => countIn(s, claim.iface, claim.kind) !== null)
          .map(([p]) => p.slice(REPO_ROOT.length + 1))
          .join(', ');
        ambiguous.push(`${claim.iface} (${claim.testFile}): ${where}`);
      }
    }
    expect(ambiguous.sort(), 'these names resolve to more than one interface:').toEqual([]);
    // Zod schemas and type aliases land here; they are out of scope by design.
    expect(
      missing.filter((m) => !/Schema/.test(m)).sort(),
      'these titles name something that is not an interface and is not a Schema — either the ' +
        'declaration was renamed, or this guard needs to learn a new shape:',
    ).toEqual([]);
  });

  it('CRITICAL a title that states a field count states the real one. Each of these arms asserts its named fields individually and passes; the number beside them is the part nothing checked, so it kept describing a shape that had since grown. Update the title to the real count when a field is added, in the same commit that adds it.', () => {
    const wrong: string[] = [];
    for (const claim of all) {
      const r = resolveCount(claim, sources);
      if (r === null) continue;
      const real = r.count;
      if (real !== claim.claimed) {
        wrong.push(
          `${claim.testFile}: ${claim.iface} title says ${claim.claimed}, source has ${real}`,
        );
      }
    }
    expect(
      wrong.sort(),
      'these titles state a field count that the interface no longer has:',
    ).toEqual([]);
  });

  it('CRITICAL the schema half is really covered, not just walked past. V-1018 shipped this guard covering interfaces only and said so; V-1019 added z.object schemas, and three of the sixteen were wrong. If the schema parser ever stops resolving them, every Schema claim would silently fall through the continue in the arm above and this file would pass while checking half the corpus.', () => {
    const schemaClaims = all.filter(({ iface }) => /Schema$/.test(iface));
    expect(schemaClaims.length, 'Schema-shaped field-count claims found').toBeGreaterThanOrEqual(
      10,
    );
    const unresolved = schemaClaims
      .filter((c) => resolveCount(c, sources) === null)
      .map((c) => `${c.iface} (${c.testFile})`)
      .sort();
    expect(
      unresolved,
      'these Schema claims resolve to nothing, so nothing checks their number:',
    ).toEqual([]);
    // The parser reads a literal z.object body. A schema COMPOSED with .extend()
    // or .merge() would count only its literal half, so none of the covered
    // claims may be built that way.
    const composed = schemaClaims
      .filter((c) => {
        const hit = sources.find(([p]) => (c.readsPath === null ? false : p.endsWith(c.readsPath)));
        if (hit === undefined) return false;
        const decl = new RegExp(`const\\s+${c.iface}\\b[^;]*?\\.(?:extend|merge)\\(`, 's');
        return decl.test(hit[1]);
      })
      .map((c) => c.iface)
      .sort();
    expect(
      composed,
      'these schemas are composed with .extend()/.merge(), so a literal-body count understates them:',
    ).toEqual([]);
  });

  it('CRITICAL a title that counts FIELDS names an interface that has no methods. The property counter keys on the `name:` shape and cannot see `foo(args): ret`, so a fields-claim about an interface carrying methods would be counted against half its members and agree with a number that was already wrong. No claim in the corpus is in that state today; this fails the moment one is, rather than quietly undercounting it.', () => {
    const mixed: string[] = [];
    for (const claim of all.filter((c) => c.kind === 'fields')) {
      const hit = sources.find(([p]) =>
        claim.readsPath === null ? false : p.endsWith(claim.readsPath),
      );
      const src = hit?.[1] ?? sources.find(([, s]) => interfaceBody(s, claim.iface) !== null)?.[1];
      if (src === undefined) continue;
      const body = interfaceBody(src, claim.iface);
      if (body === null) continue;
      const methods = methodNames(body);
      if (methods.length > 0) {
        mixed.push(`${claim.testFile}: ${claim.iface} has methods (${methods.join(', ')})`);
      }
    }
    expect(
      mixed.sort(),
      'these interfaces mix properties and methods, so a "has N fields" title counts only half of ' +
        'them — split the claim, or teach this guard which half the title means:',
    ).toEqual([]);
  });
});
