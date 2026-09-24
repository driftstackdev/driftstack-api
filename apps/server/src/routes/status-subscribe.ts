// V-295c3 — public status-page email subscription routes.
//
//   POST /v1/status/subscribe                   — start double-opt-in
//   GET  /v1/status/subscribe/confirm?token=    — finish opt-in
//   GET  /v1/status/subscribe/unsubscribe?token=— one-click unsubscribe
//
// All three routes are unauthenticated by design (the status site is
// public; visitors don't have Driftstack accounts). IP rate-limited
// via `statusSubscribe` config (3/min by default).
//
// Security sweep #5 — POST /subscribe also counts per ADDRESS (at most 5
// confirmation emails an hour and 10 a day to one mailbox, whoever asks), because
// the per-IP gate alone let rotating source addresses mail anyone without bound.
// See services/recipient-email-limit.ts.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { StatusSubscribersService } from '../services/status-subscribers.js';
import type { RateLimitStore } from '../services/rate-limit.js';
import { AUTH_IP_LIMITS, ipRateLimit } from '../middleware/ip-rate-limit.js';
import { ValidationError } from '../lib/errors.js';
import { RecipientEmailLimiter } from '../services/recipient-email-limit.js';

const SubscribeBodySchema = z.object({
  email: z.string().trim().email('Must be a valid email address.').max(254),
});

const TokenQuerySchema = z.object({
  token: z.string().min(20, 'Missing or malformed token.'),
});

export interface StatusSubscribeRoutesOptions {
  service: StatusSubscribersService;
  rateLimitStore: RateLimitStore;
}

export function registerStatusSubscribeRoutes(
  app: FastifyInstance,
  opts: StatusSubscribeRoutesOptions,
): void {
  const { service, rateLimitStore } = opts;
  const subscribeGate = ipRateLimit(rateLimitStore, {
    bucketPrefix: 'ip:status-subscribe',
    ...AUTH_IP_LIMITS.statusSubscribe,
  });
  const recipientLimit = new RecipientEmailLimiter(rateLimitStore);

  app.post('/v1/status/subscribe', { preHandler: [subscribeGate] }, async (request, reply) => {
    const parsed = SubscribeBodySchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());
    await recipientLimit.enforce('status-subscription', parsed.data.email, request.log);
    await service.subscribe(parsed.data.email, new Date());
    return reply.code(202).send({
      message: 'Confirmation email sent. Click the link to finish subscribing.',
    });
  });

  app.get<{ Querystring: { token: string } }>(
    '/v1/status/subscribe/confirm',
    { preHandler: [subscribeGate] },
    async (request, reply) => {
      const parsed = TokenQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      await service.confirm(parsed.data.token, new Date());
      return reply.code(200).send({
        message: 'Subscription confirmed. You will receive incident notifications by email.',
      });
    },
  );

  app.get<{ Querystring: { token: string } }>(
    '/v1/status/subscribe/unsubscribe',
    { preHandler: [subscribeGate] },
    async (request, reply) => {
      const parsed = TokenQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      await service.unsubscribe(parsed.data.token, new Date());
      return reply.code(200).send({ message: 'Unsubscribed.' });
    },
  );
}
