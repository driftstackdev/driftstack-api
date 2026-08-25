// W687 — cross-SDK V-462/V-297 GDPR audit-log export parity.
// Fourteenth in the cross-SDK drift-guard series (W649 verb + W675
// error class + W676 problem-type URI + W677 auth/UA + W678 webhook
// sig + W679 retry + W680 grace window + W681 plaintext-once + W682
// step-up window + W683 Idempotency-Key + W684 URL escape + W685
// RBAC-immune + W686 CLI activation + W687 GDPR audit-log).
//
// Asserts the V-462/V-297 audit-log bulk-export contract is
// consistent across all 3 SDKs:
//
//   - V-462 anchor (export feature) + V-297 anchor (problem-type
//     URI for tier-limit which gates the export) BOTH pinned
//   - "GDPR Article 20 portability" regulatory framing
//   - 10,000-row server-side ceiling + `truncated` boolean flag
//     (load-bearing for compliance auditors who need to know
//     when an export is PARTIAL)
//   - JSON-only via SDK + CSV out-of-band ("hit /v1/account/audit-
//     log/export?format=csv directly with bearer") — drift to
//     surfacing CSV through SDK would force a Promise<Blob>
//     return type that breaks content-negotiation typing
//   - Single-call semantics (NOT pagination — that\'s what `list`
//     is for; export is the bulk-pull for compliance)
//
// Drift on the row ceiling would silently change compliance-export
// semantics; drift on CSV-out-of-band would change return types
// for the export verb across the SDK surface.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS_AUDIT = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/audit-log.ts');
const GO_AUDIT = resolve(REPO_ROOT, 'packages/sdk-go/audit_log.go');
const PY_AUDIT = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/audit_log.py');

describe('W687 cross-SDK V-462/V-297 GDPR audit-log export parity', () => {
  it('all 3 SDK audit-log files exist at canonical paths', () => {
    expect(existsSync(TS_AUDIT), `missing ${TS_AUDIT}`).toBe(true);
    expect(existsSync(GO_AUDIT), `missing ${GO_AUDIT}`).toBe(true);
    expect(existsSync(PY_AUDIT), `missing ${PY_AUDIT}`).toBe(true);
  });

  it('CRITICAL V-462 + V-297 anchors pinned in all 3 SDKs. V-462 is the export feature anchor; V-297 is the related problem-type URI anchor. Drift to dropping either would lose changelog provenance.', () => {
    const ts = read(TS_AUDIT);
    const go = read(GO_AUDIT);
    const py = read(PY_AUDIT);

    expect(ts).toMatch(/V-462/);
    expect(ts).toMatch(/V-297/);
    expect(go).toMatch(/V-462/);
    expect(go).toMatch(/V-297/);
    expect(py).toMatch(/V-462/);
    expect(py).toMatch(/V-297/);
  });

  it('CRITICAL GDPR Article 20 portability regulatory framing pinned in all 3 SDKs. The Article-20 reference is the regulatory-purpose anchor that justifies why the export endpoint is opt-in (NOT rate-limited like list) and why CSV is OOB. Drift to dropping the Article-20 reference would lose the regulatory-purpose anchor.', () => {
    const ts = read(TS_AUDIT);
    const go = read(GO_AUDIT);
    const py = read(PY_AUDIT);

    // sdk-typescript: "GDPR Article 20 data-portability requests"
    expect(ts).toMatch(/GDPR Article 20 data-portability/);

    // sdk-go: "GDPR Article 20 portability"
    expect(go).toMatch(/GDPR Article\s*\/\/\s*20 portability|GDPR Article 20 portability/);

    // sdk-python: "GDPR Article 20 portability"
    expect(py).toMatch(/GDPR Article 20 portability/);
  });

  it('CRITICAL 10,000-row server-side ceiling pinned in all 3 SDKs. The "10,000 rows" exact number is what tells customers the export is a SINGLE-call bulk-pull capped at 10k (vs a multi-call pagination). Drift to a different ceiling would silently change compliance-export semantics (auditors may have built workflows around the 10k assumption).', () => {
    const ts = read(TS_AUDIT);
    const go = read(GO_AUDIT);
    const py = read(PY_AUDIT);

    // sdk-typescript: "up to 10,000 rows" + "Capped server-side at 10k"
    expect(ts).toMatch(/up to 10,000 rows/);
    expect(ts).toMatch(/10,000-row server-side ceiling/);

    // sdk-go: "Up to 10,000 rows per call"
    expect(go).toMatch(/10,000 rows/);

    // sdk-python: "up to\n        10,000 rows"
    expect(py).toMatch(/up to\s*10,000 rows/);
  });

  it('CRITICAL truncated boolean flag pinned in all 3 SDKs. The `truncated` field is what tells compliance auditors when an export is PARTIAL — drift to dropping would mean auditors can\'t distinguish "this is the full audit log" from "this is the last 10k of a larger log".', () => {
    const ts = read(TS_AUDIT);
    const go = read(GO_AUDIT);
    const py = read(PY_AUDIT);

    // sdk-typescript: `truncated: boolean;` + JSDoc about the 10,000-row server-side ceiling.
    expect(ts).toMatch(/truncated: boolean;/);

    // sdk-go: `Truncated bool `json:"truncated"``
    expect(go).toMatch(/Truncated\s+bool/);

    // sdk-python: "truncated" framing.
    expect(py).toMatch(/``truncated``|truncated/);
  });

  it('CRITICAL JSON-only via SDK + CSV out-of-band framing pinned in all 3 SDKs. Drift to surfacing CSV through the SDK would force a Promise<Blob> return type that breaks content-negotiation typing across the SDK surface. The "hit /v1/account/audit-log/export?format=csv directly with bearer" framing tells customers the CSV path EXISTS but is NOT part of the SDK API.', () => {
    const ts = read(TS_AUDIT);
    const go = read(GO_AUDIT);
    const py = read(PY_AUDIT);

    // sdk-typescript: "CSV download in a browser is not\n   * surfaced here — hit `/v1/account/audit-log/export?format=csv`"
    expect(ts).toMatch(/CSV download in a browser is not\s*\*\s*surfaced here/);
    expect(ts).toMatch(/\/v1\/account\/audit-log\/export\?format=csv/);

    // sdk-go: "CSV branch is not\n// surfaced through the SDK"
    expect(go).toMatch(/CSV branch is not\s*\/\/\s*surfaced through the SDK/);

    // sdk-python: "CSV branch is not exposed here"
    expect(py).toMatch(/CSV branch is not exposed here/);
  });

  it("CRITICAL JSON-format hardcoded request invariant — the SDK request hardcodes `format=json` so the return type stays Promise<typed-shape> (NOT Promise<Blob>). sdk-typescript uses `query: { format: 'json' }`. sdk-python uses `format=json` in the URL literal. sdk-go uses the path literal without query (server defaults to JSON).", () => {
    const ts = read(TS_AUDIT);
    const go = read(GO_AUDIT);
    const py = read(PY_AUDIT);

    // sdk-typescript: query: { format: 'json' }
    expect(ts).toMatch(/query: \{ format: 'json' \}/);

    // sdk-go: path with /export (no query — server defaults to JSON).
    expect(go).toMatch(/\/v1\/account\/audit-log\/export/);

    // sdk-python: ?format=json literal in URL.
    expect(py).toMatch(/\/v1\/account\/audit-log\/export\?format=json/);
  });

  it('CRITICAL single-call + no-pagination framing pinned in all 3 SDKs. The export verb is DISTINCT from list — export is the bulk-pull for compliance (single call, no cursor), list is the paginated read. Drift to making export paginated would conflate the two verbs.', () => {
    const ts = read(TS_AUDIT);
    const go = read(GO_AUDIT);
    const py = read(PY_AUDIT);

    // sdk-typescript: "a single call, up to 10,000 rows, no pagination"
    expect(ts).toMatch(/a single call, up to 10,000 rows, no pagination/);

    // sdk-go: "Up to 10,000 rows per call"
    expect(go).toMatch(/10,000 rows per call/);

    // sdk-python: "Single call; up to"
    expect(py).toMatch(/Single call;/);
  });

  it('CRITICAL wire path /v1/account/audit-log/export pinned in all 3 SDKs. The single canonical export path — drift to a different URL (e.g. /v1/exports/audit-log) would break server-side routing.', () => {
    const ts = read(TS_AUDIT);
    const go = read(GO_AUDIT);
    const py = read(PY_AUDIT);

    expect(ts).toMatch(/\/v1\/account\/audit-log\/export/);
    expect(go).toMatch(/\/v1\/account\/audit-log\/export/);
    expect(py).toMatch(/\/v1\/account\/audit-log\/export/);
  });

  it('Cross-flow consistency — all 3 SDKs reference BOTH V-462 + V-297 + GDPR Article 20 + 10,000 rows + truncated + CSV-out-of-band. The 6-invariant cluster is what threads the compliance-export contract across the SDKs. Drift to dropping ANY invariant on ANY SDK would fragment the cross-language compliance story.', () => {
    const sdks = {
      'sdk-typescript': read(TS_AUDIT),
      'sdk-go': read(GO_AUDIT),
      'sdk-python': read(PY_AUDIT),
    };

    for (const [name, body] of Object.entries(sdks)) {
      expect(body, `${name} V-462`).toMatch(/V-462/);
      expect(body, `${name} V-297`).toMatch(/V-297/);
      expect(body, `${name} GDPR Article 20`).toMatch(/GDPR Article 20|GDPR Article\s*\/\/\s*20/);
      expect(body, `${name} 10,000 rows`).toMatch(/10,000 rows|10,000-row/);
      expect(body, `${name} truncated`).toMatch(/truncated|Truncated/);
      // CSV-out-of-band can span multiple comment lines, so allow `[\s\S]` cross-line match.
      expect(body, `${name} CSV not via SDK`).toMatch(
        /CSV[\s\S]{0,80}not[\s\S]{0,30}(?:surfaced|exposed)/,
      );
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/cross-sdk-gdpr-audit-export-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
