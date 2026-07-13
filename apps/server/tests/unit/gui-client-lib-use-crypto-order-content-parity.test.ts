// W473.C — drift guard for apps/gui-client/src/lib/use-crypto-order.ts.
// V-534.T useCryptoOrder polling hook + V-666.AU events timeline +
// V-666.AV expires_at pay-window. Drift here either drops the
// TERMINAL_STATUSES auto-stop (polling keeps hammering the server
// after the order's already paid — Set('paid','failed')) or breaks
// the DEFAULT_POLL_MS = 5_000 cadence (a sub-second default would
// rate-limit storm; a 30s default would feel broken to the user
// watching the spinner).
//
//   • V-534.T framing pinned: 'useCryptoOrder polling hook.' +
//     'Polls GET /v1/billing/crypto-orders/:id for the given order
//     id and transitions the state machine each tick. Polling stops
//     automatically once the order reaches a terminal status (paid
//     / failed / cancelled). Callers can pass `pollIntervalMs` to
//     override the default cadence.'
//   • CryptoOrderEvent 3-field with V-666.AU source 4-value union
//     ('create' | 'ipn' | 'cancel' | 'expired' — 'swept' mapped to
//     'expired' server-side).
//   • CryptoOrderData 9-field: order_id + product + price_cents +
//     price_currency + payment_id nullable + status 6-value union +
//     events optional CryptoOrderEvent[] (V-666.AU append-only
//     timeline, optional so older builds parse) + expires_at?
//     string|null (V-666.AV) + created_at + updated_at.
//   • TERMINAL_STATUSES Set('paid','failed','cancelled') + DEFAULT_POLL_MS 5_000
//     constants (off-module so polling cadence is pinned).
//   • lastStatusRef tracks last-seen status; setInterval terminates
//     once TERMINAL_STATUSES has it.
//   • interval <= 0 disables polling (cadence-disable opt-out).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/use-crypto-order.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W473.C apps/gui-client/src/lib/use-crypto-order.ts content parity', () => {
  const body = read(LIB);

  it("V-534.T framing pinned: 'V-534.T — useCryptoOrder polling hook.' + 'Polls GET /v1/billing/crypto-orders/:id for the given order id and transitions the state machine each tick. Polling stops automatically once the order reaches a terminal status (paid / failed / cancelled). Callers can pass `pollIntervalMs` to override the default cadence.'", () => {
    expect(body).toMatch(/\/\/ V-534\.T — useCryptoOrder polling hook\./);
    expect(body).toMatch(
      /\/\/ Polls GET \/v1\/billing\/crypto-orders\/:id for the given order id and\s*\n?\s*\/\/ transitions the state machine each tick\. Polling stops automatically\s*\n?\s*\/\/ once the order reaches a terminal status \(paid \/ failed \/ cancelled\)\.\s*\n?\s*\/\/ Callers can pass `pollIntervalMs` to override the default cadence\./,
    );
  });

  it("CryptoOrderEvent 3-field (status 6-value union + at ISO + source 4-value union) with V-666.AU framing 'customer-facing source tag. \\'swept\\' is mapped to \\'expired\\' server-side.' — pinned so the swept-vs-expired customer-facing label decision isn't reverted in the wire contract", () => {
    expect(body).toMatch(
      /export interface CryptoOrderEvent \{\s*\n?\s*status: 'pending' \| 'confirming' \| 'paid' \| 'failed' \| 'partial' \| 'cancelled';\s*\n?\s*at: string;\s*\n?\s*\/\*\* V-666\.AU — customer-facing source tag\. 'swept' is mapped to 'expired' server-side\. \*\/\s*\n?\s*source: 'create' \| 'ipn' \| 'cancel' \| 'expired';\s*\n?\s*\}/,
    );
  });

  it("CryptoOrderData 9-field: status 6-value union + events optional CryptoOrderEvent[] V-666.AU 'append-only state-transition timeline. Optional on the wire so older server builds still parse.' + expires_at? V-666.AV 'informational pay-window deadline (ISO 8601). Set for pending orders; null otherwise.'", () => {
    expect(body).toMatch(
      /export interface CryptoOrderData \{\s*\n?\s*order_id: string;\s*\n?\s*product: string;\s*\n?\s*price_cents: number;\s*\n?\s*price_currency: string;\s*\n?\s*payment_id: string \| null;\s*\n?\s*status: 'pending' \| 'confirming' \| 'paid' \| 'failed' \| 'partial' \| 'cancelled';/,
    );
    expect(body).toMatch(
      /\/\*\* V-666\.AU — append-only state-transition timeline\. Optional on\s*\n?\s*\*\s+the wire so older server builds still parse\. \*\/\s*\n?\s*events\?: CryptoOrderEvent\[\];/,
    );
    expect(body).toMatch(
      /\/\*\* V-666\.AV — informational pay-window deadline \(ISO 8601\)\. Set\s*\n?\s*\*\s+for pending orders; null otherwise\. \*\/\s*\n?\s*expires_at\?: string \| null;\s*\n?\s*created_at: string;\s*\n?\s*updated_at: string;\s*\n?\s*\}/,
    );
  });

  it("UseCryptoOrderOpts: manual? 'Disable auto-fetch on mount. Default false.' + pollIntervalMs? 'Polling cadence in ms. Default 5_000. Set 0 to disable polling.'; useCryptoOrder(orderId: string | null, opts = {})", () => {
    expect(body).toMatch(
      /export interface UseCryptoOrderOpts \{\s*\n?\s*\/\*\* Disable auto-fetch on mount\. Default false\. \*\/\s*\n?\s*manual\?: boolean;\s*\n?\s*\/\*\* Polling cadence in ms\. Default 5_000\. Set 0 to disable polling\. \*\/\s*\n?\s*pollIntervalMs\?: number;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export function useCryptoOrder\(\s*\n?\s*orderId: string \| null,\s*\n?\s*opts: UseCryptoOrderOpts = \{\},\s*\n?\s*\): UseCryptoOrderResult \{/,
    );
  });

  it("TERMINAL_STATUSES = new Set(['paid', 'failed', 'cancelled']) + DEFAULT_POLL_MS = 5_000 module-level constants — pinned so polling cadence + terminal-stop logic aren't reverted to a hard-coded interior literal (cancelled is terminal — the IPN flow won't transition out of it, so polling must stop)", () => {
    expect(body).toMatch(/const TERMINAL_STATUSES = new Set\(\['paid', 'failed', 'cancelled'\]\);/);
    expect(body).toMatch(/const DEFAULT_POLL_MS = 5_000;/);
  });

  it('lastStatusRef + setInterval polling loop: lastStatusRef = useRef<string|null>(null) + body.status assigned on each successful tick + setInterval tick checks lastStatusRef.current !== null && TERMINAL_STATUSES.has(lastStatusRef.current) → clearInterval + return (auto-stop on terminal) + interval <= 0 disables polling + cleanup returns clearInterval', () => {
    expect(body).toMatch(/const lastStatusRef = useRef<string \| null>\(null\);/);
    expect(body).toMatch(
      /lastStatusRef\.current = body\.status;\s*\n?\s*setState\(\{ kind: 'ready', data: body \}\);/,
    );
    expect(body).toContain('const interval = opts.pollIntervalMs ?? DEFAULT_POLL_MS;');
    expect(body).toContain('if (interval <= 0) return;');
    expect(body).toContain('const tick = setInterval(() => {');
    expect(body).toContain('void fetcher();');
    expect(body).toContain('clearInterval(tick);');
    // Auto-stop on a terminal/partial status OR after repeated failures (so a
    // failing or idle order never polls forever).
    expect(body).toContain('STOP_POLLING_STATUSES.has(lastStatusRef.current)');
    expect(body).toContain('failCountRef.current >= MAX_CONSECUTIVE_ERRORS');
    expect(body).toContain(
      "const STOP_POLLING_STATUSES = new Set([...TERMINAL_STATUSES, 'partial']);",
    );
  });

  it('orderId===null short-circuit on initial state + fetcher early-return + useEffect skip; URL `/v1/billing/crypto-orders/${orderId}` exact (no /receipt suffix — separate hook); useCallback deps [orderId, settings.apiKey, settings.baseUrl]', () => {
    expect(body).toMatch(
      /const \[state, setState\] = useState<CryptoOrderState>\(\s*\n?\s*opts\.manual === true \|\| orderId === null \? \{ kind: 'idle' \} : \{ kind: 'loading' \},\s*\n?\s*\);/,
    );
    expect(body).toMatch(
      /const res = await fetchWithDeadline\(`\$\{baseUrl\}\/v1\/billing\/crypto-orders\/\$\{orderId\}`, \{\s*\n?\s*method: 'GET',\s*\n?\s*signal: controller\.signal,\s*\n?\s*headers: \{\s*\n?\s*authorization: `Bearer \$\{settings\.apiKey\}`,\s*\n?\s*accept: 'application\/json',\s*\n?\s*\},\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(/if \(inFlightRef\.current\) return;/);
    expect(body).toMatch(
      /if \(sequence === sequenceRef\.current\) \{[\s\S]*?setState\(\{ kind: 'ready', data: body \}\);/,
    );
    expect(body).toMatch(/requestRef\.current\?\.abort\(\);/);
    expect(body).toMatch(/\}, \[orderId, settings\.apiKey, settings\.baseUrl\]\);/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
