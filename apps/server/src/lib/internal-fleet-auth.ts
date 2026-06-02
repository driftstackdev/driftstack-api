// Wave 29-400 §8.5 — internal fleet auth helper (shared-secret bearer).
//
// Internal endpoints (/v1/internal/atlas-priority/*) are NOT customer-
// facing. They're called by Agent 1's harvester + bs-atlas-priority.sh +
// atlas-priority-append.py running inside the operator-trusted fleet.
//
// Auth: `Authorization: Bearer <DRIFTSTACK_FLEET_INTERNAL_TOKEN>` header.
// Compared with timingSafeEqual to defeat string-length timing attacks.
// The token is provisioned via /opt/driftstack/api/.env (operator) and
// shipped to fleet nodes via the bootstrap config (Agent 1 reads from
// its own env). No customer or unauthenticated traffic can reach these
// routes — preHandler rejects with 401 before the handler runs.
//
// Disable posture: if the env var is missing, return 503 from every
// internal route via the `internalFleetAuthEnabled` predicate. This
// matches the activation-gate pattern used for other Tier-1 features
// — surface unavailable rather than silently accept all requests when
// the secret isn't set.

import type { FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { UnauthorizedError } from './errors.js';

export interface InternalFleetAuthConfig {
  /** From DRIFTSTACK_FLEET_INTERNAL_TOKEN env var. When absent (null),
   *  the auth predicate rejects EVERY request — the routes can still
   *  register but always 503/401. Treat the env-var-set state as the
   *  activation flag. */
  internalToken: string | null;
}

export class InternalFleetAuth {
  private readonly tokenBuf: Buffer | null;

  constructor(config: InternalFleetAuthConfig) {
    this.tokenBuf =
      config.internalToken !== null && config.internalToken.length > 0
        ? Buffer.from(config.internalToken, 'utf8')
        : null;
  }

  /** True if the env-var token is set (activation flag). */
  isEnabled(): boolean {
    return this.tokenBuf !== null;
  }

  /** Validates an Authorization: Bearer <token> header value (raw
   *  string from req.headers.authorization). Throws UnauthorizedError
   *  on missing-header, malformed-header, wrong-prefix, or
   *  not-equal-token. Constant-time on the token compare. */
  validate(req: FastifyRequest): void {
    if (this.tokenBuf === null) {
      throw new UnauthorizedError(
        'Internal fleet auth disabled on this deployment (DRIFTSTACK_FLEET_INTERNAL_TOKEN not set).',
      );
    }
    const header = req.headers.authorization;
    if (!header || typeof header !== 'string') {
      throw new UnauthorizedError('Missing Authorization header.');
    }
    if (!header.startsWith('Bearer ')) {
      throw new UnauthorizedError('Authorization header must use Bearer scheme.');
    }
    const candidate = Buffer.from(header.slice('Bearer '.length).trim(), 'utf8');
    // timingSafeEqual rejects different-length buffers (throws). Pre-
    // length-check to convert that into a uniform "wrong token" outcome.
    if (candidate.length !== this.tokenBuf.length) {
      throw new UnauthorizedError('Internal fleet token mismatch.');
    }
    if (!timingSafeEqual(candidate, this.tokenBuf)) {
      throw new UnauthorizedError('Internal fleet token mismatch.');
    }
  }
}
