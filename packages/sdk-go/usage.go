package driftstack

import "context"

// UsageResource handles /v1/usage.
type UsageResource struct {
	client *Client
}

// CurrentPeriod returns the calendar-month-UTC totals + tier quotas
// for the current account.
func (r *UsageResource) CurrentPeriod(ctx context.Context) (*UsagePeriodSummary, error) {
	var out UsagePeriodSummary
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/usage",
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}
