// Shared client-IP extractor for audit logging. Three admin routes
// (admin-webhooks / admin-force-actions / admin-accounts) hand-rolled
// near-identical `X-Forwarded-For` first-hop parsers; each is the
// source for the `actor_ip` column on its admin_audit_log row.
// Extracting collapses the drift surface so the proxy-header contract
// has one source of truth.
//
// Contract:
//   - read `x-forwarded-for` (Fastify lowercases headers before this
//     runs);
//   - if present + non-empty string, return the first comma-separated
//     entry trimmed (XFF lists "client, proxy1, proxy2…" left-to-
//     right; first is the original caller);
//   - fall back to `request.ip` (Fastify's already-trusted-proxy-
//     aware value);
//   - `?? null` so the return type stays `string | null` for the
//     audit row's nullable `actor_ip` column.

import type { FastifyRequest } from 'fastify';

export function readClientIp(request: FastifyRequest): string | null {
  const xff = request.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.ip ?? null;
}
