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

func TestInteractActionConstructors(t *testing.T) {
	tests := []struct {
		name    string
		action  InteractAction
		expect  string
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
