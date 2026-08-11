// No successful response body carries a credential-shaped field, except the
// handful that exist to hand one over exactly once.
//
// The redaction work in this repo covers LOGS (logger-v494, query-credential
// completeness, redact-url, the SSE ds_token case) and ERROR bodies
// (error-handler-internal-error-no-leak). Nothing swept the thing customers
// actually receive: 2xx response bodies, across the population.
//
// That is the gap a serializer change opens. Every one of these values exists
// in the row a repo reads — an API key hash, a wrapped DEK, a TOTP secret, a
// webhook signing secret — so exposing one is a `select *` or a forgotten
// `publicX()` mapper away, and it would ship green because no per-endpoint test
// asserts the absence of a field nobody meant to add.
//
// `plaintext` is deliberately in the pattern even though POST /v1/api-keys
// returns it by design. That is the point: the one-time reveal is allowlisted
// at its own operation, so the same field appearing anywhere else — a list, a
// GET by id, an audit row — fails. A one-time secret that becomes retrievable
// is a breach, not a convenience.
//
// Matching is on the LEAF key name, never the dotted path. A path-wide regex
// matches the container instead of the field and acquits everything under a
// well-named parent.
//
// TWO surfaces are swept, because a customer key sees the admin routes only as
// 403s and would report them clean without ever reading a body: the customer
// fixture, and a second one holding `driftstack_internal_admin`.
//
// The `/v1/admin/owner/*` tier is NOT reachable from either. It sits behind
// `requireOwner`, which admits one specific account by email and fails closed
// otherwise, so those three endpoints answer 403 here. That is a real boundary
// of this guard rather than a gap in the API: `admin-owner-secrets.test.ts`
// covers the sensitive one behaviourally, including the taint rule that a
// secret value never appears in the list response or any audit payload.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from './_helpers/build-test-app.js';

let fx: Awaited<ReturnType<typeof buildTestApp>>;
let staff: Awaited<ReturnType<typeof buildTestApp>>;
let spec: SpecDocument;
let adminScanned = 0;
let ids: Record<string, string> = {};

interface SpecDocument {
  paths?: Record<string, Record<string, Operation>>;
}
interface Operation {
  responses?: Record<string, { content?: Record<string, unknown> }>;
}
interface Created {
  id?: string;
}

/** Leaf names that look like a credential, a key, or key material. */
const CREDENTIAL_LEAF =
  /^(.*_)?(secret|password|passwd|private_key|privatekey|key_hash|hashed|hash|encrypted|ciphertext|dek|salt|nonce|totp|mfa_secret|client_secret|refresh_token|access_token|signing_key|plaintext)$/i;

/**
 * Fields that legitimately appear, keyed by `METHOD /path` then leaf name.
 *
 * Exact, and checked for staleness below: an entry that stops describing a real
 * occurrence exempts nothing and reads as reviewed.
 */
const INTENTIONAL: Record<string, Record<string, string>> = {
  'POST /v1/api-keys': {
    plaintext:
      'The one-time key reveal. Unrecoverable after this response — that is the ' +
      'whole contract — and its presence on any OTHER operation would mean a ' +
      'key became retrievable after creation.',
  },
  'POST /v1/webhooks': {
    secret:
      'The signing secret, revealed once at creation so the caller can verify ' +
      'deliveries. Proved contained by the arm below: it does NOT come back ' +
      'from GET /v1/webhooks/{id} or the list.',
  },
  'POST /v1/webhooks/{id}/rotate-secret': {
    secret:
      'The newly minted signing secret, returned once so the caller can install ' +
      'it. Same shape of contract as the api-key plaintext above.',
  },
  'GET /v1/legal/documents': {
    content_hash:
      'A document INTEGRITY digest, not key material. It exists so a customer ' +
      'can verify the terms they accepted were not altered, so it is meant to ' +
      'be published.',
  },
};

interface Hit {
  op: string;
  leaf: string;
  path: string;
}

const hits: Hit[] = [];
let scanned = 0;

/** Collect every credential-shaped LEAF key in a body. */
function walk(node: unknown, path: string, op: string, out: Hit[]): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => {
      walk(v, `${path}[${String(i)}]`, op, out);
    });
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (CREDENTIAL_LEAF.test(k)) out.push({ op, leaf: k, path: `${path}.${k}` });
    walk(v, `${path}.${k}`, op, out);
  }
}

const auth = (): { authorization: string } => ({ authorization: `Bearer ${fx.plaintext}` });

function familyOf(path: string): string | null {
  if (path.startsWith('/v1/profiles/')) return 'profile';
  if (path.startsWith('/v1/sessions/')) return 'session';
  if (path.startsWith('/v1/webhooks/')) return 'webhook';
  return null;
}

beforeAll(async () => {
  fx = await buildTestApp({ scopes: ['read', 'write', 'account_owner'] });
  staff = await buildTestApp({
    scopes: ['read', 'write', 'account_owner', 'driftstack_internal_admin'],
  });
  spec = (await fx.app.inject({ method: 'GET', url: '/openapi.json' })).json<SpecDocument>();

  const create = async (url: string, payload: Record<string, unknown>): Promise<string> => {
    const res = await fx.app.inject({ method: 'POST', url, headers: auth(), payload });
    try {
      return res.json<Created>().id ?? '';
    } catch {
      return '';
    }
  };
  ids = {
    profile: await create('/v1/profiles', { name: 'leak-probe' }),
    session: await create('/v1/sessions', {}),
    webhook: await create('/v1/webhooks', {
      url: 'https://example.com/hook',
      events: ['session.completed'],
    }),
  };

  // Bodies that make the interesting operations actually succeed. Without
  // these the api-key create 400s and the one-time `plaintext` — the field
  // whose containment this whole guard is built around — is never scanned.
  const PAYLOADS: Record<string, Record<string, unknown>> = {
    'POST /v1/api-keys': { name: 'leak-probe-key', scopes: ['read'] },
    'POST /v1/profiles': { name: 'leak-probe-2' },
    'POST /v1/sessions': {},
    'POST /v1/webhooks': { url: 'https://example.com/hook2', events: ['session.completed'] },
  };

  for (const path of Object.keys(spec.paths ?? {})) {
    for (const method of ['get', 'post'] as const) {
      if (spec.paths?.[path]?.[method] === undefined) continue;
      const responses = Object.values(spec.paths[path]?.[method]?.responses ?? {});
      if (responses.some((r) => r.content?.['text/event-stream'] !== undefined)) continue;

      let url = path;
      if (path.includes('{')) {
        const family = familyOf(path);
        if (family === null) continue;
        url = path.replace(/\{[^}]+\}/, ids[family] ?? '');
        if (url.includes('{')) continue;
      }
      const op = `${method.toUpperCase()} ${path}`;
      const res = await fx.app.inject({
        method: method.toUpperCase() as 'GET',
        url,
        headers: auth(),
        ...(method === 'get' ? {} : { payload: PAYLOADS[op] ?? {} }),
      });
      if (res.statusCode < 200 || res.statusCode >= 300) continue;
      scanned += 1;
      let body: unknown;
      try {
        body = res.json();
      } catch {
        continue;
      }
      walk(body, '', op, hits);
    }
  }

  // The admin surface, with a staff credential. The customer fixture above sees
  // every one of these as a 403 and would report them clean having read no body
  // at all — the shape of false green this whole file exists to avoid.
  const staffAuth = { authorization: `Bearer ${staff.plaintext}` };
  for (const path of Object.keys(spec.paths ?? {})) {
    if (!path.startsWith('/v1/admin/') || path.includes('{')) continue;
    for (const method of ['get', 'post'] as const) {
      if (spec.paths?.[path]?.[method] === undefined) continue;
      const res = await staff.app.inject({
        method: method.toUpperCase() as 'GET',
        url: path,
        headers: staffAuth,
        ...(method === 'get' ? {} : { payload: {} }),
      });
      if (res.statusCode < 200 || res.statusCode >= 300) continue;
      adminScanned += 1;
      let body: unknown;
      try {
        body = res.json();
      } catch {
        continue;
      }
      walk(body, '', `${method.toUpperCase()} ${path}`, hits);
    }
  }
}, 180_000);

afterAll(async () => {
  await fx.app.close();
  await staff.app.close();
});

describe('no successful response leaks a credential', () => {
  it('CRITICAL the sweep reached real bodies AND the detector fires. Every assertion below reports an ABSENCE, so a sweep that scanned nothing — or a pattern that matched nothing — would satisfy them having proved nothing.', () => {
    expect(scanned, 'customer-surface 2xx bodies scanned').toBeGreaterThan(40);
    // Floored separately: a staff credential that stopped working would turn
    // every admin route back into a 403 and this sweep would silently return to
    // reading nothing while still reporting clean.
    expect(adminScanned, 'admin-surface 2xx bodies scanned').toBeGreaterThan(15);

    // The detector, on a body whose verdict is not in doubt.
    const probe: Hit[] = [];
    walk({ nested: [{ mfa_secret: 'x' }], ok: 1 }, '', 'PROBE', probe);
    expect(
      probe.map((h) => h.leaf),
      'a nested credential leaf is found',
    ).toEqual(['mfa_secret']);

    // And a benign body is not flagged — `key_prefix` and `next_cursor` are
    // both normal fields whose names brush against the pattern.
    const benign: Hit[] = [];
    walk({ key_prefix: 'ds_live_ab', next_cursor: null, id: 'x' }, '', 'PROBE', benign);
    expect(benign, 'ordinary fields are not flagged').toEqual([]);

    // The one-time reveal really was exercised; otherwise the allowlist entry
    // for it is untested and the containment claim is empty.
    expect(
      hits.filter((h) => h.op === 'POST /v1/api-keys' && h.leaf === 'plaintext').length,
      'the api-key one-time plaintext was actually seen',
    ).toBeGreaterThan(0);
  });

  it('CRITICAL no response carries a credential-shaped field outside its reviewed operation. A one-time secret that becomes retrievable — plaintext on a list, a rotated secret on a GET — is a breach, not a convenience.', () => {
    const unexplained = hits
      .filter((h) => INTENTIONAL[h.op]?.[h.leaf] === undefined)
      .map((h) => `${h.op} exposes ${h.path}`);
    expect(
      unexplained,
      'response field(s) that look like credentials and are not reviewed:',
    ).toEqual([]);
  });

  it('CRITICAL the one-time secrets are genuinely one-time — neither the webhook signing secret nor the api-key plaintext comes back from a READ. This is what makes the allowlist entries safe, and asserting it beats inferring it from the absence of a hit.', async () => {
    for (const url of [`/v1/webhooks/${ids['webhook'] ?? ''}`, '/v1/webhooks', '/v1/api-keys']) {
      const res = await fx.app.inject({ method: 'GET', url, headers: auth() });
      expect(res.statusCode, `${url} reads back`).toBe(200);
      const found: Hit[] = [];
      walk(res.json(), '', `GET ${url}`, found);
      expect(
        found.map((h) => h.path),
        `${url} must not return a credential on a read`,
      ).toEqual([]);
    }
  });

  it('CRITICAL every allowlist entry still describes a field that really appears. An entry whose field is gone exempts nothing and reads as reviewed.', () => {
    const stale: string[] = [];
    for (const [op, leaves] of Object.entries(INTENTIONAL)) {
      for (const leaf of Object.keys(leaves)) {
        if (!hits.some((h) => h.op === op && h.leaf === leaf)) stale.push(`${op}.${leaf}`);
      }
    }
    expect(stale, 'allowlist entr(ies) that no longer describe a real field:').toEqual([]);
  });
});
