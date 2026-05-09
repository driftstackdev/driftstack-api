package driftstack

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

// V-462 — AuditLogResource.Export test. Covers the JSON branch.
func TestAuditLog_Export(t *testing.T) {
	t.Parallel()
	now := time.Now().UTC().Truncate(time.Second)
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/account/audit-log/export" || r.Method != "GET" {
			t.Errorf("unexpected: %s %s", r.Method, r.URL.Path)
		}
		if got := r.URL.Query().Get("format"); got != "json" {
			t.Errorf("format=%q want json", got)
		}
		w.Header().Set("content-type", "application/json")
		actorID := "acc_abc"
		_ = json.NewEncoder(w).Encode(AuditLogExportResponse{
			GeneratedAt: now,
			AccountID:   "acc_abc",
			RowCount:    1,
			Truncated:   false,
			Data: []AuditLogEntry{
				{
					ID:             "11111111-1111-1111-1111-111111111111",
					AccountID:      "acc_abc",
					ActorType:      "customer",
					ActorAccountID: &actorID,
					Action:         "profile.created",
					Timestamp:      now,
				},
			},
		})
	})
	got, err := client.AuditLog.Export(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got.RowCount != 1 || got.Truncated {
		t.Errorf("export response shape: %+v", got)
	}
	if len(got.Data) != 1 || got.Data[0].Action != "profile.created" {
		t.Errorf("data missing: %+v", got.Data)
	}
}

func TestAuditLog_Export_TruncatedFlag(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(AuditLogExportResponse{
			GeneratedAt: time.Now().UTC().Truncate(time.Second),
			AccountID:   "acc_abc",
			RowCount:    10000,
			Truncated:   true,
			Data:        []AuditLogEntry{},
		})
	})
	got, err := client.AuditLog.Export(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !got.Truncated || got.RowCount != 10000 {
		t.Errorf("truncated branch shape: %+v", got)
	}
}
