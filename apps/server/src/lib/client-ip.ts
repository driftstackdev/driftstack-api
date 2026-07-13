// Shared client-IP extractor for audit logging and session metadata.
// Fastify resolves `request.ip` through its configured `trustProxy`
// boundary; consumers must not parse `X-Forwarded-For` themselves.
// Production nginx appends the observed peer to that header, so the
// raw leftmost value can be caller-supplied and is not authoritative.
//
// Contract:
//   - return only Fastify's trusted-proxy-aware `request.ip` value;
//   - ignore raw forwarding headers, including spoofed leftmost hops;
//   - `?? null` so the return type stays `string | null` for the
//     audit row's nullable `actor_ip` column.

import type { FastifyRequest } from 'fastify';

export function readClientIp(request: FastifyRequest): string | null {
  return request.ip ?? null;
}
