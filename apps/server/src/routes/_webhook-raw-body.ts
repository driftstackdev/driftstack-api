// V-666 — shared raw-body content-type parser for webhook routes.
//
// Multiple webhook routes (Stripe + NowPayments + future) need access
// to the raw request body for signature verification. Fastify only
// allows ONE content-type parser per content-type, so all webhook
// routes share a single parser that opts into raw-body stashing for a
// known set of URLs.
//
// Registration is idempotent: each route calls
// `registerWebhookRawBodyParser(app)` and only the first call actually
// registers the parser. A WeakSet keyed on the FastifyInstance tracks
// the registration state.

import type { FastifyInstance, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

const MAX_BODY_BYTES = 1_048_576; // 1 MiB

const RAW_BODY_URLS: ReadonlySet<string> = new Set([
  '/v1/webhooks/stripe',
  '/v1/webhooks/nowpayments',
]);

const REGISTERED = new WeakSet<FastifyInstance>();

export function registerWebhookRawBodyParser(app: FastifyInstance): void {
  if (REGISTERED.has(app)) return;
  REGISTERED.add(app);

  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string', bodyLimit: MAX_BODY_BYTES },
    (req: FastifyRequest, body, done) => {
      const url = req.routeOptions.url ?? '';
      if (RAW_BODY_URLS.has(url)) {
        const text = typeof body === 'string' ? body : '';
        req.rawBody = text;
        try {
          const parsed: unknown = text.length === 0 ? {} : JSON.parse(text);
          done(null, parsed);
        } catch (err) {
          done(err instanceof Error ? err : new Error(String(err)), undefined);
        }
        return;
      }
      // Non-webhook routes: standard parse, no raw stash.
      try {
        const parsed: unknown = typeof body === 'string' && body.length > 0 ? JSON.parse(body) : {};
        done(null, parsed);
      } catch (err) {
        done(err instanceof Error ? err : new Error(String(err)), undefined);
      }
    },
  );
}
