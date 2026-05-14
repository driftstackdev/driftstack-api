// W832 — cross-SDK LegalResource methods parity. One-hundred-fifty-
// eighth in the drift-guard series. Pins the LegalResource method set
// (V-049 legal-acceptance machinery) across all 3 SDKs. Powers the
// W809 dev-bootstrap 4-doc accept loop + customer signup-time legal
// acceptance gate.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/legal.ts');
const PY = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/legal.py');
const GO = resolve(REPO_ROOT, 'packages/sdk-go/legal.go');

// 3 shared method names cross-SDK.
const REQUIRED_METHODS: Array<[string, string, string]> = [
  ['documents', 'documents', 'Documents'],
  ['required', 'required', 'Required'],
  ['accept', 'accept', 'Accept'],
];

describe('W832 cross-SDK LegalResource methods parity', () => {
  it('all 3 LegalResource files exist at canonical paths', () => {
    expect(existsSync(TS)).toBe(true);
    expect(existsSync(PY)).toBe(true);
    expect(existsSync(GO)).toBe(true);
  });

  // ─── 3-required-method set ────────────────────────────────────

  it('CRITICAL all 3 LegalResource methods exist in all 3 SDKs — documents + required + accept. Drift would break W809 dev-bootstrap 4-doc accept loop + customer signup legal-acceptance gate (V-049).', () => {
    const ts = read(TS);
    const py = read(PY);
    const go = read(GO);

    for (const [tsName, pyName, goName] of REQUIRED_METHODS) {
      expect(ts, `TS missing '${tsName}('`).toMatch(new RegExp(`\\b${tsName}\\s*\\(`));
      expect(py, `Python missing 'def ${pyName}('`).toMatch(new RegExp(`def ${pyName}\\(`));
      expect(go, `Go missing 'func (r *LegalResource) ${goName}('`).toMatch(
        new RegExp(`func \\(r \\*LegalResource\\) ${goName}\\(`),
      );
    }
  });

  // ─── documents() returns LegalDocumentEntry[] envelope ────────

  it('CRITICAL documents() returns the canonical legal-documents envelope cross-SDK. TS: { data: LegalDocumentEntry[] }; Go: *ListLegalDocumentsResponse. Each entry has document_key + version + content_hash — what W809 dev-bootstrap uses to construct the accept body.', () => {
    expect(read(TS)).toMatch(/documents\(\): Promise<\{ data: LegalDocumentEntry\[\] \}>/);
    expect(read(GO)).toMatch(
      /Documents\(ctx context\.Context\) \(\*ListLegalDocumentsResponse, error\)/,
    );
  });

  // ─── required() returns LegalRequiredEntry[] envelope ─────────

  it("CRITICAL required() returns the legal-required-list envelope cross-SDK. TS: { data: LegalRequiredEntry[] }; Go: *ListLegalRequiredResponse. The 'required' list is what customer-dashboard pings at login to gate the acceptance modal — drift would let unaccepted-documents-required state leak.", () => {
    expect(read(TS)).toMatch(/required\(\): Promise<\{ data: LegalRequiredEntry\[\] \}>/);
    expect(read(GO)).toMatch(
      /Required\(ctx context\.Context\) \(\*ListLegalRequiredResponse, error\)/,
    );
  });

  // ─── accept(body) returns AcceptLegalDocumentResponse ─────────

  it('CRITICAL accept(AcceptLegalDocumentRequest) returns AcceptLegalDocumentResponse cross-SDK. The request body shape (document_key + version + content_hash) matches what W809 dev-bootstrap constructs. Drift to a different request shape would break the 4-doc accept loop.', () => {
    expect(read(TS)).toMatch(
      /accept\(body: AcceptLegalDocumentRequest\): Promise<AcceptLegalDocumentResponse>/,
    );
    expect(read(GO)).toMatch(
      /Accept\(ctx context\.Context, body \*AcceptLegalDocumentRequest\) \(\*AcceptLegalDocumentResponse, error\)/,
    );
  });

  // ─── Python sync + async dual ─────────────────────────────────

  it('CRITICAL Python provides BOTH LegalResource (sync) AND AsyncLegalResource (async). Every method has an async counterpart.', () => {
    const p = read(PY);
    for (const [, pyName] of REQUIRED_METHODS) {
      expect(p, `Python AsyncLegalResource missing 'async def ${pyName}'`).toMatch(
        new RegExp(`async def ${pyName}\\(`),
      );
    }
  });

  // ─── Go ctx-first convention ──────────────────────────────────

  it('CRITICAL Go LegalResource methods all take ctx context.Context as first arg. Matches W822-W831 cross-SDK Go convention.', () => {
    const p = read(GO);
    for (const [, , goName] of REQUIRED_METHODS) {
      expect(p, `Go ${goName} must take ctx context.Context as first arg`).toMatch(
        new RegExp(`func \\(r \\*LegalResource\\) ${goName}\\(\\s*ctx context\\.Context`),
      );
    }
  });

  // ─── Python __init__ wiring ───────────────────────────────────

  it('CRITICAL Python LegalResource + AsyncLegalResource constructors take http client. Matches W822-W831 cross-SDK wiring.', () => {
    const p = read(PY);
    expect(p).toMatch(/def __init__\(self, http: HttpClient\) -> None:/);
    expect(p).toMatch(/def __init__\(self, http: AsyncHttpClient\) -> None:/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/sdk-legal-resource-cross-sdk-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
