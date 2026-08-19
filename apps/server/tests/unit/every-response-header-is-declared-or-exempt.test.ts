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
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** Header names the server writes via `reply.header('name', …)`. */
function sentHeaders(): Set<string> {
  const out = new Set<string>();
  for (const f of sourceFiles(SRC)) {
    // Skip openapi.ts: its `'Header': {` entries are DECLARATIONS, not sends.
    if (f.endsWith('lib/openapi.ts')) continue;
    for (const m of readFileSync(f, 'utf8').matchAll(/\.header\(\s*'([A-Za-z0-9-]+)'/g)) {
      out.add((m[1] ?? '').toLowerCase());
    }
  }
  return out;
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
    expect(sentHeaders().size, 'distinct headers the server sends').toBeGreaterThan(12);
    expect(declaredHeaders().size, 'distinct headers the document declares').toBeGreaterThan(10);
  });

  it('CRITICAL every header the server sends is declared, or exempt with a stated reason. A sent-but-undeclared header is invisible to a generated client: that is how the request id support asks customers to quote went unpublished, and how an attachment filename stayed inside another header’s prose.', () => {
    const declared = declaredHeaders();
    const undeclared = [...sentHeaders()]
      .filter((h) => !declared.has(h))
      .filter((h) => EXEMPT[h] === undefined)
      .sort();
    expect(
      undeclared,
      'these headers are sent but neither declared nor exempt — declare them, or add an exemption with a reason:',
    ).toEqual([]);
  });

  it('CRITICAL every exemption is still a header the server actually sends. An exemption for something no longer sent is dead weight that makes the list look considered while hiding nothing — and it would silently absorb a future header of the same name.', () => {
    const sent = sentHeaders();
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
