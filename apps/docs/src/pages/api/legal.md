---
layout: ../../layouts/DocLayout.astro
title: Legal documents + acceptance
description: List the legal document catalog, see which documents your account must accept, and record acceptance with a content-hash binding.
---

# Legal documents + acceptance

Driftstack records customer acceptance of every
versioned legal document (Terms of Service, Privacy Policy, DPA,
Acceptable Use Policy, etc.) with a content-hash binding. When a
document version bumps — typically a sub-processor amendment or a
material policy change — the customer must re-accept under the
GDPR Art. 28(2) sub-processor amendment cadence.

The endpoints below are the API surface. The actual document text
lives at `/legal/*` on the marketing site (publicly readable
without auth) and on `docs/legal/*.md` in the repo (canonical
source-of-truth).

## List the catalog

`GET /v1/legal/documents`

Returns every legal document Driftstack publishes, with version,
effective date, and SHA-256 content hash. Auth-gated because the
GUI surfaces this for already-signed-in customers; the public
text URLs serve a wider audience.

Response (200):

```json
{
  "data": [
    {
      "document_key": "tos",
      "title": "Terms of Service",
      "version": "2026.05",
      "effective_date": "2026-05-01",
      "content_hash": "8f4a…(sha256 hex)…7e2b",
      "source_path": "docs/legal/terms-of-service.md",
      "byte_size": 18234
    },
    {
      "document_key": "privacy",
      "title": "Privacy Policy",
      "version": "2026.05",
      "effective_date": "2026-05-01",
      "content_hash": "…",
      "source_path": "docs/legal/privacy-policy.md",
      "byte_size": 14887
    },
    {
      "document_key": "dpa",
      "title": "Data Processing Agreement",
      "version": "2026.05",
      "effective_date": "2026-05-01",
      "content_hash": "…",
      "source_path": "docs/legal/dpa.md",
      "byte_size": 24561
    },
    {
      "document_key": "aup",
      "title": "Acceptable Use Policy",
      "version": "2026.05",
      "effective_date": "2026-05-01",
      "content_hash": "…",
      "source_path": "docs/legal/acceptable-use-policy.md",
      "byte_size": 8193
    }
  ]
}
```

The `content_hash` is the binding. Customers ship a hash with
their acceptance; if the document text has changed in any way —
even a typo fix — the hash differs and the acceptance is
rejected with 409 (the customer must re-fetch + re-accept).

Requires authentication; no specific API-key scope is needed beyond a
valid key.

## See what needs acceptance

`GET /v1/legal/required`

Returns the documents the calling account currently needs to
accept (or re-accept). An empty `data` array means the account
is fully up-to-date.

Response (200):

```json
{
  "data": [
    {
      "document_key": "dpa",
      "current_version": "2026.05",
      "content_hash": "…",
      "reason": "version_outdated",
      "last_accepted_version": "2026.04"
    }
  ]
}
```

`reason` values:

- `never_accepted` — the account has never accepted this document
  (first-time acceptance).
- `version_outdated` — the account accepted an earlier version; the
  current document version string is newer.
- `content_hash_changed` — the account accepted the current version
  string, but the document text changed (a patch-level edit landed
  without a version bump), so the content hash differs.

For a DPA sub-processor change (Art. 28(2) trigger), the new version
surfaces as `version_outdated` (or `content_hash_changed` for an
in-place edit). The dashboard surfaces an in-app banner whenever a
re-acceptance is required.

Requires authentication; no specific API-key scope is needed beyond a
valid key.

## Record acceptance

`POST /v1/legal/accept`

Records the calling account's acceptance of a `(document, version,
content_hash)` triple. The hash binding ensures the acceptance is
genuinely against the document the customer read — server-side
validation rejects mismatches.

Request:

```json
{
  "document_key": "tos",
  "version": "2026.05",
  "content_hash": "8f4a…(sha256 hex)…7e2b"
}
```

Response (201):

```json
{
  "id": "lacc_<uuid>",
  "account_id": "acc_<uuid>",
  "document_key": "tos",
  "version": "2026.05",
  "content_hash": "8f4a…7e2b",
  "accepted_at": "2026-05-10T18:00:00Z"
}
```

Errors:

- `400 bad-request` — `content_hash` not a 64-character hex SHA-256 digest.
- `404 not-found` — `document_key` is not in the catalog.
- `409 conflict` — `version` or `content_hash` doesn't match the
  current document. Response body carries
  `current_version` + `current_content_hash` so the client can
  refresh and retry. Use the conflict response, not a recursive
  client retry — log the version drift for audit.

The acceptance row is append-only — there is no `DELETE` or
`PATCH`. Customers wishing to "withdraw consent" exercise the
Article 17 right to erasure set out in the
[privacy policy](https://driftstack.dev/legal/privacy/) rather
than this endpoint.

Required scope: `account_owner` (the route gates acceptance on
`account_owner` — a broad `write` key is not sufficient).

## Where the documents live

- **Public (marketing site)**: `/legal/terms`, `/legal/privacy`,
  `/legal/dpa`, `/legal/aup`. Render the same text as the
  source-of-truth, with chrome.
- **Canonical (repo)**: `docs/legal/*.md`. Direct git history
  is the audit trail of changes.
- **API catalog**: this endpoint set surfaces metadata; never
  the document body. Read the public URLs for the body.

## Source of truth

Routes: `apps/server/src/routes/legal.ts`. Service:
`apps/server/src/services/legal.ts`. Repo:
`apps/server/src/db/legal-repo.ts`. Catalog
configuration: `apps/server/src/services/legal-catalog.ts`.
