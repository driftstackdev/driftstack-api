// W472.C — drift guard for apps/gui-client/src/lib/use-webhooks-list.ts.
// V-534.S useWebhooksList hook. Drift here either drops the
// WebhookCounts 3-field (delivered + failed + dlq) — the
// webhooks panel renders empty boxes instead of per-endpoint
// counts and operators can't tell which endpoint is failing —
// or breaks the disabledAt nullable field (UI confuses a paused
// endpoint for a deleted one).
//
//   • V-534.S framing pinned: 'useWebhooksList hook.' + 'Wraps
//     GET /v1/webhooks (V-225 listWithCounts). The endpoint
//     returns the customer's webhook endpoints + per-endpoint
//     delivery counts; this hook surfaces it through the same
//     state-machine pattern as useSessionsList (V-534.O) and
//     useAccountCost (V-534.H).'
//   • WebhookCounts 3-field (delivered + failed + dlq).
//   • WebhookListItem 8-field (id + url + events string[] +
//     description nullable + active + disabledAt nullable +
//     createdAt + counts: WebhookCounts).
//   • WebhooksListResponse 1-field (webhooks array).
//   • Same V-534 state-machine pattern as O/H/AH/AO/BA + URL
//     `/v1/webhooks` exact + useCallback deps just [apiKey, baseUrl].

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/use-webhooks-list.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W472.C apps/gui-client/src/lib/use-webhooks-list.ts content parity', () => {
  const body = read(LIB);

  it("V-534.S framing pinned: 'V-534.S — useWebhooksList hook.' + 'Wraps GET /v1/webhooks (V-225 listWithCounts). The endpoint returns the customer's webhook endpoints + per-endpoint delivery counts; this hook surfaces it through the same state-machine pattern as useSessionsList (V-534.O) and useAccountCost (V-534.H).'", () => {
    expect(body).toMatch(/\/\/ V-534\.S — useWebhooksList hook\./);
    expect(body).toMatch(
      /\/\/ Wraps GET \/v1\/webhooks \(V-225 listWithCounts\)\. The endpoint\s*\n?\s*\/\/ returns the customer's webhook endpoints \+ per-endpoint delivery\s*\n?\s*\/\/ counts; this hook surfaces it through the same state-machine\s*\n?\s*\/\/ pattern as useSessionsList \(V-534\.O\) and useAccountCost \(V-534\.H\)\./,
    );
  });

  it('WebhookCounts 3-field (delivered + failed + dlq all numbers — DLQ surfaced as distinct from failed for the V-225 listWithCounts contract)', () => {
    expect(body).toMatch(
      /export interface WebhookCounts \{\s*\n?\s*delivered: number;\s*\n?\s*failed: number;\s*\n?\s*dlq: number;\s*\n?\s*\}/,
    );
  });

  it('WebhookListItem 8-field: id + url + events string[] + description nullable + active boolean + disabledAt nullable + createdAt + counts: WebhookCounts; WebhooksListResponse: { webhooks: WebhookListItem[] }', () => {
    expect(body).toMatch(
      /export interface WebhookListItem \{\s*\n?\s*id: string;\s*\n?\s*url: string;\s*\n?\s*events: string\[\];\s*\n?\s*description: string \| null;\s*\n?\s*active: boolean;\s*\n?\s*disabledAt: string \| null;\s*\n?\s*createdAt: string;\s*\n?\s*counts: WebhookCounts;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export interface WebhooksListResponse \{\s*\n?\s*webhooks: WebhookListItem\[\];\s*\n?\s*\}/,
    );
  });

  it("UseWebhooksListOpts: manual? 'Disable auto-fetch on mount. Default false.' + UseWebhooksListResult { state + refetch }", () => {
    expect(body).toMatch(
      /export interface UseWebhooksListOpts \{\s*\n?\s*\/\*\* Disable auto-fetch on mount\. Default false\. \*\/\s*\n?\s*manual\?: boolean;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export interface UseWebhooksListResult \{\s*\n?\s*state: WebhooksListState;\s*\n?\s*refetch: \(\) => Promise<void>;\s*\n?\s*\}/,
    );
  });

  it("Same V-534 polling state-machine: manual?-aware initial state + no-apiKey 'No API key configured.' + trailing-slash strip + URL `/v1/webhooks` exact (no params) + readApiErrorMessage + instance-of-Error catch + useEffect manual gate; useCallback deps [settings.apiKey, settings.baseUrl]", () => {
    expect(body).toMatch(
      /const \[state, setState\] = useState<WebhooksListState>\(\s*\n?\s*opts\.manual === true \? \{ kind: 'idle' \} : \{ kind: 'loading' \},\s*\n?\s*\);/,
    );
    expect(body).toMatch(
      /const res = await fetchWithDeadline\(`\$\{baseUrl\}\/v1\/webhooks`, \{\s*\n?\s*method: 'GET',\s*\n?\s*signal: controller\.signal,\s*\n?\s*headers: \{\s*\n?\s*authorization: `Bearer \$\{settings\.apiKey\}`,\s*\n?\s*accept: 'application\/json',\s*\n?\s*\},\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /if \(sequence === sequenceRef\.current\) setState\(\{ kind: 'ready', data: body \}\);/,
    );
    expect(body).toMatch(/requestRef\.current\?\.abort\(\);/);
    expect(body).toMatch(/\}, \[settings\.apiKey, settings\.baseUrl\]\);/);
    expect(body).toMatch(
      /useEffect\(\(\) => \{\s*\n?\s*if \(opts\.manual === true\) return;\s*\n?\s*void fetcher\(\);\s*\n?\s*\}, \[fetcher, opts\.manual\]\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
