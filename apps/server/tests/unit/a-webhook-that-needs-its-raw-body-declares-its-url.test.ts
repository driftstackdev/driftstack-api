// V-2027 — a webhook route that opts into raw-body stashing must declare its own URL.
//
// `routes/_webhook-raw-body.ts` registers ONE global application/json content-type
// parser and stashes `req.rawBody` only for URLs listed in its `RAW_BODY_URLS` set.
// The set is a hand-maintained string list with no compile-time link to the paths the
// routes actually register, and the file's own header invites the drift: "Stripe +
// NowPayments + future".
//
// A third webhook that calls `registerWebhookRawBodyParser(app)` but forgets to add
// its URL gets `req.rawBody === undefined`. Today both consumers fail CLOSED on that
// (400 "Empty request body." before any verification), so the drift costs a broken
// webhook rather than a forged one — the arms below pin BOTH halves, because the
// fail-closed half is what keeps the coupling drift from becoming a signature bypass.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROUTES = resolve(REPO_ROOT, 'apps/server/src/routes');
const PARSER = resolve(ROUTES, '_webhook-raw-body.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

/** The URLs `_webhook-raw-body.ts` stashes a raw body for, read out of the source
 *  rather than imported: importing would prove the literal equals itself. */
function declaredUrls(): string[] {
  const src = read(PARSER);
  const block = /RAW_BODY_URLS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(src)?.[1] ?? '';
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '').sort();
}

/** Every route file that opts into raw-body stashing, mapped to the paths it registers.
 *  Walked, not listed — a fourth webhook is exactly the drift this file exists for. */
function optedInRoutes(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const name of readdirSync(ROUTES)) {
    if (!name.endsWith('.ts') || name === '_webhook-raw-body.ts') continue;
    const src = read(resolve(ROUTES, name));
    if (!/registerWebhookRawBodyParser\s*\(/.test(src)) continue;
    const paths = [...src.matchAll(/app\.post(?:<[^>]*>)?\(\s*'([^']+)'/g)].map((m) => m[1] ?? '');
    out.set(name, paths.sort());
  }
  return out;
}

describe('a webhook opting into raw-body stashing declares its own URL', () => {
  const optedIn = optedInRoutes();

  it('CRITICAL the census found the opted-in webhook routes. Both arms below iterate this map, so an empty one makes them vacuously true — and the whole point of walking rather than listing is to notice a route the list never learned about.', () => {
    expect(
      [...optedIn.keys()].sort(),
      'no route file calls registerWebhookRawBodyParser',
    ).toHaveLength(2);
  });

  it('CRITICAL every path registered by a raw-body-opted-in route appears in RAW_BODY_URLS. The set is plain strings with no compile-time tie to the routes; a path that drifts (renamed, prefixed, or a third webhook added) silently stops being stashed, and the parser cannot warn because it only ever sees URLs it already knows.', () => {
    const declared = declaredUrls();
    const missing = [...optedIn]
      .flatMap(([file, paths]) => paths.map((p) => `${file} -> ${p}`))
      .filter((entry) => !declared.includes(entry.split(' -> ')[1] ?? ''))
      .sort();
    expect(
      missing,
      'route path(s) opted into raw-body stashing but absent from RAW_BODY_URLS:',
    ).toEqual([]);
  });

  it('CRITICAL every raw-body consumer refuses an absent or empty rawBody BEFORE verifying a signature. This is what makes the coupling above fail closed: a path missing from RAW_BODY_URLS yields `undefined`, and a consumer that fell through to verification would be checking a signature over a body it never received.', () => {
    const unguarded = [...optedIn.keys()]
      .filter((name) => {
        const src = read(resolve(ROUTES, name));
        if (!/req\.rawBody|request\.rawBody/.test(src)) return false;
        return !/typeof rawBody !== 'string' \|\| rawBody\.length === 0/.test(src);
      })
      .sort();
    expect(unguarded, 'raw-body consumer(s) not refusing an absent/empty body:').toEqual([]);
  });
});
