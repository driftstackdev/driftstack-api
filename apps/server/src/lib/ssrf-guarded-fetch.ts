// SSRF-guarded fetch for the webhook delivery worker (connection-time DNS pin).
//
// The worker POSTs to customer-registered webhook URLs. The create-time guard
// (webhook-target-guard.ts) blocks LITERAL private/reserved IP targets but
// ALLOWS hostnames — a hostname that DNS-resolves to a private/internal address
// at DELIVERY time (a static A record pointed at 169.254.169.254 / 10.x / 127.x,
// or an adversarial low-TTL DNS-rebind) would otherwise let the blind delivery
// probe our internal network via the recorded response excerpt.
//
// This pins the check to CONNECT time: a custom undici dispatcher `lookup`
// classifies the IP the socket will actually connect to (reusing
// classifyUnsafeHost) and fails the connection if it is private/reserved. Doing
// it in the lookup hook — not a pre-resolve-then-fetch — removes the
// resolve-vs-connect TOCTOU that a rebind attacker would exploit.
//
// Uses undici's OWN fetch + Agent (same package version) rather than Node's
// global fetch + an npm-undici Agent, to avoid cross-version Dispatcher-interop
// mismatches between Node's bundled undici and this dependency.

import { Agent, fetch as undiciFetch } from 'undici';
import { lookup as dnsLookup } from 'node:dns';
import { classifyUnsafeHost, unsafeWebhookTargetReason } from './webhook-target-guard.js';

/** Thrown by the lookup hook when a delivery target resolves to a blocked IP. */
export class SsrfBlockedError extends Error {
  constructor(address: string, reason = 'webhook target resolves to a private/reserved address') {
    super(`SSRF blocked: ${reason} (${address}).`);
    this.name = 'SsrfBlockedError';
  }
}

function fetchTargetUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Validate the exact fetch input before undici selects a dispatcher. Node skips
 * DNS lookup for literal IP URLs, so the connect-time lookup hook alone never
 * sees them. This delivery-time preflight protects legacy/corrupt/direct-SQL
 * endpoint rows as well as callers that use this guard outside the create route.
 */
export function assertSafeSsrfFetchTarget(input: string | URL | Request): void {
  const url = fetchTargetUrl(input);
  const reason = unsafeWebhookTargetReason(url);
  if (reason === null) return;
  let host = '<invalid target>';
  try {
    host = new URL(url).hostname || host;
  } catch {
    // Keep the fixed placeholder; never reflect an unparseable credential URL.
  }
  throw new SsrfBlockedError(host, reason);
}

// The net/tls lookup contract, loose enough to cover both the single-address
// and `{ all: true }` callback shapes dns.lookup can produce.
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | { address: string; family: number }[],
  family?: number,
) => void;
export type SsrfLookup = (hostname: string, options: unknown, callback: LookupCallback) => void;

/** dns.lookup, narrowed to the shape this module calls it with. */
type Resolver = (hostname: string, options: unknown, callback: LookupCallback) => void;

/**
 * Build a connect-time `lookup` that resolves `hostname` via `resolver`
 * (default dns.lookup) and rejects if ANY resolved address is
 * private/loopback/link-local/reserved (classifyUnsafeHost). The injectable
 * `resolver` makes the SSRF decision unit-testable without real DNS.
 */
export function makeSsrfLookup(resolver: Resolver = dnsLookup as unknown as Resolver): SsrfLookup {
  return (hostname, options, callback) => {
    resolver(hostname, options, (err, address, family) => {
      if (err) {
        callback(err, address, family);
        return;
      }
      const addresses = Array.isArray(address) ? address.map((a) => a.address) : [address];
      for (const a of addresses) {
        if (classifyUnsafeHost(a) !== null) {
          callback(new SsrfBlockedError(a), address, family);
          return;
        }
      }
      callback(null, address, family);
    });
  };
}

let sharedAgent: Agent | null = null;
function ssrfAgent(): Agent {
  sharedAgent ??= new Agent({
    connect: { lookup: makeSsrfLookup() as unknown as undefined },
  });
  return sharedAgent;
}

/**
 * Drop-in fetch for outbound webhook deliveries: undici fetch pinned to the
 * SSRF-guarded dispatcher. Signature-compatible with the global `fetch` the
 * worker's config seam expects (tests inject their own fetch and bypass this).
 */
export const ssrfGuardedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  assertSafeSsrfFetchTarget(input);
  return undiciFetch(input as Parameters<typeof undiciFetch>[0], {
    ...(init as Parameters<typeof undiciFetch>[1]),
    dispatcher: ssrfAgent(),
  });
}) as unknown as typeof fetch;
