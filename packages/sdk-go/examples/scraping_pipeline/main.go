// Package main is a small scraping pipeline: target list → session
// per-target → navigate + capture → collect outputs.
//
// Demonstrates the resource composition pattern customers use most
// often (one session per workflow unit). Pairs well with goroutine_pool
// when scaling.
//
// Run:
//
//	DRIFTSTACK_API_KEY=ds_live_… go run ./examples/scraping_pipeline
package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	driftstack "github.com/driftstackdev/driftstack-api/packages/sdk-go"
)

func main() {
	apiKey := os.Getenv("DRIFTSTACK_API_KEY")
	if apiKey == "" {
		log.Fatal("DRIFTSTACK_API_KEY required")
	}

	outDir := os.Getenv("OUT_DIR")
	if outDir == "" {
		outDir = "./scrape-output"
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		log.Fatal(err)
	}

	client := driftstack.New(apiKey)
	defer client.Close()

	targets := []struct {
		name string
		url  string
	}{
		{"example", "https://example.com/"},
		{"go", "https://go.dev/"},
	}

	for _, target := range targets {
		if err := scrape(client, target.name, target.url, outDir); err != nil {
			log.Printf("[%s] failed: %v", target.name, err)
			continue
		}
		log.Printf("[%s] ok", target.name)
	}
}

func scrape(client *driftstack.Client, name, url, outDir string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	session, err := client.Sessions.Create(ctx, nil)
	if err != nil {
		return fmt.Errorf("create: %w", err)
	}
	defer func() {
		_ = client.Sessions.Destroy(context.Background(), session.ID)
	}()

	if _, err := client.Sessions.Navigate(ctx, session.ID, &driftstack.NavigateRequest{URL: url}); err != nil {
		var ne *driftstack.NotFoundError
		if errors.As(err, &ne) {
			return fmt.Errorf("upstream 404 for %s", url)
		}
		return fmt.Errorf("navigate: %w", err)
	}

	cap, err := client.Sessions.Capture(ctx, session.ID, &driftstack.CaptureRequest{
		Kind: driftstack.CaptureScreenshot,
	})
	if err != nil {
		return fmt.Errorf("capture: %w", err)
	}

	bytes, err := base64.StdEncoding.DecodeString(cap.Data)
	if err != nil {
		return fmt.Errorf("decode: %w", err)
	}
	path := filepath.Join(outDir, name+".png")
	if err := os.WriteFile(path, bytes, 0o644); err != nil {
		return fmt.Errorf("write: %w", err)
	}
	return nil
}
