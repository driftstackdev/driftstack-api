// Pins the agent-session RESPONSE schema wiring introduced when the
// OpenAPI responses for the 3 read endpoints (POST 201 create, GET
// list, GET by-id) were `z.object({})` — i.e. the whole AI-chat
// resource was untyped for SDK codegen.
//
//   1. api-types `AgentSessionSchema` mirrors the apps/server route's
//      `PublicAgentSession` interface field-for-field, so the schema,
//      the route serialization, and codegen can never drift apart.
//   2. openapi.ts registers `AgentSession` as a named component and
//      references it on the 3 read endpoints (no longer empty).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentSessionSchema, AgentIntentSchema, IntentResultSchema } from '@driftstack/api-types';
import { AgentSessionErrorEventSchema } from '../../src/services/agent-sessions.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const read = (p: string): string => readFileSync(p, 'utf8');
const SPEC = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');

describe('agent-session response schema parity', () => {
  it('AgentSessionSchema mirrors the route PublicAgentSession interface field-for-field — the response shape is shared so a field added/removed on either side breaks the build (the OpenAPI spec, SDK codegen, and the route serialization stay aligned)', () => {
    const routeSrc = read(resolve(REPO_ROOT, 'apps/server/src/routes/agent-sessions.ts'));
    const m = routeSrc.match(/interface PublicAgentSession \{([\s\S]+?)\n\}/);
    expect(m, 'PublicAgentSession interface must be present in the route').not.toBeNull();
    // Top-level field names only (anchored to line start; skips comments +
    // the inline `{ kind: ... }` members of pair_mode_state).
    const ifaceBody = m?.[1] ?? '';
    const ifaceFields = [...ifaceBody.matchAll(/^ {2}(\w+)\??:/gm)]
      .map((x) => x[1])
      .filter((f): f is string => f !== undefined);
    expect(ifaceFields.length).toBe(19);
    expect(new Set(Object.keys(AgentSessionSchema.shape))).toEqual(new Set(ifaceFields));
  });

  it('OpenAPI registers AgentSession as a named component. V-1626 — the title of this arm used to add "so Pydantic/Go/TS codegen gets a named type, not an inline anonymous shape", and that does NOT follow from what it checks. `r.register(name, schema)` creates the component; it does not tag the schema, so a route using the BARE `AgentSessionSchema` (lines ~4755, ~4809, ~4899) still emits an inline object. Measured in the published spec: zero `$ref` to AgentSession, and `GET /v1/agent-sessions/{id}` returns an inline 19-property object — exactly the anonymous shape the old title claimed was avoided. The pattern that produces a `$ref` is `Schema.openapi(name)` with routes using the TAGGED object: 41 of those are referenced, against 39 of 40 `r.register` components orphaned. Closing that is a change to the published contract, so it is recorded as OPEN-ITEMS W-10 rather than done here.', () => {
    const oapi = read(resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts'));
    expect(oapi).toMatch(/r\.register\('AgentSession', AgentSessionSchema\);/);
  });

  it('types the optional capability_report degraded states without accepting invented values', () => {
    const base = {
      id: 'agt_1',
      account_id: 'acc_1',
      driftstack_session_id: null,
      status: 'active',
      closed_reason: null,
      token_budget_total: 100,
      token_budget_remaining: 100,
      transcript_length: 0,
      closed_at: null,
      created_by_user_id: null,
      mode: 'manual',
      model: 'claude-opus-4-8',
      pair_mode_state: null,
      created_at: '2026-07-13T06:00:00.000Z',
      updated_at: '2026-07-13T06:00:00.000Z',
    };
    const capabilityReport = {
      timestamp: '2026-07-13T06:00:00.000Z',
      manual_input_available: false,
      streaming_state: 'blank',
      egress_state: 'dead_proxy',
      proxy_kind: 'socks5',
      proxy_udp_supported: false,
      transport_mode_requested: 'h2-and-h3',
      transport_mode_active: 'h2-only',
      safeguards_passed: true,
      // T-6 — null, not false: the node reports this only once it has OBSERVED a
      // completed QUIC handshake, so absent stays NOT-OBSERVED. The internal
      // interpose diagnostic is deliberately not here.
      h3_connection_observed: null,
    };
    expect(
      AgentSessionSchema.safeParse({ ...base, capability_report: capabilityReport }).success,
    ).toBe(true);
    expect(
      AgentSessionSchema.safeParse({
        ...base,
        capability_report: { ...capabilityReport, streaming_state: 'fine' },
      }).success,
    ).toBe(false);
  });

  it('types the optional durable error_event with a closed severity vocabulary', () => {
    const event = {
      timestamp: '2026-07-13T06:30:00.000Z',
      code: 'launch_timeout',
      severity: 'error',
      summary: 'The browser did not become ready in time.',
      detail: null,
      customer_actionable: false,
      retryable: true,
    } as const;
    expect(AgentSessionSchema.shape.error_event.safeParse(event).success).toBe(true);
    expect(
      AgentSessionSchema.shape.error_event.safeParse({ ...event, severity: 'critical' }).success,
    ).toBe(false);
    expect(
      AgentSessionSchema.shape.error_event.safeParse({ ...event, code: 'Launch Timeout' }).success,
    ).toBe(false);
    expect(
      AgentSessionSchema.shape.error_event.safeParse({ ...event, summary: 'x'.repeat(4097) })
        .success,
    ).toBe(false);
    expect(AgentSessionSchema.shape.error_event.safeParse(undefined).success).toBe(true);
  });

  it('V-1504 the published error_event explains its two booleans and its nullable detail. Every field here is a failure report a customer reads to decide what to do next, and `customer_actionable` / `retryable` are unreadable as bare booleans — the Go SDK spelled both out in a doc comment while the document, the TypeScript type and the customer docs carried nothing. This asserts the SPEC rather than the source: prose that never reaches the published artifact is prose no caller sees.', () => {
    const spec = JSON.parse(read(SPEC)) as {
      components: {
        schemas: Record<
          string,
          {
            properties: Record<
              string,
              { description?: string; properties?: Record<string, { description?: string }> }
            >;
          }
        >;
      };
    };
    const event = spec.components.schemas.AgentSession?.properties.error_event;
    expect(event?.description, 'error_event itself').toBe(
      'The most recent harness launch or runtime failure recorded for this session. Null when the session has not reported one.',
    );
    expect(event?.properties?.detail?.description, 'detail').toBe(
      'Null when the server has nothing to add beyond `summary`.',
    );
    expect(event?.properties?.customer_actionable?.description, 'customer_actionable').toBe(
      'Whether a human can do anything about this failure.',
    );
    expect(event?.properties?.retryable?.description, 'retryable').toBe(
      'Whether repeating the same call is worth trying.',
    );
  });

  it('OpenAPI references AgentSessionSchema on the 3 read endpoints — bare on POST 201 + GET by-id, array-wrapped on GET list (was z.object({}))', () => {
    const oapi = read(resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts'));
    // bare resource (create 201 + get-by-id both use `schema: AgentSessionSchema`)
    expect(oapi).toMatch(/schema: AgentSessionSchema \}/);
    // list rows
    expect(oapi).toMatch(/data: z\.array\(AgentSessionSchema\)/);
  });

  it('OpenAPI types the `session` envelope on the POST /:id/message turn-result union — every member (plan-executed/clarify/refuse/logged-manual) carries session: AgentSessionSchema (was z.object({}))', () => {
    const oapi = read(resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts'));
    // Scoped to the turn-result union itself: a `session:` field added
    // anywhere else in openapi.ts must not be able to satisfy this guard.
    // Non-greedy and terminated on the union's own 4-space-indented `])`
    // (members close at 6 spaces), so it cannot run past the declaration.
    const unionRe =
      /const AgentMessageResponseOpenApi = z\n {4}\.discriminatedUnion\('kind', \[\n([\s\S]+?)\n {4}\]\)/;
    const union = oapi.match(unionRe)?.[1] ?? '';
    expect(union, 'AgentMessageResponseOpenApi union must be present in openapi.ts').not.toBe('');
    const members = union.match(/kind: z\.literal\('/g) ?? [];
    const sessionFields = union.match(/session: AgentSessionSchema,/g) ?? [];
    // d5e30ea9c published the 4th runtime variant: logged-manual, the
    // transcript-only operator turn agent-runtime.ts returns with a session.
    expect(members.length).toBe(4);
    // EVERY member carries the updated session envelope — a variant that
    // ships without one fails here instead of silently passing a recount.
    expect(sessionFields.length).toBe(members.length);
  });

  it('OpenAPI types the message turn-result intents/results arrays (were z.array(z.object({}))); AgentIntent/IntentResult cover the route vocabulary', () => {
    const oapi = read(resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts'));
    expect(oapi).toMatch(/intents: z\.array\(AgentIntentSchema\)/);
    expect(oapi).toMatch(/results: z\.array\(IntentResultSchema\)/);
    // Route parity: the decomposer's AgentIntent union member count == the schema's
    // (a new verb added to the route but not api-types fails here). W140 added
    // scroll + behavioral_pause → 6 members.
    const decomposer = read(resolve(REPO_ROOT, 'apps/server/src/services/agent-decomposer.ts'));
    const intentBlock = decomposer.match(/export type AgentIntent =([\s\S]+?)\n\n/)?.[1] ?? '';
    const routeVerbCount = (intentBlock.match(/kind: '/g) ?? []).length;
    expect(routeVerbCount).toBe(6);
    expect(AgentIntentSchema.options).toHaveLength(routeVerbCount);
    // success + failure + confirmation_required (W443/W445 human-confirm guardrail).
    expect(IntentResultSchema.options).toHaveLength(3);
    expect(
      IntentResultSchema.safeParse({
        kind: 'confirmation_required',
        intent: { kind: 'interact', action: 'tap', selector: 'Buy Now' },
        category: 'purchase',
        matchedText: 'Buy Now',
      }).success,
    ).toBe(true);
    // The closed verb vocabulary parses under the schema.
    expect(AgentIntentSchema.safeParse({ kind: 'navigate', url: 'https://x' }).success).toBe(true);
    expect(AgentIntentSchema.safeParse({ kind: 'capture', capture: 'pdf' }).success).toBe(true);
    expect(
      AgentIntentSchema.safeParse({ kind: 'wait', condition: 'idle', timeoutMs: 0 }).success,
    ).toBe(true);
    expect(
      AgentIntentSchema.safeParse({ kind: 'wait', condition: 'idle', timeoutMs: -1 }).success,
    ).toBe(false);
    expect(
      AgentIntentSchema.safeParse({ kind: 'wait', condition: 'idle', timeoutMs: 1.5 }).success,
    ).toBe(false);
    // W140 behavioural intents.
    expect(
      AgentIntentSchema.safeParse({ kind: 'scroll', direction: 'down', amount_px: 800 }).success,
    ).toBe(true);
    expect(AgentIntentSchema.safeParse({ kind: 'scroll', direction: 'up' }).success).toBe(true);
    expect(
      AgentIntentSchema.safeParse({ kind: 'behavioral_pause', reading_word_count: 120 }).success,
    ).toBe(true);
    expect(AgentIntentSchema.safeParse({ kind: 'behavioral_pause' }).success).toBe(true);
    // scroll requires a direction.
    expect(AgentIntentSchema.safeParse({ kind: 'scroll' }).success).toBe(false);
    expect(
      IntentResultSchema.safeParse({
        kind: 'success',
        intent: { kind: 'wait', condition: 'idle' },
        summary: 'ok',
      }).success,
    ).toBe(true);
  });

  it('V-1616 CRITICAL every declaration of that severity vocabulary agrees. The arm above closes it in ONE place — api-types — while the same four values are written out separately in the harness wire frame, the service schema, the route interface and the hand-written SDK type. The field travels harness -> wire schema -> service -> response, so a fifth value added at the front and not the back is accepted off the wire, stored, and then refused by the schema that serialises it to the customer.', () => {
    /** Peel `.optional()` / `.nullable()` / `.describe()` until the object appears. */
    const shapeOf = (schema: unknown): Record<string, unknown> => {
      let cur = schema as { shape?: Record<string, unknown>; unwrap?: () => unknown };
      for (let guard = 0; guard < 6 && cur?.shape === undefined; guard += 1) {
        if (typeof cur?.unwrap !== 'function') break;
        cur = cur.unwrap() as typeof cur;
      }
      return cur?.shape ?? {};
    };
    const optionsOf = (schema: unknown): string[] =>
      ((schema as { options?: string[] } | undefined)?.options ?? []).slice();

    // The customer contract is the reference: it is the one already pinned, and
    // the end of the chain, so it is what the other four have to match.
    const canonical = optionsOf(shapeOf(AgentSessionSchema.shape.error_event)['severity']);
    expect(canonical, 'the reference vocabulary was read off api-types').toEqual([
      'info',
      'warn',
      'error',
      'fatal',
    ]);

    // The service schema is importable, so it is compared as VALUES — the
    // strongest form available, and immune to how the file happens to be written.
    expect(
      optionsOf(AgentSessionErrorEventSchema.shape.severity),
      'services/agent-sessions.ts AgentSessionErrorEventSchema',
    ).toEqual(canonical);

    // The other three are TypeScript types or a non-exported schema, so they are
    // read as text. EVERY declaration is checked, not the first one found: a file
    // growing a second severity field must not be able to hide behind the first.
    // Assignments (`severity: rec.lastErrorEvent.severity`) are not declarations
    // and are excluded by requiring a literal right-hand side.
    const zodDecl = `z.enum([${canonical.map((v) => `'${v}'`).join(', ')}])`;
    const unionDecl = canonical.map((v) => `'${v}'`).join(' | ');
    const textSites: { file: string; expected: string }[] = [
      { file: 'apps/server/src/schemas/harness-control-protocol.ts', expected: zodDecl },
      { file: 'apps/server/src/routes/agent-sessions.ts', expected: unionDecl },
      { file: 'packages/sdk-typescript/src/resources/agent-sessions.ts', expected: unionDecl },
    ];
    for (const { file, expected } of textSites) {
      const src = read(resolve(REPO_ROOT, file));
      const declared = [
        ...src.matchAll(/^[ \t]*severity\??:[ \t]*(z\.enum\(\[[^\]]*\]\)|'[^;,]*')[,;]/gm),
      ].map((m) => m[1]!.trim());
      expect(declared.length, `${file} declares the severity field`).toBeGreaterThan(0);
      for (const d of declared) {
        expect(d, `${file} states a severity vocabulary the response cannot serialise`).toBe(
          expected,
        );
      }
    }
  });
});
