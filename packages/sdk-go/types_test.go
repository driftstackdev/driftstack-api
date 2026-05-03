package driftstack

import (
	"encoding/json"
	"testing"
)

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
