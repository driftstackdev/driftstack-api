// W465.B — drift guard for apps/gui-client/src/lib/use-account-cost.ts.
// V-534.H useAccountCost hook. Drift here either drops the
// encodeURIComponent on billingCycle (a malformed YYYY-MM with
// special chars makes the URL malformed and the server returns
// 400, breaking the cost panel) or breaks the V-541.D → V-541.E
// SDK-migration framing (hook gets called direct-via-fetch
// indefinitely while the SDK adds its own client.account.cost
// surface).
//
//   • V-534.H framing pinned + 'Fetches the customer-facing GET
//     /v1/account/cost route landed in V-541.D. The SDK doesn't
//     yet expose `client.account.cost()` (V-541.E follow-up);
//     until it does, this hook calls the endpoint directly using
//     the baseUrl + apiKey already in SettingsContext.'
//   • State machine framing 'idle → loading → (ready | error).
//     Caller can re-fetch via refetch().'
//   • CostBreakdownInput import: type-only from './cost-panel'.
//   • AccountCostResponse 4-field (account_id + billing_cycle +
//     tier + breakdown CostBreakdownInput).
//   • UseAccountCostOpts: billingCycle? 'YYYY-MM. Omit to fetch
//     the current month.' + manual?
//   • Query string: opts.billingCycle ?
//     `?billing_cycle=${encodeURIComponent(opts.billingCycle)}`
//     : '' empty fallback.
//   • Same state-machine + fetcher + useEffect pattern as
//     V-534.Q.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/use-account-cost.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W465.B apps/gui-client/src/lib/use-account-cost.ts content parity', () => {
  const body = read(LIB);

  it("V-534.H framing pinned: 'V-534.H — useAccountCost hook.' + 'Fetches the customer-facing GET /v1/account/cost route landed in V-541.D. The SDK doesn't yet expose `client.account.cost()` (V-541.E follow-up); until it does, this hook calls the endpoint directly using the baseUrl + apiKey already in SettingsContext.'", () => {
    expect(body).toMatch(/\/\/ V-534\.H — useAccountCost hook\./);
    expect(body).toMatch(
      /\/\/ Fetches the customer-facing GET \/v1\/account\/cost route landed in\s*\n?\s*\/\/ V-541\.D\. The SDK doesn't yet expose `client\.account\.cost\(\)`\s*\n?\s*\/\/ \(V-541\.E follow-up\); until it does, this hook calls the endpoint\s*\n?\s*\/\/ directly using the baseUrl \+ apiKey already in SettingsContext\./,
    );
  });

  it("State-machine framing pinned: 'State machine: idle → loading → (ready | error). Caller can re-fetch via refetch().'", () => {
    expect(body).toMatch(
      /\/\/ State machine: idle → loading → \(ready \| error\)\. Caller can\s*\n?\s*\/\/ re-fetch via refetch\(\)\./,
    );
  });

  it("Imports + type-only import of CostBreakdownInput from './cost-panel'", () => {
    expect(body).toMatch(/import \{ useCallback, useEffect, useRef, useState \} from 'react';/);
    expect(body).toMatch(/import \{ readApiErrorMessage \} from '\.\/api-errors';/);
    expect(body).toMatch(/import \{ fetchWithDeadline \} from '\.\/fetch-with-deadline';/);
    expect(body).toMatch(/import \{ useSettings \} from '\.\/SettingsContext';/);
    expect(body).toMatch(/import type \{ CostBreakdownInput \} from '\.\/cost-panel';/);
  });

  it('AccountCostResponse 4-field (account_id + billing_cycle + tier + breakdown CostBreakdownInput); AccountCostState 4-variant union (idle | loading | ready{data} | error{message})', () => {
    expect(body).toMatch(
      /export interface AccountCostResponse \{\s*\n?\s*account_id: string;\s*\n?\s*billing_cycle: string;\s*\n?\s*tier: string;\s*\n?\s*breakdown: CostBreakdownInput;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export type AccountCostState =\s*\n?\s*\| \{ kind: 'idle' \}\s*\n?\s*\| \{ kind: 'loading' \}\s*\n?\s*\| \{ kind: 'ready'; data: AccountCostResponse \}\s*\n?\s*\| \{ kind: 'error'; message: string \};/,
    );
  });

  it("UseAccountCostOpts: billingCycle? 'YYYY-MM. Omit to fetch the current month.' + manual? 'Disable auto-fetch on mount. Default false.'", () => {
    expect(body).toMatch(
      /export interface UseAccountCostOpts \{\s*\n?\s*\/\*\* YYYY-MM\. Omit to fetch the current month\. \*\/\s*\n?\s*billingCycle\?: string;\s*\n?\s*\/\*\* Disable auto-fetch on mount\. Default false\. \*\/\s*\n?\s*manual\?: boolean;\s*\n?\s*\}/,
    );
  });

  it("Query string: opts.billingCycle ? `?billing_cycle=${encodeURIComponent(opts.billingCycle)}` : '' empty fallback (server treats absent billing_cycle as current month)", () => {
    expect(body).toMatch(
      /const qs = opts\.billingCycle \? `\?billing_cycle=\$\{encodeURIComponent\(opts\.billingCycle\)\}` : '';/,
    );
    expect(body).toMatch(
      /const res = await fetchWithDeadline\(`\$\{baseUrl\}\/v1\/account\/cost\$\{qs\}`, \{\s*\n?\s*method: 'GET',\s*\n?\s*signal: controller\.signal,\s*\n?\s*headers: \{\s*\n?\s*authorization: `Bearer \$\{settings\.apiKey\}`,\s*\n?\s*accept: 'application\/json',\s*\n?\s*\},\s*\n?\s*\}\);/,
    );
  });

  it('Same state-machine pattern as V-534.Q: no-apiKey error + manual?-aware initial state + !res.ok readApiErrorMessage + instance-of-Error catch + useEffect manual gate; useCallback deps [settings.apiKey, settings.baseUrl, opts.billingCycle]', () => {
    expect(body).toMatch(
      /if \(!settings\.apiKey\) \{\s*\n?\s*requestRef\.current = null;\s*\n?\s*setState\(\{ kind: 'error', message: 'No API key configured\.' \}\);\s*\n?\s*return;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /if \(sequence === sequenceRef\.current\) setState\(\{ kind: 'ready', data: body \}\);/,
    );
    expect(body).toMatch(/requestRef\.current\?\.abort\(\);/);
    expect(body).toMatch(/\}, \[settings\.apiKey, settings\.baseUrl, opts\.billingCycle\]\);/);
    expect(body).toMatch(
      /useEffect\(\(\) => \{\s*\n?\s*if \(opts\.manual === true\) return;\s*\n?\s*void fetcher\(\);\s*\n?\s*\}, \[fetcher, opts\.manual\]\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
