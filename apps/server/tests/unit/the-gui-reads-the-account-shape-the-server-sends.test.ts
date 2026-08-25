// The Settings tab crashed for every customer, and the tests were green.
//
// `SettingsAccountCard` declared the response of `GET /v1/account/me` as
// `{ account: { id, email, tier } }`. The route has never sent that — it returns
// the fields FLAT. So `body.account` was `undefined` and the first
// `state.account.id` in the render threw, taking the whole view down behind the
// error boundary.
//
// ⛔ It failed on the SUCCESS path. Every error path — 401, 403, network — was
// handled and looked healthy, so the failure appeared only when everything else
// worked.
//
// And it survived because the FIXTURES agreed with the component rather than
// with the server: the card's own test built `{ account: {...} }`, so the double
// described the bug and the suite confirmed it. A fixture is not a contract.
// This file is, and it reads BOTH SIDES from source so neither can drift alone.
//
// Deliberately lives in the server suite rather than the GUI one: the GUI cannot
// import server types, so a guard placed there could only ever re-state the
// client's assumption — which is exactly the failure being prevented.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/account-me.ts');
const CARD = resolve(REPO_ROOT, 'apps/gui-client/src/components/SettingsAccountCard.tsx');

/** The `GET /v1/account/me` handler body, up to its first `return {`. */
function accountMeReturnBlock(): string {
  const src = readFileSync(ROUTE, 'utf8');
  // The handler returns a flat object literal built from `accountId`/`tier`.
  const idx = src.indexOf('return {\n        id: `acc_${accountId}`,');
  expect(
    idx,
    'could not find the account-me return literal — this guard is reading the wrong shape',
  ).toBeGreaterThan(-1);
  return src.slice(idx, idx + 900);
}

describe('the GUI reads the account shape the server sends', () => {
  it('CRITICAL the server returns the account fields FLAT, not wrapped in an `account` key', () => {
    const block = accountMeReturnBlock();
    expect(block).toMatch(/id: `acc_\$\{accountId\}`/);
    expect(block).toMatch(/\bemail\b/);
    expect(block).toMatch(/\btier\b/);
    // The wrapper the GUI wrongly assumed. If the route ever DOES nest, this
    // arm fails and the client must be updated in the same change.
    expect(
      block,
      'the route now nests under an `account` key — every flat reader must be updated with it',
    ).not.toMatch(/^\s*account:\s*\{/m);
  });

  it('CRITICAL the Settings account card declares the FLAT shape. Declaring a nested one made body.account undefined and threw during render, on the success path, behind the error boundary.', () => {
    const card = readFileSync(CARD, 'utf8');
    const decl = /interface AccountMeResponse \{([\s\S]*?)\n\}/.exec(card);
    expect(decl, 'AccountMeResponse is gone from the card — this guard is stale').not.toBeNull();
    const body = decl?.[1] ?? '';

    expect(body).toMatch(/\bid:\s*string/);
    expect(body).toMatch(/\bemail:\s*string/);
    expect(body).toMatch(/\btier:\s*string/);
    expect(
      body,
      'the card nests its fields under `account` again — the route does not send that, so ' +
        'body.account is undefined and the render throws',
    ).not.toMatch(/account\s*:\s*\{/);
  });

  it('CRITICAL the card assigns the response body itself, not a `.account` member off it', () => {
    const card = readFileSync(CARD, 'utf8');
    expect(card).toMatch(/setState\(\{ kind: 'ready', account: body \}\)/);
    expect(
      card,
      'the card reads body.account, which is undefined on the real response',
    ).not.toMatch(/account: body\.account/);
  });

  it('the canonical reader agrees — SettingsContext has read the flat shape all along', () => {
    // Positive control. If this ever nests, the "flat is canonical" premise this
    // whole file rests on is wrong and the arms above are asserting the wrong thing.
    const ctx = readFileSync(
      resolve(REPO_ROOT, 'apps/gui-client/src/lib/SettingsContext.tsx'),
      'utf8',
    );
    expect(ctx).toMatch(/raw\.teams/);
    expect(ctx, 'SettingsContext started unwrapping a nested account').not.toMatch(
      /raw\.account\.tier|body\.account\.tier/,
    );
  });
});
