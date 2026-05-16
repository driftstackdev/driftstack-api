// Example: customer-configurable egress — OpenVPN variant (Phase 2
// priority per planning 133 + ORCHESTRATOR-STATE 2026-05-16).
//
// Demonstrates the OpenVPN attach flow:
//  1. Read the customer's .ovpn file from disk.
//  2. Save it to the reusable proxy library.
//  3. Attach it to an existing session.
//
// Server-side validation (api-types OpenVpnProxyConfigSchema) rejects
// blobs missing the `client` or `remote <host> <port>` directives with
// a 400 — surfacing as ValidationError in the SDK.
//
// Run with:
//
//     DRIFTSTACK_API_KEY=ds_live_... \
//       DRIFTSTACK_OVPN_CONFIG_PATH=/path/to/my.ovpn \
//       DRIFTSTACK_SESSION_ID=ses_xxx \
//       go run ./examples/egress_openvpn

package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	driftstack "github.com/driftstackdev/driftstack-api/packages/sdk-go"
)

const maxOvpnBytes = 256 * 1024

func main() {
	apiKey := os.Getenv("DRIFTSTACK_API_KEY")
	ovpnPath := os.Getenv("DRIFTSTACK_OVPN_CONFIG_PATH")
	sessionID := os.Getenv("DRIFTSTACK_SESSION_ID")
	if apiKey == "" || ovpnPath == "" || sessionID == "" {
		log.Fatal("DRIFTSTACK_API_KEY + DRIFTSTACK_OVPN_CONFIG_PATH + DRIFTSTACK_SESSION_ID required")
	}

	blob, err := os.ReadFile(ovpnPath)
	if err != nil {
		log.Fatalf("read %s: %v", ovpnPath, err)
	}
	if len(blob) > maxOvpnBytes {
		log.Fatalf("OpenVPN config %s is %d bytes; max %d", ovpnPath, len(blob), maxOvpnBytes)
	}

	client := driftstack.New(apiKey)
	ctx := context.Background()

	openvpn := map[string]any{"config_blob": string(blob)}
	if u := os.Getenv("DRIFTSTACK_OVPN_USERNAME"); u != "" {
		openvpn["username"] = u
	}
	if p := os.Getenv("DRIFTSTACK_OVPN_PASSWORD"); p != "" {
		openvpn["password"] = p
	}
	proxy := map[string]any{"type": "openvpn", "openvpn": openvpn}

	label := "openvpn-" + strings.TrimSuffix(filepath.Base(ovpnPath), filepath.Ext(ovpnPath))

	// 1. Save the OpenVPN config.
	saved, err := client.Egress.SaveProxy(ctx, &driftstack.SavedProxyConfig{
		Label: label,
		Proxy: proxy,
	})
	if err != nil {
		var validationErr *driftstack.ValidationError
		if errors.As(err, &validationErr) {
			fmt.Fprintf(os.Stderr,
				"OpenVPN config rejected by server validation: %v\n"+
					"Check that the config has `client` + `remote <host> <port>` directives.\n",
				err)
			os.Exit(3)
		}
		if errors.Is(err, driftstack.ErrFeatureUnavailable) {
			fmt.Fprintf(os.Stderr,
				"Egress not yet enabled on this deployment: %v\n"+
					"Pre-launch posture; comes online when the OpenVPN VM harness ships.\n",
				err)
			os.Exit(2)
		}
		log.Fatalf("SaveProxy: %v", err)
	}
	fmt.Printf("Saved OpenVPN config id=%s label=%s type=%s\n", saved.ID, saved.Label, saved.Type)

	// 2. Attach the proxy to the session.
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
	fmt.Printf("Attached OpenVPN proxy; safeguards=%v\n", attached.Safeguards)
}
