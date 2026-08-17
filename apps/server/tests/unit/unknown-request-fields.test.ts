// Item 6 — a mistyped request field used to be dropped in silence and answered
// 201 Created with a default substituted. The decision recorded with this code
// is to report rather than reject: making the schemas strict would fix the
// silence and break every client already sending an extra field.
//
// These arms pin BOTH halves of that decision — that the request still succeeds
// unchanged, and that the ignored keys stop being invisible.

import { describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger, FastifyReply } from 'fastify';
import {
  knownRequestKeys,
  reportUnknownRequestFields,
  UNKNOWN_FIELDS_HEADER,
} from '../../src/lib/unknown-request-fields.js';
import { z } from 'zod';
import { UpdateWebhookRequestSchema } from '@driftstack/api-types';

function makeReply(): { reply: FastifyReply; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const reply = {
    header: (k: string, v: string) => {
      headers[k] = v;
      return reply;
    },
  } as unknown as FastifyReply;
  return { reply, headers };
}

const KNOWN = ['name', 'archetype', 'description'] as const;

describe('unknown request fields are reported, never rejected', () => {
  it('CRITICAL reports a mistyped field instead of dropping it silently', () => {
    const { reply, headers } = makeReply();
    const warn = vi.fn();
    const unknown = reportUnknownRequestFields({
      body: { name: 'p', archetyp: 'iphone17_ios18_7_safari26_4' },
      knownKeys: KNOWN,
      reply,
      logger: { warn } as unknown as FastifyBaseLogger,
      route: 'POST /v1/profiles',
    });

    expect(unknown, 'the mistyped key is the one reported').toEqual(['archetyp']);
    expect(headers[UNKNOWN_FIELDS_HEADER]).toBe('archetyp');
    expect(warn, 'operators can alert on it too').toHaveBeenCalled();
  });

  it('CRITICAL says nothing when every field is recognised', () => {
    // Without this the arm above is satisfied by a header set unconditionally,
    // which would tag every well-formed request as suspect.
    const { reply, headers } = makeReply();
    const warn = vi.fn();
    const unknown = reportUnknownRequestFields({
      body: { name: 'p', archetype: 'a', description: 'd' },
      knownKeys: KNOWN,
      reply,
      logger: { warn } as unknown as FastifyBaseLogger,
      route: 'POST /v1/profiles',
    });

    expect(unknown).toEqual([]);
    expect(headers[UNKNOWN_FIELDS_HEADER]).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('bounds what a hostile body can put in the header', () => {
    // The header is attacker-influenced text. Both the count and each key are
    // capped so a body of a thousand junk keys cannot inflate the response.
    const { reply, headers } = makeReply();
    const body: Record<string, number> = {};
    // The oversized key goes FIRST, so it lands inside the reported window. With
    // it appended last the count cap alone hides it, and the length assertion
    // below would pass against a build that never truncates.
    body['x'.repeat(500)] = 1;
    for (let i = 0; i < 50; i++) body[`junk_${i.toString()}`] = i;

    const unknown = reportUnknownRequestFields({
      body,
      knownKeys: KNOWN,
      reply,
      route: 'POST /v1/profiles',
    });

    expect(unknown.length, 'at most ten keys are reported').toBe(10);
    for (const k of unknown) expect(k.length).toBeLessThanOrEqual(64);
    expect(headers[UNKNOWN_FIELDS_HEADER]?.length ?? 0).toBeLessThan(800);
  });

  it('ignores bodies that are not objects', () => {
    for (const body of [null, undefined, 'a string', 42, ['an', 'array']]) {
      const { reply, headers } = makeReply();
      expect(reportUnknownRequestFields({ body, knownKeys: KNOWN, reply, route: 'r' })).toEqual([]);
      expect(headers[UNKNOWN_FIELDS_HEADER]).toBeUndefined();
    }
  });
});

describe('a reported field name is never cut through a character', () => {
  it('CRITICAL an unknown field name carrying an emoji across the 64-char bound does not produce a header value Node refuses. The reported names go into the X-Driftstack-Unknown-Fields RESPONSE HEADER, and a plain slice counts UTF-16 units: a bound landing between the halves of an astral character leaves a lone surrogate. Measured against node:http before the fix — res.setHeader threw "Invalid character in header content" and the request answered 500, on a field name the CUSTOMER chooses.', () => {
    const { reply, headers } = makeReply();
    const key = `${'x'.repeat(63)}😀tail`;

    const reported = reportUnknownRequestFields({
      body: { [key]: 1 },
      knownKeys: [],
      reply,
      route: 'POST /v1/probe',
    });

    const value = headers['X-Driftstack-Unknown-Fields'] ?? reported.join(',');
    const loneSurrogate = [...value].some((ch) => {
      const c = ch.charCodeAt(0);
      return ch.length === 1 && c >= 0xd800 && c <= 0xdfff;
    });
    expect(loneSurrogate, 'a header value may not carry half a character').toBe(false);
    expect(
      Buffer.from(value, 'utf8').toString('utf8'),
      'the header value must survive a UTF-8 round-trip — Node rejects it otherwise',
    ).toBe(value);
  });
});

// Reading the declared keys off a schema that carries a cross-field rule.
//
// `.refine` wraps a ZodObject in a ZodEffects, which has no `.shape`. Two ways
// to get this wrong, and they fail in opposite directions:
//
//   hand-listed keys   a field added to the schema later is missing from the
//                      list, so the API reports a customer's VALID field as
//                      ignored -- worse than the silence this module fixes.
//   empty result       the known set is empty, so every key the caller sent is
//                      reported as unknown. A whole request tagged as a typo.
describe('knownRequestKeys sees through a cross-field refinement', () => {
  it('CRITICAL returns the real keys for a .refine-wrapped schema', () => {
    // UpdateWebhookRequestSchema requires at least one field, so it is a
    // ZodEffects in production, not a hypothetical.
    expect(knownRequestKeys(UpdateWebhookRequestSchema).slice().sort()).toEqual([
      'active',
      'description',
      'events',
      'url',
    ]);
  });

  it('CRITICAL returns the keys for a plain object schema too', () => {
    expect(
      knownRequestKeys(z.object({ a: z.string(), b: z.number() }))
        .slice()
        .sort(),
    ).toEqual(['a', 'b']);
  });

  it('CRITICAL an empty result would tag every field, so it is never the answer for a real schema', () => {
    // The failure mode this arm guards: if the unwrap stops working, the known
    // set is empty and `reportUnknownRequestFields` reports the caller's entire
    // body. Nested refinements are unwrapped too.
    const doubleWrapped = z
      .object({ x: z.string() })
      .refine(() => true)
      .refine(() => true);
    expect(knownRequestKeys(doubleWrapped)).toEqual(['x']);
    const { reply, headers } = makeReply();
    reportUnknownRequestFields({
      body: { x: 'ok' },
      knownKeys: knownRequestKeys(doubleWrapped),
      reply,
      route: 'TEST',
    });
    expect(
      headers[UNKNOWN_FIELDS_HEADER],
      'a valid field was reported as unknown, which is the false-positive direction',
    ).toBeUndefined();
  });
});
