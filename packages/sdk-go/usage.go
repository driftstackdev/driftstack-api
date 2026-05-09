package driftstack

import (
	"context"
	"net/url"
	"strconv"
)

// UsageResource handles /v1/usage + /v1/usage/series.
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

// UsageDailyBucket — V-452 single-day bucket on the time series.
// `Totals` keys are the UsageRecordType enum values (e.g.
// "session_minute", "navigate", "interact", etc.).
type UsageDailyBucket struct {
	Date   string         `json:"date"` // YYYY-MM-DD
	Totals map[string]int `json:"totals"`
}

// UsageSeriesResponse — V-452 daily-bucketed time series.
type UsageSeriesResponse struct {
	FromDate string             `json:"from_date"`
	ToDate   string             `json:"to_date"`
	Buckets  []UsageDailyBucket `json:"buckets"`
}

// Series — V-452 daily-bucketed usage time series. `days` is 1-90;
// default 30 server-side when 0 / negative.
func (r *UsageResource) Series(ctx context.Context, days int) (*UsageSeriesResponse, error) {
	var out UsageSeriesResponse
	q := url.Values{}
	if days > 0 {
		q.Set("days", strconv.Itoa(days))
	}
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/usage/series",
		query:  q,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}
