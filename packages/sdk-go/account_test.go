package driftstack

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
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

// The six AccountResource methods Go's tests did not reach (V-1985). The TS SDK
// pins all of them; Go pinned Me, the four BYOK calls and the bulk web-session
// revoke, leaving the profile, avatar, session-listing and rate-limit surface
// unasserted.

func TestAccount_UpdateMe_SendsOnlyTheFieldsSet(t *testing.T) {
	t.Parallel()
	var method, path string
	var body map[string]any
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		body = map[string]any{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "acc_1", "email": "a@b.test", "name": "New Name",
			"tier": "solo_manual", "status": "active",
			"timezone": nil, "slug": nil, "region": nil,
		})
	})
	name := "New Name"
	out, err := client.Account.UpdateMe(context.Background(), &UpdateMeRequest{Name: &name})
	if err != nil {
		t.Fatal(err)
	}
	if method != "PATCH" || path != "/v1/account/me" {
		t.Errorf("got %s %s, want PATCH /v1/account/me", method, path)
	}
	// Every field is a *string with omitempty, so a partial update must carry
	// ONLY what the caller set. Sending `"timezone": null` beside a name change
	// is a different request — it asks the server to clear the timezone.
	if len(body) != 1 || body["name"] != "New Name" {
		t.Errorf("body = %v, want exactly {name}", body)
	}
	if out.Name == nil || *out.Name != "New Name" {
		t.Errorf("name = %v", out.Name)
	}
}

func TestAccount_UploadAvatar(t *testing.T) {
	t.Parallel()
	var method, path string
	var body map[string]any
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		body = map[string]any{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"avatar_url": "https://cdn.test/a.png", "content_type": "image/png", "bytes": 1234,
		})
	})
	out, err := client.Account.UploadAvatar(context.Background(), &UploadAvatarRequest{
		DataBase64:  "aGVsbG8=",
		ContentType: "image/png",
	})
	if err != nil {
		t.Fatal(err)
	}
	if method != "POST" || path != "/v1/account/me/avatar" {
		t.Errorf("got %s %s, want POST /v1/account/me/avatar", method, path)
	}
	if body["data_base64"] != "aGVsbG8=" || body["content_type"] != "image/png" {
		t.Errorf("body = %v", body)
	}
	if out.Bytes != 1234 {
		t.Errorf("bytes = %d", out.Bytes)
	}
}

func TestAccount_ClearAvatar(t *testing.T) {
	t.Parallel()
	var method, path string
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		w.WriteHeader(http.StatusNoContent)
	})
	if err := client.Account.ClearAvatar(context.Background()); err != nil {
		t.Fatal(err)
	}
	if method != "DELETE" || path != "/v1/account/me/avatar" {
		t.Errorf("got %s %s, want DELETE /v1/account/me/avatar", method, path)
	}
}

func TestAccount_ListWebSessions(t *testing.T) {
	t.Parallel()
	var method, path string
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{{
				"id": "sess_1", "os": "macOS", "browser": "Safari",
				"last_used_at": "2026-05-16T18:00:00Z",
				"expires_at":   "2026-05-23T18:00:00Z",
				"current":      true,
			}},
		})
	})
	out, err := client.Account.ListWebSessions(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if method != "GET" || path != "/v1/account/web-sessions" {
		t.Errorf("got %s %s, want GET /v1/account/web-sessions", method, path)
	}
	if len(out.Data) != 1 || out.Data[0].ID != "sess_1" {
		t.Fatalf("data = %+v", out.Data)
	}
	// `current` is how a UI avoids offering "revoke" on the session you are
	// using; decoding it as false would make that control self-destructive.
	if !out.Data[0].Current {
		t.Error("current did not decode as true")
	}
	if out.Data[0].LastUsedAt.IsZero() || out.Data[0].ExpiresAt.IsZero() {
		t.Error("timestamps did not decode")
	}
}

// CRITICAL: the single revoke targets the ITEM path and the bulk revoke targets
// the COLLECTION. If this method ever pointed at the collection it would revoke
// EVERY session instead of one, and the caller would see the same nil error.
// The TS suite pins this distinction; Go did not.
func TestAccount_RevokeWebSession_TargetsTheItemPathAndEncodesTheID(t *testing.T) {
	t.Parallel()
	var method, rawURI string
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		// RequestURI, not URL.Path: URL.Path is already percent-decoded, so an
		// arm asserting on it passes whether or not the id was encoded.
		method, rawURI = r.Method, r.RequestURI
		w.WriteHeader(http.StatusNoContent)
	})
	if err := client.Account.RevokeWebSession(context.Background(), "sess/with space"); err != nil {
		t.Fatal(err)
	}
	if method != "DELETE" {
		t.Errorf("method = %s, want DELETE", method)
	}
	if rawURI != "/v1/account/web-sessions/sess%2Fwith%20space" {
		t.Errorf("raw request URI = %q, want the id encoded on the ITEM path", rawURI)
	}
	// And it must carry no ?keep=current — that belongs to the bulk revoke.
	if strings.Contains(rawURI, "keep=") {
		t.Errorf("single revoke must not carry the bulk confirm-intent query: %q", rawURI)
	}
}

func TestAccount_RateLimits(t *testing.T) {
	t.Parallel()
	var method, path string
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tier": "solo_manual",
			"buckets": []map[string]any{{
				"bucket_key": "global", "capacity": 60, "refill_per_second": 1.0,
				"source": "tier_default", "override_expires_at": nil,
			}},
		})
	})
	out, err := client.Account.RateLimits(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if method != "GET" || path != "/v1/account/rate-limits" {
		t.Errorf("got %s %s, want GET /v1/account/rate-limits", method, path)
	}
	if out.Tier != "solo_manual" || len(out.Buckets) != 1 {
		t.Fatalf("out = %+v", out)
	}
	// refill_per_second is a float; decoding it as an int would silently floor
	// a sub-1/s bucket to zero and read as "never refills".
	if out.Buckets[0].RefillPerSecond != 1.0 || out.Buckets[0].Capacity != 60 {
		t.Errorf("bucket = %+v", out.Buckets[0])
	}
	if out.Buckets[0].OverrideExpiresAt != nil {
		t.Errorf("override_expires_at should decode as nil, got %v", *out.Buckets[0].OverrideExpiresAt)
	}
}
