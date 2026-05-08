package driftstack

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

func snapshotFixture(id string) ProfileSnapshot {
	return ProfileSnapshot{
		ID:              id,
		ParentProfileID: stringPtr("prof_p"),
		Label:           "label-" + id,
		ParentArchetype: "iphone16pro_ios18_7_safari26_4",
		ParentName:      "parent",
		CapturedAt:      time.Date(2026, 5, 9, 0, 0, 0, 0, time.UTC),
		CreatedAt:       time.Date(2026, 5, 9, 0, 0, 0, 0, time.UTC),
	}
}

func TestProfileSnapshots_Capture(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/profiles/prof_p/snapshots" || r.Method != "POST" {
			t.Errorf("unexpected: %s %s", r.Method, r.URL.Path)
		}
		var body CaptureSnapshotRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Label != "before-iOS-26" {
			t.Errorf("label=%q", body.Label)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(snapshotFixture("psnap_1"))
	})
	got, err := client.ProfileSnapshots.Capture(
		context.Background(),
		"prof_p",
		&CaptureSnapshotRequest{Label: "before-iOS-26"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != "psnap_1" {
		t.Errorf("id=%q", got.ID)
	}
}

func TestProfileSnapshots_ListForProfile(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/profiles/prof_p/snapshots" || r.Method != "GET" {
			t.Errorf("unexpected: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(ProfileSnapshotsListPage{
			Data:    []ProfileSnapshot{snapshotFixture("psnap_1")},
			HasMore: false,
		})
	})
	got, err := client.ProfileSnapshots.ListForProfile(
		context.Background(),
		"prof_p",
		&ListProfileSnapshotsQuery{Limit: 10},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Data) != 1 {
		t.Errorf("got %d snapshots", len(got.Data))
	}
}

func TestProfileSnapshots_List_CrossAccount(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/profile-snapshots" || r.Method != "GET" {
			t.Errorf("unexpected: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(ProfileSnapshotsListPage{
			Data:    []ProfileSnapshot{snapshotFixture("psnap_a"), snapshotFixture("psnap_b")},
			HasMore: false,
		})
	})
	got, err := client.ProfileSnapshots.List(
		context.Background(),
		&ListProfileSnapshotsQuery{Limit: 25},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Data) != 2 {
		t.Errorf("got %d snapshots", len(got.Data))
	}
}

func TestProfileSnapshots_Iterate_WalksCursorPages(t *testing.T) {
	t.Parallel()
	pageOne := ProfileSnapshotsListPage{
		Data: []ProfileSnapshot{
			snapshotFixture("psnap_1"),
			snapshotFixture("psnap_2"),
		},
		HasMore:    true,
		NextCursor: stringPtr("psnap_2"),
	}
	pageTwo := ProfileSnapshotsListPage{
		Data:    []ProfileSnapshot{snapshotFixture("psnap_3")},
		HasMore: false,
	}
	requestN := 0
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		requestN++
		w.Header().Set("content-type", "application/json")
		if r.URL.Query().Get("cursor") == "" {
			_ = json.NewEncoder(w).Encode(pageOne)
		} else {
			_ = json.NewEncoder(w).Encode(pageTwo)
		}
	})
	var seen []string
	err := client.ProfileSnapshots.Iterate(
		context.Background(),
		nil,
		func(s *ProfileSnapshot) (bool, error) {
			seen = append(seen, s.ID)
			return true, nil
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(seen) != 3 {
		t.Errorf("seen %d snapshots; want 3 (got %v)", len(seen), seen)
	}
	if requestN != 2 {
		t.Errorf("requests %d; want 2", requestN)
	}
}

func TestProfileSnapshots_Restore(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/profile-snapshots/psnap_1/restore" || r.Method != "POST" {
			t.Errorf("unexpected: %s %s", r.Method, r.URL.Path)
		}
		var body RestoreSnapshotRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Name != "restored-baseline" {
			t.Errorf("name=%q", body.Name)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(profileFixture("prof_new"))
	})
	got, err := client.ProfileSnapshots.Restore(
		context.Background(),
		"psnap_1",
		&RestoreSnapshotRequest{Name: "restored-baseline"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != "prof_new" {
		t.Errorf("id=%q", got.ID)
	}
}

func TestProfileSnapshots_Delete(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/profile-snapshots/psnap_1" || r.Method != "DELETE" {
			t.Errorf("unexpected: %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(204)
	})
	if err := client.ProfileSnapshots.Delete(context.Background(), "psnap_1"); err != nil {
		t.Errorf("err=%v", err)
	}
}
