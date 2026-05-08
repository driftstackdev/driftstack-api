// Package main is the profile-management example for the Driftstack
// Go SDK. Walks the persistent-profile surface end-to-end: create →
// list → get → update → clone (V-313) → snapshot capture (V-312) →
// snapshot restore → cleanup.
//
// Run:
//
//	DRIFTSTACK_API_KEY=ds_live_… go run ./examples/profile_management
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

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

	// 1. Create a fresh profile.
	fmt.Println("creating profile…")
	created, err := client.Profiles.Create(ctx, &driftstack.CreateProfileRequest{
		Name: fmt.Sprintf("demo-%d", time.Now().Unix()),
	})
	if err != nil {
		log.Fatalf("create: %v", err)
	}
	fmt.Printf("  → %s (%s)\n", created.ID, created.Name)

	// 2. List via cursor walking.
	fmt.Println("listing profiles…")
	count := 0
	if err := client.Profiles.Iterate(ctx, &driftstack.ListProfilesQuery{Limit: 50},
		func(p *driftstack.Profile) (bool, error) {
			count++
			if count <= 5 {
				fmt.Printf("  %s  %s\n", p.ID, p.Name)
			}
			return true, nil
		}); err != nil {
		log.Fatalf("iterate: %v", err)
	}
	fmt.Printf("  → %d profile(s) total\n", count)

	// 3. Get one by id.
	fmt.Println("fetching by id…")
	fetched, err := client.Profiles.Get(ctx, created.ID)
	if err != nil {
		log.Fatalf("get: %v", err)
	}
	fmt.Printf("  → %s\n", fetched.ID)

	// 4. Update.
	fmt.Println("updating…")
	newName := created.Name + "-renamed"
	updated, err := client.Profiles.Update(ctx, created.ID, &driftstack.UpdateProfileRequest{
		Name: &newName,
	})
	if err != nil {
		log.Fatalf("update: %v", err)
	}
	fmt.Printf("  → %s\n", updated.Name)

	// 5. V-313 clone — server auto-derives "(copy)" naming.
	fmt.Println("cloning…")
	cloned, err := client.Profiles.Clone(ctx, updated.ID, nil)
	if err != nil {
		log.Fatalf("clone: %v", err)
	}
	fmt.Printf("  → %s  name=%q\n", cloned.ID, cloned.Name)

	// 6. V-312 snapshot capture — frozen point-in-time copy.
	fmt.Println("capturing snapshot…")
	snap, err := client.ProfileSnapshots.Capture(ctx, updated.ID,
		&driftstack.CaptureSnapshotRequest{
			Label:       "baseline",
			Description: "Captured by the profile-management example",
		})
	if err != nil {
		log.Fatalf("snapshot capture: %v", err)
	}
	fmt.Printf("  → %s  label=%q\n", snap.ID, snap.Label)

	// 7. Restore the snapshot into a NEW profile.
	fmt.Println("restoring snapshot into a new profile…")
	restored, err := client.ProfileSnapshots.Restore(ctx, snap.ID,
		&driftstack.RestoreSnapshotRequest{Name: updated.Name + "-restored"})
	if err != nil {
		log.Fatalf("restore: %v", err)
	}
	fmt.Printf("  → %s  name=%q\n", restored.ID, restored.Name)

	// 8. Cleanup.
	fmt.Println("cleaning up…")
	if err := client.ProfileSnapshots.Delete(ctx, snap.ID); err != nil {
		log.Fatalf("delete snapshot: %v", err)
	}
	for _, id := range []string{restored.ID, cloned.ID, updated.ID} {
		if err := client.Profiles.Delete(ctx, id); err != nil {
			log.Fatalf("delete profile %s: %v", id, err)
		}
	}
	fmt.Println("  → cleaned up")
}
