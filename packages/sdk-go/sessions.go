package driftstack

import (
	"context"
	"net/url"
	"strconv"
)

// SessionsResource handles /v1/sessions[/...] endpoints.
type SessionsResource struct {
	client *Client
}

// Create makes a new session. Pass nil for default options.
func (r *SessionsResource) Create(ctx context.Context, body *CreateSessionRequest) (*Session, error) {
	var out Session
	if body == nil {
		body = &CreateSessionRequest{}
	}
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/sessions",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// List returns a page of sessions for the current account, newest first.
// Pass nil for defaults.
func (r *SessionsResource) List(ctx context.Context, query *ListSessionsQuery) (*SessionsListPage, error) {
	var out SessionsListPage
	q := url.Values{}
	if query != nil {
		if query.Limit > 0 {
			q.Set("limit", strconv.Itoa(query.Limit))
		}
		if query.Cursor != "" {
			q.Set("cursor", query.Cursor)
		}
	}
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/sessions",
		query:  q,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// Get fetches a single session by id.
func (r *SessionsResource) Get(ctx context.Context, sessionID string) (*Session, error) {
	var out Session
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/sessions/" + url.PathEscape(sessionID),
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// Navigate the session to a URL.
func (r *SessionsResource) Navigate(ctx context.Context, sessionID string, body *NavigateRequest) (*NavigateResponse, error) {
	var out NavigateResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/sessions/" + url.PathEscape(sessionID) + "/navigate",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// Interact sends a tap / type / scroll / press to the session.
func (r *SessionsResource) Interact(ctx context.Context, sessionID string, body *InteractRequest) (*InteractResponse, error) {
	var out InteractResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/sessions/" + url.PathEscape(sessionID) + "/interact",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// Wait blocks until a condition (selector, url match, time) is satisfied
// or the request's TimeoutMS elapses.
func (r *SessionsResource) Wait(ctx context.Context, sessionID string, body *WaitRequest) (*WaitResponse, error) {
	var out WaitResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/sessions/" + url.PathEscape(sessionID) + "/wait",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetState snapshots the session's current URL, title, cookies, etc.
func (r *SessionsResource) GetState(ctx context.Context, sessionID string) (*SessionState, error) {
	var out SessionState
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/sessions/" + url.PathEscape(sessionID) + "/state",
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// Capture produces a screenshot, DOM snapshot, or PDF.
func (r *SessionsResource) Capture(ctx context.Context, sessionID string, body *CaptureRequest) (*CaptureResponse, error) {
	var out CaptureResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/sessions/" + url.PathEscape(sessionID) + "/capture",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// Extract reads structured data from the page — a batch of named extractions
// (text / attribute / list). Returns the values keyed by each name.
func (r *SessionsResource) Extract(ctx context.Context, sessionID string, body *ExtractRequest) (*ExtractResponse, error) {
	var out ExtractResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/sessions/" + url.PathEscape(sessionID) + "/extract",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// Destroy ends the session. Idempotent — calling it twice is safe.
func (r *SessionsResource) Destroy(ctx context.Context, sessionID string) error {
	return r.client.do(ctx, requestOptions{
		method: "DELETE",
		path:   "/v1/sessions/" + url.PathEscape(sessionID),
	})
}
