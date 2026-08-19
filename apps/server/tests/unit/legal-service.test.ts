// V-553.B-9 — unit tests for LegalService (V-047).
//
// Surface under test:
//   - list() / get() pass through to the catalog
//   - get() raises LegalDocumentNotFoundError for unknown keys
//   - recordAcceptance() rejects unknown documentKey
//   - recordAcceptance() rejects version mismatch + content-hash drift
//   - recordAcceptance() succeeds on exact catalog match
//   - required() returns 'never_accepted' for blank-slate accounts
//   - required() returns 'version_outdated' after a version bump
//   - required() returns 'content_hash_changed' on patch-level edit
//   - required() returns empty list when fully current

import { describe, expect, it } from 'vitest';
import {
  LegalDocumentMismatchError,
  LegalDocumentNotFoundError,
  LegalService,
  type LegalAcceptanceRecord,
  type LegalRepo,
  type RecordAcceptanceInput,
} from '../../src/services/legal.js';
import { buildLegalCatalogFromContent } from '../../src/services/legal-catalog.js';

function makeCatalog(docs: Array<{ key: string; version: string; effective?: string }>) {
  return buildLegalCatalogFromContent(
    docs.map((d) => ({
      documentKey: d.key,
      title: `${d.key} title`,
      sourcePath: `docs/legal/${d.key}.md`,
      content: `**Version:** ${d.version} · **Effective:** ${d.effective ?? '2026-05-11'}\n\nbody`,
    })),
  );
}

function makeRepo(initial: LegalAcceptanceRecord[] = []): {
  repo: LegalRepo;
  records: LegalAcceptanceRecord[];
} {
  const records: LegalAcceptanceRecord[] = [...initial];
  const repo: LegalRepo = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async recordAcceptance(input: RecordAcceptanceInput): Promise<LegalAcceptanceRecord> {
      const rec: LegalAcceptanceRecord = {
        id: `acc_${records.length + 1}`,
        accountId: input.accountId,
        documentKey: input.documentKey,
        version: input.version,
        contentHash: input.contentHash,
        acceptedFromIp: input.acceptedFromIp,
        acceptedUserAgent: input.acceptedUserAgent,
        acceptedAt: new Date(),
      };
      records.push(rec);
      return rec;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async latestAcceptancesForAccount(
      accountId: string,
    ): Promise<Map<string, LegalAcceptanceRecord>> {
      const result = new Map<string, LegalAcceptanceRecord>();
      for (const rec of records.filter((r) => r.accountId === accountId)) {
        result.set(rec.documentKey, rec);
      }
      return result;
    },
  };
  return { repo, records };
}

describe('V-553.B-9 LegalService — list + get', () => {
  it('list() returns every catalog entry', () => {
    const svc = new LegalService(makeCatalog([{ key: 'tos', version: '1.0.0' }]), makeRepo().repo);
    const items = svc.list();
    expect(items).toHaveLength(1);
    expect(items[0]?.documentKey).toBe('tos');
  });

  it('get(unknown) throws LegalDocumentNotFoundError', () => {
    const svc = new LegalService(makeCatalog([{ key: 'tos', version: '1.0.0' }]), makeRepo().repo);
    expect(() => svc.get('aup')).toThrow(LegalDocumentNotFoundError);
  });
});

describe('V-553.B-9 LegalService.recordAcceptance', () => {
  it('rejects unknown documentKey', async () => {
    const svc = new LegalService(makeCatalog([{ key: 'tos', version: '1.0.0' }]), makeRepo().repo);
    await expect(
      svc.recordAcceptance({
        accountId: 'acc_1',
        documentKey: 'aup',
        version: '1.0.0',
        contentHash: 'a'.repeat(64),
        acceptedFromIp: null,
        acceptedUserAgent: null,
      }),
    ).rejects.toThrow(LegalDocumentNotFoundError);
  });

  it('rejects version mismatch', async () => {
    const catalog = makeCatalog([{ key: 'tos', version: '1.0.0' }]);
    const svc = new LegalService(catalog, makeRepo().repo);
    const entry = catalog.get('tos');
    await expect(
      svc.recordAcceptance({
        accountId: 'acc_1',
        documentKey: 'tos',
        version: '0.9.0',
        contentHash: entry?.contentHash ?? '',
        acceptedFromIp: null,
        acceptedUserAgent: null,
      }),
    ).rejects.toThrow(LegalDocumentMismatchError);
  });

  it('rejects content-hash drift even when version matches', async () => {
    const catalog = makeCatalog([{ key: 'tos', version: '1.0.0' }]);
    const svc = new LegalService(catalog, makeRepo().repo);
    await expect(
      svc.recordAcceptance({
        accountId: 'acc_1',
        documentKey: 'tos',
        version: '1.0.0',
        contentHash: 'b'.repeat(64),
        acceptedFromIp: null,
        acceptedUserAgent: null,
      }),
    ).rejects.toThrow(LegalDocumentMismatchError);
  });

  it('records when version + hash both match — IP + UA propagate to repo', async () => {
    const catalog = makeCatalog([{ key: 'tos', version: '1.0.0' }]);
    const { repo, records } = makeRepo();
    const svc = new LegalService(catalog, repo);
    const entry = catalog.get('tos');
    const written = await svc.recordAcceptance({
      accountId: 'acc_1',
      documentKey: 'tos',
      version: '1.0.0',
      contentHash: entry?.contentHash ?? '',
      acceptedFromIp: '203.0.113.42',
      acceptedUserAgent: 'Test/1.0',
    });
    expect(written.accountId).toBe('acc_1');
    expect(records).toHaveLength(1);
    expect(records[0]?.acceptedFromIp).toBe('203.0.113.42');
    expect(records[0]?.acceptedUserAgent).toBe('Test/1.0');
  });
});

describe('V-553.B-9 LegalService.required', () => {
  it('returns one row per catalog entry with reason=never_accepted for a blank account', async () => {
    const catalog = makeCatalog([
      { key: 'tos', version: '1.0.0' },
      { key: 'privacy', version: '2.0.0' },
    ]);
    const svc = new LegalService(catalog, makeRepo().repo);
    const required = await svc.required('acc_blank');
    expect(required).toHaveLength(2);
    expect(required.every((r) => r.reason === 'never_accepted')).toBe(true);
    expect(required.every((r) => r.lastAcceptedVersion === null)).toBe(true);
  });

  it('returns "version_outdated" after the catalog bumps version forward', async () => {
    const catalog = makeCatalog([{ key: 'tos', version: '2.0.0' }]);
    // The acceptance row was written against an older version.
    const stale: LegalAcceptanceRecord = {
      id: 'acc_old',
      accountId: 'acc_1',
      documentKey: 'tos',
      version: '1.0.0',
      contentHash: 'stale_hash',
      acceptedFromIp: null,
      acceptedUserAgent: null,
      acceptedAt: new Date('2026-01-01Z'),
    };
    const { repo } = makeRepo([stale]);
    const svc = new LegalService(catalog, repo);
    const required = await svc.required('acc_1');
    expect(required).toHaveLength(1);
    expect(required[0]?.reason).toBe('version_outdated');
    expect(required[0]?.lastAcceptedVersion).toBe('1.0.0');
    expect(required[0]?.currentVersion).toBe('2.0.0');
  });

  it('returns "content_hash_changed" on patch-level content drift at same version', async () => {
    const catalog = makeCatalog([{ key: 'tos', version: '1.0.0' }]);
    const entry = catalog.get('tos');
    const accepted: LegalAcceptanceRecord = {
      id: 'acc_old',
      accountId: 'acc_1',
      documentKey: 'tos',
      version: '1.0.0',
      contentHash: `${entry?.contentHash.slice(0, -1) ?? ''}0`, // intentional drift
      acceptedFromIp: null,
      acceptedUserAgent: null,
      acceptedAt: new Date(),
    };
    const { repo } = makeRepo([accepted]);
    const svc = new LegalService(catalog, repo);
    const required = await svc.required('acc_1');
    expect(required).toHaveLength(1);
    expect(required[0]?.reason).toBe('content_hash_changed');
    expect(required[0]?.lastAcceptedVersion).toBe('1.0.0');
  });

  it('returns empty when the account is current on every document', async () => {
    const catalog = makeCatalog([
      { key: 'tos', version: '1.0.0' },
      { key: 'privacy', version: '2.0.0' },
    ]);
    const tosHash = catalog.get('tos')?.contentHash ?? '';
    const privHash = catalog.get('privacy')?.contentHash ?? '';
    const records: LegalAcceptanceRecord[] = [
      {
        id: 'a1',
        accountId: 'acc_1',
        documentKey: 'tos',
        version: '1.0.0',
        contentHash: tosHash,
        acceptedFromIp: null,
        acceptedUserAgent: null,
        acceptedAt: new Date(),
      },
      {
        id: 'a2',
        accountId: 'acc_1',
        documentKey: 'privacy',
        version: '2.0.0',
        contentHash: privHash,
        acceptedFromIp: null,
        acceptedUserAgent: null,
        acceptedAt: new Date(),
      },
    ];
    const { repo } = makeRepo(records);
    const svc = new LegalService(catalog, repo);
    const required = await svc.required('acc_1');
    expect(required).toEqual([]);
  });

  it('V-1008 CRITICAL a PATCH bump is enforced exactly like a major one — 0.1.0 → 0.1.1 makes every prior acceptance stale. The service comment used to say patch bumps were exempt and that a per-document catalog setting chose that behaviour; neither was true, and the arm above only ever bumped 1.0.0 → 2.0.0, so the specific claim was never tested. required() gates API-key minting, so this is the difference between a typo fix in the ToS and a fleet-wide minting outage.', async () => {
    const catalog = makeCatalog([{ key: 'tos', version: '0.1.1' }]);
    const acceptedAtPatchBefore: LegalAcceptanceRecord = {
      id: 'acc_old',
      accountId: 'acc_1',
      documentKey: 'tos',
      version: '0.1.0',
      contentHash: 'whatever',
      acceptedFromIp: null,
      acceptedUserAgent: null,
      acceptedAt: new Date('2026-01-01Z'),
    };
    const { repo } = makeRepo([acceptedAtPatchBefore]);
    const svc = new LegalService(catalog, repo);

    const required = await svc.required('acc_1');
    expect(
      required,
      'a patch-level version bump must make the prior acceptance stale — the comparison is a ' +
        'whole-string inequality and there is no semver anywhere in this service',
    ).toHaveLength(1);
    expect(required[0]?.reason).toBe('version_outdated');
    expect(required[0]?.lastAcceptedVersion).toBe('0.1.0');
    expect(required[0]?.currentVersion).toBe('0.1.1');

    // Positive control: an account current on the patch version is NOT required to
    // re-accept, so the arm above cannot pass against a required() that returns a
    // row for everyone.
    const entry = catalog.get('tos');
    const current: LegalAcceptanceRecord = {
      ...acceptedAtPatchBefore,
      id: 'acc_current',
      accountId: 'acc_2',
      version: '0.1.1',
      contentHash: entry?.contentHash ?? '',
    };
    const { repo: repo2 } = makeRepo([current]);
    expect(await new LegalService(catalog, repo2).required('acc_2')).toEqual([]);
  });
});
