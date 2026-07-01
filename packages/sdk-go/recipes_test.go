package driftstack

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

var recipeEnvelope = map[string]any{
	"id":               "rec_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
	"account_id":       "acc_1",
	"agent_session_id": "agt_inmem_00000001",
	"label":            "login flow snapshot",
	"description":      nil,
	"intent_count":     3,
	"created_at":       "2026-05-17T12:00:00Z",
	"updated_at":       "2026-05-17T12:00:00Z",
}

func TestRecipes_Create_LabelOnly(t *testing.T) {
	t.Parallel()
	var captured map[string]any
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/recipes" || r.Method != "POST" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&captured); err != nil {
			t.Fatal(err)
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(recipeEnvelope)
	})
	got, err := client.Recipes.Create(context.Background(), CreateRecipeRequest{
		AgentSessionID: "agt_inmem_00000001",
		Label:          "login flow snapshot",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != "rec_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" {
		t.Errorf("id=%q", got.ID)
	}
	if got.IntentCount != 3 {
		t.Errorf("intent_count=%d", got.IntentCount)
	}
	// description omitted when not supplied — clean wire shape.
	if _, present := captured["description"]; present {
		t.Errorf("description was sent on the wire when omitted from the request")
	}
}

func TestRecipes_Create_WithDescription(t *testing.T) {
	t.Parallel()
	var captured map[string]any
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&captured); err != nil {
			t.Fatal(err)
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(recipeEnvelope)
	})
	_, err := client.Recipes.Create(context.Background(), CreateRecipeRequest{
		AgentSessionID: "agt_inmem_00000001",
		Label:          "login flow",
		Description:    "Logs into the test account.",
	})
	if err != nil {
		t.Fatal(err)
	}
	if captured["description"] != "Logs into the test account." {
		t.Errorf("description=%v", captured["description"])
	}
}

func TestRecipes_Create_NullableAgentSessionIDInResponse(t *testing.T) {
	t.Parallel()
	envelopeNullSession := make(map[string]any, len(recipeEnvelope))
	for k, v := range recipeEnvelope {
		envelopeNullSession[k] = v
	}
	envelopeNullSession["agent_session_id"] = nil
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(envelopeNullSession)
	})
	got, err := client.Recipes.Create(context.Background(), CreateRecipeRequest{
		AgentSessionID: "agt_inmem_00000001",
		Label:          "x",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.AgentSessionID != nil {
		t.Errorf("agent_session_id should decode as nil pointer when server returns null; got %v", *got.AgentSessionID)
	}
}

func TestRecipes_Suggest_URLEncodesTheSessionID(t *testing.T) {
	t.Parallel()
	suggestionEnvelope := map[string]any{
		"suggested_label":       "Fill form on example.com",
		"suggested_description": "Navigates to example.com, fills 1 field.",
		"intent_count":          4,
	}
	var gotPath string
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		// r.URL.Path is the DECODED path (%2F would show as a literal
		// slash); EscapedPath() preserves the wire encoding — the same
		// pattern client_test.go / crypto_orders_test.go use to assert
		// url.PathEscape actually encoded '/' and ' '.
		gotPath = r.URL.EscapedPath()
		if r.Method != "GET" {
			t.Errorf("unexpected method: %s", r.Method)
		}
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(suggestionEnvelope)
	})
	got, err := client.Recipes.Suggest(context.Background(), "agt/with space")
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/agent-sessions/agt%2Fwith%20space/recipe-suggestion" {
		t.Errorf("path=%q", gotPath)
	}
	if got.SuggestedLabel != "Fill form on example.com" {
		t.Errorf("suggested_label=%q", got.SuggestedLabel)
	}
	if got.IntentCount != 4 {
		t.Errorf("intent_count=%d", got.IntentCount)
	}
}
