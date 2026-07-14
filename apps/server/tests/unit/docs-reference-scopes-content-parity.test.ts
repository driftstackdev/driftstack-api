// Drift guard for apps/docs/src/pages/reference/scopes.md. Pins
// the 3-category framing (broad / account-control / granular) +
// the broad-satisfies-granular rule + 12 specific scope names.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/reference/scopes.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('docs reference/scopes content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('title + description front-matter pinned', () => {
    expect(body).toMatch(/title: API key scopes/);
    expect(body).toMatch(/description: Full reference of API key scopes/);
  });

  it('3-category framing pinned: broad / account-control / granular — the load-bearing scope taxonomy. Drift to reordering or dropping a category would mislead customers about which scope to mint for a given integration', () => {
    expect(body).toMatch(/\*\*Broad scopes\*\* — `read`, `write`, `admin`/);
    expect(body).toMatch(
      /\*\*Account-control scopes\*\* — `account_owner`,\s+`driftstack_internal_admin`/,
    );
    expect(body).toMatch(/\*\*Granular scopes\s*\*\* — `verb:resource` syntax/);
  });

  it("legacy 'admin' scope remains customer-compatible but never grants staff authority", () => {
    expect(body).toMatch(
      /`admin`\s+\|\s+broad \(legacy\)\s+\|\s+Deprecated customer alias\. Satisfies `account_owner` and customer `admin:\*` scopes, but never the staff-only `driftstack_internal_admin` scope/,
    );
  });

  it('granular per-resource scope table covers 12 canonical names (sample-check 6 of the 12 to detect a row-drop): read:sessions / write:sessions / read:profiles / read:webhooks / admin:api-keys / read:billing — drift to dropping any would break SDK consumers who mint narrow-scoped keys', () => {
    expect(body).toMatch(/`read:sessions`/);
    expect(body).toMatch(/`write:sessions`/);
    expect(body).toMatch(/`read:profiles`/);
    expect(body).toMatch(/`read:webhooks`/);
    expect(body).toMatch(/`admin:api-keys`/);
    expect(body).toMatch(/`read:billing`/);
  });

  it('broad-satisfies-granular rule pinned: a `read` key satisfies every `read:*` scope (the core scope-checking semantic; drift to making broad scopes NOT satisfy granular would break customers who hold legacy broad keys against routes that gate on granular scopes)', () => {
    expect(body).toMatch(
      /A key with a broad scope \*\*satisfies\*\* any granular scope on\s+the same verb/,
    );
    expect(body).toMatch(/A key with `read` satisfies every `read:\*` granular scope/);
  });

  it('gui_control L-001 locked-decision framing pinned: self-hosted GUI workflow only (drift to dropping the L-001 reference would orphan the locked-decision audit trail that justifies the special-case scope category)', () => {
    expect(body).toMatch(/`gui_control`/);
    expect(body).toMatch(/locked-decision L-001/);
  });
});
