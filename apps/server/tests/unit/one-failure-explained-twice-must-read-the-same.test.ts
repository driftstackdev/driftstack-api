// A customer can learn why their proxy failed from two different places, and the
// two answers are written out separately.
//
//   apps/gui-client/src/lib/api-errors.ts   PROXY_REASON_COPY — what the desktop
//                                           client renders after a blocked LAUNCH.
//   apps/server/src/routes/account-me.ts    the `copy` map on
//                                           POST /proxies/:id/test — what the TEST
//                                           button returns.
//
// They are byte-identical today, and only a comment says they should be
// ("same four sentences as the client"). They cannot share a module: api-errors.ts
// enforces that server prose is never reflected into the installed client, so the
// client's copy is deliberately its own. That is the right boundary and it is
// exactly what makes them drift — improve the wording on one surface and the same
// proxy starts explaining itself two different ways depending on which button was
// pressed.
//
// Which is the confusion this whole thread set out to remove. A customer hit a
// provider that authenticated and then refused to route; every surface said "The
// proxy could not be verified. Check its details and try again." — one sentence
// for four different causes. The client was fixed, then the Test endpoint. Two
// independent copies of the same four sentences is how that comes back.
//
// So both maps are DERIVED from source and compared as maps, and their key sets
// are checked against the reason enum itself. The values ARE pinned here, unlike
// the docs guard next door — not because the wording is sacred, but because the
// property is that two surfaces agree, and that cannot be expressed without
// reading what both of them say. Changing a sentence is fine; changing it in one
// place is the failure.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

/** The object literal that follows `anchor`, brace-matched rather than regexed to
 *  its first `}` — a nested object or a `}` inside a string would truncate it. */
function literalAfter(source: string, anchor: string): string {
  const at = source.indexOf(anchor);
  if (at === -1) throw new Error(`anchor not found: ${anchor}`);
  const open = source.indexOf('{', at);
  if (open === -1) throw new Error(`no object literal after: ${anchor}`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced object literal after: ${anchor}`);
}

/** `key: 'value'` pairs, tolerating prettier wrapping the value onto its own line. */
function entries(literalBody: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of literalBody.matchAll(/(\w+):\s*'((?:[^'\\]|\\.)*)'/g)) {
    out[m[1] as string] = m[2] as string;
  }
  return out;
}

/** Members of a TS string-literal union or a `readonly [...] as const` array. */
function quotedMembers(declaration: string): string[] {
  return [...declaration.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string).sort();
}

const REASONS = quotedMembers(
  /export type ProxyProbeReason =[^;]+;/.exec(
    read('apps/server/src/services/proxy-connectivity-probe.ts'),
  )?.[0] ?? '',
);

describe('one failure explained twice must read the same', () => {
  it('CRITICAL the launch copy and the Test copy are the same sentences. Two independently-maintained copies of customer guidance, one shown after a blocked launch and one after a Test of the same proxy — a customer who presses both and gets two different explanations of one failure has been told the product is confused about its own diagnosis.', () => {
    const client = entries(
      literalAfter(
        read('apps/gui-client/src/lib/api-errors.ts'),
        'const PROXY_REASON_COPY: Record<KnownReason, string> =',
      ),
    );
    const server = entries(
      literalAfter(
        read('apps/server/src/routes/account-me.ts'),
        'const copy: Record<string, string> =',
      ),
    );

    expect(Object.keys(client).length, 'the client copy map parsed as empty').toBeGreaterThan(0);
    expect(Object.keys(server).length, 'the Test route copy map parsed as empty').toBeGreaterThan(
      0,
    );
    expect(
      server,
      'the Test endpoint and the desktop client no longer explain a proxy failure the same way',
    ).toEqual(client);
  });

  it('CRITICAL both surfaces cover every reason the probe can return. A reason with no sentence on one surface falls back to the generic "could not be verified" line — which is the exact collapse this thread removed, reintroduced for one value instead of all four, and therefore harder to notice.', () => {
    expect(REASONS.length, 'ProxyProbeReason parsed as empty — the regex, not the code').toBe(4);
    const client = entries(
      literalAfter(
        read('apps/gui-client/src/lib/api-errors.ts'),
        'const PROXY_REASON_COPY: Record<KnownReason, string> =',
      ),
    );
    const server = entries(
      literalAfter(
        read('apps/server/src/routes/account-me.ts'),
        'const copy: Record<string, string> =',
      ),
    );
    expect(Object.keys(client).sort(), 'the desktop client is missing a reason').toEqual(REASONS);
    expect(Object.keys(server).sort(), 'the Test endpoint is missing a reason').toEqual(REASONS);
  });

  it('CRITICAL the client accepts exactly the reasons the server emits. KNOWN_REASONS is the allowlist that keeps server prose off the customer’s screen, so it must not be widened — but a value missing from it is silently downgraded to the generic sentence, which reads as "we do not know" for a failure the server had already classified.', () => {
    const src = read('apps/gui-client/src/lib/api-errors.ts');
    const known = quotedMembers(/const KNOWN_REASONS = \[[^\]]+\]/.exec(src)?.[0] ?? '');
    expect(known.length, 'KNOWN_REASONS parsed as empty').toBeGreaterThan(0);
    expect(known, 'the client allowlist and the server reason enum have drifted apart').toEqual(
      REASONS,
    );
  });
});
