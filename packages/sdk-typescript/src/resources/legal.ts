// LegalResource — typed methods for /v1/legal/* (V-049 / V-458).
//
// Customer acceptance of legal documents (ToS / Privacy / DPA / AUP).
// Document content is served separately on the marketing site; this
// resource handles the catalog + acceptance machinery.

import type { HttpClient } from '../http.js';

export interface LegalDocumentEntry {
  document_key: string;
  title: string;
  version: string;
  effective_date: string;
  content_hash: string;
  source_path: string;
  byte_size: number;
}

export interface LegalRequiredEntry {
  document_key: string;
  current_version: string;
  content_hash: string;
  reason: string;
  last_accepted_version: string | null;
}

export interface AcceptLegalDocumentRequest {
  document_key: string;
  version: string;
  /** 64-character lowercase hex SHA-256 of the document content. */
  content_hash: string;
}

export interface AcceptLegalDocumentResponse {
  id: string;
  account_id: string;
  document_key: string;
  version: string;
  content_hash: string;
  accepted_at: string;
}

export class LegalResource {
  constructor(private readonly http: HttpClient) {}

  /** List the legal-document catalog. */
  documents(): Promise<{ data: LegalDocumentEntry[] }> {
    return this.http.request<{ data: LegalDocumentEntry[] }>({
      method: 'GET',
      path: '/v1/legal/documents',
    });
  }

  /** List documents the calling account must accept (or re-accept). */
  required(): Promise<{ data: LegalRequiredEntry[] }> {
    return this.http.request<{ data: LegalRequiredEntry[] }>({
      method: 'GET',
      path: '/v1/legal/required',
    });
  }

  /** Record acceptance of a (document, version, content_hash) tuple. */
  accept(body: AcceptLegalDocumentRequest): Promise<AcceptLegalDocumentResponse> {
    return this.http.request<AcceptLegalDocumentResponse>({
      method: 'POST',
      path: '/v1/legal/accept',
      body,
    });
  }
}
