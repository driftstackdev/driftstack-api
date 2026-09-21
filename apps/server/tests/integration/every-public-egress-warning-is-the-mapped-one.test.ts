// Every public response that carries `egress_capabilities` carries the MAPPED
// warning vocabulary — and the operations are ENUMERATED from the published
// document, not listed by hand.
//
// ⛔ THE DEFECT. The stored `egress_capabilities.warnings` is the INTERNAL
// vocabulary: `safeguard_failed:<layer>` where `<layer>` is 64 free characters
// chosen by the device, plus codes naming our own mechanisms. `publicSession()`
// echoed the whole object, so that list reached customers on four operations
// spread over two route files — `POST /v1/profiles/{id}/launch` is registered
// in `routes/sessions.ts`, which is how it has gone missing from hand tables
// before.
//
// ⛔ WHY ENUMERATED. A hand table of the echoing routes is only as complete as
// the last person to re-derive it. The set below is computed by following
// `$ref`s to every component that carries the field, so a fifth echoing
// operation added tomorrow is covered the moment it is documented — and one
// that is NOT documented fails the positive control rather than passing
// unexamined.
//
// The admin operation is enumerated by the same walk and asserted the OTHER
// way: it must still show the internal codes, layer names included. Operators
// need "the screen-recording check failed", not "a safeguard failed", and
// `requireScope('driftstack_internal_admin')` really does gate that route.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { generateOpenApiSpec } from '../../src/lib/openapi.js';
import {
  isPublicEgressWarning,
  PUBLIC_EGRESS_WARNINGS,
} from '../../src/services/customer-safe-egress-warnings.js';

const WIRE_FIELD = 'egress_capabilities';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

/**
 * What a real row holds: exactly what `deriveWarnings` writes today, plus the
 * hostile layer the open `z.string().max(64)` permits and an unclassified code
 * standing in for one the device ships tomorrow.
 */
const STORED_INTERNAL_WARNINGS = [
  'udp_unsupported_by_proxy',
  'h3_interpose_unavailable',
  'safeguards_expectation_unreported',
  'safeguard_missing:webkit_gate',
  'safeguard_failed:screen_recording',
  'safeguard_failed:network_firewall',
  'safeguard_failed:../../x <script> relay-07.fleet.internal:1080',
  'streaming_blank',
  'dead_proxy',
  'a_code_nobody_has_classified',
];

/** What the customer must see for that row. Written out in full rather than
 *  computed from the mapper, so a mapper that changed its mind would fail here
 *  rather than agree with itself. */
const EXPECTED_PUBLIC_WARNINGS = [
  'udp_unsupported_by_proxy',
  'quic_unavailable',
  'safeguards_unverified',
  'safeguard_failed:live_view_capture',
  'safeguard_failed:direct_internet_block',
  'safeguard_failed',
  'streaming_blank',
  'dead_proxy',
];

/** Fragments that must never appear anywhere in a customer response body. */
const FORBIDDEN_FRAGMENTS = [
  'h3_interpose_unavailable',
  'safeguards_expectation_unreported',
  'safeguard_missing',
  'screen_recording',
  'network_firewall',
  'webkit_gate',
  'a_code_nobody_has_classified',
  '<script>',
  'fleet.internal',
  '1080',
];

const DERIVED = {
  udp_associate: true,
  quic_route: 'disabled' as const,
  dns_remote_resolve: false,
  warnings: STORED_INTERNAL_WARNINGS,
};

interface EchoOperation {
  method: 'get' | 'post';
  path: string;
}

/** Component schema names that carry `egress_capabilities`, directly or through
 *  a `$ref`. Computed to a fixpoint so a wrapper schema counts too. */
function carrierComponents(doc: Record<string, unknown>): Set<string> {
  const schemas = ((doc.components as Record<string, unknown> | undefined)?.schemas ??
    {}) as Record<string, unknown>;
  const carriers = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, schema] of Object.entries(schemas)) {
      if (carriers.has(name)) continue;
      const text = JSON.stringify(schema);
      const direct = text.includes(`"${WIRE_FIELD}"`);
      const viaRef = [...carriers].some((c) => text.includes(`#/components/schemas/${c}"`));
      if (direct || viaRef) {
        carriers.add(name);
        changed = true;
      }
    }
  }
  return carriers;
}

function enumerateEchoOperations(): EchoOperation[] {
  const doc = generateOpenApiSpec() as unknown as Record<string, unknown>;
  const carriers = carrierComponents(doc);
  const paths = (doc.paths ?? {}) as Record<string, Record<string, unknown>>;
  const found: EchoOperation[] = [];
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (method !== 'get' && method !== 'post') continue;
      const responses = (operation as Record<string, unknown> | null)?.responses;
      if (responses === undefined || responses === null) continue;
      const text = JSON.stringify(responses);
      const direct = text.includes(`"${WIRE_FIELD}"`);
      const viaRef = [...carriers].some((c) => text.includes(`#/components/schemas/${c}"`));
      if (direct || viaRef) found.push({ method, path });
    }
  }
  return found.sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
}

function concreteUrl(op: EchoOperation, ids: { session: string; profile: string }): string {
  return op.path
    .replace('/v1/profiles/{id}', `/v1/profiles/${ids.profile}`)
    .replace('/v1/sessions/{id}', `/v1/sessions/${ids.session}`);
}

/** Every value stored under `egress_capabilities` anywhere in a response — the
 *  field is top-level on a detail response and under `data[]` on a list, so the
 *  walk finds both without knowing which is which. */
function collectCapabilities(body: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(body)) {
    for (const item of body) collectCapabilities(item, out);
    return out;
  }
  if (body !== null && typeof body === 'object') {
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (key === WIRE_FIELD) out.push(value);
      else collectCapabilities(value, out);
    }
  }
  return out;
}

describe('the public egress warning list is the mapped one on every documented surface', () => {
  it('CRITICAL enumerated from the OpenAPI document — every public operation returns the public vocabulary and no internal code', async () => {
    fx = await buildTestApp();
    const auth = { authorization: `Bearer ${fx.plaintext}` };

    const created = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth,
      payload: {},
    });
    expect(created.statusCode).toBe(201);
    const sessionId = created.json<{ id: string }>().id;

    const profile = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: auth,
      payload: { name: 'egress-warning-fixture' },
    });
    expect(profile.statusCode, profile.body).toBeLessThan(300);
    const profileId = profile.json<{ id: string }>().id;

    // Seed the INTERNAL codes exactly as the relay persists them.
    await fx.sessionsRepo.setEgressCapabilityReport({
      sessionId: sessionId.replace(/^ses_/, ''),
      derived: DERIVED,
      raw: { proxyKind: 'socks5' },
    });

    const operations = enumerateEchoOperations();
    const publicOps = operations.filter((op) => !op.path.startsWith('/v1/admin'));
    const adminOps = operations.filter((op) => op.path.startsWith('/v1/admin'));

    // POSITIVE CONTROLS on the enumeration itself. An empty set would make
    // every assertion below vacuously true.
    expect(publicOps.length, 'the OpenAPI walk found no public carrier').toBeGreaterThan(0);
    expect(adminOps.length, 'the OpenAPI walk found no admin carrier').toBeGreaterThan(0);
    const publicLabels = publicOps.map((op) => `${op.method.toUpperCase()} ${op.path}`);
    expect(publicLabels).toContain('GET /v1/sessions/{id}');
    expect(publicLabels).toContain('GET /v1/sessions');
    expect(publicLabels).toContain('POST /v1/sessions');
    expect(publicLabels).toContain('POST /v1/profiles/{id}/launch');

    let sawPopulated = false;
    for (const op of publicOps) {
      const url = concreteUrl(op, { session: sessionId, profile: profileId });
      expect(url, `no parameter substitution for ${op.method} ${op.path}`).not.toContain('{');
      const res = await fx.app.inject({
        method: op.method === 'get' ? 'GET' : 'POST',
        url,
        headers: auth,
        ...(op.method === 'post' ? { payload: {} } : {}),
      });
      expect(res.statusCode, `${op.method} ${url} -> ${res.statusCode} ${res.body}`).toBeLessThan(
        300,
      );

      // Nothing internal survives anywhere in the body, whatever shape it has.
      for (const fragment of FORBIDDEN_FRAGMENTS) {
        expect(res.body, `${op.method} ${url} leaked ${fragment}`).not.toContain(fragment);
      }

      const capabilities = collectCapabilities(res.json());
      expect(
        capabilities.length,
        `${op.method} ${url} returned no ${WIRE_FIELD} at all`,
      ).toBeGreaterThan(0);
      for (const cap of capabilities) {
        // A create returns a brand-new session whose capabilities are null;
        // null is the honest value and not a leak.
        if (cap === null) continue;
        sawPopulated = true;
        const warnings = (cap as { warnings?: unknown }).warnings as string[];
        expect(warnings, `${op.method} ${url} lost the warnings array`).toEqual(
          EXPECTED_PUBLIC_WARNINGS,
        );
        for (const code of warnings) {
          expect(isPublicEgressWarning(code), `${op.method} ${url} published ${code}`).toBe(true);
        }
        // The other three fields are untouched by the mapping.
        expect(cap).toMatchObject({
          udp_associate: true,
          quic_route: 'disabled',
          dns_remote_resolve: false,
        });
      }
    }
    expect(
      sawPopulated,
      'no public operation returned a populated capabilities object, so the mapping was never exercised',
    ).toBe(true);

    // The operator half of the decision: the internal codes are still there,
    // layer names included, on the staff-only route.
    for (const op of adminOps) {
      const res = await fx.app.inject({ method: 'GET', url: op.path, headers: auth });
      expect(res.statusCode).toBe(200);
      const adminCap = collectCapabilities(res.json()).find((c) => c !== null) as {
        warnings: string[];
      };
      expect(adminCap, `${op.path} returned no populated capabilities`).toBeTruthy();
      expect(adminCap.warnings, `${op.path} lost the internal vocabulary`).toEqual(
        STORED_INTERNAL_WARNINGS,
      );
      expect(adminCap.warnings).toContain('safeguard_failed:screen_recording');
      expect(adminCap.warnings).toContain('a_code_nobody_has_classified');
    }
  });

  it('NEGATIVE CONTROL — the stored row still holds the internal vocabulary, so the arms above map at the EDGE and not at rest', async () => {
    fx = await buildTestApp();
    const auth = { authorization: `Bearer ${fx.plaintext}` };
    const created = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth,
      payload: {},
    });
    const sessionId = created.json<{ id: string }>().id;
    await fx.sessionsRepo.setEgressCapabilityReport({
      sessionId: sessionId.replace(/^ses_/, ''),
      derived: DERIVED,
      raw: {},
    });

    // Read back from the repo, not reconstructed: this fails if storage ever
    // starts mapping, which it must not — the row is the operator's record and
    // rows are deliberately NOT migrated.
    const stored = fx.sessionsRepo.getSession(sessionId.replace(/^ses_/, ''))?.egressCapabilities;
    expect(stored?.warnings).toEqual(STORED_INTERNAL_WARNINGS);
    // And the public list is genuinely different from it, so "they match" is
    // not how the arms above pass.
    expect(EXPECTED_PUBLIC_WARNINGS).not.toEqual(STORED_INTERNAL_WARNINGS);
    expect(EXPECTED_PUBLIC_WARNINGS.every((c) => isPublicEgressWarning(c))).toBe(true);
    expect(STORED_INTERNAL_WARNINGS.some((c) => !isPublicEgressWarning(c))).toBe(true);
  });

  it('an OLD row written before this change maps on the way out — no migration was needed', async () => {
    fx = await buildTestApp();
    const auth = { authorization: `Bearer ${fx.plaintext}` };
    const created = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth,
      payload: {},
    });
    const sessionId = created.json<{ id: string }>().id;
    // The shape migration 0045's own example wrote, verbatim.
    await fx.sessionsRepo.setEgressCapabilityReport({
      sessionId: sessionId.replace(/^ses_/, ''),
      derived: {
        udp_associate: false,
        quic_route: 'disabled',
        dns_remote_resolve: true,
        warnings: ['udp_unsupported_by_proxy', 'dead_proxy'],
      },
      raw: {},
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ egress_capabilities: { warnings: string[] } }>().egress_capabilities.warnings)
      // Both are published codes, so an old row is unchanged rather than emptied.
      .toEqual(['udp_unsupported_by_proxy', 'dead_proxy']);
  });

  it('a RETIRED code in an old stored row is dropped, not leaked — 2026-09-21: quic_disabled_fallback_http2 and dns_remote_resolve_unsupported_by_proxy were removed from the public vocabulary because nothing ever emitted them', async () => {
    fx = await buildTestApp();
    const auth = { authorization: `Bearer ${fx.plaintext}` };
    const created = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth,
      payload: {},
    });
    const sessionId = created.json<{ id: string }>().id;
    // A row written before the retirement can still hold these — storage is
    // unchanged and rows are never migrated. The map must drop them now, the
    // same way it already drops any other code it does not recognise.
    await fx.sessionsRepo.setEgressCapabilityReport({
      sessionId: sessionId.replace(/^ses_/, ''),
      derived: {
        udp_associate: false,
        quic_route: 'disabled',
        dns_remote_resolve: true,
        warnings: [
          'udp_unsupported_by_proxy',
          'quic_disabled_fallback_http2',
          'dns_remote_resolve_unsupported_by_proxy',
        ],
      },
      raw: {},
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ egress_capabilities: { warnings: string[] } }>();
    expect(body.egress_capabilities.warnings).toEqual(['udp_unsupported_by_proxy']);
    expect(res.body).not.toContain('quic_disabled_fallback_http2');
    expect(res.body).not.toContain('dns_remote_resolve_unsupported_by_proxy');
    expect(isPublicEgressWarning('quic_disabled_fallback_http2')).toBe(false);
    expect(isPublicEgressWarning('dns_remote_resolve_unsupported_by_proxy')).toBe(false);
  });

  it('POSITIVE CONTROL — the fixture really exercises every branch of the mapper', () => {
    // pass-through, rename, merge, known layer, unknown layer, drop.
    expect(STORED_INTERNAL_WARNINGS).toContain('udp_unsupported_by_proxy');
    expect(STORED_INTERNAL_WARNINGS).toContain('h3_interpose_unavailable');
    expect(STORED_INTERNAL_WARNINGS.some((c) => c.startsWith('safeguard_missing:'))).toBe(true);
    expect(STORED_INTERNAL_WARNINGS).toContain('safeguard_failed:network_firewall');
    expect(STORED_INTERNAL_WARNINGS.some((c) => c.includes('<script>'))).toBe(true);
    expect(STORED_INTERNAL_WARNINGS).toContain('a_code_nobody_has_classified');
    // And every expected public string really is in the closed vocabulary.
    for (const code of EXPECTED_PUBLIC_WARNINGS) {
      expect(PUBLIC_EGRESS_WARNINGS).toContain(code);
    }
  });
});
