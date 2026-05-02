// Package main is the quickstart example for the Driftstack Go SDK.
//
// Run:
//
//	DRIFTSTACK_API_KEY=ds_live_… go run ./examples/quickstart
package main

import (
	"context"
	"fmt"
	"log"
	"os"

	driftstack "github.com/driftstackdev/driftstack-api/packages/sdk-go"
)

func main() {
	apiKey := os.Getenv("DRIFTSTACK_API_KEY")
	if apiKey == "" {
		log.Fatal("DRIFTSTACK_API_KEY environment variable is required")
	}

	opts := []driftstack.Option{}
	if base := os.Getenv("DRIFTSTACK_BASE_URL"); base != "" {
		opts = append(opts, driftstack.WithBaseURL(base))
	}
	client := driftstack.New(apiKey, opts...)
	defer client.Close()

	ctx := context.Background()

	// Create a session.
	label := "quickstart"
	session, err := client.Sessions.Create(ctx, &driftstack.CreateSessionRequest{Label: label})
	if err != nil {
		log.Fatalf("create session: %v", err)
	}
	fmt.Printf("created session %s\n", session.ID)

	// Navigate.
	if _, err := client.Sessions.Navigate(ctx, session.ID, &driftstack.NavigateRequest{
		URL: "https://example.com/",
	}); err != nil {
		log.Fatalf("navigate: %v", err)
	}
	fmt.Println("navigated")

	// Capture a screenshot.
	cap, err := client.Sessions.Capture(ctx, session.ID, &driftstack.CaptureRequest{
		Kind: driftstack.CaptureScreenshot,
	})
	if err != nil {
		log.Fatalf("capture: %v", err)
	}
	fmt.Printf("captured screenshot (%d bytes)\n", cap.ByteSize)

	// Destroy. Idempotent — safe to call twice.
	if err := client.Sessions.Destroy(ctx, session.ID); err != nil {
		log.Fatalf("destroy: %v", err)
	}
	fmt.Printf("destroyed session %s\n", session.ID)
}
