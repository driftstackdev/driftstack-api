package driftstack

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

// V-309g — TeamResource tests.

func TestTeam_Invite(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/team/invites" || r.Method != "POST" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		var body TeamInviteRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Email != "user@example.test" || body.Role != TeamRoleAdmin {
			t.Errorf("unexpected body: %+v", body)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(TeamInviteResponse{Message: "Invite sent."})
	})

	got, err := client.Team.Invite(
		context.Background(),
		&TeamInviteRequest{Email: "user@example.test", Role: TeamRoleAdmin},
	)
	if err != nil {
		t.Fatal(err)
	}
	if got.Message != "Invite sent." {
		t.Errorf("message=%q", got.Message)
	}
}

func TestTeam_AcceptInvite(t *testing.T) {
	t.Parallel()
	now := time.Now().UTC().Truncate(time.Second)
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/team/invites/accept" || r.Method != "POST" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		var body TeamAcceptRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Token != "plaintext" {
			t.Errorf("token=%q", body.Token)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(TeamAcceptResponse{
			Membership: TeamMember{
				ID:              "mem_test",
				OwnerAccountID:  "acc_owner",
				MemberAccountID: "acc_member",
				MemberEmail:     "m@example.test",
				Role:            TeamRoleMember,
				InvitedAt:       now,
				AcceptedAt:      now,
			},
		})
	})

	got, err := client.Team.AcceptInvite(context.Background(), "plaintext")
	if err != nil {
		t.Fatal(err)
	}
	if got.Membership.MemberEmail != "m@example.test" {
		t.Errorf("member_email=%q", got.Membership.MemberEmail)
	}
}

func TestTeam_ListOwners(t *testing.T) {
	t.Parallel()
	ownerName := "Workspace owner"
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/team/owners" || r.Method != "GET" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(TeamOwnersList{Data: []TeamOwner{{
			OwnerAccountID: "acc_owner",
			OwnerEmail:     "owner@example.test",
			OwnerName:      &ownerName,
			Role:           TeamRoleAdmin,
			MembershipID:   "mem_test",
		}}})
	})

	got, err := client.Team.ListOwners(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Data) != 1 || got.Data[0].OwnerName == nil || *got.Data[0].OwnerName != ownerName {
		t.Fatalf("owners=%+v", got.Data)
	}
}

func TestTeam_RemoveMember(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/team/members/mem_test" || r.Method != "DELETE" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(204)
	})

	if err := client.Team.RemoveMember(context.Background(), "mem_test"); err != nil {
		t.Fatal(err)
	}
}

// ListTeams and RenameTeam shipped with NO test in ANY of the three SDKs
// (V-1978). Both target real routes with matching verbs, so nothing was broken;
// nothing was checking either.
func TestTeam_ListTeams(t *testing.T) {
	t.Parallel()
	var method, path string
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{{
				"id":               "team_1",
				"name":             "Acme",
				"slug":             nil,
				"owner_account_id": "acc_1",
				"created_at":       "2026-05-08T10:00:00Z",
				"updated_at":       "2026-05-08T10:00:00Z",
			}},
		})
	})
	out, err := client.Team.ListTeams(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if method != "GET" || path != "/v1/teams" {
		t.Errorf("got %s %s, want GET /v1/teams", method, path)
	}
	if len(out.Data) != 1 || out.Data[0].Name != "Acme" {
		t.Fatalf("data=%+v", out.Data)
	}
	// Slug is published but always null today; decoding it as a nil *string
	// rather than "" is what tells a caller it is unset.
	if out.Data[0].Slug != nil {
		t.Errorf("slug should decode to nil, got %v", *out.Data[0].Slug)
	}
}

func TestTeam_RenameTeam_SendsExactlyTheNameAndEncodesTheID(t *testing.T) {
	t.Parallel()
	var method, rawURI string
	var body map[string]any
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		// RequestURI, not URL.Path: URL.Path is already percent-DECODED, so
		// asserting on it cannot distinguish an encoded id from an unencoded one
		// and the arm would pass either way.
		method, rawURI = r.Method, r.RequestURI
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"team": map[string]any{
				"id": "team_1", "name": "New", "slug": nil,
				"owner_account_id": "acc_1",
				"created_at":       "2026-05-08T10:00:00Z",
				"updated_at":       "2026-05-08T10:00:00Z",
			},
		})
	})

	// A caller-supplied id must not be able to alter the path.
	out, err := client.Team.RenameTeam(context.Background(), "team/with space", "New")
	if err != nil {
		t.Fatal(err)
	}
	if method != "PATCH" {
		t.Errorf("method=%s, want PATCH", method)
	}
	if rawURI != "/v1/teams/team%2Fwith%20space" {
		t.Errorf("raw request URI = %q, want the id percent-encoded", rawURI)
	}
	// Exactly {"name": ...}: the route reports unknown request fields against
	// RenameTeamBodySchema, so an extra key is a warning the caller never sees.
	if len(body) != 1 || body["name"] != "New" {
		t.Errorf("body=%v, want exactly {name:New}", body)
	}
	if out.Team.Name != "New" {
		t.Errorf("team.name=%q", out.Team.Name)
	}
}
