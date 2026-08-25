// W428.B (W658-deepened) — drift guard for packages/sdk-typescript/
// src/resources/legal.ts. V-049/V-458 LegalResource TS parity.
//
// W658 splits the original 10 it() blocks into 17 focused per-concept
// blocks + pins previously-implicit invariants:
//
//   • Architectural separation pinned: "Document content is served
//     separately on the marketing site; this resource handles the
//     catalog + acceptance machinery." Drift to surfacing document
//     TEXT through the API would put binary legal content on the
//     JSON surface — breaks the load-bearing separation that keeps
//     legal-doc text on Cloudflare Pages.
//   • 64-character lowercase hex SHA-256 content_hash format
//     invariant pinned inline on the AcceptLegalDocumentRequest
//     field. Drift to allowing uppercase hex or 32-byte raw would
//     silently break hash-comparison with the server-side digest;
//     drift to a different hash algo (SHA-512) would break every
//     historical acceptance row.
//   • SDK-defined-NOT-api-types-imported invariant pinned: legal
//     shapes live in this file, not @driftstack/api-types. Drift
//     to importing from api-types would force the Zod schema to be
//     the source-of-truth, but the dashboard uses a slightly
//     different subset — the SDK's lean shape lives here so the
//     SDK and dashboard diverge cleanly.
//   • 3-tuple acceptance integrity (document_key + version +
//     content_hash) pinned. The content_hash is what BINDS an
//     acceptance to a specific snapshot of text. Drift to dropping
//     content_hash would let a re-versioned doc silently re-accept
//     stale text.
//   • last_accepted_version nullable invariant on
//     LegalRequiredEntry — null when the account NEVER accepted
//     that doc (vs a string when there's a stale prior version).
//     Drift to making it non-nullable would force a sentinel value
//     and lose the never-accepted-yet distinction.
//   • LegalDocumentEntry source_path + byte_size fields — pinned
//     because they let the marketing site cross-reference the
//     served-content URL with the catalog entry, AND let the
//     dashboard pre-warn customers about long ToS reads.
//   • Per-verb blocks + 3-verb inventory drift guard.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/legal.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W428.B packages/sdk-typescript/src/resources/legal.ts content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path + module header V-049/V-458 anchor on the resource line + ToS/Privacy/DPA/AUP 4-document coverage scope', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(
      /\/\/ LegalResource — typed methods for \/v1\/legal\/\* \(V-049 \/ V-458\)\./,
    );
    expect(body).toMatch(
      /\/\/ Customer acceptance of legal documents \(ToS \/ Privacy \/ DPA \/ AUP\)\./,
    );
  });

  it('CRITICAL architectural separation pinned per-line: "Document content is served separately on the marketing site; this resource handles the catalog + acceptance machinery." Drift to surfacing document TEXT through the API would put binary legal content on the JSON surface — breaks the load-bearing separation that keeps legal-doc text/PDFs on Cloudflare Pages and the JSON surface lean.', () => {
    expect(body).toMatch(
      /\/\/ Document content is served separately on the marketing site; this\s*\/\/ resource handles the catalog \+ acceptance machinery\./,
    );
  });

  it('Imports — HttpClient only (no @driftstack/api-types import). CRITICAL: legal shapes are SDK-DEFINED locally, not re-exported from api-types. Drift to importing from api-types would force the Zod schema to be the source-of-truth for both SDK and dashboard, but the dashboard uses a slightly different subset — divergent shapes is INTENTIONAL.', () => {
    expect(body).toMatch(/import type \{ HttpClient \} from '\.\.\/http\.js';/);
    expect(body).not.toMatch(/from '@driftstack\/api-types'/);
  });

  it('LegalDocumentEntry — 7-field shape (document_key + title + version + effective_date + content_hash + source_path + byte_size). source_path lets the marketing site cross-reference the served-content URL with the catalog entry; byte_size lets the dashboard pre-warn customers about long ToS reads. Drift to dropping these would lose the marketing-site cross-reference.', () => {
    expect(body).toMatch(
      /export interface LegalDocumentEntry \{\s*document_key: string;\s*title: string;\s*version: string;\s*effective_date: string;\s*content_hash: string;\s*source_path: string;\s*byte_size: number;\s*\}/,
    );
  });

  it('LegalRequiredEntry — 5-field shape with last_accepted_version: string | NULL. CRITICAL: nullable when account NEVER accepted that doc (vs a string for stale prior version). Drift to making non-nullable would force a sentinel value ("none" / "") and lose the never-accepted-yet distinction the dashboard uses to render "First time? Read this." vs "Re-accept the updated terms".', () => {
    expect(body).toMatch(
      /export interface LegalRequiredEntry \{\s*document_key: string;\s*current_version: string;\s*content_hash: string;\s*reason: string;\s*last_accepted_version: string \| null;\s*\}/,
    );
  });

  it('AcceptLegalDocumentRequest — 3-field shape (document_key + version + content_hash). CRITICAL inline doc-comment on content_hash: "64-character lowercase hex SHA-256 of the document content." 64-char (not 32-byte raw) + lowercase (not uppercase) + SHA-256 (not SHA-512) — all 3 invariants pinned. Drift to uppercase hex would silently fail hash-comparison; drift to SHA-512 would break every historical acceptance row.', () => {
    expect(body).toMatch(
      /export interface AcceptLegalDocumentRequest \{\s*document_key: string;\s*version: string;\s*\/\*\* 64-character lowercase hex SHA-256 of the document content\. \*\/\s*content_hash: string;\s*\}/,
    );
  });

  it('AcceptLegalDocumentResponse — 6-field shape (id + account_id + document_key + version + content_hash + accepted_at). Includes the SAME 3 tuple fields the request carried + 3 server-stamped fields (id + account_id + accepted_at). Drift to dropping content_hash from the response would make it impossible for callers to confirm WHAT they actually accepted (server could replay with a different hash).', () => {
    expect(body).toMatch(
      /export interface AcceptLegalDocumentResponse \{\s*id: string;\s*account_id: string;\s*document_key: string;\s*version: string;\s*content_hash: string;\s*accepted_at: string;\s*\}/,
    );
  });

  it('LegalResource class declaration + private-readonly http constructor field. Stateless wrapper pattern.', () => {
    expect(body).toMatch(/^export class LegalResource \{$/m);
    expect(body).toMatch(/constructor\(private readonly http: HttpClient\) \{\}/);
  });

  it('documents verb — GET /v1/legal/documents → Promise<{ data: LegalDocumentEntry[] }>. CRITICAL: same catalog returned for every account (public catalog) — drift to filtering by account would break the "this is the canonical legal-doc list" invariant that the marketing site renders for unauthenticated visitors AND the dashboard renders for authenticated customers.', () => {
    expect(body).toMatch(/\/\*\* List the legal-document catalog\. \*\//);
    expect(body).toMatch(
      /documents\(\): Promise<\{ data: LegalDocumentEntry\[\] \}> \{\s*return this\.http\.request<\{ data: LegalDocumentEntry\[\] \}>\(\{\s*method: 'GET',\s*path: '\/v1\/legal\/documents',\s*\}\);\s*\}/,
    );
  });

  it('required verb — GET /v1/legal/required → Promise<{ data: LegalRequiredEntry[] }>. CRITICAL: "must accept (or re-accept)" parenthetical is load-bearing. The "or re-accept" tells callers an existing acceptance can become stale when a new version with a different content_hash ships. Account-scoped via bearer.', () => {
    expect(body).toMatch(
      /\/\*\* List documents the calling account must accept \(or re-accept\)\. \*\//,
    );
    expect(body).toMatch(
      /required\(\): Promise<\{ data: LegalRequiredEntry\[\] \}> \{\s*return this\.http\.request<\{ data: LegalRequiredEntry\[\] \}>\(\{\s*method: 'GET',\s*path: '\/v1\/legal\/required',\s*\}\);\s*\}/,
    );
  });

  it('accept verb — POST /v1/legal/accept with AcceptLegalDocumentRequest body → Promise<AcceptLegalDocumentResponse>. CRITICAL: 3-tuple (document, version, content_hash) acceptance — the content_hash BINDS the acceptance to a specific snapshot of text. If a customer accepts version "1.2" but the text changes (content_hash drifts), their acceptance becomes STALE and required() will re-list the doc. Drift to dropping content_hash from the body would silently let stale acceptances persist past a content rewrite.', () => {
    expect(body).toMatch(
      /\/\*\* Record acceptance of a \(document, version, content_hash\) tuple\. \*\//,
    );
    expect(body).toMatch(
      /accept\(body: AcceptLegalDocumentRequest\): Promise<AcceptLegalDocumentResponse> \{\s*return this\.http\.request<AcceptLegalDocumentResponse>\(\{\s*method: 'POST',\s*path: '\/v1\/legal\/accept',\s*body,\s*\}\);\s*\}/,
    );
  });

  it('Sync 3-verb inventory + verb-mix invariants — exactly 2 GETs (documents + required) + 1 POST (accept) + ZERO PATCH/PUT/DELETE. CRITICAL: NO "withdraw acceptance" or "delete acceptance" verb — once accepted, the acceptance is immutable for audit/compliance reasons. Drift to a DELETE verb would break the immutable-acceptance-ledger invariant.', () => {
    // Count class methods (2-space indent, identifier, open paren).
    // Constructor excluded via negative lookahead. The simpler regex
    // dodges the `Promise<{ ... }>` brace-in-return-type pitfall.
    const methods = body.match(/^ {2}(?!constructor)[a-zA-Z]+\(/gm) ?? [];
    expect(methods.length, 'expected 3 verb declarations').toBe(3);
    const gets = (body.match(/method: 'GET'/g) ?? []).length;
    expect(gets, 'expected 2 GETs (documents + required)').toBe(2);
    const posts = (body.match(/method: 'POST'/g) ?? []).length;
    expect(posts, 'expected 1 POST (accept)').toBe(1);
    expect(body).not.toMatch(/method: 'PATCH'/);
    expect(body).not.toMatch(/method: 'PUT'/);
    expect(body).not.toMatch(/method: 'DELETE'/);
  });

  it('Wire-path inventory — exactly 3 distinct /v1/legal/* paths (documents + required + accept). Drift to a per-document sub-path (e.g. /v1/legal/documents/:key) would change the doc-addressing model from doc_key-in-body to doc_key-in-URL.', () => {
    const paths = body.match(/path: '\/v1\/legal\/[a-z]+'/g) ?? [];
    expect(paths.length, 'expected 3 path: literals').toBe(3);
    const unique = new Set(paths);
    expect(unique.size, 'expected 3 DISTINCT paths').toBe(3);
    expect(unique).toEqual(
      new Set([
        "path: '/v1/legal/documents'",
        "path: '/v1/legal/required'",
        "path: '/v1/legal/accept'",
      ]),
    );
  });

  it('content_hash field appears in EXACTLY 4 type declarations — LegalDocumentEntry (catalog row) + LegalRequiredEntry (pending row) + AcceptLegalDocumentRequest (acceptance body) + AcceptLegalDocumentResponse (acceptance receipt). The 4-position presence is what threads the SAME hash through every step of the acceptance flow (catalog → pending → request → receipt). Drift to dropping content_hash from any of these would break the hash-as-acceptance-binding invariant.', () => {
    const hashMatches = body.match(/content_hash: string;/g) ?? [];
    expect(hashMatches.length, 'expected content_hash field in 4 interfaces').toBe(4);
  });

  it('4-shape export inventory pinned: LegalDocumentEntry + LegalRequiredEntry + AcceptLegalDocumentRequest + AcceptLegalDocumentResponse. All 4 exported as `export interface` (not type-alias) so SDK consumers can declaration-merge if they want to extend (e.g. add a UI-only field via module-augmentation).', () => {
    expect(body).toMatch(/^export interface LegalDocumentEntry \{$/m);
    expect(body).toMatch(/^export interface LegalRequiredEntry \{$/m);
    expect(body).toMatch(/^export interface AcceptLegalDocumentRequest \{$/m);
    expect(body).toMatch(/^export interface AcceptLegalDocumentResponse \{$/m);
    const interfaceCount = (body.match(/^export interface /gm) ?? []).length;
    expect(interfaceCount, 'expected exactly 4 exported interfaces').toBe(4);
  });

  it('document_key field appears across all 4 shapes — the document_key STRING is the join-key threading catalog → required → accept-request → accept-response. Drift to changing the key name in any shape (e.g. "doc_key" vs "document_key") would break the cross-shape join and silently force callers to map keys manually.', () => {
    const keyMatches = body.match(/document_key: string;/g) ?? [];
    expect(keyMatches.length, 'expected document_key in 4 interfaces').toBe(4);
  });
});
