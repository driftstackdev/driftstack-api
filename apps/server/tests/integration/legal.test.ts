// /v1/legal/* — catalog list, required-by-account, accept.
//
// The fixture seeds 4 canned documents (tos, privacy, dpa, aup) at
// version 0.1.0-draft. A fresh account starts with all four required;
// after accepting all four, required returns empty; if any document's
// hash changes mid-flight, the customer's accept call 409s with the
// current version + hash so the client can refresh.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx !== undefined) await fx.cleanup();
});

function auth(f: TestAppFixture): Record<string, string> {
  return { authorization: `Bearer ${f.plaintext}` };
}

interface CatalogEntry {
  document_key: string;
  title: string;
  version: string;
  effective_date: string;
  content_hash: string;
  byte_size: number;
}

describe('GET /v1/legal/documents', () => {
  it('200 lists 4 canned documents (tos, privacy, dpa, aup)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/legal/documents',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: CatalogEntry[] }>();
    expect(body.data).toHaveLength(4);
    const keys = body.data.map((d) => d.document_key).sort();
    expect(keys).toEqual(['aup', 'dpa', 'privacy', 'tos']);
    for (const entry of body.data) {
      expect(entry.version).toBe('0.1.0-draft');
      expect(entry.effective_date).toBe('2026-05-03');
      expect(entry.content_hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('401 without auth', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({ method: 'GET', url: '/v1/legal/documents' });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /v1/legal/required', () => {
  it('200 lists all 4 documents as never_accepted for a fresh account', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/legal/required',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: Array<{ document_key: string; reason: string; last_accepted_version: string | null }>;
    }>();
    expect(body.data).toHaveLength(4);
    expect(new Set(body.data.map((d) => d.reason))).toEqual(new Set(['never_accepted']));
    expect(body.data.every((d) => d.last_accepted_version === null)).toBe(true);
  });

  it('returns empty after the account has accepted every document', async () => {
    fx = await buildTestApp();
    // Fetch catalog to get the current version + hash for each.
    const cat = await fx.app.inject({
      method: 'GET',
      url: '/v1/legal/documents',
      headers: auth(fx),
    });
    const entries = cat.json<{ data: CatalogEntry[] }>().data;
    for (const entry of entries) {
      const r = await fx.app.inject({
        method: 'POST',
        url: '/v1/legal/accept',
        headers: { ...auth(fx), 'content-type': 'application/json' },
        payload: {
          document_key: entry.document_key,
          version: entry.version,
          content_hash: entry.content_hash,
        },
      });
      expect(r.statusCode).toBe(201);
    }
    // Now required should be empty.
    const req = await fx.app.inject({
      method: 'GET',
      url: '/v1/legal/required',
      headers: auth(fx),
    });
    expect(req.statusCode).toBe(200);
    expect(req.json<{ data: unknown[] }>().data).toHaveLength(0);
  });
});

describe('POST /v1/legal/accept', () => {
  it('201 records an acceptance and returns the audit shape', async () => {
    fx = await buildTestApp();
    const cat = await fx.app.inject({
      method: 'GET',
      url: '/v1/legal/documents',
      headers: auth(fx),
    });
    const tos = cat.json<{ data: CatalogEntry[] }>().data.find((d) => d.document_key === 'tos');
    if (!tos) throw new Error('tos missing from catalog');
    const r = await fx.app.inject({
      method: 'POST',
      url: '/v1/legal/accept',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: {
        document_key: 'tos',
        version: tos.version,
        content_hash: tos.content_hash,
      },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json<Record<string, unknown>>();
    expect(body.id).toMatch(/^lacc_[0-9a-f-]+$/);
    expect(body.document_key).toBe('tos');
    expect(body.version).toBe(tos.version);
    expect(body.content_hash).toBe(tos.content_hash);
    expect(body.accepted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('409 with a problem when the version is stale', async () => {
    fx = await buildTestApp();
    const r = await fx.app.inject({
      method: 'POST',
      url: '/v1/legal/accept',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: {
        document_key: 'tos',
        version: '0.0.9-stale',
        content_hash: 'a'.repeat(64),
      },
    });
    expect(r.statusCode).toBe(409);
    const body = r.json<Record<string, unknown>>();
    expect(body.type).toBe('https://errors.driftstack.dev/conflict');
    expect(body.document_key).toBe('tos');
    expect(body.provided_version).toBe('0.0.9-stale');
    expect(typeof body.current_version).toBe('string');
    expect(typeof body.current_content_hash).toBe('string');
  });

  it('404 when document_key is unknown', async () => {
    fx = await buildTestApp();
    const r = await fx.app.inject({
      method: 'POST',
      url: '/v1/legal/accept',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: {
        document_key: 'made_up',
        version: '0.1.0',
        content_hash: 'b'.repeat(64),
      },
    });
    expect(r.statusCode).toBe(404);
  });

  it('400 when content_hash is not a 64-hex string', async () => {
    fx = await buildTestApp();
    const r = await fx.app.inject({
      method: 'POST',
      url: '/v1/legal/accept',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: {
        document_key: 'tos',
        version: '0.1.0-draft',
        content_hash: 'too short',
      },
    });
    expect(r.statusCode).toBe(400);
  });
});

describe('Acceptance recovers from version bump', () => {
  it('content_hash_changed reason fires when same version but different content', async () => {
    // The fixture catalog is fixed; this test exercises the
    // content_hash_changed branch of the service via direct service
    // construction inside the existing fixture's helpers. The HTTP
    // path through the API doesn't easily mutate the catalog mid-test
    // because the catalog is constructed at app boot. Skipping the
    // HTTP-level assertion here; the unit-level coverage is in the
    // service exercise below.
    const { LegalService } = await import('../../src/services/legal.js');
    const { buildLegalCatalogFromContent } = await import('../../src/services/legal-catalog.js');
    const { InMemoryLegalRepo } = await import('./_helpers/in-memory-legal-repo.js');

    const repo = new InMemoryLegalRepo();
    const catalogV1 = buildLegalCatalogFromContent([
      {
        documentKey: 'tos',
        title: 'ToS',
        sourcePath: 'docs/legal/terms-of-service.md',
        content: '# ToS v1\n\n**Version:** 0.1.0 · **Effective:** 2026-05-03\n',
      },
    ]);
    const svcV1 = new LegalService(catalogV1, repo);
    const tosV1 = svcV1.get('tos');
    await svcV1.recordAcceptance({
      accountId: 'acc-1',
      documentKey: 'tos',
      version: tosV1.version,
      contentHash: tosV1.contentHash,
      acceptedFromIp: null,
      acceptedUserAgent: null,
    });
    expect(await svcV1.required('acc-1')).toEqual([]);

    // Patch-level edit: same version string, new content hash.
    const catalogV1Patched = buildLegalCatalogFromContent([
      {
        documentKey: 'tos',
        title: 'ToS',
        sourcePath: 'docs/legal/terms-of-service.md',
        content: '# ToS v1 patched\n\n**Version:** 0.1.0 · **Effective:** 2026-05-03\n',
      },
    ]);
    const svcV1Patched = new LegalService(catalogV1Patched, repo);
    const required = await svcV1Patched.required('acc-1');
    expect(required).toHaveLength(1);
    expect(required[0]?.reason).toBe('content_hash_changed');
    expect(required[0]?.lastAcceptedVersion).toBe('0.1.0');
  });
});
