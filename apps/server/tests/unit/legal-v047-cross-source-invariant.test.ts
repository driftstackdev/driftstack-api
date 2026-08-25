// W945 — V-047 LegalService cross-source invariant. Two-hundred-
// seventy-first in the drift-guard series. Pins the customer legal-
// acceptance service:
//
//   V-047 anchor — 'LegalService — customer acceptance of legal
//   documents (ToS, Privacy Policy, DPA, AUP)'.
//
//   Architecture (V-047):
//     - Documents live at docs/legal/*.md; text is source of truth;
//       service does not store the text.
//     - Loaded at startup as LegalDocumentCatalog with stable
//       documentKey ('tos' | 'privacy' | 'dpa' | 'aup') + version +
//       contentHash + display path.
//     - Startup reads docs/legal/*.md, computes SHA-256, parses
//       version, builds catalog. Missing doc / unparseable version =
//       server fails fast.
//     - POST /v1/legal/accept writes a legal_acceptances row:
//       (account, doc, version, content_hash, accepted_at, ip,
//       user_agent).
//     - /v1/legal/required compares catalog vs latest per-doc
//       acceptance.
//
//   Re-acceptance on version bump — 'minor / major version bumps
//   render prior acceptances stale. The check is "does the latest
//   acceptance for (account, doc) match the currently-published
//   version?" — if not, the account is required to re-accept'.
//
//   RequiredAcceptance 5-field shape: documentKey + currentVersion
//     + contentHash + reason (3-value union) + lastAcceptedVersion
//     (nullable).
//
//   Reason 3-value union: 'never_accepted' | 'version_outdated' |
//     'content_hash_changed'.
//
//   LegalAcceptanceRecord 8-field shape: id + accountId + documentKey
//     + version + contentHash + acceptedFromIp (nullable) +
//     acceptedUserAgent (nullable) + acceptedAt.
//
//   recordAcceptance rejects stale-cached client input — 'protects
//   against acceptance of a stale document the client cached while
//   a revision shipped' via LegalDocumentMismatchError.
//
//   LegalDocumentMismatchError 5-field structured error: documentKey
//     + providedVersion + currentVersion + providedHash + currentHash.
//
//   LegalRepo 2-method interface: recordAcceptance + latest-
//     AcceptancesForAccount.
//
//   Patch bumps NOT enforced as re-acceptance triggers (catalog
//     config chooses).
//
// stays in lockstep across apps/server/src/services/legal.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LegalDocumentMismatchError,
  LegalDocumentNotFoundError,
} from '../../src/services/legal.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W945 V-047 LegalService cross-source invariant', () => {
  // ─── Header intro + V-047 anchor ─────────────────────────────

  it("CRITICAL apps/server/src/services/legal.ts header pins V-047 anchor — 'LegalService — customer acceptance of legal documents (ToS, Privacy Policy, DPA, AUP)' + 'Architecture (V-047)'. The V-047 anchor + 4-doc scope is the policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/legal.ts'));
    expect(p).toMatch(/LegalService — customer acceptance of legal documents \(ToS, Privacy/);
    expect(p).toMatch(/Policy, DPA, AUP\)\./);
    expect(p).toMatch(/Architecture \(V-047\):/);
  });

  // ─── Docs-source-of-truth framing ────────────────────────────

  it("CRITICAL docs-source framing — 'Documents live at docs/legal/*.md. Their text is the source of truth; this service does not store the text'. The service-doesnt-store-text design keeps legal text + code rev in lockstep.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/legal.ts'));
    expect(p).toMatch(/Documents live at `docs\/legal\/\*\.md`\. Their text is the source of/);
    expect(p).toMatch(/truth; this service does not store the text\./);
  });

  // ─── 4-doc catalog framing ───────────────────────────────────

  it("CRITICAL 4-doc catalog framing — 'Each entry binds a stable documentKey (tos | privacy | dpa | aup) to the document's current version + content hash + display path'. The 4-doc stable-key set is the V-047 catalog contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/legal.ts'));
    expect(p).toMatch(/Each entry binds a stable `documentKey`/);
    expect(p).toMatch(/\('tos' \| 'privacy' \| 'dpa' \| 'aup'\) to the document's current/);
    expect(p).toMatch(/version \+ content hash \+ display path/);
  });

  // ─── Fail-fast on missing / unparseable framing ──────────────

  it("CRITICAL fail-fast framing — 'On startup, the server reads docs/legal/*.md, computes SHA-256 of the content, parses the version from the document header, and builds the catalog. If a doc is missing or the version is unparseable, the server fails fast — better than silently serving stale content'. The fail-fast guard prevents silent legal-doc drift.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/legal.ts'));
    expect(p).toMatch(/On startup, the server reads `docs\/legal\/\*\.md`, computes SHA-256/);
    expect(p).toMatch(/of the content, parses the version from the document header, and/);
    expect(p).toMatch(/builds the catalog\. If a doc is missing or the version is/);
    expect(p).toMatch(/unparseable, the server fails fast — better than silently serving/);
    expect(p).toMatch(/stale content\./);
  });

  // ─── Acceptance row shape framing ────────────────────────────

  it("CRITICAL POST /v1/legal/accept framing — 'writes a row to legal_acceptances recording (account, doc, version, content_hash, accepted_at, ip, user_agent)'. The 7-field acceptance row is the legal-trail data shape.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/legal.ts'));
    expect(p).toMatch(/Customers accept documents through `POST \/v1\/legal\/accept`, which/);
    expect(p).toMatch(/writes a row to `legal_acceptances` recording \(account, doc,/);
    expect(p).toMatch(/version, content_hash, accepted_at, ip, user_agent\)/);
  });

  // ─── Re-acceptance on version-bump framing ───────────────────

  it('V-1008 CRITICAL re-acceptance framing — ANY change to the version string makes prior acceptances stale, by whole-string inequality with no semver and no per-document opt-out. This arm used to pin a minor/major-required + patch-optional split as "the version-bump policy"; there is no such split, and the setting it credited for one has never existed. required() gates API-key minting, so a typo fix in a legal document blocks every account until it re-accepts.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/legal.ts'));
    expect(p).toMatch(/Re-acceptance on version bump: ANY change to a document's version/);
    expect(p).toMatch(/string renders prior acceptances stale\./);
    expect(p).toMatch(/for \(account, doc\) match the currently-published version\?"/);
    // The retracted claims, paraphrased in the negative.
    expect(p).not.toMatch(/[Pp]atch bumps are not enforced/);
    expect(p).not.toMatch(/catalog config\s*\/\/\s*chooses/);
    // The behaviour the wording now has to keep describing.
    expect(p).toMatch(/whole-string inequality/);
  });

  // ─── RequiredAcceptance 5-field shape ────────────────────────

  it('CRITICAL RequiredAcceptance has 5 fields — documentKey + currentVersion + contentHash + reason (3-value union) + lastAcceptedVersion (nullable). The 5-field row is the dashboard/SDK pending-acceptance shape.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/legal.ts'));
    expect(p).toMatch(/export interface RequiredAcceptance \{/);
    expect(p).toMatch(/documentKey: string;/);
    expect(p).toMatch(/currentVersion: string;/);
    expect(p).toMatch(/contentHash: string;/);
    expect(p).toMatch(/reason: 'never_accepted' \| 'version_outdated' \| 'content_hash_changed';/);
    expect(p).toMatch(/Last version \(if any\) the account previously accepted/);
    expect(p).toMatch(/lastAcceptedVersion: string \| null;/);
  });

  // ─── Reason 3-value union framing ────────────────────────────

  it("CRITICAL reason 3-value union — 'never_accepted' | 'version_outdated' | 'content_hash_changed'. The 3-reason taxonomy distinguishes never-seen from version-bumped from same-version-text-changed.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/legal.ts'));
    expect(p).toMatch(/'never_accepted' \| 'version_outdated' \| 'content_hash_changed'/);
  });

  // ─── LegalAcceptanceRecord 8-field shape ─────────────────────

  it('CRITICAL LegalAcceptanceRecord has 8 fields — id + accountId + documentKey + version + contentHash + acceptedFromIp (nullable) + acceptedUserAgent (nullable) + acceptedAt. The 8-field row is the legal-trail audit shape.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/legal.ts'));
    expect(p).toMatch(/export interface LegalAcceptanceRecord \{/);
    expect(p).toMatch(/id: string;/);
    expect(p).toMatch(/accountId: string;/);
    expect(p).toMatch(/documentKey: string;/);
    expect(p).toMatch(/version: string;/);
    expect(p).toMatch(/contentHash: string;/);
    expect(p).toMatch(/acceptedFromIp: string \| null;/);
    expect(p).toMatch(/acceptedUserAgent: string \| null;/);
    expect(p).toMatch(/acceptedAt: Date;/);
  });

  // ─── LegalRepo 2-method interface ────────────────────────────

  it('CRITICAL LegalRepo has 2 methods — recordAcceptance + latestAcceptancesForAccount (returns Map keyed by documentKey). The 2-method storage seam covers per-row writes + per-account-doc reads.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/legal.ts'));
    expect(p).toMatch(/export interface LegalRepo \{/);
    expect(p).toMatch(
      /recordAcceptance\(input: RecordAcceptanceInput\): Promise<LegalAcceptanceRecord>;/,
    );
    expect(p).toMatch(
      /Latest acceptance per \(account, document_key\)\. Returns Map keyed by documentKey/,
    );
    expect(p).toMatch(
      /latestAcceptancesForAccount\(accountId: string\): Promise<Map<string, LegalAcceptanceRecord>>/,
    );
  });

  // ─── recordAcceptance stale-cache rejection framing ──────────

  it("CRITICAL recordAcceptance JSDoc — 'Record customer acceptance. The customer supplies the version + content_hash they're accepting. The service rejects if either doesn't match the current published catalog — protects against acceptance of a stale document the client cached while a revision shipped'. The version-hash-must-match contract is what prevents stale-cache acceptance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/legal.ts'));
    expect(p).toMatch(/Record customer acceptance\./);
    expect(p).toMatch(/The customer supplies the version \+ content_hash they're accepting\./);
    expect(p).toMatch(/The service rejects if either doesn't match the current published/);
    expect(p).toMatch(/catalog — protects against acceptance of a stale document the/);
    expect(p).toMatch(/client cached while a revision shipped\./);
  });

  it('CRITICAL recordAcceptance rejects via LegalDocumentMismatchError when current.version !== input.version OR current.contentHash !== input.contentHash. The 2-condition OR-mismatch is the dual-guard against version + hash drift.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/legal.ts'));
    expect(p).toMatch(
      /if \(current\.version !== input\.version \|\| current\.contentHash !== input\.contentHash\) \{/,
    );
    expect(p).toMatch(/throw new LegalDocumentMismatchError\(\{/);
  });

  // ─── LegalDocumentMismatchError 5-field structured ───────────

  it('CRITICAL LegalDocumentMismatchError 5 readonly fields — documentKey + providedVersion + currentVersion + providedHash + currentHash. The 5-field structured error lets API responses surface both sides of the mismatch.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/legal.ts'));
    expect(p).toMatch(/export class LegalDocumentMismatchError extends Error \{/);
    expect(p).toMatch(/readonly documentKey: string;/);
    expect(p).toMatch(/readonly providedVersion: string;/);
    expect(p).toMatch(/readonly currentVersion: string;/);
    expect(p).toMatch(/readonly providedHash: string;/);
    expect(p).toMatch(/readonly currentHash: string;/);
  });

  it("CRITICAL LegalDocumentMismatchError message format — 'Legal document mismatch on X: provided V/HASH..., current V/HASH...' with 12-char hash truncation. The truncated-hash format gives operators readable error logs.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/legal.ts'));
    expect(p).toMatch(
      /`Legal document mismatch on \$\{opts\.documentKey\}: provided \$\{opts\.providedVersion\}\/\$\{opts\.providedHash\.slice\(0, 12\)\}…,/,
    );
    expect(p).toMatch(
      /current \$\{opts\.currentVersion\}\/\$\{opts\.currentHash\.slice\(0, 12\)\}…/,
    );
  });

  // ─── LegalDocumentNotFoundError ──────────────────────────────

  it("CRITICAL LegalDocumentNotFoundError carries documentKey readonly field + message 'Legal document not found: X'. The structured-error + interpolated-key matches the LegalDocumentMismatchError pattern.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/legal.ts'));
    expect(p).toMatch(/export class LegalDocumentNotFoundError extends Error \{/);
    expect(p).toMatch(/readonly documentKey: string;/);
    expect(p).toMatch(/`Legal document not found: \$\{documentKey\}`/);
  });

  it('CRITICAL LegalDocumentMismatchError runtime — constructor accepts 5-field opts + super message contains 12-char hash slice. Mechanically verified via instantiation.', () => {
    const err = new LegalDocumentMismatchError({
      documentKey: 'tos',
      providedVersion: '0.1.0',
      currentVersion: '0.2.0',
      providedHash: 'abcdef0123456789aaaaaaaaaaaaaaaaaa',
      currentHash: '9876543210fedcbabbbbbbbbbbbbbbbb',
    });
    expect(err.name).toBe('LegalDocumentMismatchError');
    expect(err.documentKey).toBe('tos');
    expect(err.providedVersion).toBe('0.1.0');
    expect(err.currentVersion).toBe('0.2.0');
    expect(err.message).toContain('tos');
    expect(err.message).toContain('abcdef012345'); // 12-char hash prefix
    expect(err.message).toContain('9876543210fe');
  });

  it('CRITICAL LegalDocumentNotFoundError runtime — documentKey readonly + name + interpolated message. Mechanically verified.', () => {
    const err = new LegalDocumentNotFoundError('dpa');
    expect(err.name).toBe('LegalDocumentNotFoundError');
    expect(err.documentKey).toBe('dpa');
    expect(err.message).toBe('Legal document not found: dpa');
  });

  // ─── LegalService get() throws NotFound ──────────────────────

  it('CRITICAL LegalService.get(documentKey) throws LegalDocumentNotFoundError when catalog.get returns undefined. The lookup-then-throw pattern matches the W919 / W931 NotFoundError convention.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/legal.ts'));
    expect(p).toMatch(/get\(documentKey: string\): LegalDocumentEntry \{/);
    expect(p).toMatch(/const entry = this\.catalog\.get\(documentKey\);/);
    expect(p).toMatch(
      /if \(entry === undefined\) throw new LegalDocumentNotFoundError\(documentKey\);/,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/legal-v047-cross-source-invariant.test.ts'),
      ),
    ).toBe(true);
  });
});
