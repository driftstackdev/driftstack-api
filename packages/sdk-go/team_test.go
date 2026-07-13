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
