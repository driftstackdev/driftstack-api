// Package main shows a worker-pool pattern: fan out N concurrent
// session ops, collect results. Honours the SDK's tier rate limit
// because each worker uses the same client (which retries + bounded
// retries; rate-limit excursions automatically back off).
//
// Run:
//
//	DRIFTSTACK_API_KEY=ds_live_… go run ./examples/goroutine_pool
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"sync"

	driftstack "github.com/driftstackdev/driftstack-api/packages/sdk-go"
)

const numWorkers = 4

func main() {
	apiKey := os.Getenv("DRIFTSTACK_API_KEY")
	if apiKey == "" {
		log.Fatal("DRIFTSTACK_API_KEY required")
	}
	client := driftstack.New(apiKey)
	defer client.Close()
	ctx := context.Background()

	urls := []string{
		"https://example.com/",
		"https://example.org/",
		"https://example.net/",
		"https://golang.org/",
		"https://httpbin.org/get",
	}

	jobs := make(chan string, len(urls))
	results := make(chan string, len(urls))
	var wg sync.WaitGroup

	worker := func(id int) {
		defer wg.Done()
		for url := range jobs {
			session, err := client.Sessions.Create(ctx, nil)
			if err != nil {
				results <- fmt.Sprintf("worker %d url %s ERR create: %v", id, url, err)
				continue
			}
			if _, err := client.Sessions.Navigate(ctx, session.ID, &driftstack.NavigateRequest{
				URL: url,
			}); err != nil {
				results <- fmt.Sprintf("worker %d url %s ERR navigate: %v", id, url, err)
				_ = client.Sessions.Destroy(ctx, session.ID)
				continue
			}
			state, err := client.Sessions.GetState(ctx, session.ID)
			if err != nil {
				results <- fmt.Sprintf("worker %d url %s ERR state: %v", id, url, err)
			} else {
				title := ""
				if state.Title != nil {
					title = *state.Title
				}
				results <- fmt.Sprintf("worker %d url %s OK title=%q", id, url, title)
			}
			_ = client.Sessions.Destroy(ctx, session.ID)
		}
	}

	for i := 0; i < numWorkers; i++ {
		wg.Add(1)
		go worker(i)
	}
	for _, u := range urls {
		jobs <- u
	}
	close(jobs)

	go func() {
		wg.Wait()
		close(results)
	}()

	for r := range results {
		fmt.Println(r)
	}
}
