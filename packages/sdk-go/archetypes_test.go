package driftstack

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

func TestArchetypesList(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/v1/archetypes" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(ListArchetypesResponse{
			DefaultArchetypeID: "iphone17_ios18_7_safari26_4",
			Data: []PublicArchetype{{
				ID: "iphone17_ios18_7_safari26_4", DisplayLabel: "iPhone 17 / iOS 18.7 / Safari 26.4",
				Device: "iPhone 17", IOSVersion: "18.7", SafariVersion: "26.4",
				CanvasFamily: "B", Status: "launch", IsDefault: true,
			}},
		})
	})

	got, err := client.Archetypes.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got.DefaultArchetypeID != "iphone17_ios18_7_safari26_4" || len(got.Data) != 1 {
		t.Fatalf("unexpected catalog: %+v", got)
	}
	if !got.Data[0].IsDefault || got.Data[0].Status != "launch" {
		t.Fatalf("unexpected default archetype: %+v", got.Data[0])
	}
}
