// Example: run an AI task from code — start an agent session, send it a
// task, read the outcome, and close the session.
//
// The flow:
//  1. create the session (Mode "ai") and wait until its browser is ready;
//  2. send the task with a fresh idempotency key, printing live progress;
//  3. branch on the result's Kind — and, if the agent stopped before a
//     purchase, a payment or an account deletion, approve it by sending the
//     next message with the approvals;
//  4. close the session with defer, whatever happened.
//
// Run with:
//
//	DRIFTSTACK_API_KEY=ds_live_... go run ./examples/agent_chat
//
// Optional:
//
//	DRIFTSTACK_BYOK_ANTHROPIC_API_KEY=sk-ant-...  run the AI on your own Anthropic key
//	DRIFTSTACK_TASK='Open https://example.com and tell me the main heading.'
//	DRIFTSTACK_APPROVE_ACTIONS=yes                approve a purchase / payment /
//	                                              account deletion the agent stops on
//
// Deployments without an AI provider reject these calls with
// FeatureUnavailableError (exit code 2).
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"

	driftstack "github.com/driftstackdev/driftstack-api/packages/sdk-go"
)

const defaultTask = "Open https://example.com and tell me the main heading on the page."

func main() {
	os.Exit(run())
}

func run() int {
	apiKey := os.Getenv("DRIFTSTACK_API_KEY")
	if apiKey == "" {
		fmt.Fprintln(os.Stderr, "DRIFTSTACK_API_KEY not set")
		return 1
	}
	// Your own Anthropic key, optional. Empty means "none": the SDK sends the
	// x-byok-anthropic-api-key header only for a non-empty key.
	byokKey := os.Getenv("DRIFTSTACK_BYOK_ANTHROPIC_API_KEY")
	// Ask for what you want back ("…and tell me …"): a task that asks for
	// information comes back with an Answer. Put the start URL in the task.
	task := os.Getenv("DRIFTSTACK_TASK")
	if task == "" {
		task = defaultTask
	}
	approveActions := os.Getenv("DRIFTSTACK_APPROVE_ACTIONS") == "yes"

	client := driftstack.New(apiKey)
	ctx := context.Background()

	session, err := client.AgentSessions.Create(ctx, &driftstack.CreateAgentSessionRequest{
		Mode:        "ai",
		TokenBudget: 100_000,
	}, &driftstack.CreateOptions{IdempotencyKey: newKey(), ByokAPIKey: byokKey})
	if err != nil {
		return reportError(err)
	}
	sessionID := session.ID
	fmt.Printf("Created agent session %s\n", sessionID)
	// Always close: an open session keeps counting toward your plan's limit.
	defer func() {
		if err := client.AgentSessions.Close(ctx, sessionID); err != nil {
			fmt.Fprintf(os.Stderr, "Could not close the session: %v\n", err)
			return
		}
		fmt.Println("Closed.")
	}()

	// A runaway task is stopped after ten minutes; Message then returns Kind "stopped".
	stopTimer := time.AfterFunc(10*time.Minute, func() {
		_, _ = client.AgentSessions.Stop(ctx, sessionID)
	})
	defer stopTimer.Stop()

	ready, err := waitUntilReady(ctx, client, session)
	if err != nil {
		return reportError(err)
	}
	if ready.Status != "active" {
		reason := "none"
		if ready.ClosedReason != nil {
			reason = *ready.ClosedReason
		}
		fmt.Fprintf(os.Stderr, "The session did not start: status=%s closed_reason=%s\n", ready.Status, reason)
		return 1
	}

	send := func(text string, approvals []driftstack.ConsequentialActionApproval) (*driftstack.AgentMessageResponse, error) {
		return client.AgentSessions.Message(ctx, sessionID, text, &driftstack.MessageOptions{
			ByokAPIKey: byokKey,
			// One key per logical turn. Reuse a key only to retry the same
			// turn after the connection dropped with no response.
			IdempotencyKey:              newKey(),
			ApproveConsequentialActions: approvals,
			OnStep: func(step driftstack.AgentStepEvent) {
				fmt.Printf("  step %d: %s\n", step.Index+1, step.Result.Kind)
			},
			OnEvent: func(name string, data json.RawMessage) {
				// The set of event names is open: ignore the ones you do not use.
				if name != "step_start" {
					return
				}
				var start struct {
					Label string `json:"label"`
				}
				if json.Unmarshal(data, &start) == nil && start.Label != "" {
					fmt.Printf("  … %s\n", start.Label)
				}
			},
		})
	}

	fmt.Printf("→ %s\n", task)
	resp, err := send(task, nil)
	if err != nil {
		return reportError(err)
	}
	results, err := resp.ParsedResults()
	if err != nil {
		return reportError(err)
	}

	// The agent stops BEFORE a purchase, a payment or an account deletion and
	// waits for approval. Approve by sending the very next message with the
	// approvals.
	var pending []driftstack.ConsequentialActionApproval
	for _, r := range results {
		if r.Kind == "confirmation_required" {
			pending = append(pending, driftstack.ApprovalFor(r))
		}
	}
	if resp.Kind == "plan-executed" && len(pending) > 0 && approveActions {
		fmt.Println("Approving and continuing…")
		if resp, err = send(task, pending); err != nil {
			return reportError(err)
		}
		if results, err = resp.ParsedResults(); err != nil {
			return reportError(err)
		}
	}
	printOutcome(resp, results)
	return 0
}

// waitUntilReady polls until the session's browser is ready (or two minutes pass).
func waitUntilReady(ctx context.Context, client *driftstack.Client, session *driftstack.AgentSession) (*driftstack.AgentSession, error) {
	deadline := time.Now().Add(2 * time.Minute)
	for session.Status == "provisioning" && time.Now().Before(deadline) {
		time.Sleep(2 * time.Second)
		next, err := client.AgentSessions.Get(ctx, session.ID)
		if err != nil {
			return nil, err
		}
		session = next
	}
	return session, nil
}

func printOutcome(resp *driftstack.AgentMessageResponse, results []driftstack.AgentIntentResult) {
	switch resp.Kind {
	case "plan-executed":
		for _, r := range results {
			switch r.Kind {
			case "success":
				fmt.Printf("  ✓ %s\n", r.Summary)
			case "failure":
				// Treat a category you do not recognise as "unknown". Never
				// replay a step whose Retryable is false without checking first.
				category := "unknown"
				if r.Diagnosis != nil {
					category = r.Diagnosis.Category
				}
				fmt.Printf("  ✗ %s (%s)\n", r.Reason, category)
			case "confirmation_required":
				fmt.Printf("  ⏸ waiting for approval: %s (%q)\n", r.Category, r.MatchedText)
			default:
				fmt.Printf("  ? %s\n", r.Kind)
			}
		}
		if resp.Answer != "" {
			fmt.Printf("Answer: %s\n", resp.Answer)
		}
		// OK alone does not mean finished: a Notice says why the task is not
		// done yet (send "continue" as the next message when it asks for that).
		if resp.Notice != "" {
			fmt.Printf("Not finished: %s\n", resp.Notice)
		}
		if resp.OK && resp.Notice == "" {
			fmt.Println("Done.")
		} else {
			fmt.Println("The task did not finish.")
		}
	case "clarify":
		fmt.Printf("The agent asks: %s (reply with another message)\n", resp.ClarifyingQuestion)
	case "refuse":
		fmt.Printf("Refused: %s\n", resp.RefuseReason)
	case "stopped":
		fmt.Printf("Stopped: %s\n", resp.Notice)
	case "logged-manual":
		fmt.Println("Recorded without running (manual mode).")
	default:
		// A kind newer than this example: log it rather than fail.
		fmt.Printf("Unrecognised result kind %q\n", resp.Kind)
	}
}

// reportError maps the AI-specific errors to a message and an exit code.
func reportError(err error) int {
	var forbidden *driftstack.ForbiddenError
	var rateLimit *driftstack.RateLimitError
	var conflict *driftstack.ConflictError
	switch {
	case errors.Is(err, driftstack.ErrFeatureUnavailable):
		fmt.Fprintf(os.Stderr, "AI tasks are unavailable on this deployment: %v\nUse a deployment with bundled Anthropic access or provide a valid BYOK Anthropic key.\n", err)
		return 2
	case errors.As(err, &forbidden) && forbidden.RequiresOwnKey():
		fmt.Fprintf(os.Stderr, "%s runs only on your own Anthropic key: set DRIFTSTACK_BYOK_ANTHROPIC_API_KEY or pick another model.\n", forbidden.Model())
	case errors.Is(err, driftstack.ErrByokAnthropicRequired),
		errors.Is(err, driftstack.ErrBundledLlmConsentRequired),
		errors.Is(err, driftstack.ErrBundledLlmBudgetExhausted):
		fmt.Fprintf(os.Stderr, "No AI key or budget is available: %v\n", err)
	case errors.As(err, &rateLimit):
		fmt.Fprintf(os.Stderr, "Too many requests or AI tasks at once. Wait %ds, then send again with a new idempotency key.\n", rateLimit.RetryAfterSeconds)
	case errors.Is(err, driftstack.ErrConcurrencyLimit):
		fmt.Fprintf(os.Stderr, "Concurrency limit reached: %v\n", err)
	case errors.As(err, &conflict) && conflict.TurnInProgress():
		fmt.Fprintln(os.Stderr, "Another message is still running on this session.")
	case errors.As(err, &conflict) && conflict.SessionStatus() != "":
		fmt.Fprintf(os.Stderr, "The session is %s; start a new one.\n", conflict.SessionStatus())
	default:
		fmt.Fprintf(os.Stderr, "Request failed: %v\n", err)
	}
	return 1
}

// newKey returns a random idempotency key.
func newKey() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
