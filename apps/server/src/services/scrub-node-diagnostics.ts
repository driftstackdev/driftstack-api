// Scrub a free-form harness diagnostic string before it crosses to a CUSTOMER
// surface (webhook / SDK / dashboard) — audit M2, enforcing the W1859 forward-guard.
//
// A harness `detail` / `summary` can carry the Mac fleet node's REAL egress IP as
// an egress-leak diagnostic in the documented form `proxied=<customer-exit>
// direct=<node-ip>`, where `direct=` is the node's own IP — the value the
// customer's proxy/VPN exists to HIDE. Surfacing it to a customer deanonymizes
// the fleet infrastructure. The terminal-close path avoids this by keying on the
// enumerated `reason` (never the free-form detail); the challenge / profile-save-
// failed relays DO forward the free-form detail, so they must scrub it first.

import { redactText } from '../lib/redact-url.js';

// `direct=<token>` — the documented egress-leak format. Catches the node IP
// whether it is IPv4 or IPv6 (the whole token after `direct=` is redacted).
const DIRECT_TOKEN = /\bdirect\s*=\s*[^\s,;]+/gi;
// Bare IPv4 literal — defence-in-depth for a node IP that appears outside a
// `direct=` segment. (IPv6 in the documented `direct=` form is covered above;
// a bare IPv6 is intentionally NOT matched to avoid scrubbing timestamps like
// 12:34:56 — the `direct=` segment is the real, documented leak vector.)
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

// Every retained node diagnostic is already schema-bounded, but keep this pure
// helper safe when a future caller reaches it before wire validation. The
// current largest admitted diagnostic is errorEvent.detail at 16 KiB.
const CUSTOMER_NODE_DIAGNOSTIC_INPUT_MAX_LENGTH = 16 * 1024;
export const CUSTOMER_NODE_DIAGNOSTIC_MAX_LENGTH = 4096;

/**
 * Redact node-egress diagnostics from a free-form harness string. Returns the
 * string with `direct=<...>` segments and bare IPv4 literals replaced by a
 * marker. Safe on any string (no-op when nothing matches).
 */
export function scrubNodeDiagnostics(s: string): string {
  return s.replace(DIRECT_TOKEN, 'direct=[redacted]').replace(IPV4, '[redacted-ip]');
}

/**
 * Bound and scrub a free-form authenticated-node diagnostic before it enters an
 * API body, in-memory customer state, or durable webhook. This is the common
 * forward boundary for URL/query/userinfo/Bearer/Basic credentials and real
 * fleet IPs. Ordinary actionable text is preserved byte-for-byte.
 */
export function customerSafeNodeDiagnostic(
  value: string,
  maxLength = CUSTOMER_NODE_DIAGNOSTIC_MAX_LENGTH,
  fallback = 'device operation failed',
): string {
  const boundedMax = Math.max(1, Math.min(maxLength, CUSTOMER_NODE_DIAGNOSTIC_INPUT_MAX_LENGTH));
  // Inspect the complete admitted input before applying the caller's output
  // bound. Otherwise a URL credential whose terminating `@` falls just beyond
  // that output boundary can leave its userinfo prefix visible.
  const bounded = value.slice(0, CUSTOMER_NODE_DIAGNOSTIC_INPUT_MAX_LENGTH);
  const scrubbed = scrubNodeDiagnostics(redactText(bounded));
  return (scrubbed.length > 0 ? scrubbed : fallback).slice(0, boundedMax);
}
