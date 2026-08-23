// V-944 — every response header the server sends is either declared in the
// published document or on an exemption list with a reason.
//
// Three entries closed three instances of the same defect by hand: V-941 found
// `Content-Disposition` sent by four routes and declared for one; V-942 found
// `X-Request-Id` sent on every response, promised to customers on five doc pages,
// and declared nowhere — plus the `X-RateLimit-*` aliases acknowledged only inside
// another header's prose. Each was found by looking. This closes the class so the
// next one fails a test instead.
//
// The rule is deliberately two-sided. A header the server sends and the document
// omits is invisible to a generated client — the defect above. A header the
// document declares and the server never sends is the same untruth pointed the
// other way, and `openapi.ts` already refuses it in prose: the daily-IP-ceiling
// headers are kept OUT of the shared error set because "declaring it on every
// route would advertise a limit the other 200-odd paths do not enforce, which is
// the same class of untruth as leaving a real header undeclared."
//
// EXEMPTIONS carry their reason here rather than being silently skipped, because a
// list of names with no justification is how a real gap hides among deliberate
// ones.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SPEC = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');
const SRC = resolve(REPO_ROOT, 'apps/server/src');

/**
 * Headers the server sends that the document deliberately does NOT declare.
 * Each entry is a reason, not a name.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  'content-type':
    'Not a declarable response header in OpenAPI — it IS the content map, and every response already names its media type there.',
  'cache-control':
    'V-942 decision: set at nine sites with values that differ by endpoint (no-store on billing reads, public max-age on status). It describes cache semantics rather than a value a client reads and acts on, so declaring it per-endpoint would mean nine descriptions for no behavioural gain.',
  // V-1372 — this header was invisible to the scan below until the constant
  // resolution landed, so it has never been on either side of this rule.
  'x-driftstack-unknown-fields':
    'Sent on 40 customer-facing writes and no error path, so declaring it means editing ~40 of the 232 hand-written 2xx blocks in openapi.ts and keeping that subset in sync by hand — the same cost the X-Request-Id decision above declined for success responses, with no shared 2xx construct to hang it on. It is not invisible to customers, which is what this rule is actually about: apps/docs/src/pages/api/versioning.md gives it a worked example and tells integrators to log it, and V-1371 put it on Access-Control-Expose-Headers so a browser can read it. BOTH of those are asserted below, so this exemption fails if the visibility it rests on goes away.',
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/**
 * Header names the server writes via `reply.header(…)` — both the literal form and
 * the constant one.
 *
 * V-1372 — this used to match `.header('name'` only. Exactly one header in the server
 * is sent through a constant, `reply.header(UNKNOWN_FIELDS_HEADER, …)`, and it was
 * therefore absent from BOTH sides of the rule below: never reported as undeclared,
 * never reportable as exempt. It is also the header apps/docs tells integrators to log,
 * so the one the scan could not see was the one with a documented customer workflow.
 * A name-shaped blind spot in a guard is worth more than the header it hid.
 */
function sentHeaders(): { names: Set<string>; viaConstant: Set<string> } {
  const names = new Set<string>();
  const viaConstant = new Set<string>();
  const constants = new Map<string, string>();
  const files = sourceFiles(SRC).filter((f) => !f.endsWith('lib/openapi.ts'));

  // Resolve `const SOME_HEADER = 'x-name'` first: a send may precede its declaration
  // in file order, and the constant is routinely exported from another module.
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(
      /\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*'([A-Za-z0-9-]+)'/g,
    )) {
      constants.set(m[1] ?? '', (m[2] ?? '').toLowerCase());
    }
  }

  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\.header\(\s*'([A-Za-z0-9-]+)'/g)) {
      names.add((m[1] ?? '').toLowerCase());
    }
    for (const m of src.matchAll(/\.header\(\s*([A-Z][A-Z0-9_]*)\s*,/g)) {
      const resolved = constants.get(m[1] ?? '');
      if (resolved === undefined) continue;
      names.add(resolved);
      viaConstant.add(resolved);
    }
  }
  return { names, viaConstant };
}

interface SpecShape {
  paths: Record<
    string,
    Record<string, { responses?: Record<string, { headers?: Record<string, unknown> }> }>
  >;
}

/** Header names the document declares anywhere, lowercased. */
function declaredHeaders(): Set<string> {
  const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as SpecShape;
  const out = new Set<string>();
  for (const ops of Object.values(spec.paths)) {
    for (const op of Object.values(ops)) {
      for (const r of Object.values(op.responses ?? {})) {
        for (const h of Object.keys(r.headers ?? {})) out.add(h.toLowerCase());
      }
    }
  }
  return out;
}

describe('V-944 every response header is declared or exempt', () => {
  it('CRITICAL both sides were really read. The arm below reports an ABSENCE, so an empty send-set or an empty declared-set would satisfy it having compared nothing — the shape this arc kept finding in guards that check for a missing thing.', () => {
    expect(sentHeaders().names.size, 'distinct headers the server sends').toBeGreaterThan(12);
    expect(declaredHeaders().size, 'distinct headers the document declares').toBeGreaterThan(10);
  });

  it('CRITICAL every header the server sends is declared, or exempt with a stated reason. A sent-but-undeclared header is invisible to a generated client: that is how the request id support asks customers to quote went unpublished, and how an attachment filename stayed inside another header’s prose.', () => {
    const declared = declaredHeaders();
    const undeclared = [...sentHeaders().names]
      .filter((h) => !declared.has(h))
      .filter((h) => EXEMPT[h] === undefined)
      .sort();
    expect(
      undeclared,
      'these headers are sent but neither declared nor exempt — declare them, or add an exemption with a reason:',
    ).toEqual([]);
  });

  it('CRITICAL the scan resolves a header sent through a CONSTANT, not just a quoted literal. Exactly one header in the server is written that way and it sat outside this rule entirely — neither flagged as undeclared nor listable as exempt. A guard whose population is defined by how a name is spelled has a blind spot shaped like a coding style.', () => {
    const { names, viaConstant } = sentHeaders();
    expect(
      viaConstant.size,
      'no header resolved through a constant — the resolution stopped working, and the rule below silently shrank',
    ).toBeGreaterThan(0);
    expect(
      names.has('x-driftstack-unknown-fields'),
      'the header the docs tell integrators to log is in the sent set',
    ).toBe(true);
  });

  it('CRITICAL the unknown-fields exemption rests on a visibility that is CHECKED, not asserted. It is waived from the spec because customers reach it two other ways; if either goes away it is simply an undeclared header again, and the exemption prose would still read as considered.', () => {
    const versioning = readFileSync(
      resolve(REPO_ROOT, 'apps/docs/src/pages/api/versioning.md'),
      'utf8',
    );
    expect(
      versioning,
      'the docs page no longer tells integrators to log the header, so the exemption lost its premise',
    ).toMatch(/Log `x-driftstack-unknown-fields`/);
    expect(
      versioning,
      'the docs page no longer shows the header in a response, so a reader has nothing to match on',
    ).toMatch(/x-driftstack-unknown-fields:/);

    const app = readFileSync(resolve(SRC, 'lib/app.ts'), 'utf8');
    const exposed = /exposedHeaders: \[([^\]]*)\]/.exec(app)?.[1] ?? '';
    expect(
      exposed,
      'V-1371 exposed this header so a browser can read it; without that the docs instruct something no cross-origin caller can do',
    ).toContain("'x-driftstack-unknown-fields'");
  });

  it('CRITICAL every exemption is still a header the server actually sends. An exemption for something no longer sent is dead weight that makes the list look considered while hiding nothing — and it would silently absorb a future header of the same name.', () => {
    const sent = sentHeaders().names;
    const stale = Object.keys(EXEMPT).filter((h) => !sent.has(h));
    expect(stale, 'these exemptions name headers nothing sends any more:').toEqual([]);
  });

  it('CRITICAL the headers this arc published are still declared. Named individually rather than counted, because a count would stay green if one were swapped for another.', () => {
    const declared = declaredHeaders();
    for (const h of [
      'x-request-id',
      'content-disposition',
      'x-ratelimit-limit',
      'x-ratelimit-remaining',
      'x-ratelimit-reset',
      'ratelimit-limit',
      'www-authenticate',
      'retry-after',
      'location',
      'idempotent-replayed',
    ]) {
      expect(declared.has(h), `${h} is declared`).toBe(true);
    }
  });
});
