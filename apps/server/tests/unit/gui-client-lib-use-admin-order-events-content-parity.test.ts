// W466.C — drift guard for apps/gui-client/src/lib/use-admin-order-events.ts.
// V-534.BD useAdminOrderEvents hook. Drift here either drops the
// orderId === null → {kind:'idle'} guard (hook tries to fetch
// '/v1/admin/crypto-orders/null/events' and the drawer flashes a
// useless error before the user clicks an order) or breaks the
// Array.isArray(body.events) defensive check (a non-array events
// payload from server bug or partial state makes the drawer
// .map crash on undefined.map).
//
//   • V-534.BD framing pinned: 'Wraps GET /v1/admin/crypto-
//     orders/:order_id/events (V-666.AT). Fetches on mount and
//     on orderId change. The detail drawer consumes this to
//     render an inline timeline below the envelope.'
//   • AdminOrderEvent: 3-field with status 6-union (pending/
//     confirming/paid/failed/partial/cancelled) + at + source
//     5-union ('create'|'ipn'|'cancel'|'expired'|'swept').
//   • orderId: string | null parameter (NOT opts object — unique
//     signature in the hook family).
//   • Initial state: orderId === null → 'idle' else 'loading'.
//   • Fetcher: orderId === null → {kind:'idle'} reset (NOT error);
//     no-apiKey → 'No API key configured.'; trailing-slash strip
//     + encodeURIComponent(orderId).
//   • Defensive Array.isArray(body.events) ? body.events : []
//     fallback (server might return {} or {events: null}).
//   • useEffect deps just [fetcher] (no manual?, no extra opts).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/use-admin-order-events.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W466.C apps/gui-client/src/lib/use-admin-order-events.ts content parity', () => {
  const body = read(LIB);

  it("V-534.BD framing pinned: 'V-534.BD — useAdminOrderEvents hook.' + 'Wraps GET /v1/admin/crypto-orders/:order_id/events (V-666.AT). Fetches on mount and on orderId change. The detail drawer consumes this to render an inline timeline below the envelope.'", () => {
    expect(body).toMatch(/\/\/ V-534\.BD — useAdminOrderEvents hook\./);
    expect(body).toMatch(
      /\/\/ Wraps GET \/v1\/admin\/crypto-orders\/:order_id\/events \(V-666\.AT\)\.\s*\n?\s*\/\/ Fetches on mount and on orderId change\. The detail drawer\s*\n?\s*\/\/ consumes this to render an inline timeline below the envelope\./,
    );
  });

  it("AdminOrderEvent: 3-field with status 6-union ('pending'|'confirming'|'paid'|'failed'|'partial'|'cancelled') + at + source 5-union ('create'|'ipn'|'cancel'|'expired'|'swept')", () => {
    expect(body).toMatch(
      /export interface AdminOrderEvent \{\s*\n?\s*status: 'pending' \| 'confirming' \| 'paid' \| 'failed' \| 'partial' \| 'cancelled';\s*\n?\s*at: string;\s*\n?\s*source: 'create' \| 'ipn' \| 'cancel' \| 'expired' \| 'swept';\s*\n?\s*\}/,
    );
  });

  it('AdminOrderEventsState 4-variant union: idle | loading | ready{events: AdminOrderEvent[]} | error{message} — note: events array, NOT data wrapped, distinct from other V-534 hooks', () => {
    expect(body).toMatch(
      /export type AdminOrderEventsState =\s*\n?\s*\| \{ kind: 'idle' \}\s*\n?\s*\| \{ kind: 'loading' \}\s*\n?\s*\| \{ kind: 'ready'; events: AdminOrderEvent\[\] \}\s*\n?\s*\| \{ kind: 'error'; message: string \};/,
    );
  });

  it('Signature: useAdminOrderEvents(orderId: string | null) — bare positional parameter, NOT opts object (distinct from V-534.Q/H/AH/AO family)', () => {
    expect(body).toMatch(
      /export function useAdminOrderEvents\(orderId: string \| null\): UseAdminOrderEventsResult \{/,
    );
  });

  it("Initial state: orderId === null → {kind:'idle'} else {kind:'loading'} (null-orderId pre-mount stays idle, drawer hasn't opened)", () => {
    expect(body).toMatch(
      /const \[state, setState\] = useState<AdminOrderEventsState>\(\s*\n?\s*orderId === null \? \{ kind: 'idle' \} : \{ kind: 'loading' \},\s*\n?\s*\);/,
    );
  });

  it("Fetcher orderId-null guard: orderId === null → setState({kind:'idle'}) reset (NOT error — drawer closed is not a failure)", () => {
    expect(body).toMatch(
      /if \(orderId === null\) \{\s*\n?\s*setState\(\{ kind: 'idle' \}\);\s*\n?\s*return;\s*\n?\s*\}\s*\n?\s*if \(!settings\.apiKey\) \{\s*\n?\s*setState\(\{ kind: 'error', message: 'No API key configured\.' \}\);\s*\n?\s*return;\s*\n?\s*\}/,
    );
  });

  it('URL with encodeURIComponent(orderId): deadline-bounded GET + signal + Bearer + accept JSON', () => {
    expect(body).toMatch(
      /const res = await fetchWithDeadline\(\s*\n?\s*`\$\{baseUrl\}\/v1\/admin\/crypto-orders\/\$\{encodeURIComponent\(orderId\)\}\/events`,/,
    );
    expect(body).toContain("method: 'GET',");
    expect(body).toContain('signal: controller.signal,');
    expect(body).toContain('authorization: `Bearer ${settings.apiKey}`');
    expect(body).toContain("accept: 'application/json',");
  });

  it('Bounded defensive parsing: typed event envelope + Array.isArray fallback handles {} or {events: null}', () => {
    expect(body).toMatch(
      /const body = await readBoundedApiJson<\{ events\?: AdminOrderEvent\[\] \}>\(res\);/,
    );
    expect(body).toMatch(/import \{ readBoundedApiJson \} from '\.\/read-bounded-json';/);
    expect(body).not.toMatch(/\bres\.json\(\)/);
    expect(body).toContain(
      "setState({ kind: 'ready', events: Array.isArray(body.events) ? body.events : [] });",
    );
  });

  it('keeps unconditional auto-fetch while reads are single-flight, sequence-gated, and dependency-aborted', () => {
    expect(body).toContain('if (inFlightRef.current) return;');
    expect(body).toContain('if (sequence === sequenceRef.current) {');
    expect(body).toContain('requestRef.current?.abort();');
    expect(body).toContain('[settings.apiKey, settings.baseUrl, orderId],');
    expect(body).toMatch(
      /useEffect\(\(\) => \{\s*\n?\s*void fetcher\(\);\s*\n?\s*\}, \[fetcher\]\);/,
    );
    expect(body).toMatch(/\}, \[settings\.apiKey, settings\.baseUrl, orderId\]\);/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
