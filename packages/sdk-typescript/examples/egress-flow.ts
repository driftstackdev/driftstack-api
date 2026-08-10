// ⚠️ THIS EXAMPLE CANNOT RUN SUCCESSFULLY TODAY. The per-session attach step below
// hits POST /v1/sessions/:id/proxy, which throws FeatureUnavailableError (503) on
// EVERY deployment — routes/session-proxy.ts discards the injected service and both
// registration branches throw, so no configuration makes it succeed. Session
// creation itself also refuses first when egress is required. The reusable proxy
// CRUD steps (save / list / update / delete) DO work; the attach + read-back steps
// are declared-but-unshipped. Kept as the intended shape for when the backend lands.
//
// Customer-configurable egress flow — attach a SOCKS5 proxy to a
// session, manage saved proxy configs (planning 133 Phase 1+).
//
// Demonstrates the full egress lifecycle for a single session:
//   1. Save a reusable SOCKS5 config to the customer's library.
//   2. Attach the proxy to an existing session (session id passed in).
//   3. Read the session's proxy summary back (verifies safeguards).
//
// Run with:
//
//     DRIFTSTACK_API_KEY=ds_live_... \
//       DRIFTSTACK_PROXY_HOST=proxy.example.com \
//       DRIFTSTACK_PROXY_PORT=1080 \
//       DRIFTSTACK_SESSION_ID=ses_xxx \
//       npx tsx examples/egress-flow.ts
//
// The server activation-gates this surface — until the SOCKS5 backend
// is wired on the deployment, calls reject with FeatureUnavailableError
// (HTTP 503; machine-readable problem-type).

/* eslint-disable no-console */
import { Driftstack, FeatureUnavailableError } from '@driftstack/sdk';

const apiKey = process.env.DRIFTSTACK_API_KEY;
const proxyHost = process.env.DRIFTSTACK_PROXY_HOST;
const proxyPortEnv = process.env.DRIFTSTACK_PROXY_PORT;
const sessionId = process.env.DRIFTSTACK_SESSION_ID;
if (!apiKey || !proxyHost || !proxyPortEnv || !sessionId) {
  console.error(
    'Set DRIFTSTACK_API_KEY + DRIFTSTACK_PROXY_HOST + DRIFTSTACK_PROXY_PORT + DRIFTSTACK_SESSION_ID in your environment.',
  );
  process.exit(1);
}

const proxyPort = Number(proxyPortEnv);
const client = new Driftstack({ apiKey });

async function main(): Promise<void> {
  const proxy = {
    type: 'socks5' as const,
    socks5: {
      host: proxyHost!,
      port: proxyPort,
      udp_associate: true, // Required for WebRTC routing per planning 133.
      // EG-WK-1.9 — leave DNS resolution local-side (default). Set true to
      // route DNS through the proxy via SOCKS5 ATYP DOMAINNAME (0x03).
      require_remote_dns: false,
    },
  };

  try {
    // 1. Save the proxy config to the customer's reusable library (the live
    //    account-proxies API — flat body; password write-only). Then probe it.
    const saved = await client.egress.createProxy({
      label: `example ${proxyHost!}`,
      scheme: 'socks5',
      host: proxyHost!,
      port: proxyPort,
    });
    console.log(`Saved proxy id=${saved.id} label=${saved.label} scheme=${saved.scheme}`);
    const probe = await client.egress.testProxy(saved.id);
    console.log(
      'Reachability:',
      probe.ok ? `ok (${probe.latency_ms}ms)` : `unreachable (${probe.reason})`,
    );

    // 2. Attach the proxy to the existing session.
    const attached = await client.egress.attachToSession(sessionId!, {
      session_id: sessionId!,
      proxy,
      egress_safeguard: {
        block_direct_internet: true,
        block_unproxied_dns: true,
        block_webrtc_stun_leakage: true,
      },
    });
    console.log(`Attached proxy type=${attached.type}; safeguards=`, attached.safeguards);

    // 3. Read it back to verify.
    const read = await client.egress.getSessionProxy(sessionId!);
    console.log('Session proxy summary:', read);
  } catch (err) {
    if (err instanceof FeatureUnavailableError) {
      console.error(
        `SOCKS5 egress is unavailable on this deployment: ${err.message}\nUse a deployment with SOCKS5 egress support or choose another supported proxy scheme.`,
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
