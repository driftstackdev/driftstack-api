// V-821 — every reason `LegalGate.required()` can return blocks API-key minting,
// because the only gate on it does not look at reasons.
//
// `services/legal.ts required()` returns one entry per document the account owes
// re-acceptance on, each tagged with a reason: `never_accepted`,
// `version_outdated`, or `content_hash_changed`. The last of those fires when the
// version string is UNCHANGED and only the bytes differ — a typo fix, a
// reformatted paragraph.
//
// `services/api-keys.ts create()` gates on `pending.length > 0` and throws
// `LegalAcceptanceRequiredError`. It does not filter by reason. There are exactly
// two callers of `required()`: that one, and `routes/legal.ts`, which lists the
// result for display. So a content-only edit to a legal document — no version
// bump, no substantive change — blocks API-key creation for EVERY account until
// each one re-accepts.
//
// The comment in legal.ts used to end "the route layer can decide whether to gate
// on it", which describes a discretion that no route exercises. Saying the route
// layer decides does not make any route decide.
//
// What this guard defends: the reason SET. Adding a fourth reason joins the
// blocking set automatically and silently, because the consumer treats the array
// as a boolean. If someone adds one, this fails and they have to look at
// api-keys.ts and decide on purpose. That is the whole point — the coupling is
// real, it is invisible at both ends, and it is one grep away from being missed.
//
// This does NOT assert that content_hash_changed should or should not block. That
// is a product decision about legal posture, flagged in the log and not taken
// here.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');

const LEGAL = readFileSync(resolve(SRC, 'services/legal.ts'), 'utf8');
const API_KEYS = readFileSync(resolve(SRC, 'services/api-keys.ts'), 'utf8');

/** The `required()` body, brace-matched so a reason elsewhere in the file is not counted. */
function requiredBody(): string {
  const start = LEGAL.indexOf('async required(');
  expect(start, 'required() found in services/legal.ts').toBeGreaterThan(-1);
  const open = LEGAL.indexOf('{', start);
  let depth = 0;
  for (let k = open; k < LEGAL.length; k += 1) {
    if (LEGAL[k] === '{') depth += 1;
    else if (LEGAL[k] === '}') {
      depth -= 1;
      if (depth === 0) return LEGAL.slice(open, k + 1);
    }
  }
  return '';
}

function reasonsEmitted(): string[] {
  const body = requiredBody().replace(/\/\/[^\n]*/g, ''); // strip comments: the retraction names them
  return [
    ...new Set([...body.matchAll(/reason:\s*'([a-z_]+)'/g)].map((m) => m[1] as string)),
  ].sort();
}

describe('V-821 a new legal reason silently blocks key minting', () => {
  it('CRITICAL the reason set is really parsed out of required(). The comparison below is an equality, so an empty parse would fail loudly rather than pass — but the brace-match and the comment-strip are both load-bearing and worth asserting directly.', () => {
    expect(requiredBody().length, 'required() body brace-matched').toBeGreaterThan(200);
    expect(reasonsEmitted().length, 'distinct reasons emitted').toBeGreaterThan(2);
  });

  it('CRITICAL the reasons required() can return are exactly the three that exist today. A fourth joins the API-key-minting blocklist the moment it is added, with nothing to notice: api-keys.ts treats the array as a boolean. If you added one, go and decide in api-keys.ts whether it should stop a customer minting a key, then update this list.', () => {
    expect(reasonsEmitted()).toEqual([
      'content_hash_changed',
      'never_accepted',
      'version_outdated',
    ]);
  });

  it('CRITICAL the api-keys gate still does not discriminate by reason, which is what makes the arm above load-bearing. If a filter is ever added, this fails and the reason-set arm stops being a blocking-set arm — at which point both need rewriting rather than quietly meaning something weaker.', () => {
    const start = API_KEYS.indexOf('this.legalGate.required(');
    expect(start, 'the legal gate call in api-keys.ts').toBeGreaterThan(-1);
    const window = API_KEYS.slice(start, start + 600);

    expect(window, 'the gate is a length check over every reason').toMatch(/pending\.length > 0/);
    expect(
      window,
      'a reason filter appeared — the blast radius changed, so revisit both this guard and the comment in legal.ts',
    ).not.toMatch(/reason\s*[=!]==|\.filter\(|reason ===/);
  });
});
