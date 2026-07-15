package driftstack

import (
	"context"
	"encoding/json"
	"net/url"
	"strconv"
)

// RecipesResource manages saved recipes and recipe suggestions.
//
// Surface: Create + List + Iterate + Get + Delete + Suggest. Deployments
// without recipe storage return the typed FeatureUnavailable error. Recipe
// execution is intentionally outside this resource; it has no Execute method.
type RecipesResource struct {
	client *Client
}

// Recipe is the list/create metadata envelope.
type Recipe struct {
	ID             string  `json:"id"`
	AccountID      string  `json:"account_id"`
	AgentSessionID *string `json:"agent_session_id"`
	Label          string  `json:"label"`
	Description    *string `json:"description"`
	IntentCount    int     `json:"intent_count"`
	CreatedAt      string  `json:"created_at"`
	UpdatedAt      string  `json:"updated_at"`
}

// RecipeDetail is the public recipe returned by Get. It embeds the list
// metadata and adds the ordered IntentLog. Sensitive type steps retain their
// selector and sensitive marker but omit the optional value; exact replay
// values stay encrypted server-side.
type RecipeDetail struct {
	Recipe
	IntentLog []json.RawMessage `json:"intent_log"`
}

// RecipesListPage is a page of recipes, newest first.
type RecipesListPage struct {
	Data       []Recipe `json:"data"`
	HasMore    bool     `json:"has_more"`
	NextCursor *string  `json:"next_cursor"`
}

// ListRecipesQuery holds the pagination knobs for List / Iterate.
type ListRecipesQuery struct {
	Limit  int
	Cursor string
}

// CreateRecipeRequest is the body for Create.
type CreateRecipeRequest struct {
	AgentSessionID string `json:"agent_session_id"`
	Label          string `json:"label"`
	Description    string `json:"description,omitempty"`
}

// Create snapshots a finished agent_session's intent_log + transcript
// into a new recipe row. Returns the inserted Recipe.
//
// Cross-account access on AgentSessionID returns 404 (not 403) — the
// server intentionally doesn't distinguish missing from forbidden to
// avoid existence leakage.
func (r *RecipesResource) Create(ctx context.Context, body CreateRecipeRequest) (*Recipe, error) {
	var out Recipe
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/recipes",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// List returns a page of the account's recipes, newest first. Pass nil
// for defaults.
func (r *RecipesResource) List(ctx context.Context, query *ListRecipesQuery) (*RecipesListPage, error) {
	var out RecipesListPage
	q := url.Values{}
	if query != nil {
		if query.Limit > 0 {
			q.Set("limit", strconv.Itoa(query.Limit))
		}
		if query.Cursor != "" {
			q.Set("cursor", query.Cursor)
		}
	}
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/recipes",
		query:  q,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// Iterate yields every recipe across cursor pages. The callback returns
// false to stop early; an error from the callback is propagated back.
func (r *RecipesResource) Iterate(ctx context.Context, query *ListRecipesQuery, fn func(*Recipe) (bool, error)) error {
	cursor := ""
	limit := 0
	if query != nil {
		limit = query.Limit
		cursor = query.Cursor
	}
	for {
		page, err := r.List(ctx, &ListRecipesQuery{Limit: limit, Cursor: cursor})
		if err != nil {
			return err
		}
		for i := range page.Data {
			cont, err := fn(&page.Data[i])
			if err != nil {
				return err
			}
			if !cont {
				return nil
			}
		}
		next, done, err := advanceCursor(cursor, page.NextCursor)
		if err != nil {
			return err
		}
		if done {
			return nil
		}
		cursor = next
	}
}

// Get fetches a single recipe with its public IntentLog. A missing or
// cross-account id returns 404 (existence not leaked) — propagated as an error.
func (r *RecipesResource) Get(ctx context.Context, recipeID string) (*RecipeDetail, error) {
	var out RecipeDetail
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/recipes/" + url.PathEscape(recipeID),
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// Delete removes a recipe. Unlike Profiles.Delete this is NOT
// idempotent — a missing or cross-account id returns 404 (propagated
// as an error), matching the server's deliberate existence-non-leak.
func (r *RecipesResource) Delete(ctx context.Context, recipeID string) error {
	return r.client.do(ctx, requestOptions{
		method: "DELETE",
		path:   "/v1/recipes/" + url.PathEscape(recipeID),
	})
}

// RecipeSuggestion is the doc-132 §5.2 (recipe auto-generation) v1.0
// slice response: a deterministic label/description suggestion derived
// from a session's own intent_log (same assembly Create uses).
type RecipeSuggestion struct {
	SuggestedLabel       string `json:"suggested_label"`
	SuggestedDescription string `json:"suggested_description"`
	IntentCount          int    `json:"intent_count"`
}

// Suggest fetches a label/description suggestion for agentSessionID's
// own intent_log. Read-only; safe to call speculatively before the
// customer decides to save. A missing or cross-account id returns 404
// (existence not leaked) — propagated as an error.
func (r *RecipesResource) Suggest(ctx context.Context, agentSessionID string) (*RecipeSuggestion, error) {
	var out RecipeSuggestion
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/agent-sessions/" + url.PathEscape(agentSessionID) + "/recipe-suggestion",
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}
