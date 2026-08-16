// Item 6 — unrecognised request fields were silently dropped.
//
// The routes validate with `Schema.safeParse(req.body)` and zod STRIPS unknown
// keys, so a customer who mistypes `archetype` on profile creation gets 201
// Created with the default archetype substituted. In a product whose value is
// which device you appear to be, that is a silent misconfiguration presented as
// success.
//
// Making the schemas strict would fix it and break every client already sending
// an extra field, which is why the item sat undecided. This is the non-breaking
// half: the request still succeeds exactly as before, and the unknown keys are
// reported — in a response header a client can read, and in a server log an
// operator can alert on. Nothing about the response body changes, so no
// existing integration can break on it.
//
// Top-level keys only, deliberately. Nested unknown keys are a larger surface
// with a much higher false-positive rate (polymorphic payloads, forward-compat
// blocks), and the failure this item describes is a mistyped top-level field.

import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import { sliceWithoutSplittingSurrogate } from './bounded-text.js';
import type { z, ZodObject, ZodRawShape } from 'zod';
import { ValidationError } from './errors.js';

export const UNKNOWN_FIELDS_HEADER = 'x-driftstack-unknown-fields';

/** Cap the header so a hostile body cannot inflate the response. */
const MAX_REPORTED = 10;
const MAX_KEY_CHARS = 64;

/**
 * Report top-level request-body keys the schema does not declare.
 *
 * `knownKeys` comes from the schema's own shape, NOT from the parsed result:
 * parsed output has defaults filled in and transforms applied, so diffing
 * against it would under-report (a key the schema knows but drops) and
 * over-report (a key the transform renames).
 */
export function reportUnknownRequestFields(args: {
  body: unknown;
  knownKeys: readonly string[];
  reply: FastifyReply;
  logger?: FastifyBaseLogger;
  route: string;
}): string[] {
  const { body, knownKeys, reply, logger, route } = args;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return [];
  const known = new Set(knownKeys);
  const unknown = Object.keys(body)
    .filter((k) => !known.has(k))
    .slice(0, MAX_REPORTED)
    .map((k) => sliceWithoutSplittingSurrogate(k, MAX_KEY_CHARS));
  if (unknown.length === 0) return [];
  reply.header(UNKNOWN_FIELDS_HEADER, unknown.join(','));
  logger?.warn(
    { component: 'request-validation', route, unknownFields: unknown },
    'request carried fields the schema does not declare; they were ignored',
  );
  return unknown;
}

/**
 * Validate a request body and report — never reject — top-level keys the schema
 * does not declare.
 *
 * One helper rather than the same three lines at 33 call sites: a new route that
 * uses it inherits the reporting, and a structural test can pin that
 * customer-facing writes go through here rather than calling `safeParse`
 * directly.
 *
 * Deliberately NOT applied to unauthenticated auth endpoints. Echoing the keys a
 * caller sent back to an anonymous caller is a (mild) disclosure of schema shape
 * on exactly the surface that attracts probing, and the failure this exists to
 * fix — a mistyped field silently changing a resource's configuration — is a
 * property of authenticated resource writes, not of login.
 */
export function parseRequestBodyReportingUnknown<Shape extends ZodRawShape>(args: {
  schema: ZodObject<Shape>;
  req: FastifyRequest;
  reply: FastifyReply;
  route: string;
}): z.infer<ZodObject<Shape>> {
  const parsed = args.schema.safeParse(args.req.body);
  if (!parsed.success) throw new ValidationError(parsed.error.flatten());
  reportUnknownRequestFields({
    body: args.req.body,
    knownKeys: Object.keys(args.schema.shape),
    reply: args.reply,
    logger: args.req.log,
    route: args.route,
  });
  return parsed.data;
}
