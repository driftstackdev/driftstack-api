// Drift guard for apps/docs/src/pages/api/profile-snapshots.md.
// Pins the 5-endpoint surface, the snapshot-vs-profile immutability
// model, and the tier-cap-on-restore framing (the most-cited
// customer surprise).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/profile-snapshots.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('docs api/profile-snapshots content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('title + description front-matter pinned', () => {
    expect(body).toMatch(/title: Profile snapshots/);
    expect(body).toMatch(/description: Capture, list, and restore immutable point-in-time copies/);
  });

  it('snapshot-vs-profile immutability model pinned: profiles evolve, snapshots are frozen — the load-bearing mental model that justifies the separate resource type. Drift to claiming snapshots mutate would mislead customers into expecting Snapshots to track upstream profile changes', () => {
    expect(body).toMatch(/\*\*Profiles\*\* evolve/);
    expect(body).toMatch(/\*\*Snapshots\*\* are frozen/);
    expect(body).toMatch(/Restoring a snapshot creates a \*\*new profile row\*\*/);
    expect(body).toMatch(/source profile is untouched/);
  });

  it('5-endpoint surface pinned: capture / list-per-profile / list-all / get / restore / delete — drift to dropping the across-account list endpoint would force customers to iterate profiles to enumerate snapshots', () => {
    expect(body).toMatch(/`POST \/v1\/profiles\/:id\/snapshots`/);
    expect(body).toMatch(/`GET \/v1\/profiles\/:id\/snapshots`/);
    expect(body).toMatch(/`GET \/v1\/profile-snapshots`/);
    expect(body).toMatch(/`GET \/v1\/profile-snapshots\/:id`/);
    expect(body).toMatch(/`POST \/v1\/profile-snapshots\/:id\/restore`/);
    expect(body).toMatch(/`DELETE \/v1\/profile-snapshots\/:id`/);
  });

  it("restore-counts-against-tier-cap framing pinned (the most-cited customer surprise — restore looks free but counts against PROFILES_PER_TIER): 429 tier-limit when over cap; drift to hiding this would create 'why won't my restore work?' support tickets", () => {
    expect(body).toMatch(/`429 tier-limit`/);
    expect(body).toMatch(/Snapshot restore counts against\s+the same cap as profile-create/);
  });

  it('profile_name extra field on across-account list pinned — saves a per-row second fetch when listing snapshots from multiple profiles; drift to dropping would force N+1 fetches in customer dashboards', () => {
    expect(body).toMatch(/Note the additional `profile_name` field/);
    expect(body).toMatch(
      /handy when listing\s+across profiles so you don't have to issue a second fetch per\s+row/,
    );
  });

  it('cross-link to /api/audit-log pinned (snapshot lifecycle events land in the customer audit log; drift to dropping would orphan the audit-trail visibility from this doc)', () => {
    expect(body).toMatch(/\[\/api\/audit-log\]\(\/api\/audit-log\)/);
  });
});
