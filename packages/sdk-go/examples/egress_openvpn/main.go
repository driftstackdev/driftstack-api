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
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
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

	// The live account-proxies API stores the VPN endpoint as host:port, parsed
	// from the `remote <host> <port>` directive (defaults to 1194).
	ovpnHost, ovpnPort := "vpn.example.com", 1194
	if m := regexp.MustCompile(`(?m)^[ \t]*remote[ \t]+(\S+)(?:[ \t]+(\d+))?`).FindStringSubmatch(string(blob)); m != nil {
		ovpnHost = m[1]
		if m[2] != "" {
			if p, perr := strconv.Atoi(m[2]); perr == nil {
				ovpnPort = p
			}
		}
	}

	// 1. Save the OpenVPN config to the customer's reusable library (the live
	// account-proxies API). The .ovpn config_blob is write-only.
	saved, err := client.Egress.CreateProxy(ctx, &driftstack.AccountProxyInput{
		Label:   label,
		Scheme:  "openvpn",
		Host:    ovpnHost,
		Port:    ovpnPort,
		OpenVPN: openvpn,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr,
			"CreateProxy rejected: %v\n"+
				"Check that the config has `client` + `remote <host> <port>` directives.\n",
			err)
		os.Exit(3)
	}
	fmt.Printf("Saved OpenVPN config id=%s label=%s scheme=%s\n", saved.ID, saved.Label, saved.Scheme)

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
