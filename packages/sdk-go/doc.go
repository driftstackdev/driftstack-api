// Package driftstack is the official Go SDK for the Driftstack API —
// stealth iPhone Safari automation, called from Go.
//
// Quickstart:
//
//	client := driftstack.New("ds_live_…")
//	defer client.Close()
//
//	ctx := context.Background()
//	session, err := client.Sessions.Create(ctx, nil)
//	if err != nil {
//		log.Fatal(err)
//	}
//	if _, err := client.Sessions.Navigate(ctx, session.ID, &driftstack.NavigateRequest{
//		URL: "https://example.com/",
//	}); err != nil {
//		log.Fatal(err)
//	}
//	_ = client.Sessions.Destroy(ctx, session.ID)
//
// Errors are typed: every server problem-type maps to a concrete error
// type customers can switch on with errors.As. The retry policy is
// applied automatically (configurable via [WithRetry]) and honours
// Retry-After. Retries fire on transport errors and 429 rate limits
// (not on 4xx or 5xx response bodies — those are terminal in the Go
// SDK). Because a transport error can mean a request the server already
// processed but whose response was lost, an automatically-retried create
// or charge can execute twice — pass an IdempotencyKey on those calls
// (e.g. CreateOptions.IdempotencyKey) so the server collapses the retry.
//
// Webhook signature verification is in [VerifyWebhookSignature].
//
// Module path: github.com/driftstackdev/driftstack-api/packages/sdk-go
package driftstack
