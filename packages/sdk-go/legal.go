package driftstack

import (
	"context"
	"time"
)

// LegalResource handles /v1/legal/* (V-049 / V-458).
//
// Customer acceptance of legal documents (ToS / Privacy / DPA / AUP).
// Document content is served separately on the marketing site;
// this resource handles the catalog + acceptance machinery.
type LegalResource struct {
	client *Client
}

// LegalDocumentEntry — one row in the legal-document catalog.
type LegalDocumentEntry struct {
	DocumentKey   string `json:"document_key"`
	Title         string `json:"title"`
	Version       string `json:"version"`
	EffectiveDate string `json:"effective_date"`
	ContentHash   string `json:"content_hash"`
	SourcePath    string `json:"source_path"`
	ByteSize      int    `json:"byte_size"`
}

type ListLegalDocumentsResponse struct {
	Data []LegalDocumentEntry `json:"data"`
}

// LegalRequiredEntry — one document the calling account must accept.
type LegalRequiredEntry struct {
	DocumentKey         string  `json:"document_key"`
	CurrentVersion      string  `json:"current_version"`
	ContentHash         string  `json:"content_hash"`
	Reason              string  `json:"reason"`
	LastAcceptedVersion *string `json:"last_accepted_version"`
}

type ListLegalRequiredResponse struct {
	Data []LegalRequiredEntry `json:"data"`
}

// AcceptLegalDocumentRequest — record acceptance of a (document, version,
// content_hash) tuple.
type AcceptLegalDocumentRequest struct {
	DocumentKey string `json:"document_key"`
	Version     string `json:"version"`
	ContentHash string `json:"content_hash"`
}

type AcceptLegalDocumentResponse struct {
	ID          string    `json:"id"`
	AccountID   string    `json:"account_id"`
	DocumentKey string    `json:"document_key"`
	Version     string    `json:"version"`
	ContentHash string    `json:"content_hash"`
	AcceptedAt  time.Time `json:"accepted_at"`
}

// Documents lists the legal-document catalog.
func (r *LegalResource) Documents(ctx context.Context) (*ListLegalDocumentsResponse, error) {
	var out ListLegalDocumentsResponse
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/legal/documents",
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// Required lists documents the calling account must accept (or re-accept).
func (r *LegalResource) Required(ctx context.Context) (*ListLegalRequiredResponse, error) {
	var out ListLegalRequiredResponse
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/legal/required",
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// Accept records acceptance of a (document, version, content_hash) tuple.
func (r *LegalResource) Accept(ctx context.Context, body *AcceptLegalDocumentRequest) (*AcceptLegalDocumentResponse, error) {
	var out AcceptLegalDocumentResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/legal/accept",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}
