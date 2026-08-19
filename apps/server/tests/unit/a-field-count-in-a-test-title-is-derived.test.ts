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
// Deliberately narrow: only `interface` declarations, only titles of the exact
// `X has N fields` shape. The Zod-schema equivalents (`…Schema has N fields`) are
// NOT covered — a `z.object` shape needs a different parser, sixteen of them are
// in the corpus, and pretending otherwise would be the vacuous half-coverage this
// sweep keeps finding. The arm below names that gap out loud rather than leaving
// a reader to assume it is total.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
 * Top-level member names of an interface body.
 *
 * Split on semicolons at depth zero so a member whose TYPE contains braces or a
 * function signature counts once, not once per inner token. Comments go first —
 * a JSDoc mentioning `foo:` would otherwise read as a member.
 */
function memberNames(body: string): string[] {
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
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

interface Claim {
  readonly iface: string;
  readonly claimed: number;
  readonly testFile: string;
  /** Source file the arm reads, when it names one. */
  readonly readsPath: string | null;
}

function claims(): Claim[] {
  const dir = resolve(HERE);
  const out: Claim[] = [];
  const RE =
    /\bit\(\s*['"`](?:CRITICAL\s+)?([A-Z]\w*) has (?:EXACTLY )?(\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve) fields/g;
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
      });
    }
  }
  return out;
}

/** The source the claim is about: the file its arm reads, else a unique global match. */
function resolveBody(
  claim: Claim,
  sources: readonly (readonly [string, string])[],
): { body: string; ambiguous: boolean } | null {
  if (claim.readsPath !== null) {
    const hit = sources.find(([p]) => p.endsWith(claim.readsPath as string));
    if (hit !== undefined) {
      const body = interfaceBody(hit[1], claim.iface);
      if (body !== null) return { body, ambiguous: false };
    }
  }
  const hits = sources.filter(([, s]) => interfaceBody(s, claim.iface) !== null);
  if (hits.length === 0) return null;
  return {
    body: interfaceBody(hits[0]?.[1] as string, claim.iface) as string,
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
      const r = resolveBody(claim, sources);
      if (r === null) missing.push(`${claim.iface} (${claim.testFile})`);
      else if (r.ambiguous) {
        const where = sources
          .filter(([, s]) => interfaceBody(s, claim.iface) !== null)
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
      const r = resolveBody(claim, sources);
      if (r === null) continue;
      const real = memberNames(r.body).length;
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

  it('CRITICAL this guard names its own blind spot. Sixteen sibling arms state a field count for a Zod SCHEMA rather than an interface, and none of them is covered here. Recorded so the green above is not read as "every field count in the corpus is checked".', () => {
    const schemaClaims = all.filter(({ iface }) => /Schema$/.test(iface));
    expect(
      schemaClaims.length,
      'no Schema-shaped claims found — either they were converted to interfaces (delete this arm) ' +
        'or the title regex stopped matching them',
    ).toBeGreaterThanOrEqual(10);
  });
});
