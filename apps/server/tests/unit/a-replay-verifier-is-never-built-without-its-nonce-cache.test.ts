// V-2029 — every production FleetNodeAuthImpl is built WITH a nonce cache.
//
// `FleetNodeAuthImpl`'s second constructor parameter is optional, and
// `services/fleet-node-auth.ts` states the consequence itself: without it a
// captured fleet-node JWT "CAN be replayed" for its 5-minute lifetime, so
// "production deployments MUST inject the cache". The optionality is deliberate —
// signature/expiry unit tests construct the verifier with one argument and want no
// nonce-cache fixture — but the MUST lives only in prose. Omitting the argument is
// not a type error and reds nothing.
//
// `lib-bootstrap-content-parity.test.ts` pins the ONE production construction as a
// literal. That pin asserts that line still exists; it cannot see a SECOND
// construction added elsewhere, which is the shape this file covers: the rule is
// "no unguarded construction anywhere under src", not "this call site is intact".
//
// Scope: `apps/server/src` only. Test files legitimately construct the one-argument
// form, and the arm below would be wrong to forbid it.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SRC_ROOT = resolve(REPO_ROOT, 'apps/server/src');

const CTOR = 'new FleetNodeAuthImpl(';

/** Split a paren-balanced argument list at depth-0 commas, dropping the empty tail a
 *  trailing comma leaves behind. Counting raw commas is what made V-1679's argument
 *  counter wrong: prettier writes a trailing comma on every multi-line call, so a
 *  one-argument call spread over lines counts two. */
function argumentsOf(src: string, openParenIdx: number): string[] {
  let depth = 0;
  let i = openParenIdx;
  const parts: string[] = [];
  let current = '';
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) break;
    }
    if (depth === 1 && ch === ',') {
      parts.push(current);
      current = '';
      continue;
    }
    if (!(depth === 1 && i === openParenIdx)) current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Every `new FleetNodeAuthImpl(` under apps/server/src, as `<relpath>:<args>`.
 *  Walked rather than listed — a second production construction is the drift. */
function productionConstructions(): { where: string; args: string[] }[] {
  const out: { where: string; args: string[] }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      const src = readFileSync(p, 'utf8');
      let idx = src.indexOf(CTOR);
      while (idx !== -1) {
        out.push({
          where: relative(SRC_ROOT, p),
          args: argumentsOf(src, idx + CTOR.length - 1),
        });
        idx = src.indexOf(CTOR, idx + 1);
      }
    }
  };
  walk(SRC_ROOT);
  return out;
}

describe('a replay verifier is never built without its nonce cache', () => {
  it('CRITICAL the census found the production construction(s). The arm below iterates them, so an empty walk asserts nothing — and a rename of the class is exactly the refactor that would empty it while leaving a real construction behind.', () => {
    expect(
      productionConstructions().map((c) => c.where),
      'no `new FleetNodeAuthImpl(` found under apps/server/src',
    ).not.toHaveLength(0);
  });

  it('CRITICAL every production FleetNodeAuthImpl receives a nonce cache. The second parameter is optional, so omitting it compiles cleanly and silently disables replay defence — a captured fleet-node JWT then works repeatedly for its full 5-minute lifetime. The verifier source states this as a MUST; nothing enforced it.', () => {
    const unguarded = productionConstructions()
      .filter((c) => c.args.length < 2)
      .map((c) => `${c.where} (${c.args.length} arg${c.args.length === 1 ? '' : 's'})`)
      .sort();
    expect(unguarded, 'FleetNodeAuthImpl built without a nonce cache:').toEqual([]);
  });
});
