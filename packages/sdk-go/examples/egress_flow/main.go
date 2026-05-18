// Example: customer-configurable egress flow.
//
// Demonstrates the EGRESS Phase 1 SOCKS5 lifecycle (planning 133):
//   1. Save a reusable SOCKS5 config to the customer's library.
//   2. Attach the proxy to an existing session (id passed in via env).
//   3. Read the session's proxy summary back (verifies safeguards).
//
// Run with:
//
//     DRIFTSTACK_API_KEY=ds_live_... \
//       DRIFTSTACK_PROXY_HOST=proxy.example.com \
//       DRIFTSTACK_PROXY_PORT=1080 \
//       DRIFTSTACK_SESSION_ID=ses_xxx \
//       go run ./examples/egress_flow
//
// The server activation-gates this surface — until the SOCKS5 backend
// is wired on the deployment, calls reject with FeatureUnavailableError.

package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"strconv"

	driftstack "github.com/driftstackdev/driftstack-api/packages/sdk-go"
)

func main() {
	apiKey := os.Getenv("DRIFTSTACK_API_KEY")
	proxyHost := os.Getenv("DRIFTSTACK_PROXY_HOST")
	proxyPortStr := os.Getenv("DRIFTSTACK_PROXY_PORT")
	sessionID := os.Getenv("DRIFTSTACK_SESSION_ID")
	if apiKey == "" || proxyHost == "" || proxyPortStr == "" || sessionID == "" {
		log.Fatal("DRIFTSTACK_API_KEY + DRIFTSTACK_PROXY_HOST + DRIFTSTACK_PROXY_PORT + DRIFTSTACK_SESSION_ID required")
	}
	proxyPort, err := strconv.Atoi(proxyPortStr)
	if err != nil {
		log.Fatalf("DRIFTSTACK_PROXY_PORT not numeric: %v", err)
	}

	client := driftstack.New(apiKey)
	ctx := context.Background()

	proxy := map[string]any{
		"type": "socks5",
		// udp_associate: required for WebRTC routing per planning 133.
		// require_remote_dns: EG-WK-1.9 (2026-05-17) — leave false to keep
		// DNS resolution local-side; set true to route DNS through the
		// proxy via SOCKS5 ATYP DOMAINNAME (0x03).
		"socks5": map[string]any{
			"host":               proxyHost,
			"port":               proxyPort,
			"udp_associate":      true,
			"require_remote_dns": false,
		},
	}

	// 1. Save the proxy config.
	saved, err := client.Egress.SaveProxy(ctx, &driftstack.SavedProxyConfig{
		Label: fmt.Sprintf("example %s", proxyHost),
		Proxy: proxy,
	})
	if err != nil {
		if errors.Is(err, driftstack.ErrFeatureUnavailable) {
			fmt.Fprintf(os.Stderr, "Egress not yet enabled on this deployment: %v\nPre-launch posture; comes online when the SOCKS5 backend wires up.\n", err)
			os.Exit(2)
		}
		log.Fatalf("SaveProxy: %v", err)
	}
	fmt.Printf("Saved proxy id=%s label=%s type=%s\n", saved.ID, saved.Label, saved.Type)

	// 2. Attach the proxy to the existing session.
	attached, err := client.Egress.AttachToSession(ctx, sessionID, &driftstack.SessionEgressConfig{
		SessionID: sessionID,
		Proxy:     proxy,
		EgressSafeguard: map[string]bool{
			"block_direct_internet":     true,
			"block_unproxied_dns":       true,
			"block_webrtc_stun_leakage": true,
		},
	})
	if err != nil {
		log.Fatalf("AttachToSession: %v", err)
	}
	fmt.Printf("Attached proxy type=%s; safeguards=%v\n", attached.Type, attached.Safeguards)

	// 3. Read it back to verify.
	read, err := client.Egress.GetSessionProxy(ctx, sessionID)
	if err != nil {
		log.Fatalf("GetSessionProxy: %v", err)
	}
	fmt.Printf("Session proxy summary: type=%s safeguards=%v\n", read.Type, read.Safeguards)
}
