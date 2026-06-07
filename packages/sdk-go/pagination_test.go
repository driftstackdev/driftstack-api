package driftstack

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"
)

// advanceCursor is the shared termination + non-advance guard every resource
// Iterate helper calls, so unit-testing it here covers the guard for all of
// them (profiles / audit_log / recipes / profile_snapshots / crypto_orders).
func TestAdvanceCursor(t *testing.T) {
	t.Parallel()

	if c, done, err := advanceCursor("c1", nil); !done || err != nil || c != "" {
		t.Errorf("nil next: got (%q,%v,%v), want (\"\",true,nil)", c, done, err)
	}
	empty := ""
	if c, done, err := advanceCursor("c1", &empty); !done || err != nil || c != "" {
		t.Errorf("empty next: got (%q,%v,%v), want (\"\",true,nil)", c, done, err)
	}
	c2 := "c2"
	if c, done, err := advanceCursor("c1", &c2); done || err != nil || c != "c2" {
		t.Errorf("advance: got (%q,%v,%v), want (\"c2\",false,nil)", c, done, err)
	}

	// Non-advance: the server returned the same cursor → TransportError, not done.
	same := "c1"
	c, done, err := advanceCursor("c1", &same)
	if done || err == nil || c != "" {
		t.Fatalf("non-advance: got (%q,%v,%v), want (\"\",false,error)", c, done, err)
	}
	var te *TransportError
	if !errors.As(err, &te) {
		t.Errorf("non-advance error is %T, want *TransportError", err)
	}
}

// End-to-end proof that the guard is wired into a real Iterate loop: a server
// that returns the SAME non-null cursor forever must surface an error rather
// than spin infinitely and hang the caller.
func TestProfiles_Iterate_NonAdvancingCursorDoesNotHang(t *testing.T) {
	t.Parallel()
	requestN := 0
	_, client := newServer(t, func(w http.ResponseWriter, _ *http.Request) {
		requestN++
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(ProfilesListPage{
			Data:       []Profile{profileFixture("prf_stuck")},
			HasMore:    true,
			NextCursor: stringPtr("stuck"),
		})
	})

	seen := 0
	err := client.Profiles.Iterate(context.Background(), nil, func(_ *Profile) (bool, error) {
		seen++
		return true, nil
	})
	if err == nil {
		t.Fatal("expected an error on a non-advancing cursor, got nil (would have hung)")
	}
	var te *TransportError
	if !errors.As(err, &te) {
		t.Errorf("error is %T, want *TransportError", err)
	}
	// page1 cursor="" → advance to "stuck"; page2 cursor="stuck" → "stuck" again
	// → guard fires. Exactly 2 requests, not ∞.
	if requestN != 2 {
		t.Errorf("requests %d, expected 2 (guard stops the walk)", requestN)
	}
	if seen != 2 {
		t.Errorf("seen %d, expected 2", seen)
	}
}
