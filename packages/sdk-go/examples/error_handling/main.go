// Package main shows the typed-error catch patterns: errors.As for
// payload, errors.Is for category.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"time"

	driftstack "github.com/driftstackdev/driftstack-api/packages/sdk-go"
)

func main() {
	apiKey := os.Getenv("DRIFTSTACK_API_KEY")
	if apiKey == "" {
		log.Fatal("DRIFTSTACK_API_KEY required")
	}
	client := driftstack.New(apiKey)
	defer client.Close()
	ctx := context.Background()

	// Custom retry loop on top of the SDK's default policy. Most callers
	// don't need this — the SDK retries TransportError + RateLimitError
	// automatically. Shown here as a recipe for finer control.
	var session *driftstack.Session
	for attempt := 0; attempt < 5; attempt++ {
		s, err := client.Sessions.Create(ctx, nil)
		if err == nil {
			session = s
			break
		}

		var rl *driftstack.RateLimitError
		if errors.As(err, &rl) {
			wait := time.Duration(rl.RetryAfterSeconds) * time.Second
			if wait == 0 {
				wait = time.Duration(1<<attempt) * time.Second
			}
			fmt.Printf("rate limited; waiting %v before retry %d/5\n", wait, attempt+1)
			time.Sleep(wait)
			continue
		}

		var cle *driftstack.ConcurrencyLimitError
		if errors.As(err, &cle) {
			log.Fatalf("concurrent-session ceiling: %d/%d", cle.CurrentSessions, cle.Limit)
		}

		var qe *driftstack.QuotaExceededError
		if errors.As(err, &qe) {
			log.Fatalf("quota exhausted for %s: %d/%d", qe.RecordType, qe.Current, qe.Limit)
		}

		// Sentinel-based catch-all for category.
		if errors.Is(err, driftstack.ErrAuth) {
			log.Fatalf("auth failure: %v", err)
		}

		log.Fatalf("create session: %v", err)
	}

	if session == nil {
		log.Fatal("gave up after 5 retries")
	}

	if err := client.Sessions.Destroy(ctx, session.ID); err != nil {
		log.Printf("warn: destroy failed: %v", err)
	}
}
