package driftstack

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

func TestAccount_Me(t *testing.T) {
	t.Parallel()
	body := map[string]any{
		"id":                        "acc_00000000-0000-4000-8000-000000000001",
		"email":                     "alice@driftstack.local",
		"name":                      "Alice",
		"tier":                      "api_builder",
		"status":                    "active",
		"timezone":                  "Europe/Amsterdam",
		"slug":                      "alice-co",
		"region":                    "eu",
		"avatar_url":                "https://r2.example/avatars/alice.png?sig=...",
		"avatar_source":             "user",
		"mfa_enrolled":              true,
		"concurrent_session_cap":    8,
		"concurrent_session_active": 2,
		"profile_cap":               50,
		"profile_count":             7,
		"teams": []map[string]any{
			{
				"owner_account_id": "acc_00000000-0000-4000-8000-000000000099",
				"role":             "admin",
				"membership_id":    "mem_00000000-0000-4000-8000-000000000003",
			},
		},
	}
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/account/me" || r.Method != "GET" {
			t.Errorf("unexpected: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(body)
	})
	got, err := client.Account.Me(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != "acc_00000000-0000-4000-8000-000000000001" {
		t.Errorf("id=%q", got.ID)
	}
	if got.Slug == nil || *got.Slug != "alice-co" {
		t.Errorf("slug=%v", got.Slug)
	}
	if got.Region == nil || *got.Region != "eu" {
		t.Errorf("region=%v", got.Region)
	}
	if got.AvatarSource != "user" {
		t.Errorf("avatar_source=%q", got.AvatarSource)
	}
	if !got.MfaEnrolled {
		t.Errorf("mfa_enrolled should be true")
	}
	if got.ProfileCap == nil || *got.ProfileCap != 50 {
		t.Errorf("profile_cap=%v", got.ProfileCap)
	}
	if len(got.Teams) != 1 || got.Teams[0].Role != "admin" {
		t.Errorf("teams=%v", got.Teams)
	}
}

func TestAccount_Me_NullableFields(t *testing.T) {
	t.Parallel()
	body := map[string]any{
		"id":                        "acc_00000000-0000-4000-8000-000000000001",
		"email":                     "x@y.z",
		"name":                      nil,
		"tier":                      "free",
		"status":                    "active",
		"timezone":                  nil,
		"slug":                      nil,
		"region":                    nil,
		"avatar_url":                nil,
		"avatar_source":             "none",
		"mfa_enrolled":              false,
		"concurrent_session_cap":    1,
		"concurrent_session_active": 0,
		"profile_cap":               nil, // null = enterprise / unmetered
		"profile_count":             0,
		"teams":                     []map[string]any{},
	}
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(body)
	})
	got, err := client.Account.Me(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != nil {
		t.Errorf("name should be nil; got %v", got.Name)
	}
	if got.Slug != nil || got.Region != nil || got.AvatarURL != nil {
		t.Errorf("nullable fields should all be nil")
	}
	if got.ProfileCap != nil {
		t.Errorf("profile_cap should be nil for enterprise/unmetered")
	}
	if len(got.Teams) != 0 {
		t.Errorf("teams should be empty")
	}
}
