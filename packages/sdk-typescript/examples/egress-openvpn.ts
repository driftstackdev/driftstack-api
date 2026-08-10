// ⚠️ THIS EXAMPLE CANNOT RUN SUCCESSFULLY TODAY. The per-session attach step below
// hits POST /v1/sessions/:id/proxy, which throws FeatureUnavailableError (503) on
// EVERY deployment — routes/session-proxy.ts discards the injected service and both
// registration branches throw, so no configuration makes it succeed. Session
// creation itself also refuses first when egress is required. The reusable proxy
// CRUD steps (save / list / update / delete) DO work; the attach + read-back steps
// are declared-but-unshipped. Kept as the intended shape for when the backend lands.
//
// Example: customer-configurable egress — OpenVPN variant (Phase 2
// priority per planning 133 + ORCHESTRATOR-STATE 2026-05-16).
//
// Demonstrates the OpenVPN attach flow:
//   1. Read the customer's .ovpn file from disk.
//   2. Save it to the reusable proxy library.
//   3. Attach it to an existing session.
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
//       npx tsx examples/egress-openvpn.ts

/* eslint-disable no-console */
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { Driftstack, FeatureUnavailableError, ValidationError } from '@driftstack/sdk';

const apiKey = process.env.DRIFTSTACK_API_KEY;
const ovpnPath = process.env.DRIFTSTACK_OVPN_CONFIG_PATH;
const sessionId = process.env.DRIFTSTACK_SESSION_ID;
if (!apiKey || !ovpnPath || !sessionId) {
  console.error(
    'Set DRIFTSTACK_API_KEY + DRIFTSTACK_OVPN_CONFIG_PATH + DRIFTSTACK_SESSION_ID in your environment.',
  );
  process.exit(1);
}

const configBlob = readFileSync(ovpnPath, 'utf8');
const MAX_OVPN_BYTES = 256 * 1024;
if (configBlob.length > MAX_OVPN_BYTES) {
  console.error(`OpenVPN config ${ovpnPath} is ${configBlob.length} bytes; max ${MAX_OVPN_BYTES}.`);
  process.exit(1);
}

const client = new Driftstack({ apiKey });

interface OpenVpnInner {
  config_blob: string;
  username?: string;
  password?: string;
}
const openvpn: OpenVpnInner = { config_blob: configBlob };
if (process.env.DRIFTSTACK_OVPN_USERNAME) {
  openvpn.username = process.env.DRIFTSTACK_OVPN_USERNAME;
}
if (process.env.DRIFTSTACK_OVPN_PASSWORD) {
  openvpn.password = process.env.DRIFTSTACK_OVPN_PASSWORD;
}
const proxy = { type: 'openvpn' as const, openvpn };

const label = 'openvpn-' + basename(ovpnPath, extname(ovpnPath));

// The live account-proxies API stores the VPN endpoint as host:port, parsed
// from the `remote <host> <port>` directive (defaults to 1194).
const remoteMatch = /^[ \t]*remote[ \t]+(\S+)(?:[ \t]+(\d+))?/m.exec(configBlob);
const ovpnHost = remoteMatch?.[1] ?? 'vpn.example.com';
const ovpnPort = remoteMatch?.[2] ? Number(remoteMatch[2]) : 1194;

async function main(): Promise<void> {
  try {
    // 1. Save the OpenVPN config to the customer's reusable library (the live
    //    account-proxies API). The .ovpn config_blob is write-only.
    const saved = await client.egress.createProxy({
      label,
      scheme: 'openvpn',
      host: ovpnHost,
      port: ovpnPort,
      openvpn,
    });
    console.log(`Saved OpenVPN config id=${saved.id} label=${saved.label} scheme=${saved.scheme}`);

    // 2. Attach to the session.
    const attached = await client.egress.attachToSession(sessionId!, {
      session_id: sessionId!,
      proxy,
      egress_safeguard: {
        block_direct_internet: true,
        block_unproxied_dns: true,
        block_webrtc_stun_leakage: true,
      },
    });
    console.log('Attached OpenVPN proxy; safeguards=', attached.safeguards);
  } catch (err) {
    if (err instanceof ValidationError) {
      console.error(
        `OpenVPN config rejected by server validation: ${err.message}\n` +
          'Check that the config has `client` + `remote <host> <port>` directives.',
      );
      process.exit(3);
    }
    if (err instanceof FeatureUnavailableError) {
      console.error(
        `OpenVPN egress is unavailable on this deployment: ${err.message}\n` +
          'Use a deployment with OpenVPN support or choose another supported proxy scheme.',
      );
      process.exit(2);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
