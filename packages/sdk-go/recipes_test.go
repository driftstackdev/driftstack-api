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

// Pagination. List and Iterate had no arms at all: the tests above cover Create
// and Suggest only, so nothing asserted that a caller's Limit or Cursor ever
// reached the wire. The TS SDK carried the identical gap (V-1974), and the
// cross-SDK pagination contract is exactly the kind that drifts silently when
// only one language pins it.
func TestRecipes_List_ForwardsPaginationOnlyWhenSet(t *testing.T) {
	t.Parallel()
	var rawQuery string
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/recipes" || r.Method != "GET" {
			t.Errorf("unexpected: %s %s", r.Method, r.URL.Path)
		}
		rawQuery = r.URL.RawQuery
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(RecipesListPage{Data: []Recipe{}, HasMore: false})
	})

	// The zero query: Go treats Limit 0 and Cursor "" as unset, so NOTHING may
	// reach the URL. A stray "limit=0" would be a different request, and the
	// server rejects a zero limit.
	if _, err := client.Recipes.List(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if rawQuery != "" {
		t.Errorf("nil query should send no params, got %q", rawQuery)
	}

	// Limit alone must not invent a cursor key.
	if _, err := client.Recipes.List(context.Background(), &ListRecipesQuery{Limit: 25}); err != nil {
		t.Fatal(err)
	}
	if rawQuery != "limit=25" {
		t.Errorf("limit alone: got %q, want %q", rawQuery, "limit=25")
	}

	// Cursor alone must not invent a limit key.
	if _, err := client.Recipes.List(context.Background(), &ListRecipesQuery{Cursor: "cur_2"}); err != nil {
		t.Fatal(err)
	}
	if rawQuery != "cursor=cur_2" {
		t.Errorf("cursor alone: got %q, want %q", rawQuery, "cursor=cur_2")
	}
}

// The load-bearing one: page 2 must carry the cursor page 1 returned. Drop that
// handoff and the walk either repeats page 1 forever or stops early — neither is
// visible to a count of yielded items alone.
func TestRecipes_Iterate_ThreadsNextCursor(t *testing.T) {
	t.Parallel()
	var seenCursor []string
	cur2 := "cur_2"
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/recipes" || r.Method != "GET" {
			t.Errorf("unexpected: %s %s", r.Method, r.URL.Path)
		}
		seenCursor = append(seenCursor, r.URL.Query().Get("cursor"))
		w.Header().Set("content-type", "application/json")
		if r.URL.Query().Get("cursor") == "" {
			_ = json.NewEncoder(w).Encode(RecipesListPage{
				Data:       []Recipe{{ID: "rec_1", AccountID: "acc_1", Label: "a"}},
				HasMore:    true,
				NextCursor: &cur2,
			})
			return
		}
		_ = json.NewEncoder(w).Encode(RecipesListPage{
			Data:       []Recipe{{ID: "rec_2", AccountID: "acc_1", Label: "b"}},
			HasMore:    false,
			NextCursor: nil,
		})
	})

	var ids []string
	err := client.Recipes.Iterate(
		context.Background(),
		&ListRecipesQuery{Limit: 1},
		func(r *Recipe) (bool, error) {
			ids = append(ids, r.ID)
			return true, nil
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 2 || ids[0] != "rec_1" || ids[1] != "rec_2" {
		t.Errorf("ids=%v", ids)
	}
	// Page 1 sends no cursor; page 2 must send the one page 1 returned.
	if len(seenCursor) != 2 || seenCursor[0] != "" || seenCursor[1] != "cur_2" {
		t.Errorf("cursor handoff: got %v, want [\"\" \"cur_2\"]", seenCursor)
	}
}
