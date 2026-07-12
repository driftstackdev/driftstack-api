// W464.A — drift guard for apps/gui-client/src/lib/api-errors.ts.
// V-534.BV problem+json detail surfacing in GUI error states.
// Drift here either drops the JSON-parse try/catch (a non-JSON
// body throws to the caller as an unhandled rejection and the UI
// state breaks instead of showing 'HTTP 400') or breaks the
// .detail-before-.title precedence (server's problem+json
// `title` is a generic class name like 'Bad Request'; `detail` is
// the actionable per-call explanation — flipping the order means
// users see uninformative class names).
//
//   • V-534.BV framing pinned: 'shared helper for surfacing the
//     server's problem+json detail in GUI error states. The
//     Driftstack API returns RFC 7807 problem+json bodies on 4xx;
//     without this helper, hooks would surface only "HTTP 400"
//     which is unhelpful.'
//   • readApiErrorMessage: 'Best-effort parse a fetch Response's
//     body into a human-readable error message. Tries problem+json
//     (.detail then .title) first, falls back to "HTTP <status>"
//     if the body isn't JSON or doesn't carry either field.'
//   • .detail-before-.title precedence ordering + length>0 string
//     check on both fields.
//   • catch-block 'body wasn't JSON; fall through' framing pinned.
//   • Fallback: `HTTP ${res.status.toString()}`.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/api-errors.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W464.A apps/gui-client/src/lib/api-errors.ts content parity', () => {
  const body = read(LIB);

  it("V-534.BV framing pinned: 'V-534.BV — shared helper for surfacing the server's problem+json detail in GUI error states. The Driftstack API returns RFC 7807 problem+json bodies on 4xx; without this helper, hooks would surface only \"HTTP 400\" which is unhelpful.'", () => {
    expect(body).toMatch(
      /\/\/ V-534\.BV — shared helper for surfacing the server's problem\+json\s*\n?\s*\/\/ detail in GUI error states\. The Driftstack API returns RFC 7807\s*\n?\s*\/\/ problem\+json bodies on 4xx; without this helper, hooks would\s*\n?\s*\/\/ surface only "HTTP 400" which is unhelpful\./,
    );
  });

  it("readApiErrorMessage JSDoc pinned: 'Best-effort parse a fetch Response's body into a human-readable error message. Tries problem+json (.detail then .title) first, falls back to \"HTTP <status>\" if the body isn't JSON or doesn't carry either field.'", () => {
    expect(body).toMatch(
      /\*\s*Best-effort parse a fetch Response's body into a human-readable\s*\n?\s*\*\s*error message\. Tries problem\+json \(\.detail then \.title\) first,\s*\n?\s*\*\s*falls back to "HTTP <status>" if the body isn't JSON or doesn't\s*\n?\s*\*\s*carry either field\./,
    );
  });

  it('Function signature: async function readApiErrorMessage(res: Response): Promise<string> + body typed as {detail?: unknown; title?: unknown} (loose-typed for runtime narrowing)', () => {
    expect(body).toMatch(
      /export async function readApiErrorMessage\(res: Response\): Promise<string> \{\s*\n?\s*try \{\s*\n?\s*const body = \(await res\.json\(\)\) as \{ detail\?: unknown; title\?: unknown \};/,
    );
  });

  it('.detail-before-.title precedence with length>0 string check on BOTH fields (so empty strings fall through to HTTP-status fallback)', () => {
    expect(body).toMatch(
      /if \(typeof body\.detail === 'string' && body\.detail\.length > 0\) return body\.detail;\s*\n?\s*if \(typeof body\.title === 'string' && body\.title\.length > 0\) return body\.title;/,
    );
  });

  it("Catch-block fall-through framing pinned: 'body wasn't JSON; fall through' comment + bare catch (no err binding) + HTTP-status string fallback at function bottom", () => {
    expect(body).toMatch(
      /\} catch \{\s*\n?\s*\/\* body wasn't JSON; fall through \*\/\s*\n?\s*\}[\s\S]*?return `HTTP \$\{res\.status\.toString\(\)\}`;/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
