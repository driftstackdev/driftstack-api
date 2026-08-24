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

  it("V-1509 CRITICAL read:webhooks is described as everything it actually unlocks. The service gates FOUR methods on it — list, listWithCounts, get and listDeliveries — so the scope also reads delivery history, whose rows carry last_response_status, last_response_excerpt and last_error from the customer's own endpoint. This page said `Read webhook endpoints only.`, which understates the grant: someone minting a least-privilege key to let something list their endpoints was also handing it their delivery log. The marketing api-keys and oauth-apps pages have said `List webhook endpoints + delivery history.` all along, so the canonical reference was the one surface out of step. Derived from the service rather than restated: the gate on listDeliveries is read here, so removing it retires the claim instead of stranding it.", () => {
    const service = readFileSync(
      resolve(REPO_ROOT, 'apps/server/src/services/webhooks.ts'),
      'utf8',
    );
    // The claim rests on listDeliveries being gated by this scope. Assert the
    // gate exists inside that method, not merely somewhere in the file.
    const start = service.indexOf('async listDeliveries(');
    expect(start, 'listDeliveries is still declared in the webhooks service').toBeGreaterThan(-1);
    const body_ = service.slice(start, start + 2000);
    expect(body_, 'listDeliveries is gated on read:webhooks').toMatch(
      /throwIfMissingScope\(ctx, 'read:webhooks'\)/,
    );

    expect(body).toMatch(/`read:webhooks`[^|]*\|[^|]*\|[^|]*delivery history/);
    expect(body).toMatch(/last_response_excerpt/);
    // The understatement must not come back.
    expect(body).not.toMatch(/Read webhook endpoints only/);
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
