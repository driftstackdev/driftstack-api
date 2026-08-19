// LegalService — customer acceptance of legal documents (ToS, Privacy
// Policy, DPA, AUP).
//
// Architecture (V-047):
//
// - Documents live at `docs/legal/*.md`. Their text is the source of
//   truth; this service does not store the text.
// - Documents are loaded into memory at server start as a
//   `LegalDocumentCatalog`. Each entry binds a stable `documentKey`
//   ('tos' | 'privacy' | 'dpa' | 'aup') to the document's current
//   version + content hash + display path.
// - On startup, the server reads `docs/legal/*.md`, computes SHA-256
//   of the content, parses the version from the document header, and
//   builds the catalog. If a doc is missing or the version is
//   unparseable, the server fails fast — better than silently serving
//   stale content.
// - Customers accept documents through `POST /v1/legal/accept`, which
//   writes a row to `legal_acceptances` recording (account, doc,
//   version, content_hash, accepted_at, ip, user_agent).
// - The `legal/required` endpoint compares the catalog against each
//   account's most recent acceptance per document and returns the
//   list of documents the account needs to accept (or re-accept).
//
// Re-acceptance on version bump: ANY change to a document's version
// string renders prior acceptances stale. The check is "does the latest
// acceptance for (account, doc) match the currently-published version?"
// — if not, the account is required to re-accept.
//
// V-1008 — this paragraph used to exempt patch-level bumps from
// triggering re-acceptance, and to attribute that choice to a per-document
// setting in the catalog. Both halves were false, and the second described
// a mechanism that has never existed:
//
//   • The comparison below is `accepted.version !== entry.version` — a
//     whole-string inequality. No semver parsing exists anywhere in this
//     service or in legal-catalog.ts, which captures the version as an
//     opaque token. 0.1.0 → 0.1.1 is simply a different string.
//   • There is no catalog config to choose with. `DocSource` carries
//     documentKey, title and filePath; `LegalDocumentEntry` has no
//     re-acceptance flag.
//
// The consequence is not academic. `required()` is the API-key issuance
// gate — `services/api-keys.ts` throws LegalAcceptanceRequiredError on
// any non-empty result — so editing a legal document's version to fix a
// typo blocks key minting for EVERY account until each re-accepts. The
// old comment is exactly what would convince the person making that edit
// it was safe.
//
// A content edit WITHOUT a version bump is also surfaced, as
// `content_hash_changed`, and is enforced the same way: `routes/legal.ts`
// returns every row unfiltered.
//
// Whether fleet-wide re-acceptance on a patch bump is the intended
// behaviour is an open decision, not something this comment should keep
// answering in the negative.

import type { LegalDocumentCatalog, LegalDocumentEntry } from './legal-catalog.js';

export interface RequiredAcceptance {
  documentKey: string;
  currentVersion: string;
  contentHash: string;
  reason: 'never_accepted' | 'version_outdated' | 'content_hash_changed';
  /** Last version (if any) the account previously accepted. */
  lastAcceptedVersion: string | null;
}

export interface LegalAcceptanceRecord {
  id: string;
  accountId: string;
  documentKey: string;
  version: string;
  contentHash: string;
  acceptedFromIp: string | null;
  acceptedUserAgent: string | null;
  acceptedAt: Date;
}

export interface RecordAcceptanceInput {
  accountId: string;
  documentKey: string;
  version: string;
  contentHash: string;
  acceptedFromIp: string | null;
  acceptedUserAgent: string | null;
}

export interface LegalRepo {
  recordAcceptance(input: RecordAcceptanceInput): Promise<LegalAcceptanceRecord>;
  /** Latest acceptance per (account, document_key). Returns Map keyed by documentKey. */
  latestAcceptancesForAccount(accountId: string): Promise<Map<string, LegalAcceptanceRecord>>;
}

export class LegalDocumentMismatchError extends Error {
  readonly documentKey: string;
  readonly providedVersion: string;
  readonly currentVersion: string;
  readonly providedHash: string;
  readonly currentHash: string;
  constructor(opts: {
    documentKey: string;
    providedVersion: string;
    currentVersion: string;
    providedHash: string;
    currentHash: string;
  }) {
    super(
      `Legal document mismatch on ${opts.documentKey}: provided ${opts.providedVersion}/${opts.providedHash.slice(0, 12)}…, current ${opts.currentVersion}/${opts.currentHash.slice(0, 12)}…`,
    );
    this.name = 'LegalDocumentMismatchError';
    this.documentKey = opts.documentKey;
    this.providedVersion = opts.providedVersion;
    this.currentVersion = opts.currentVersion;
    this.providedHash = opts.providedHash;
    this.currentHash = opts.currentHash;
  }
}

export class LegalDocumentNotFoundError extends Error {
  readonly documentKey: string;
  constructor(documentKey: string) {
    super(`Legal document not found: ${documentKey}`);
    this.name = 'LegalDocumentNotFoundError';
    this.documentKey = documentKey;
  }
}

export class LegalService {
  constructor(
    private readonly catalog: LegalDocumentCatalog,
    private readonly repo: LegalRepo,
  ) {}

  /** Returns the catalog snapshot for client-side display. */
  list(): LegalDocumentEntry[] {
    return this.catalog.entries();
  }

  get(documentKey: string): LegalDocumentEntry {
    const entry = this.catalog.get(documentKey);
    if (entry === undefined) throw new LegalDocumentNotFoundError(documentKey);
    return entry;
  }

  /**
   * Record customer acceptance.
   *
   * The customer supplies the version + content_hash they're accepting.
   * The service rejects if either doesn't match the current published
   * catalog — protects against acceptance of a stale document the
   * client cached while a revision shipped.
   */
  async recordAcceptance(input: {
    accountId: string;
    documentKey: string;
    version: string;
    contentHash: string;
    acceptedFromIp: string | null;
    acceptedUserAgent: string | null;
  }): Promise<LegalAcceptanceRecord> {
    const current = this.catalog.get(input.documentKey);
    if (current === undefined) {
      throw new LegalDocumentNotFoundError(input.documentKey);
    }
    if (current.version !== input.version || current.contentHash !== input.contentHash) {
      throw new LegalDocumentMismatchError({
        documentKey: input.documentKey,
        providedVersion: input.version,
        currentVersion: current.version,
        providedHash: input.contentHash,
        currentHash: current.contentHash,
      });
    }
    return this.repo.recordAcceptance({
      accountId: input.accountId,
      documentKey: input.documentKey,
      version: input.version,
      contentHash: input.contentHash,
      acceptedFromIp: input.acceptedFromIp,
      acceptedUserAgent: input.acceptedUserAgent,
    });
  }

  /**
   * Returns the list of documents the account still needs to accept
   * (or re-accept). Empty list = account is current on every document.
   */
  async required(accountId: string): Promise<RequiredAcceptance[]> {
    const latest = await this.repo.latestAcceptancesForAccount(accountId);
    const out: RequiredAcceptance[] = [];
    for (const entry of this.catalog.entries()) {
      const accepted = latest.get(entry.documentKey);
      if (accepted === undefined) {
        out.push({
          documentKey: entry.documentKey,
          currentVersion: entry.version,
          contentHash: entry.contentHash,
          reason: 'never_accepted',
          lastAcceptedVersion: null,
        });
        continue;
      }
      if (accepted.version !== entry.version) {
        out.push({
          documentKey: entry.documentKey,
          currentVersion: entry.version,
          contentHash: entry.contentHash,
          reason: 'version_outdated',
          lastAcceptedVersion: accepted.version,
        });
        continue;
      }
      if (accepted.contentHash !== entry.contentHash) {
        // Same version string but content hash differs — patch-level
        // edit landed without a version bump. The catalog policy is to
        // surface this as a content_hash_changed reason.
        //
        // V-821 — this used to end "the route layer can decide whether to
        // gate on it", describing a discretion nothing exercises. There are
        // exactly two callers of required(): routes/legal.ts lists the
        // result, and services/api-keys.ts create() gates on
        // `pending.length > 0` with NO filter on reason. So this reason is
        // load-bearing, not advisory: a typo fix in a legal document, with
        // no version bump at all, blocks API-key minting for EVERY account
        // until each one re-accepts. If that is not wanted, the filter goes
        // in api-keys.ts — but it has to be written, because saying the
        // route layer decides does not make any route decide.
        out.push({
          documentKey: entry.documentKey,
          currentVersion: entry.version,
          contentHash: entry.contentHash,
          reason: 'content_hash_changed',
          lastAcceptedVersion: accepted.version,
        });
      }
    }
    return out;
  }
}
