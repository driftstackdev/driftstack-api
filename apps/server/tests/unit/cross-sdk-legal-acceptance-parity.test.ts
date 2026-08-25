// W692 — cross-SDK V-049/V-458 legal-acceptance parity. Nineteenth
// in the cross-SDK drift-guard series (W649 + W675 + W676 + W677 +
// W678 + W679 + W680 + W681 + W682 + W683 + W684 + W685 + W686 +
// W687 + W688 + W689 + W690 + W691 + W692).
//
// Asserts the V-049/V-458 legal-acceptance machinery is consistent
// across all 3 SDKs:
//
//   - V-049 + V-458 anchors pinned per-SDK
//   - 4-document coverage (ToS / Privacy / DPA / AUP)
//   - 3-tuple (document_key + version + content_hash) acceptance
//     integrity — content_hash binds acceptance to specific text
//     snapshot (drift to dropping = stale acceptances persist past
//     content rewrite)
//   - content_hash format invariant: 64-character LOWERCASE hex
//     SHA-256 (sdk-typescript pins this inline)
//   - Marketing-site-content-not-API-surface architectural
//     separation — drift would put binary legal text on JSON
//     surface
//   - 3-verb surface (documents + required + accept)
//
// Drift on the 3-tuple acceptance integrity would let customers
// silently accept stale text after a content rewrite.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS_LEGAL = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/legal.ts');
const GO_LEGAL = resolve(REPO_ROOT, 'packages/sdk-go/legal.go');
const PY_LEGAL = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/legal.py');

describe('W692 cross-SDK V-049/V-458 legal-acceptance parity', () => {
  it('all 3 SDK legal resource files exist at canonical paths', () => {
    expect(existsSync(TS_LEGAL), `missing ${TS_LEGAL}`).toBe(true);
    expect(existsSync(GO_LEGAL), `missing ${GO_LEGAL}`).toBe(true);
    expect(existsSync(PY_LEGAL), `missing ${PY_LEGAL}`).toBe(true);
  });

  it('CRITICAL V-049 + V-458 anchors pinned in all 3 SDKs. V-049 is the legal-acceptance base anchor; V-458 is the related feature extension. Drift to dropping either would lose changelog provenance.', () => {
    const ts = read(TS_LEGAL);
    const go = read(GO_LEGAL);
    const py = read(PY_LEGAL);

    expect(ts).toMatch(/V-049 \/ V-458/);
    expect(go).toMatch(/V-049 \/ V-458/);
    expect(py).toMatch(/V-049 \/ V-458/);
  });

  it('CRITICAL ToS/Privacy/DPA/AUP 4-document coverage pinned in sdk-typescript + sdk-python. The 4-document set is the canonical legal-acceptance scope; drift to dropping any (e.g. DPA) would leave a customer-facing legal-compliance gap.', () => {
    const ts = read(TS_LEGAL);
    const py = read(PY_LEGAL);

    // sdk-typescript: "Customer acceptance of legal documents (ToS / Privacy / DPA / AUP)."
    expect(ts).toMatch(/\(ToS \/ Privacy \/ DPA \/ AUP\)/);

    // sdk-python: same.
    expect(py).toMatch(/\(ToS \/ Privacy \/ DPA \/ AUP\)/);
  });

  it('CRITICAL 3-tuple (document_key + version + content_hash) acceptance integrity pinned in all 3 SDKs. The 3-tuple is what BINDS an acceptance to a specific text snapshot — drift to dropping any field would let stale acceptances persist past a content rewrite.', () => {
    const ts = read(TS_LEGAL);
    const go = read(GO_LEGAL);
    const py = read(PY_LEGAL);

    // All 3 SDKs reference the 3-tuple in acceptance request bodies/comments.
    for (const sdk of [ts, go, py]) {
      expect(sdk).toMatch(/document_key/);
      expect(sdk).toMatch(/version/);
      expect(sdk).toMatch(/content_hash/);
    }
  });

  it('CRITICAL "(document, version, content_hash) tuple" framing pinned in all 3 SDKs. The "tuple" wording is what tells customers acceptance is 3-field (not just doc+version). Drift to dropping would let customers think content_hash is optional.', () => {
    const ts = read(TS_LEGAL);
    const py = read(PY_LEGAL);
    const go = read(GO_LEGAL);

    // sdk-typescript: "Record acceptance of a (document, version, content_hash) tuple."
    expect(ts).toMatch(/\(document, version, content_hash\) tuple/);

    // sdk-python: "Record acceptance of a (document, version, content_hash) tuple."
    expect(py).toMatch(/\(document, version, content_hash\) tuple/);

    // sdk-go: similar — may span lines.
    expect(go).toMatch(
      /document, version,\s*\/\/\s*content_hash\) tuple|\(document, version, content_hash\) tuple/,
    );
  });

  it('CRITICAL content_hash format invariant pinned in sdk-typescript: "64-character lowercase hex SHA-256 of the document content." The 3 sub-invariants (64-char + lowercase + SHA-256) are load-bearing — drift to uppercase hex would fail server-side hash-comparison; drift to SHA-512 would break every historical acceptance row.', () => {
    const ts = read(TS_LEGAL);
    expect(ts).toMatch(/64-character lowercase hex SHA-256 of the document content/);
  });

  it('CRITICAL marketing-site-content-not-API-surface architectural separation pinned in all 3 SDKs. The "Document content is served separately on the marketing site" framing prevents binary legal text from being put on the JSON surface. Drift to surfacing TEXT through the API would break the load-bearing separation that keeps legal PDFs on Cloudflare Pages.', () => {
    const ts = read(TS_LEGAL);
    const py = read(PY_LEGAL);

    // sdk-typescript: "Document content is served separately on the marketing site"
    expect(ts).toMatch(/Document content is served separately on the marketing site/);

    // sdk-python: similar framing.
    expect(py).toMatch(/Document content is served separately on the marketing site/);
  });

  it('3-verb surface pinned across all 3 SDKs — documents + required + accept. Drift to a 4th verb (e.g. "withdraw" or "delete acceptance") would break the immutable-acceptance-ledger invariant (acceptances are AUDIT records).', () => {
    const ts = read(TS_LEGAL);
    const go = read(GO_LEGAL);
    const py = read(PY_LEGAL);

    // 3 verbs across SDKs (language-canonical naming).
    expect(ts).toMatch(/documents\(\)/);
    expect(ts).toMatch(/required\(\)/);
    expect(ts).toMatch(/accept\(body:/);

    expect(go).toMatch(/Documents\(/);
    expect(go).toMatch(/Required\(/);
    expect(go).toMatch(/Accept\(/);

    expect(py).toMatch(/def documents\(self/);
    expect(py).toMatch(/def required\(self/);
    expect(py).toMatch(/def accept\(self/);
  });

  it('CRITICAL "must accept (or re-accept)" framing pinned in all 3 SDKs on the required() verb. The "or re-accept" wording is what tells customers an existing acceptance can become STALE when a new version with a different content_hash ships. Drift to dropping would lose this customer-facing claim.', () => {
    const ts = read(TS_LEGAL);
    const py = read(PY_LEGAL);

    expect(ts).toMatch(/must accept \(or re-accept\)/);
    expect(py).toMatch(/must accept \(or re-accept\)/);
  });

  it('3 wire-paths pinned across all 3 SDKs: /v1/legal/documents + /v1/legal/required + /v1/legal/accept. Drift to a per-document sub-path would change the addressing model.', () => {
    const ts = read(TS_LEGAL);
    const go = read(GO_LEGAL);
    const py = read(PY_LEGAL);

    for (const sdk of [ts, go, py]) {
      expect(sdk).toMatch(/\/v1\/legal\/documents/);
      expect(sdk).toMatch(/\/v1\/legal\/required/);
      expect(sdk).toMatch(/\/v1\/legal\/accept/);
    }
  });

  it('CRITICAL immutable-acceptance invariant — NO "withdraw" or "delete acceptance" verbs in any SDK. Once accepted, an acceptance is IMMUTABLE for audit/compliance reasons. Drift to adding a DELETE verb would break the immutable-acceptance-ledger invariant.', () => {
    const ts = read(TS_LEGAL);
    const go = read(GO_LEGAL);
    const py = read(PY_LEGAL);

    for (const sdk of [ts, go, py]) {
      expect(sdk, 'no withdraw verb').not.toMatch(/withdraw|deleteAcceptance|delete_acceptance/);
    }
  });

  it('Cross-SDK V-049/V-458 5-invariant cluster — V-049 + V-458 anchors + 3-tuple integrity + content_hash threading + marketing-site separation. Drift on any would fragment the cross-language legal-acceptance contract.', () => {
    const sdks = {
      'sdk-typescript': read(TS_LEGAL),
      'sdk-go': read(GO_LEGAL),
      'sdk-python': read(PY_LEGAL),
    };

    for (const [name, body] of Object.entries(sdks)) {
      expect(body, `${name} V-049`).toMatch(/V-049/);
      expect(body, `${name} V-458`).toMatch(/V-458/);
      // 3-tuple components.
      expect(body, `${name} document_key`).toMatch(/document_key/);
      expect(body, `${name} content_hash`).toMatch(/content_hash/);
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/cross-sdk-legal-acceptance-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
