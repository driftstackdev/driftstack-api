package driftstack

import "context"

// PublicArchetype is one customer-selectable device/iOS/Safari combination.
type PublicArchetype struct {
	ID            string `json:"id"`
	DisplayLabel  string `json:"display_label"`
	Device        string `json:"device"`
	IOSVersion    string `json:"ios_version"`
	SafariVersion string `json:"safari_version"`
	CanvasFamily  string `json:"canvas_family"`
	Status        string `json:"status"`
	IsDefault     bool   `json:"is_default"`
}

// ListArchetypesResponse contains the current default and complete public catalog.
type ListArchetypesResponse struct {
	DefaultArchetypeID string            `json:"default_archetype_id"`
	Data               []PublicArchetype `json:"data"`
}

// ArchetypesResource handles the public server-authoritative archetype catalog.
type ArchetypesResource struct {
	client *Client
}

// List returns every customer-selectable archetype and the current default.
func (r *ArchetypesResource) List(ctx context.Context) (*ListArchetypesResponse, error) {
	var out ListArchetypesResponse
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/archetypes",
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}
