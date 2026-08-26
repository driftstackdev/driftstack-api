import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');

function read(relativePath: string): string {
  return readFileSync(resolve(REPO, relativePath), 'utf8');
}

describe('residual protected-route API-key scope contract', () => {
  it('pins the team directory and membership-mutation route floors', () => {
    const route = read('apps/server/src/routes/team.ts');
    // 4 since `GET /v1/teams` — the team DIRECTORY read, beside the three
    // membership reads.
    expect(route.match(/app\.requireScope\('read'\)/g)).toHaveLength(4);
    expect(route).toMatch(
      /'\/v1\/team\/invites\/accept',[\s\S]*?app\.requireScope\('account_owner'\)/,
    );
  });

  it('pins billing quote and active/disabled proxy scope symmetry', () => {
    const billing = read('apps/server/src/routes/billing-crypto-quote.ts');
    expect(billing).toContain("app.requireScope('read:billing')");

    const proxy = read('apps/server/src/routes/session-proxy.ts');
    expect(proxy.match(/app\.requireScope\('write:sessions'\)/g)).toHaveLength(2);
    expect(proxy.match(/app\.requireScope\('read:sessions'\)/g)).toHaveLength(2);
  });

  it('keeps public scope guidance aligned with the enforced routes', () => {
    const scopes = read('apps/docs/src/pages/reference/scopes.md');
    expect(scopes).toContain('`POST /v1/billing/crypto-checkout/quote`');

    const team = read('apps/docs/src/pages/api/team.md');
    expect(team).toContain(
      'Team directory reads (`GET /v1/team/invites`, `/members`, and\n`/owners`) require broad `read` or `account_owner`.',
    );
    expect(team).toContain('Requires `account_owner`; a dashboard web session satisfies this.');
  });

  it('keeps handwritten SDK scope comments coherent', () => {
    const tsTeam = read('packages/sdk-typescript/src/resources/team.ts');
    // 4 since `listTeams` — the team directory read, beside the three membership
    // directory reads.
    expect(tsTeam.match(/Requires broad read or account_owner\./g)).toHaveLength(4);
    expect(tsTeam).toContain('Requires account_owner (dashboard web sessions satisfy it).');
    expect(read('packages/sdk-typescript/src/resources/crypto-orders.ts')).toContain(
      'Requires read:billing (broad read/account_owner also satisfy it).',
    );

    const pythonTeam = read('packages/sdk-python/src/driftstack/resources/team.py');
    // The Python resource carries a sync AND an async class, so every comment is
    // doubled: 4 directory reads x 2 = 8, and 2 owner-gated mutations x 2 = 4.
    expect(pythonTeam.match(/Requires broad read or account_owner\./g)).toHaveLength(8);
    expect(pythonTeam.match(/Requires account_owner\./g)).toHaveLength(4);
    expect(read('packages/sdk-python/src/driftstack/resources/crypto_orders.py')).toContain(
      'Requires read:billing; broad read/account_owner also satisfy it.',
    );

    const goTeam = read('packages/sdk-go/team.go');
    expect(goTeam.match(/Requires broad read or account_owner\./g)).toHaveLength(3);
    expect(goTeam).toContain('// Requires account_owner.');
    const goCrypto = read('packages/sdk-go/crypto_orders.go');
    expect(goCrypto).toContain('// Quote previews the authoritative fiat price without minting an');
    // The scope sentence is the load-bearing claim. `9c53dd232` deliberately
    // stripped internal rollout markers from the shipped Go SDK, so pinning
    // the old "(V-666.H)" text here made this guard require copy the product
    // had intentionally removed.
    expect(goCrypto).toContain('// order. Requires read:billing; broad read or');
    expect(goCrypto).toContain('// account_owner also satisfies it.');
    expect(goCrypto).not.toMatch(/V-666/);
  });

  it('keeps the generated OpenAPI snapshot scope summaries in sync', () => {
    const source = read('apps/server/src/lib/openapi.ts');
    const snapshot = read('packages/sdk-python/openapi.json');
    // Disclosures are now stated in the exact form the satisfaction rules imply
    // (`scopesSatisfy` in lib/errors-helpers.ts): a granular scope is also
    // satisfied by its broad verb and by `account_owner`, and a bare verb by
    // `account_owner`. The loose prose these previously pinned ("requires broad
    // read") understated what actually works, which is its own kind of wrong
    // answer for a customer minting a least-privilege key.
    for (const summary of [
      'List pending invites for the calling owner (requires broad `read` or `account_owner`)',
      'Accept a pending team invite (requires `account_owner`)',
      'List confirmed team members for the calling owner (requires broad `read` or `account_owner`)',
      'List owner accounts the caller is a member of (requires broad `read` or `account_owner`)',
      'Preview a crypto-checkout price (requires `read:billing`, broad `read`, or `account_owner`)',
    ]) {
      expect(source).toContain(summary);
      expect(snapshot).toContain(summary);
    }
  });
});
