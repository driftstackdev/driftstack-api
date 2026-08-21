// V-1072 — the fields a route publishes on success are fields it actually sends.
//
// V-1063 closed the request direction: a published bound must be the bound the route
// enforces. The response direction had per-route guards for three endpoints and
// nothing general, and two routes were publishing a shape their handler has never
// returned:
//
//   POST /v1/admin/sessions/:id/destroy    published { ok: true }
//                                          returns   { id, status, destroyed_at }
//   POST /v1/admin/api-keys/:id/revoke     published { ok: true }
//                                          returns   { id, revoked_at }
//
// A caller typed from that document reads `.ok`, gets undefined, and cannot reach the
// id or the timestamp at all — the fields are outside the generated type. The
// integration suite asserts the real shape in six arms, so the server was never in
// doubt; only the published contract was.
//
// ── The instrument took four attempts, and the failures are the interesting part ──
//
// Comparing a handler's returned literal against the published properties sounds
// simple and is mostly a lesson in what a text scan cannot see:
//
//   1. Shorthand properties. `{ country, region }` sets `country`, but a `key:`
//      regex reports it missing. `GET /v1/egress/echo` looked broken for this reason
//      alone.
//   2. The first `return {` is not the response. Handlers return early from inner
//      callbacks; `GET /v1/account/rate-limits` returns an override branch first and
//      `{ tier, buckets }` last.
//   3. Registration-to-next-registration is not the handler. That span swallows any
//      module-level helper declared between two routes — the segment for
//      `PUT /v1/account/me/organization` is 7.5k characters and contains a proxy
//      mapper whose return the scan then read as the route's.
//
// So the scan bounds each route at its own registration call by matching parentheses,
// and unions the keys of EVERY return in it, counting shorthand. Three of the four
// candidates the earlier versions produced dissolved on inspection; both survivors
// were real.
//
// A handler whose response is assembled by a helper or a spread cannot be judged this
// way, and those are skipped rather than guessed at — an arm below reports how many,
// so the skip stays visible.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROUTES = resolve(REPO_ROOT, 'apps/server/src/routes');
const SPEC = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');

interface SpecDoc {
  readonly paths?: Record<string, Record<string, unknown>>;
  readonly components?: { schemas?: Record<string, Record<string, unknown>> };
}

/** The keyset envelope reference/pagination.md tells customers to drive. */
const ENVELOPE = ['has_more', 'next_cursor'] as const;

const spec = (): SpecDoc => JSON.parse(readFileSync(SPEC, 'utf8')) as SpecDoc;

function deref(doc: SpecDoc, s: Record<string, unknown> | undefined): Record<string, unknown> {
  const ref = s?.['$ref'];
  if (typeof ref !== 'string') return s ?? {};
  return doc.components?.schemas?.[ref.split('/').pop() ?? ''] ?? {};
}

/** Text of a call's arguments, paren-matched from its opening bracket. */
function callBody(src: string, openParen: number): string | null {
  let depth = 0;
  for (let j = openParen; j < src.length; j += 1) {
    if (src[j] === '(') depth += 1;
    else if (src[j] === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(openParen + 1, j);
    }
  }
  return null;
}

/**
 * Strip `//` and block comments so a commented key is still seen.
 *
 * Without this, any property preceded by an explanatory comment is invisible: the
 * segment after the previous comma starts with `//`, the key matcher anchors at the
 * start, and the real key two lines down is dropped. Measured — `GET /v1/account/me`
 * annotates seven of its fields and every one of them read as unset.
 */
// V-1256 — comment stripping is the SHARED scanner. The private `/\*[\s\S]*?\*\//`
// pass that used to live here runs BEFORE line comments and cannot tell that the `/*`
// in `// … /v1/agent-sessions/* routes` is inside one, so it opens a comment there and
// closes it at the next `*/` far below. Measured on that file: all 61 imports vanished,
// and on `lib/internal-fleet-auth.ts` all 3. Eighteen files under `apps/server/src`
// carry that shape, nearly all route paths with a wildcard. `code-only.ts` models line
// comments, string literals and regex literals, and keeps line numbers (V-1254).
function stripComments(block: string): string {
  return codeOnly(block);
}

/** Keys of an object literal, counting shorthand; reports whether it spreads. */
function literalKeys(raw: string): { keys: Set<string>; spread: boolean } {
  const block = stripComments(raw);
  const keys = new Set<string>();
  let spread = false;
  let depth = 0;
  let buf = '';
  const take = (raw: string): void => {
    const seg = raw.trim();
    if (seg.startsWith('...')) {
      spread = true;
      return;
    }
    const m = /^([A-Za-z_][\w]*)\s*(:|$)/.exec(seg);
    if (m !== null) keys.add(m[1]!);
  };
  for (const ch of block) {
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
    if (depth === 0 && ch === ',') {
      take(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  take(buf);
  return { keys, spread };
}

/** Every brace-matched `return { … }` block inside a handler. */
function returnBlocks(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/return\s*\{/g)) {
    const i = m.index + m[0].length - 1;
    let depth = 0;
    for (let j = i; j < body.length; j += 1) {
      if (body[j] === '{') depth += 1;
      else if (body[j] === '}') {
        depth -= 1;
        if (depth === 0) {
          out.push(body.slice(i + 1, j));
          break;
        }
      }
    }
  }
  return out;
}

interface Judged {
  readonly key: string;
  readonly missing: string[];
  /** Envelope keys the handler sends that the document never mentions. */
  readonly unpublished: string[];
}

/** Routes whose returns are all plain literals, judged against the published 200/201. */
function judge(): { compared: Judged[]; skipped: number } {
  const doc = spec();
  const compared: Judged[] = [];
  let skipped = 0;
  const REG = /app\.(get|post|put|patch|delete)\s*(?:<[^(]*>)?\s*\(/g;
  for (const file of readdirSync(ROUTES).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(join(ROUTES, file), 'utf8');
    const fns = [...src.matchAll(/^export function (\w+)/gm)].map((m) => [m.index, m[1]!] as const);
    for (const m of src.matchAll(REG)) {
      let owner = '(top)';
      for (const [at, name] of fns) {
        if (at <= m.index) owner = name;
        else break;
      }
      if (/Disabled/.test(owner)) continue;
      const body = callBody(src, m.index + m[0].length - 1);
      if (body === null) continue;
      const pm = /^\s*['"`](\/v1\/[^'"`]*)['"`]/.exec(body);
      if (pm === null) continue;
      const blocks = returnBlocks(body);
      if (blocks.length === 0) continue;

      const keys = new Set<string>();
      let spread = false;
      for (const b of blocks) {
        const r = literalKeys(b);
        for (const k of r.keys) keys.add(k);
        spread = spread || r.spread;
      }
      if (spread || keys.size < 2) {
        skipped += 1;
        continue;
      }

      const path = (pm[1] ?? '').replace(/:(\w+)/g, '{$1}');
      const op = doc.paths?.[path]?.[(m[1] ?? '').toLowerCase()] as
        | {
            responses?: Record<
              string,
              { content?: Record<string, { schema?: Record<string, unknown> }> }
            >;
          }
        | undefined;
      const ok = op?.responses?.['200'] ?? op?.responses?.['201'];
      const schema = deref(doc, ok?.content?.['application/json']?.schema);
      const props = Object.keys(schema['properties'] ?? {});
      const required = new Set((schema['required'] ?? []) as string[]);
      if (props.length === 0) continue;

      compared.push({
        key: `${(m[1] ?? '').toUpperCase()} ${pm[1] ?? ''}`,
        missing: props.filter((p) => required.has(p) && !keys.has(p)).sort(),
        // Only the pagination envelope is judged in this direction. A handler may
        // legitimately send more than it documents in general — an internal debug
        // field, a value the spec models inside a $ref this scan does not expand —
        // but the envelope is a published contract customers loop on, and a cursor
        // the document omits is one a typed client cannot reach.
        unpublished: ENVELOPE.filter((k) => keys.has(k) && !props.includes(k)).sort(),
      });
    }
  }
  return { compared, skipped };
}

describe('V-1072 a published response is the one returned', () => {
  it("CRITICAL the comment stripper does not blank a route file whose header contains a wildcard path. `routes/agent-sessions.ts` opens with `// AI-D — /v1/agent-sessions/* routes`; a block-comment pass that runs first cannot tell that `/*` is inside a LINE comment, so it opens a comment there and closes it at the next `*/` far below. Measured: all 61 of that file's imports disappeared, and this guard walks every file in that directory — it was scanning an empty string and reporting nothing wrong. Eighteen files under apps/server/src carry the same shape.", () => {
    const raw = readFileSync(resolve(ROUTES, 'agent-sessions.ts'), 'utf8');
    const rawImports = (raw.match(/^import\s/gm) ?? []).length;
    expect(rawImports, 'the fixture file stopped having imports to lose').toBeGreaterThan(20);

    const stripped = stripComments(raw);
    expect(
      (stripped.match(/^import\s/gm) ?? []).length,
      'the stripper swallowed the file body — this guard is scanning nothing',
    ).toBe(rawImports);
  });

  it('CRITICAL the scan compares a real population and the literal reader handles both property forms. A key extractor blind to shorthand reports every `{ country, region }` handler as broken, which is how the first version of this scan produced three findings that were all itself.', () => {
    const { compared, skipped } = judge();
    expect(compared.length, 'routes judged against a published response').toBeGreaterThanOrEqual(
      45,
    );
    // The skip count is asserted rather than hidden: helper- or spread-built
    // responses cannot be judged by reading a literal, and pretending otherwise
    // is how a scan reports confidence it has not earned.
    expect(skipped, 'handlers skipped as helper- or spread-built').toBeGreaterThan(0);

    expect(literalKeys('country, region: r').keys.has('country')).toBe(true);
    expect(literalKeys('...base, id: 1').spread).toBe(true);
  });

  it('CRITICAL no route publishes a required success field its handler never sets. A caller typed from the document reads that field, gets undefined, and cannot reach what the server actually sent — the real fields are outside the generated type entirely. Both routes V-1072 found published `{ ok: true }` against handlers returning an id and a timestamp.', () => {
    const broken = judge()
      .compared.filter((c) => c.missing.length > 0)
      .map((c) => `${c.key}: publishes ${c.missing.join(', ')}, never set`)
      .sort();
    expect(
      broken,
      'these routes publish a required response field no return statement sets — correct the ' +
        'schema in lib/openapi.ts to the shape the handler sends:',
    ).toEqual([]);
  });

  it('CRITICAL no route sends a pagination envelope key the document omits. This is the opposite of the arm above and it hides rather than misleads: the server pages correctly, the contract says the list is all there is, and a caller typed from it cannot reach the cursor. GET /v1/agent-sessions returned has_more and next_cursor while publishing data alone, with the pagination reference naming it among the endpoints that carry has_more.', () => {
    const hidden = judge()
      .compared.filter((c) => c.unpublished.length > 0)
      .map((c) => `${c.key}: sends ${c.unpublished.join(', ')}, publishes neither`)
      .sort();
    expect(
      hidden,
      'these routes send envelope keys the document does not declare — publish the paginated ' +
        'schema so a generated client can page:',
    ).toEqual([]);
  });
});
