// Package main shows the cursor-pagination loop pattern. Go pre-1.23 has
// no generators / range-over-func, so the SDK exposes raw List(...)
// methods that return one page at a time. This example wraps the page
// loop into a small helper so caller code reads as a single for-loop.
//
// The pattern translates 1:1 to webhook deliveries (client.Webhooks.
// ListDeliveries) — same shape: Data + NextCursor + has_more.
//
// Run with:
//
//	DRIFTSTACK_API_KEY=ds_live_... go run ./examples/pagination
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
	client := driftstack.New(apiKey)
	defer client.Close()

	ctx := context.Background()

	// Pattern 1 — walk every session, newest first.
	count := 0
	cursor := ""
	for {
		page, err := client.Sessions.List(ctx, &driftstack.ListSessionsQuery{
			Limit:  50,
			Cursor: cursor,
		})
		if err != nil {
			log.Fatalf("list sessions: %v", err)
		}
		for _, s := range page.Data {
			count++
			if count <= 5 {
				fmt.Printf("  %s  %s  %s\n", s.ID, s.Status, s.Archetype)
			}
		}
		if page.NextCursor == nil {
			break
		}
		cursor = *page.NextCursor
	}
	fmt.Printf("→ %d session(s) total\n", count)

	// Pattern 2 — early-exit on the first match. Cursor pagination is
	// page-aligned so the loop body controls how aggressively to walk.
	target := os.Getenv("FIND_SESSION_LABEL")
	if target == "" {
		return
	}
	cursor = ""
	for {
		page, err := client.Sessions.List(ctx, &driftstack.ListSessionsQuery{
			Limit:  100,
			Cursor: cursor,
		})
		if err != nil {
			log.Fatalf("list sessions: %v", err)
		}
		for _, s := range page.Data {
			if s.Label != nil && *s.Label == target {
				fmt.Printf("found: %s (%s)\n", s.ID, *s.Label)
				return
			}
		}
		if page.NextCursor == nil {
			break
		}
		cursor = *page.NextCursor
	}
	fmt.Printf("no session with label %q\n", target)
}
