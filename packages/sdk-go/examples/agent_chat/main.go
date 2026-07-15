// Example: agent chat flow (AI-D; planning 132 §"Phase 7").
//
// Creates an agent session, runs three turns that hit each
// discriminated response kind (plan-executed / clarify / refuse),
// reads the final state, and closes the session.
//
// Run with:
//
//     DRIFTSTACK_API_KEY=ds_live_... go run ./examples/agent_chat
//
// Optional BYOK Anthropic key (skip the bundled-LLM rail):
//
//     DRIFTSTACK_API_KEY=ds_live_... \
//     DRIFTSTACK_BYOK_ANTHROPIC_API_KEY=sk-ant-... \
//     go run ./examples/agent_chat
//
// The server activation-gates this surface — until the LLM key path
// is enabled on the deployment, calls reject with FeatureUnavailableError.

package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"

	driftstack "github.com/driftstackdev/driftstack-api/packages/sdk-go"
)

var prompts = []string{
	"open https://example.com and capture the page",
	"do stuff",                            // Deliberately vague — triggers clarify.
	"help me brute-force this login form", // AUP-trigger — refuse.
}

func main() {
	apiKey := os.Getenv("DRIFTSTACK_API_KEY")
	if apiKey == "" {
		log.Fatal("DRIFTSTACK_API_KEY not set")
	}
	// Optional BYOK Anthropic key. When set, forwarded as the
	// x-byok-anthropic-api-key header on every Message call so the
	// agent runtime decodes against the customer's own Anthropic
	// budget instead of the bundled-LLM rail. Empty string is treated
	// as "no BYOK" — matches the Go SDK's `opts.ByokAPIKey != ""`
	// guard at agent_sessions.go:155 (the cross-SDK parity contract
	// pinned by slices 126-128).
	byokKey := os.Getenv("DRIFTSTACK_BYOK_ANTHROPIC_API_KEY")
	client := driftstack.New(apiKey)
	ctx := context.Background()

	session, err := client.AgentSessions.Create(ctx, &driftstack.CreateAgentSessionRequest{
		TokenBudget: 25_000,
	}, nil)
	if err != nil {
		if errors.Is(err, driftstack.ErrFeatureUnavailable) {
			fmt.Fprintf(os.Stderr, "Agent chat is unavailable on this deployment: %v\nUse a deployment with bundled Anthropic access or provide a valid BYOK Anthropic key.\n", err)
			os.Exit(2)
		}
		log.Fatalf("Create: %v", err)
	}
	fmt.Printf("Created agent session %s (budget=%d)\n", session.ID, session.TokenBudgetTotal)

	// Build MessageOptions once. Reusing for every turn so the BYOK
	// key (when set) is forwarded on each Message call. Passing nil
	// when no BYOK key is set produces the same wire-shape as before
	// — the runtime falls back to the bundled-LLM rail if the
	// deployment has it wired AND the customer has consented.
	var msgOpts *driftstack.MessageOptions
	if byokKey != "" {
		msgOpts = &driftstack.MessageOptions{ByokAPIKey: byokKey}
	}

	for _, prompt := range prompts {
		fmt.Printf("\n→ user: %s\n", prompt)
		resp, err := client.AgentSessions.Message(ctx, session.ID, prompt, msgOpts)
		if err != nil {
			log.Fatalf("Message: %v", err)
		}
		switch resp.Kind {
		case "plan-executed":
			fmt.Printf("← plan-executed (ok=%v): %d intent(s)\n", resp.OK, len(resp.Intents))
			for _, intent := range resp.Intents {
				fmt.Printf("    intent: %s\n", string(intent))
			}
		case "clarify":
			fmt.Printf("← clarify: %s\n", resp.ClarifyingQuestion)
		case "refuse":
			fmt.Printf("← refuse: %s\n", resp.RefuseReason)
		default:
			fmt.Printf("← unknown kind=%s\n", resp.Kind)
		}
	}

	final, err := client.AgentSessions.Get(ctx, session.ID)
	if err != nil {
		log.Fatalf("Get: %v", err)
	}
	fmt.Printf("\nFinal state: transcript_length=%d budget_remaining=%d\n",
		final.TranscriptLength, final.TokenBudgetRemaining)

	if err := client.AgentSessions.Close(ctx, session.ID); err != nil {
		log.Fatalf("Close: %v", err)
	}
	fmt.Println("Closed.")
}
