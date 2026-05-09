package driftstack

import (
	"context"
	"net/url"
	"strconv"
	"time"
)

// AuditLogResource handles /v1/account/audit-log (V-216 / V-449).
//
// Append-only ledger; honors the V-326c X-Driftstack-Account team-RBAC
// header (a member with read access on the team owner can pull the
// OWNER's audit log).
type AuditLogResource struct {
	client *Client
}

// AuditLogEntry — V-216 single ledger entry. Action-specific structured
// payload lives in `Payload`; see /api/audit-log doc for shapes per
// action type. IPAddress + UserAgent are server-stored fields but
// nulled in customer-facing responses per V-211 (see also V-413
// caveat about auth-flow events leaking via payload).
type AuditLogEntry struct {
	ID               string                 `json:"id"`
	AccountID        string                 `json:"account_id"`
	ActorType        string                 `json:"actor_type"` // "customer" | "system" | "staff"
	ActorAccountID   *string                `json:"actor_account_id"`
	ActorKeyID       *string                `json:"actor_key_id"`
	Action           string                 `json:"action"`
	TargetResourceID *string                `json:"target_resource_id"`
	Payload          map[string]interface{} `json:"payload"`
	IPAddress        *string                `json:"ip_address"`
	UserAgent        *string                `json:"user_agent"`
	Timestamp        time.Time              `json:"timestamp"`
}

type AuditLogListPage struct {
	Data       []AuditLogEntry `json:"data"`
	NextCursor *string         `json:"next_cursor"`
}

type ListAuditLogQuery struct {
	Limit  int
	Cursor string
	Action string // filter to a single action name
}

// List returns one page of audit-log entries newest-first.
func (r *AuditLogResource) List(ctx context.Context, query *ListAuditLogQuery) (*AuditLogListPage, error) {
	var out AuditLogListPage
	q := url.Values{}
	if query != nil {
		if query.Limit > 0 {
			q.Set("limit", strconv.Itoa(query.Limit))
		}
		if query.Cursor != "" {
			q.Set("cursor", query.Cursor)
		}
		if query.Action != "" {
			q.Set("action", query.Action)
		}
	}
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/account/audit-log",
		query:  q,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// AuditLogExportResponse — V-297 bulk-export envelope (GDPR Article
// 20 portability). Up to 10,000 rows per call; `Truncated` flips to
// true when older entries weren't returned.
type AuditLogExportResponse struct {
	GeneratedAt time.Time       `json:"generated_at"`
	AccountID   string          `json:"account_id"`
	RowCount    int             `json:"row_count"`
	Truncated   bool            `json:"truncated"`
	Data        []AuditLogEntry `json:"data"`
}

// Export returns a single-call JSON bulk-export of the calling
// account's audit log (V-462 / V-297). Designed for compliance
// portability requests; up to 10,000 rows. The CSV branch is not
// surfaced through the SDK — hit /v1/account/audit-log/export?format=csv
// directly with the bearer for spreadsheet downloads.
func (r *AuditLogResource) Export(ctx context.Context) (*AuditLogExportResponse, error) {
	var out AuditLogExportResponse
	q := url.Values{}
	q.Set("format", "json")
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/account/audit-log/export",
		query:  q,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// Iterate yields every audit-log entry across cursor pages. Callback
// returns false to stop early. Action filter narrows to one event type.
func (r *AuditLogResource) Iterate(
	ctx context.Context,
	query *ListAuditLogQuery,
	fn func(*AuditLogEntry) (bool, error),
) error {
	cursor := ""
	limit := 0
	action := ""
	if query != nil {
		limit = query.Limit
		cursor = query.Cursor
		action = query.Action
	}
	for {
		page, err := r.List(ctx, &ListAuditLogQuery{
			Limit:  limit,
			Cursor: cursor,
			Action: action,
		})
		if err != nil {
			return err
		}
		for i := range page.Data {
			cont, err := fn(&page.Data[i])
			if err != nil {
				return err
			}
			if !cont {
				return nil
			}
		}
		if page.NextCursor == nil || *page.NextCursor == "" {
			return nil
		}
		cursor = *page.NextCursor
	}
}
