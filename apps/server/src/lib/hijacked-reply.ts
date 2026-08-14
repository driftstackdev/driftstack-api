// Headers a hijacked reply must carry forward itself.
//
// `reply.hijack()` hands the socket to the route. Fastify then never flushes its
// own header store and no `onSend` hook runs, so everything the pipeline decided
// upstream is computed and silently discarded — the request id, and the
// rate-limit accounting for the token the request just spent.
//
// The SSE routes already knew this about ONE hook: each has a comment saying the
// hijack bypasses `@fastify/cors`'s onSend hook, so each sets
// Access-Control-Allow-Origin by hand. The reasoning was never carried to the
// rest, and the same bypass quietly dropped:
//
//   x-request-id     set by an onSend hook. So a long-lived stream — the failure
//                    a customer is most likely to report and least able to
//                    reproduce — was the one response with no id to quote.
//   rate-limit set   the streams run through `app.rateLimit(...)`, so a
//                    connection costs a real bucket token. The limiter wrote
//                    remaining/limit/reset onto the reply and the hijack threw
//                    them away, leaving a client blind to a bucket it is paying.
//
// One of the four hijack sites had already worked this out and copied
// `reply.getHeaders()` by hand — and still missed the request id, because that
// one is not on the reply at hijack time. This replaces that bespoke copy so all
// four sites answer the question the same way.

import type { FastifyReply } from 'fastify';

/**
 * Everything already set on `reply`, plus the request id, ready to spread into
 * `reply.raw.writeHead()`.
 *
 * Read off the reply rather than recomputed: a second computation could disagree
 * with what the limiter actually applied, and telling a client about a bucket
 * state that never existed is worse than telling it nothing.
 *
 * Spread FIRST at the call site, so a route's own `content-type` and
 * `cache-control` win over anything inherited.
 */
/**
 * The headers a stream inherits. An ALLOW-LIST, not everything on the reply.
 *
 * Copying the whole header set is the obvious implementation and it is wrong.
 * `@fastify/cors` puts `access-control-allow-credentials` on the reply before
 * the handler runs, while the SSE routes decide the origin question themselves
 * and deliberately emit NO CORS headers for a disallowed origin. A blanket copy
 * re-attaches the credentials header to a stream whose origin was just refused —
 * a response saying credentials are permitted where policy said they are not.
 *
 * That is not hypothetical: it is what a blanket copy did here, caught by
 * `private-response-cache-cors`, and it is what the one hand-rolled site was
 * already doing before this helper replaced it.
 *
 * So: name what a stream should inherit, and let everything else stay behind.
 */
const INHERITED_HEADERS = [
  'x-ratelimit-bucket',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
] as const;

export function hijackedReplyHeaders(
  reply: FastifyReply,
): Record<string, string | number | string[]> {
  const forwarded: Record<string, string | number | string[]> = {};

  // `getHeader` is absent on some hand-rolled test doubles of a reply. Treat
  // that as "nothing inherited" rather than throwing: the request id below is
  // the part that cannot be obtained any other way, and a stream that fails to
  // open because a header helper threw would be a far worse bug than the one
  // this function exists to fix.
  if (typeof reply.getHeader === 'function') {
    for (const name of INHERITED_HEADERS) {
      const value = reply.getHeader(name);
      if (typeof value === 'string' || typeof value === 'number' || Array.isArray(value)) {
        forwarded[name] = value;
      }
    }
  }

  // Set by an onSend hook, which a hijacked reply never reaches — so it is not
  // in getHeaders() yet and has to come from the request. This is the specific
  // subtlety that defeated the one site that had otherwise got this right.
  //
  // Guarded for the same reason as `getHeaders` above: a real FastifyReply
  // always carries `.request`, but this runs during stream setup, and a header
  // helper that throws would fail the connection outright — a worse bug than
  // the missing header it exists to fix. The live tests are what prove the id
  // is actually present on a real stream; this only decides how a degenerate
  // object is handled.
  const requestId: unknown = reply.request?.id;
  if (typeof requestId === 'string' || typeof requestId === 'number') {
    forwarded['x-request-id'] = String(requestId);
  }

  return forwarded;
}
