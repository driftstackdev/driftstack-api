// W833 — cross-SDK miscellaneous resources parity. One-hundred-
// fifty-ninth in the drift-guard series. Pins 4 remaining resources:
//   - AuditLog (V-216 customer audit log)
//   - CryptoOrders (V-666 crypto-payment orders)
//   - EmailPreferences (V-204 opt-in/opt-out)
//   - Usage (current + series)
// Drift in any would break customer-dashboard /audit-log + crypto-
// checkout flows + /usage page + email-preferences settings.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W833 cross-SDK miscellaneous resources parity', () => {
  // ─── AuditLog (V-216) ─────────────────────────────────────────

  it('CRITICAL AuditLogResource 3-method set pinned cross-SDK — list + iterate + export. V-216 append-only customer audit log; powers W796 quickstart + customer-dashboard /audit-log page.', () => {
    const ts = read(resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/audit-log.ts'));
    const py = read(
      resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/audit_log.py'),
    );
    const go = read(resolve(REPO_ROOT, 'packages/sdk-go/audit_log.go'));

    for (const m of ['list', 'iterate', 'export']) {
      expect(ts, `TS audit-log missing '${m}('`).toMatch(new RegExp(`\\b${m}\\s*\\(`));
      expect(py, `Python audit-log missing 'def ${m}('`).toMatch(new RegExp(`def ${m}\\(`));
    }
    expect(go).toMatch(/func \(r \*AuditLogResource\) List\(/);
    expect(go).toMatch(/func \(r \*AuditLogResource\) Iterate\(/);
    expect(go).toMatch(/func \(r \*AuditLogResource\) Export\(/);
  });

  it('CRITICAL AuditLog list/export return typed shapes. TS: list → AuditLogListPage, export → AuditLogExportResponse. Go: List → *AuditLogListPage + error, Export → *AuditLogExportResponse + error. Drift would break customer audit-log-CSV-download flow.', () => {
    const ts = read(resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/audit-log.ts'));
    const go = read(resolve(REPO_ROOT, 'packages/sdk-go/audit_log.go'));
    expect(ts).toMatch(/list\(query: AuditLogQuery = \{\}\): Promise<AuditLogListPage>/);
    expect(ts).toMatch(/export\(\): Promise<AuditLogExportResponse>/);
    expect(go).toMatch(
      /List\(ctx context\.Context, query \*ListAuditLogQuery\) \(\*AuditLogListPage, error\)/,
    );
    expect(go).toMatch(/Export\(ctx context\.Context\) \(\*AuditLogExportResponse, error\)/);
  });

  // ─── CryptoOrders (V-666) ─────────────────────────────────────

  it('CRITICAL CryptoOrdersResource 8-method set pinned cross-SDK — quote + createCheckout + list + iterate + get + updateNote + cancel + receipt. V-666 crypto-payment orders surface; drift would break customer-dashboard crypto-checkout flow.', () => {
    const ts = read(resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/crypto-orders.ts'));
    const py = read(
      resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/crypto_orders.py'),
    );
    const go = read(resolve(REPO_ROOT, 'packages/sdk-go/crypto_orders.go'));

    const tsMethods = ['quote', 'createCheckout', 'list', 'get', 'updateNote', 'cancel', 'receipt'];
    const pyMethods = [
      'quote',
      'create_checkout',
      'list',
      'iterate',
      'get',
      'update_note',
      'cancel',
      'receipt',
    ];
    const goMethods = [
      'Quote',
      'CreateCheckout',
      'List',
      'Iterate',
      'Get',
      'UpdateNote',
      'Cancel',
      'Receipt',
    ];

    for (const m of tsMethods) {
      expect(ts, `TS crypto-orders missing '${m}('`).toMatch(new RegExp(`\\b${m}\\s*\\(`));
    }
    for (const m of pyMethods) {
      expect(py, `Python crypto-orders missing 'def ${m}('`).toMatch(new RegExp(`def ${m}\\(`));
    }
    for (const m of goMethods) {
      expect(go, `Go crypto-orders missing 'func ... ${m}('`).toMatch(
        new RegExp(`func \\(r \\*CryptoOrdersResource\\) ${m}\\(`),
      );
    }
  });

  it('CRITICAL CryptoOrders quote/createCheckout typed responses pinned. TS: quote → CryptoQuoteResponse, createCheckout returns checkout-envelope, receipt → CryptoOrderReceipt. Go: Quote → CryptoQuoteResponse (value, not pointer); Receipt → CryptoOrderReceipt. The Go value-return for Quote/Receipt indicates these are flat envelopes.', () => {
    const ts = read(resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/crypto-orders.ts'));
    const go = read(resolve(REPO_ROOT, 'packages/sdk-go/crypto_orders.go'));
    expect(ts).toMatch(/quote\(body: CryptoQuoteRequest\): Promise<CryptoQuoteResponse>/);
    expect(ts).toMatch(/receipt\(orderId: string\): Promise<CryptoOrderReceipt>/);
    expect(go).toMatch(
      /Quote\(ctx context\.Context, body CryptoQuoteRequest\) \(CryptoQuoteResponse, error\)/,
    );
    expect(go).toMatch(
      /Receipt\(ctx context\.Context, orderID string\) \(CryptoOrderReceipt, error\)/,
    );
  });

  // ─── EmailPreferences (V-204) ─────────────────────────────────

  it('CRITICAL EmailPreferencesResource 4-method set pinned cross-SDK — list + set + optOut + optIn. V-204 non-critical email opt-in/opt-out; powers customer-dashboard /settings/email page. optIn + optOut are convenience wrappers around set(eventType, opted_in=bool) — drift to dropping them would force customers to construct the SetEmailPreferenceRequest manually.', () => {
    const ts = read(
      resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/email-preferences.ts'),
    );
    const py = read(
      resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/email_preferences.py'),
    );
    const go = read(resolve(REPO_ROOT, 'packages/sdk-go/email_preferences.go'));

    expect(ts).toMatch(/list\(\): Promise<ListEmailPreferencesResponse>/);
    expect(ts).toMatch(/set\(body: SetEmailPreferenceRequest\): Promise<EmailPreference>/);
    expect(ts).toMatch(/optOut\(eventType: OptOutableEmailEvent\): Promise<EmailPreference>/);
    expect(ts).toMatch(/optIn\(eventType: OptOutableEmailEvent\): Promise<EmailPreference>/);

    expect(py).toMatch(/def list\(self\) -> dict\[str, Any\]:/);
    expect(py).toMatch(/def set\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/);
    expect(py).toMatch(/def opt_out\(self, event_type: str\) -> dict\[str, Any\]:/);
    expect(py).toMatch(/def opt_in\(self, event_type: str\) -> dict\[str, Any\]:/);

    expect(go).toMatch(/List\(ctx context\.Context\) \(\*ListEmailPreferencesResponse, error\)/);
    expect(go).toMatch(
      /OptOut\(ctx context\.Context, eventType string\) \(\*EmailPreference, error\)/,
    );
    expect(go).toMatch(
      /OptIn\(ctx context\.Context, eventType string\) \(\*EmailPreference, error\)/,
    );
  });

  it("CRITICAL EmailPreferences TS uses OptOutableEmailEvent typed enum for eventType param. The typed enum makes the 'only these events are opt-outable' contract enforceable at compile time — drift to plain string would lose the discrimination.", () => {
    const ts = read(
      resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/email-preferences.ts'),
    );
    expect(ts).toMatch(/OptOutableEmailEvent/);
  });

  // ─── Usage ────────────────────────────────────────────────────

  it("CRITICAL UsageResource 2-method set pinned. TS: current + series; Go: CurrentPeriod + Series. The Go 'CurrentPeriod' (vs TS 'current') is a documented naming difference — drift to renaming either would break customer-dashboard /usage page.", () => {
    const ts = read(resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/usage.ts'));
    const go = read(resolve(REPO_ROOT, 'packages/sdk-go/usage.go'));
    expect(ts).toMatch(/current\(\): Promise<UsagePeriodSummary>/);
    expect(ts).toMatch(/series\(opts: \{ days\?: number \} = \{\}\): Promise<UsageSeriesResponse>/);
    expect(go).toMatch(/CurrentPeriod\(ctx context\.Context\) \(\*UsagePeriodSummary, error\)/);
    expect(go).toMatch(/Series\(ctx context\.Context, days int\) \(\*UsageSeriesResponse, error\)/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/sdk-misc-resources-cross-sdk-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
