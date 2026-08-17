// Legal routes — three endpoints under /v1/legal.
//
//   GET  /v1/legal/documents   — list catalog (auth required)
//   GET  /v1/legal/required    — list documents the calling account
//                                must accept (auth required)
//   POST /v1/legal/accept      — record acceptance (auth required)
//
// Documents themselves are static text in `docs/legal/*.md`; this
// endpoint set deals with the acceptance side. Document content is
// not served via this API — the GUI / customer dashboard reads from
// the published static URLs once the marketing site is live.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { knownRequestKeys, reportUnknownRequestFields } from '../lib/unknown-request-fields.js';
import { z } from 'zod';
import {
  LegalDocumentMismatchError,
  LegalDocumentNotFoundError,
  type LegalService,
} from '../services/legal.js';
import { BadRequestError, ConflictError, NotFoundError } from '../lib/errors.js';

const AcceptBodySchema = z.object({
  document_key: z.string().min(1).max(64),
  version: z.string().min(1).max(64),
  content_hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'content_hash must be a 64-character lowercase hex SHA-256 digest'),
});

function requireCtx(request: FastifyRequest): NonNullable<FastifyRequest['account']> {
  if (request.account === null || request.account === undefined) {
    throw new Error('account context missing after requireAuth');
  }
  return request.account;
}

function prefixId(prefix: string, uuid: string): string {
  return `${prefix}_${uuid}`;
}

export function registerLegalRoutes(app: FastifyInstance, service: LegalService): void {
  // ── GET /v1/legal/documents ────────────────────────────────────────────
  // List the legal-document catalog. Auth-gated only because the GUI
  // surfaces this for already-signed-in customers; the public document
  // text is served separately at the marketing site URL.
  app.get(
    '/v1/legal/documents',
    {
      preHandler: [app.requireAuth, app.rateLimit('global')],
    },
    (_request) => {
      return {
        data: service.list().map((entry) => ({
          document_key: entry.documentKey,
          title: entry.title,
          version: entry.version,
          effective_date: entry.effectiveDate,
          content_hash: entry.contentHash,
          source_path: entry.sourcePath,
          byte_size: entry.byteSize,
        })),
      };
    },
  );

  // ── GET /v1/legal/required ─────────────────────────────────────────────
  // List documents the calling account must accept (or re-accept).
  app.get(
    '/v1/legal/required',
    {
      preHandler: [app.requireAuth, app.rateLimit('global')],
    },
    async (request) => {
      const ctx = requireCtx(request);
      const required = await service.required(ctx.account.id);
      return {
        data: required.map((r) => ({
          document_key: r.documentKey,
          current_version: r.currentVersion,
          content_hash: r.contentHash,
          reason: r.reason,
          last_accepted_version: r.lastAcceptedVersion,
        })),
      };
    },
  );

  // ── POST /v1/legal/accept ──────────────────────────────────────────────
  // Record customer acceptance of a (document, version) pair.
  app.post(
    '/v1/legal/accept',
    {
      preHandler: [app.requireAuth, app.requireScope('account_owner'), app.rateLimit('global')],
    },
    async (request, reply) => {
      const ctx = requireCtx(request);
      const body = AcceptBodySchema.parse(request.body ?? {});
      reportUnknownRequestFields({
        body: request.body ?? {},
        knownKeys: knownRequestKeys(AcceptBodySchema),
        reply,
        logger: request.log,
        route: 'POST /v1/legal/accept',
      });
      try {
        const record = await service.recordAcceptance({
          accountId: ctx.account.id,
          documentKey: body.document_key,
          version: body.version,
          contentHash: body.content_hash,
          acceptedFromIp: ipFromRequest(request),
          acceptedUserAgent: userAgentFromRequest(request),
        });
        return reply.code(201).send({
          id: prefixId('lacc', record.id),
          account_id: prefixId('acc', record.accountId),
          document_key: record.documentKey,
          version: record.version,
          content_hash: record.contentHash,
          accepted_at: record.acceptedAt.toISOString(),
        });
      } catch (err) {
        if (err instanceof LegalDocumentNotFoundError) {
          throw new NotFoundError(`Legal document ${err.documentKey} not found.`);
        }
        if (err instanceof LegalDocumentMismatchError) {
          // 409: customer attempted to accept a stale version. The
          // response carries the current version + hash so the client
          // can re-fetch + retry.
          throw new ConflictError(
            `Legal document ${err.documentKey} has changed since you fetched it. Refresh and re-accept.`,
            {
              document_key: err.documentKey,
              provided_version: err.providedVersion,
              current_version: err.currentVersion,
              provided_content_hash: err.providedHash,
              current_content_hash: err.currentHash,
            },
          );
        }
        if (err instanceof z.ZodError) {
          throw new BadRequestError(err.issues.map((i) => i.message).join('; '));
        }
        throw err;
      }
    },
  );
}

function ipFromRequest(request: FastifyRequest): string | null {
  // Fastify exposes request.ip after the trustProxy plumbing in app.ts
  // populates from X-Forwarded-For. Null if not available (e.g. unit
  // tests injecting through fastify.inject without a real socket).
  const ip = request.ip;
  return typeof ip === 'string' && ip.length > 0 ? ip : null;
}

function userAgentFromRequest(request: FastifyRequest): string | null {
  const ua = request.headers['user-agent'];
  if (typeof ua === 'string' && ua.length > 0) {
    // Truncate to a sane bound — UA strings can be exotic.
    return ua.slice(0, 1024);
  }
  return null;
}
