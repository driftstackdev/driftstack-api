package driftstack

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

func profileFixture(id string) Profile {
	return Profile{
		ID:        id,
		Name:      "test profile " + id,
		Archetype: "iphone16pro_ios18_7_safari26_4",
	}
}

func TestProfiles_Create(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/profiles" || r.Method != "POST" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		var body CreateProfileRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Name != "fresh" {
			t.Errorf("name=%q", body.Name)
		}
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(201)
		_ = json.NewEncoder(w).Encode(profileFixture("prf_x"))
	})
	got, err := client.Profiles.Create(context.Background(), &CreateProfileRequest{Name: "fresh"})
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != "prf_x" {
		t.Errorf("id=%q", got.ID)
	}
}

func TestProfiles_List(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/profiles" || r.Method != "GET" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if r.URL.Query().Get("limit") != "25" {
			t.Errorf("limit=%q", r.URL.Query().Get("limit"))
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(ProfilesListPage{
			Data:    []Profile{profileFixture("prf_1"), profileFixture("prf_2")},
			HasMore: false,
		})
	})
	got, err := client.Profiles.List(context.Background(), &ListProfilesQuery{Limit: 25})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Data) != 2 {
		t.Errorf("got %d profiles", len(got.Data))
	}
}

func TestProfiles_Iterate_WalksCursorPages(t *testing.T) {
	t.Parallel()
	pageOne := ProfilesListPage{
		Data:       []Profile{profileFixture("prf_1"), profileFixture("prf_2")},
		HasMore:    true,
		NextCursor: stringPtr("prf_2"),
	}
	pageTwo := ProfilesListPage{
		Data:    []Profile{profileFixture("prf_3")},
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
	err := client.Profiles.Iterate(context.Background(), nil, func(p *Profile) (bool, error) {
		seen = append(seen, p.ID)
		return true, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(seen) != 3 {
		t.Errorf("seen %d profiles, expected 3 (got %v)", len(seen), seen)
	}
	if requestN != 2 {
		t.Errorf("requests %d, expected 2 (one per page)", requestN)
	}
}

func TestProfiles_Update_PartialPatch(t *testing.T) {
	t.Parallel()
	newName := "renamed"
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "PATCH" {
			t.Errorf("method=%q", r.Method)
		}
		var body UpdateProfileRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Name == nil || *body.Name != newName {
			t.Errorf("body.name=%v", body.Name)
		}
		updated := profileFixture("prf_x")
		updated.Name = newName
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(updated)
	})
	got, err := client.Profiles.Update(context.Background(), "prf_x", &UpdateProfileRequest{Name: &newName})
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != newName {
		t.Errorf("name=%q", got.Name)
	}
}

func TestProfiles_Delete_Idempotent(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "DELETE" {
			t.Errorf("method=%q", r.Method)
		}
		w.WriteHeader(204)
	})
	if err := client.Profiles.Delete(context.Background(), "prf_x"); err != nil {
		t.Errorf("err=%v", err)
	}
}

func TestProfiles_Clone_DefaultBodyEmpty(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/profiles/prof_src/clone" || r.Method != "POST" {
			t.Errorf("unexpected: %s %s", r.Method, r.URL.Path)
		}
		var body CloneProfileRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Name != "" {
			t.Errorf("default name should be empty, got %q", body.Name)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(profileFixture("prof_copy"))
	})
	got, err := client.Profiles.Clone(context.Background(), "prof_src", nil)
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != "prof_copy" {
		t.Errorf("id=%q", got.ID)
	}
}

func TestProfiles_Clone_ExplicitName(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		var body CloneProfileRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Name != "my-explicit-clone" {
			t.Errorf("name=%q", body.Name)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(profileFixture("prof_x"))
	})
	_, err := client.Profiles.Clone(
		context.Background(),
		"prof_src",
		&CloneProfileRequest{Name: "my-explicit-clone"},
	)
	if err != nil {
		t.Fatal(err)
	}
}

func stringPtr(s string) *string { return &s }
