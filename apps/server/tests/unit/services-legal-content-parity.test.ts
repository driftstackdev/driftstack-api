// W400.C — drift guard for apps/server/src/services/legal.ts.
// V-047 customer acceptance of legal documents. Drift here either
// lets acceptance of a stale document slip through (regulatory
// risk — customer never actually consented to current ToS) or
// breaks the re-acceptance trigger on version bumps.
//
//   • V-047 architecture framing: catalog source-of-truth + legal_
//     acceptances table.
//   • Re-acceptance rules: minor / major version bumps render prior
//     acceptances stale; patch bumps NOT enforced (catalog config
//     ships them as re-acceptance via content_hash_changed reason).
//   • RequiredAcceptance: 5 fields with 3-reason union (never_accepted
//     / version_outdated / content_hash_changed).
//   • LegalAcceptanceRecord: 8 fields including ip + UA + accepted_at.
//   • LegalDocumentMismatchError: 4 fields exposed (documentKey +
//     providedVersion + currentVersion + providedHash + currentHash);
//     truncates hashes to 12 chars in error message.
//   • LegalDocumentNotFoundError: documentKey property exposed.
//   • recordAcceptance: rejects when EITHER provided version OR
//     provided contentHash mismatches current catalog (stale-doc
//     acceptance protection — protects against client cached a doc
//     while a revision shipped).
//   • required: 3-clause cascade per entry — never_accepted →
//     version_outdated → content_hash_changed (patch-level edit
//     surfaced as content_hash_changed reason).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/legal.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W400.C apps/server/src/services/legal.ts content parity', () => {
  const body = read(LIB);

  it('V-047 architecture framing: 4 docs (ToS + Privacy + DPA + AUP), catalog source-of-truth, server-fails-fast', () => {
    expect(body).toMatch(
      /LegalService — customer acceptance of legal documents \(ToS, Privacy\s*\n?\s*\/\/\s*Policy, DPA, AUP\)\./,
    );
    expect(body).toMatch(/Architecture \(V-047\):/);
    expect(body).toMatch(
      /Documents live at `docs\/legal\/\*\.md`\. Their text is the source of\s*\n?\s*\/\/\s*truth; this service does not store the text\./,
    );
    expect(body).toMatch(
      /If a doc is missing or the version is\s*\n?\s*\/\/\s*unparseable, the server fails fast — better than silently serving\s*\n?\s*\/\/\s*stale content\./,
    );
  });

  it('POST /v1/legal/accept framing pinned: legal_acceptances table fields (account, doc, version, content_hash, accepted_at, ip, user_agent)', () => {
    expect(body).toMatch(
      /Customers accept documents through `POST \/v1\/legal\/accept`, which\s*\n?\s*\/\/\s*writes a row to `legal_acceptances` recording \(account, doc,\s*\n?\s*\/\/\s*version, content_hash, accepted_at, ip, user_agent\)\./,
    );
  });

  it('Re-acceptance rules pinned: minor/major bump stale; patch bump opt-in via catalog config', () => {
    expect(body).toMatch(
      /Re-acceptance on version bump: minor \/ major version bumps render\s*\n?\s*\/\/\s*prior acceptances stale\. The check is "does the latest acceptance\s*\n?\s*\/\/\s*for \(account, doc\) match the currently-published version\?" — if not,\s*\n?\s*\/\/\s*the account is required to re-accept\. Patch bumps are not enforced\s*\n?\s*\/\/\s*as re-acceptance triggers in this service; the catalog config\s*\n?\s*\/\/\s*chooses whether to ship a patch as a re-acceptance event\./,
    );
  });

  it('RequiredAcceptance: 5 fields with 3-reason union (never_accepted / version_outdated / content_hash_changed) + lastAcceptedVersion nullable', () => {
    expect(body).toMatch(/export interface RequiredAcceptance \{/);
    expect(body).toMatch(/documentKey: string;/);
    expect(body).toMatch(/currentVersion: string;/);
    expect(body).toMatch(/contentHash: string;/);
    expect(body).toMatch(
      /reason: 'never_accepted' \| 'version_outdated' \| 'content_hash_changed';/,
    );
    expect(body).toMatch(
      /\/\*\* Last version \(if any\) the account previously accepted\. \*\/\s*\n?\s*lastAcceptedVersion: string \| null;/,
    );
  });

  it('LegalAcceptanceRecord: 8 fields (id / accountId / documentKey / version / contentHash / acceptedFromIp / acceptedUserAgent / acceptedAt)', () => {
    expect(body).toMatch(/export interface LegalAcceptanceRecord \{/);
    expect(body).toMatch(/id: string;/);
    expect(body).toMatch(/accountId: string;/);
    expect(body).toMatch(/documentKey: string;/);
    expect(body).toMatch(/version: string;/);
    expect(body).toMatch(/contentHash: string;/);
    expect(body).toMatch(/acceptedFromIp: string \| null;/);
    expect(body).toMatch(/acceptedUserAgent: string \| null;/);
    expect(body).toMatch(/acceptedAt: Date;/);
  });

  it('LegalRepo: 2 methods (recordAcceptance / latestAcceptancesForAccount returning Map<documentKey, record>)', () => {
    expect(body).toMatch(/export interface LegalRepo \{/);
    expect(body).toMatch(
      /recordAcceptance\(input: RecordAcceptanceInput\): Promise<LegalAcceptanceRecord>;/,
    );
    expect(body).toMatch(
      /\/\*\* Latest acceptance per \(account, document_key\)\. Returns Map keyed by documentKey\. \*\/\s*\n?\s*latestAcceptancesForAccount\(accountId: string\): Promise<Map<string, LegalAcceptanceRecord>>;/,
    );
  });

  it('LegalDocumentMismatchError: 5 readonly fields + truncated-hash error message (12 chars + …)', () => {
    expect(body).toMatch(/export class LegalDocumentMismatchError extends Error \{/);
    expect(body).toMatch(/readonly documentKey: string;/);
    expect(body).toMatch(/readonly providedVersion: string;/);
    expect(body).toMatch(/readonly currentVersion: string;/);
    expect(body).toMatch(/readonly providedHash: string;/);
    expect(body).toMatch(/readonly currentHash: string;/);
    expect(body).toMatch(
      /`Legal document mismatch on \$\{opts\.documentKey\}: provided \$\{opts\.providedVersion\}\/\$\{opts\.providedHash\.slice\(0, 12\)\}…, current \$\{opts\.currentVersion\}\/\$\{opts\.currentHash\.slice\(0, 12\)\}…`/,
    );
    expect(body).toMatch(/this\.name = 'LegalDocumentMismatchError';/);
  });

  it('LegalDocumentNotFoundError: readonly documentKey + message includes documentKey', () => {
    expect(body).toMatch(/export class LegalDocumentNotFoundError extends Error \{/);
    expect(body).toMatch(/readonly documentKey: string;/);
    expect(body).toMatch(
      /constructor\(documentKey: string\) \{\s*\n?\s*super\(`Legal document not found: \$\{documentKey\}`\);\s*\n?\s*this\.name = 'LegalDocumentNotFoundError';\s*\n?\s*this\.documentKey = documentKey;\s*\n?\s*\}/,
    );
  });

  it('LegalService: catalog + repo constructor; list() = catalog.entries(); get() = catalog.get(key)-or-throw', () => {
    expect(body).toMatch(/export class LegalService \{/);
    expect(body).toMatch(
      /constructor\(\s*\n?\s*private readonly catalog: LegalDocumentCatalog,\s*\n?\s*private readonly repo: LegalRepo,\s*\n?\s*\) \{\}/,
    );
    expect(body).toMatch(
      /list\(\): LegalDocumentEntry\[\] \{\s*\n?\s*return this\.catalog\.entries\(\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /get\(documentKey: string\): LegalDocumentEntry \{\s*\n?\s*const entry = this\.catalog\.get\(documentKey\);\s*\n?\s*if \(entry === undefined\) throw new LegalDocumentNotFoundError\(documentKey\);\s*\n?\s*return entry;\s*\n?\s*\}/,
    );
  });

  it('recordAcceptance: rejects when EITHER version OR contentHash mismatches current catalog (stale-acceptance protection)', () => {
    expect(body).toMatch(
      /The customer supplies the version \+ content_hash they're accepting\.\s*\n?\s*\*\s*The service rejects if either doesn't match the current published\s*\n?\s*\*\s*catalog — protects against acceptance of a stale document the\s*\n?\s*\*\s*client cached while a revision shipped\./,
    );
    expect(body).toMatch(/const current = this\.catalog\.get\(input\.documentKey\);/);
    expect(body).toMatch(
      /if \(current === undefined\) \{\s*\n?\s*throw new LegalDocumentNotFoundError\(input\.documentKey\);/,
    );
    expect(body).toMatch(
      /if \(current\.version !== input\.version \|\| current\.contentHash !== input\.contentHash\) \{\s*\n?\s*throw new LegalDocumentMismatchError\(\{[\s\S]+?documentKey: input\.documentKey,\s*\n?\s*providedVersion: input\.version,\s*\n?\s*currentVersion: current\.version,\s*\n?\s*providedHash: input\.contentHash,\s*\n?\s*currentHash: current\.contentHash,/,
    );
  });

  it('required: 3-clause cascade per entry — never_accepted → version_outdated → content_hash_changed', () => {
    expect(body).toMatch(
      /Returns the list of documents the account still needs to accept\s*\n?\s*\*\s*\(or re-accept\)\. Empty list = account is current on every document\./,
    );
    // never_accepted: acceptance row absent
    expect(body).toMatch(
      /if \(accepted === undefined\) \{\s*\n?\s*out\.push\(\{[\s\S]+?reason: 'never_accepted',\s*\n?\s*lastAcceptedVersion: null,/,
    );
    // version_outdated: version mismatch
    expect(body).toMatch(
      /if \(accepted\.version !== entry\.version\) \{\s*\n?\s*out\.push\(\{[\s\S]+?reason: 'version_outdated',\s*\n?\s*lastAcceptedVersion: accepted\.version,/,
    );
    // content_hash_changed: same version, different hash
    expect(body).toMatch(
      /\/\/ Same version string but content hash differs — patch-level\s*\n?\s*\/\/ edit landed without a version bump\. The catalog policy is to\s*\n?\s*\/\/ surface this as a content_hash_changed reason\./,
    );
    // V-821 — the comment must state that this reason GATES, because it does:
    // api-keys.ts create() throws on `pending.length > 0` with no filter on
    // reason, so a content-only edit blocks minting account-wide.
    expect(body).toMatch(/blocks API-key minting for EVERY account/);
    // SENTINEL — the retired discretion claim must not return. No route layer
    // decides anything here; both callers treat every reason identically.
    expect(body, 'no route layer exercises this discretion').not.toMatch(
      /layer can decide whether to gate on it/,
    );
    expect(body).toMatch(
      /if \(accepted\.contentHash !== entry\.contentHash\) \{[\s\S]+?reason: 'content_hash_changed',\s*\n?\s*lastAcceptedVersion: accepted\.version,/,
    );
  });

  it('imports: LegalDocumentCatalog + LegalDocumentEntry types from ./legal-catalog.js', () => {
    expect(body).toMatch(
      /import type \{ LegalDocumentCatalog, LegalDocumentEntry \} from '\.\/legal-catalog\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
