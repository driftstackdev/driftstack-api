package driftstack

import (
	"encoding/json"
	"testing"
)

func TestWaitConditionConstructors(t *testing.T) {
	tests := []struct {
		name      string
		condition WaitCondition
		expect    string
	}{
		{
			name:      "selector condition",
			condition: NewSelectorCondition("#go"),
			expect:    `{"kind":"selector","selector":"#go"}`,
		},
		{
			name:      "selector_hidden condition",
			condition: NewSelectorHiddenCondition("#spinner"),
			expect:    `{"kind":"selector_hidden","selector":"#spinner"}`,
		},
		{
			name:      "url_matches condition",
			condition: NewURLMatchesCondition(`https://.*\.example\.com/.*`),
			expect:    `{"kind":"url_matches","pattern":"https://.*\\.example\\.com/.*"}`,
		},
		{
			name:      "time condition uses kind=\"time\" per the contract",
			condition: NewTimeCondition(5000),
			expect:    `{"kind":"time","ms":5000}`,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := json.Marshal(tc.condition)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			if string(got) != tc.expect {
				t.Errorf("expected %q, got %q", tc.expect, got)
			}
		})
	}
}

func TestNavigateRequestMarshalling(t *testing.T) {
	req := NavigateRequest{URL: "https://example.com", WaitUntil: "load", TimeoutMS: 15000}
	got, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	expect := `{"url":"https://example.com","wait_until":"load","timeout_ms":15000}`
	if string(got) != expect {
		t.Errorf("expected %q, got %q", expect, got)
	}
}

func TestSessionLoginResponseStrictBranches(t *testing.T) {
	t.Run("submitted branch", func(t *testing.T) {
		raw := []byte(`{"submitted":true,"credentials_truncated":false,"logged_in":false,"post_login_url":"https://example.test/challenge","duration_ms":12450}`)
		var got SessionLoginResponse
		if err := json.Unmarshal(raw, &got); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if !got.Submitted || got.CredentialsTruncated || got.LoggedIn || got.DurationMS != 12450 {
			t.Fatalf("unexpected submitted outcome: %+v", got)
		}
		if got.PostLoginURL != "https://example.test/challenge" {
			t.Fatalf("post_login_url=%q", got.PostLoginURL)
		}
	})

	t.Run("safe truncation branch", func(t *testing.T) {
		raw := []byte(`{"submitted":false,"credentials_truncated":true,"logged_in":false,"duration_ms":600000}`)
		var got SessionLoginResponse
		if err := json.Unmarshal(raw, &got); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if got.Submitted || !got.CredentialsTruncated || got.LoggedIn || got.PostLoginURL != "" || got.DurationMS != 600000 {
			t.Fatalf("unexpected truncation outcome: %+v", got)
		}
	})

	invalid := []string{
		`{"submitted":true,"credentials_truncated":true,"logged_in":false,"duration_ms":1}`,
		`{"submitted":false,"credentials_truncated":true,"logged_in":true,"duration_ms":1}`,
		`{"submitted":false,"credentials_truncated":true,"logged_in":false,"post_login_url":"https://example.test/leak","duration_ms":1}`,
		`{"submitted":false,"credentials_truncated":true,"logged_in":false,"post_login_url":null,"duration_ms":1}`,
		`{"submitted":true,"credentials_truncated":false,"logged_in":true,"post_login_url":null,"duration_ms":1}`,
		`{"submitted":true,"credentials_truncated":false,"logged_in":true,"duration_ms":600001}`,
		`{"submitted":true,"credentials_truncated":false,"logged_in":true,"duration_ms":1,"unexpected":true}`,
		`{"credentials_truncated":false,"logged_in":true,"duration_ms":1}`,
	}
	for i, raw := range invalid {
		var got SessionLoginResponse
		if err := json.Unmarshal([]byte(raw), &got); err == nil {
			t.Fatalf("invalid case %d was accepted: %+v", i, got)
		}
	}
}

func TestSearchResponseStrictBranches(t *testing.T) {
	visible := false
	completedRaw := []byte(`{"submitted":false,"query_truncated":false,"results_visible":false,"duration_ms":8420}`)
	var completed SearchResponse
	if err := json.Unmarshal(completedRaw, &completed); err != nil {
		t.Fatalf("unmarshal completed: %v", err)
	}
	if completed.Submitted || completed.QueryTruncated || completed.DurationMS != 8420 || completed.ResultsVisible == nil || *completed.ResultsVisible != visible {
		t.Fatalf("unexpected completed outcome: %+v", completed)
	}

	truncatedRaw := []byte(`{"submitted":false,"query_truncated":true,"duration_ms":600000}`)
	var truncated SearchResponse
	if err := json.Unmarshal(truncatedRaw, &truncated); err != nil {
		t.Fatalf("unmarshal truncated: %v", err)
	}
	if truncated.Submitted || !truncated.QueryTruncated || truncated.ResultsVisible != nil || truncated.DurationMS != 600000 {
		t.Fatalf("unexpected truncated outcome: %+v", truncated)
	}

	invalid := []string{
		`{"submitted":true,"query_truncated":true,"duration_ms":1}`,
		`{"submitted":false,"query_truncated":true,"results_visible":false,"duration_ms":1}`,
		`{"submitted":true,"query_truncated":false,"results_visible":null,"duration_ms":1}`,
		`{"submitted":true,"query_truncated":false,"duration_ms":600001}`,
		`{"submitted":true,"query_truncated":false,"duration_ms":1,"unexpected":true}`,
		`{"query_truncated":false,"duration_ms":1}`,
	}
	for i, raw := range invalid {
		var got SearchResponse
		if err := json.Unmarshal([]byte(raw), &got); err == nil {
			t.Fatalf("invalid case %d was accepted: %+v", i, got)
		}
	}
}

func TestInteractActionConstructors(t *testing.T) {
	tests := []struct {
		name   string
		action InteractAction
		expect string
	}{
		{
			name:   "tap with selector",
			action: NewTapAction("#go"),
			expect: `{"kind":"tap","selector":"#go"}`,
		},
		{
			name:   "type with selector",
			action: NewTypeAction("input[name=email]", "hi"),
			expect: `{"kind":"type","selector":"input[name=email]","text":"hi"}`,
		},
		{
			name:   "scroll uses delta_x / delta_y per the contract",
			action: NewScrollAction(0, 200),
			expect: `{"kind":"scroll","delta_y":200}`,
		},
		{
			name:   "press with key",
			action: NewPressAction("Enter"),
			expect: `{"kind":"press","key":"Enter"}`,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := json.Marshal(tc.action)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			if string(got) != tc.expect {
				t.Errorf("expected %q, got %q", tc.expect, got)
			}
		})
	}
}

// Arc 5 EGRESS eg.1.g.2 — Session unmarshalling round-trips the
// new egress_capability_report field. Pins that the raw payload
// survives the JSON wire boundary as a typed map[string]any so
// customer code can branch on harness-emitted fields the SDK
// schema doesn't formally know about.
func TestSessionUnmarshallingEgressCapabilityReport(t *testing.T) {
	body := []byte(`{
		"id": "ses_00000000-0000-0000-0000-000000000001",
		"account_id": "acc_00000000-0000-0000-0000-000000000002",
		"api_key_id": "key_00000000-0000-0000-0000-000000000003",
		"status": "ready",
		"archetype": "iphone16pro_ios18_7_safari26_4",
		"purpose": "production_customer",
		"label": null,
		"metadata": null,
		"egress_capabilities": {
			"udp_associate": true,
			"quic_route": "proxy",
			"dns_remote_resolve": false,
			"warnings": []
		},
		"egress_capability_report": {
			"udp_associate": true,
			"harness_diagnostic": {"rtt_ms": 12, "hop_count": 3}
		},
		"created_at": "2026-05-18T12:00:00Z",
		"updated_at": "2026-05-18T12:00:00Z",
		"last_state_at": null,
		"destroyed_at": null
	}`)
	var s Session
	if err := json.Unmarshal(body, &s); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if s.EgressCapabilityReport == nil {
		t.Fatal("expected EgressCapabilityReport to be non-nil")
	}
	if got, ok := s.EgressCapabilityReport["udp_associate"].(bool); !ok || !got {
		t.Errorf("expected EgressCapabilityReport[\"udp_associate\"] == true, got %v", s.EgressCapabilityReport["udp_associate"])
	}
	diag, ok := s.EgressCapabilityReport["harness_diagnostic"].(map[string]any)
	if !ok {
		t.Fatalf("expected harness_diagnostic to be map[string]any, got %T", s.EgressCapabilityReport["harness_diagnostic"])
	}
	if got := diag["rtt_ms"]; got != float64(12) {
		t.Errorf("expected rtt_ms == 12, got %v (%T)", got, got)
	}
}

// Defensive: a Session without egress_capability_report (e.g.
// pre-migration row, non-SOCKS5 session, or harness hasn't emitted
// yet) unmarshals with the field as nil — NOT an empty map. This
// lets customer code use `if sess.EgressCapabilityReport != nil`
// as the gating check.
func TestSessionUnmarshallingEgressCapabilityReportNull(t *testing.T) {
	body := []byte(`{
		"id": "ses_00000000-0000-0000-0000-000000000001",
		"account_id": "acc_00000000-0000-0000-0000-000000000002",
		"api_key_id": "key_00000000-0000-0000-0000-000000000003",
		"status": "ready",
		"archetype": "iphone16pro_ios18_7_safari26_4",
		"purpose": "production_customer",
		"label": null,
		"metadata": null,
		"egress_capabilities": null,
		"egress_capability_report": null,
		"created_at": "2026-05-18T12:00:00Z",
		"updated_at": "2026-05-18T12:00:00Z",
		"last_state_at": null,
		"destroyed_at": null
	}`)
	var s Session
	if err := json.Unmarshal(body, &s); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if s.EgressCapabilityReport != nil {
		t.Errorf("expected EgressCapabilityReport to be nil for null wire value, got %v", s.EgressCapabilityReport)
	}
}
