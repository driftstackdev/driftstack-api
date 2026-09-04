// W257.C — drift-guard for docs.driftstack.io/sdk/installation.
// Previous revision was missing the profileSnapshots / billing /
// cryptoOrders / emailPreferences resources from the TS resource
// list. Pin every top-level accessor + a representative method to
// the live SDK source.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/installation.md');
const CLIENT = resolve(REPO_ROOT, 'packages/sdk-typescript/src/client.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const ACCESSORS = [
  'sessions',
  'profiles',
  'profileSnapshots',
  'apiKeys',
  'webhooks',
  'auth',
  'auditLog',
  'legal',
  'mfa',
  'team',
  'emailPreferences',
  'billing',
  'cryptoOrders',
  'usage',
  'account',
];

describe('W257.C docs/sdk/installation ↔ TS SDK client parity', () => {
  const doc = read(DOC);
  const client = read(CLIENT);

  it('every live top-level resource accessor is documented', () => {
    for (const name of ACCESSORS) {
      // Live: `this.<name> = new …Resource(this.http);`
      expect(client).toMatch(new RegExp(`this\\.${name}\\s*=\\s*new\\s+\\w+Resource\\(`));
      // Doc: `client.<name>.<method>` somewhere in the TS block.
      expect(doc).toMatch(new RegExp(`client\\.${name}\\.`));
    }
  });

  it('billing methods cited in the doc exist on the live BillingResource', () => {
    const billing = read(resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/billing.ts'));
    for (const m of ['getState', 'createCheckoutSession', 'createPortalSession']) {
      expect(doc).toContain(`client.billing.${m}`);
      expect(billing).toMatch(new RegExp(`\\b${m}\\s*\\(`));
    }
  });

  it('cryptoOrders methods cited in the doc exist on the live CryptoOrdersResource', () => {
    const crypto = read(
      resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/crypto-orders.ts'),
    );
    for (const m of ['quote', 'createCheckout', 'list', 'get', 'cancel', 'receipt']) {
      expect(doc).toContain(`client.cryptoOrders.${m}`);
      expect(crypto).toMatch(new RegExp(`\\b${m}\\s*\\(`));
    }
  });

  it('profileSnapshots methods cited in the doc exist on the live resource', () => {
    const snap = read(
      resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/profile-snapshots.ts'),
    );
    for (const m of ['capture', 'listForProfile', 'list', 'iterate', 'get', 'restore', 'delete']) {
      expect(doc).toContain(`client.profileSnapshots.${m}`);
      expect(snap).toMatch(new RegExp(`\\b${m}\\s*\\(`));
    }
  });

  it('Node.js minimum is >=18 (matches package.json engines)', () => {
    expect(doc).toMatch(/Node\.js\s*≥\s*18/);
  });

  it('cites the typed Driftstack class import', () => {
    expect(doc).toMatch(/import\s*\{\s*Driftstack\s*\}\s*from\s*'@driftstack\/sdk'/);
  });
});
