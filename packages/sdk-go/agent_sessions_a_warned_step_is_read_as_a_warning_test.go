package driftstack

// A step that SUCCEEDED with something worth knowing carries a Warning, and a
// clean step carries none. A navigation the site answered with 400 or above is
// the first kind: the step succeeded, the page may be an error page or a
// verification step, and Warning carries the status for a program to branch on.

import (
	"encoding/json"
	"testing"
)

func TestAWarnedStepIsReadAsAWarningAndACleanStepHasNone(t *testing.T) {
	t.Parallel()
	raw := `{"kind":"plan-executed","session":{},"ok":true,
	  "intents":[{"kind":"navigate","url":"https://x.test/a"},{"kind":"navigate","url":"https://x.test/b"},{"kind":"navigate","url":"https://x.test/c"}],
	  "results":[
	    {"kind":"success","intent":{"kind":"navigate","url":"https://x.test/a"},"summary":"navigated to https://x.test/a — the site answered 404 (this address may not exist)","warning":{"kind":"http_error_status","status":404}},
	    {"kind":"success","intent":{"kind":"navigate","url":"https://x.test/b"},"summary":"navigated to https://x.test/b"},
	    {"kind":"success","intent":{"kind":"navigate","url":"https://x.test/c"},"summary":"navigated","warning":{"kind":"a_warning_newer_than_this_sdk"}}
	  ]}`
	var resp AgentMessageResponse
	if err := json.Unmarshal([]byte(raw), &resp); err != nil {
		t.Fatal(err)
	}
	results, err := resp.ParsedResults()
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 3 {
		t.Fatalf("len=%d", len(results))
	}
	warned := results[0].Warning
	if warned == nil || warned.Kind != "http_error_status" || warned.Status == nil || *warned.Status != 404 {
		t.Errorf("warned=%+v", warned)
	}
	if results[1].Warning != nil {
		t.Errorf("a clean step carries a warning: %+v", results[1].Warning)
	}
	// A kind newer than this SDK is still read, with no status.
	newer := results[2].Warning
	if newer == nil || newer.Kind != "a_warning_newer_than_this_sdk" || newer.Status != nil {
		t.Errorf("newer=%+v", newer)
	}
	// And a clean step writes no warning back out.
	buf, err := json.Marshal(results[1])
	if err != nil {
		t.Fatal(err)
	}
	var back map[string]any
	if err := json.Unmarshal(buf, &back); err != nil {
		t.Fatal(err)
	}
	if _, ok := back["warning"]; ok {
		t.Errorf("clean step marshals a warning: %s", buf)
	}
}
