package driftstack

import "context"

// RecipesResource handles /v1/recipes (AI-B4; write-only at v1.0).
// Mirrors the TypeScript + Python RecipesResource.
//
// Server registers this endpoint as a 503 FeatureUnavailable stub
// until both recipesRepo and agentSessionsRepo are wired in AppDeps.
// SDK surface is stable so consumers compile ahead of time.
//
// V1.0 SDK surface is intentionally narrow — Create only. Read /
// list / execute / delete surfaces are v1.1 D2/D3.
type RecipesResource struct {
	client *Client
}

// Recipe is the read envelope returned by Create.
type Recipe struct {
	ID              string  `json:"id"`
	AccountID       string  `json:"account_id"`
	AgentSessionID  *string `json:"agent_session_id"`
	Label           string  `json:"label"`
	Description     *string `json:"description"`
	IntentCount     int     `json:"intent_count"`
	CreatedAt       string  `json:"created_at"`
	UpdatedAt       string  `json:"updated_at"`
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
