// Arc 4 Wave 2.B sub-slice 8.20.c (v2-#8) — docs action-catalog drift guard.
//
// Pins apps/docs/src/pages/api/audit-log.md's "Action catalog" table
// against AccountAuditActionSchema so any new action added to the
// enum without a corresponding docs row breaks CI. Otherwise the
// docs page silently lags behind the wire surface and customers
// can't discover new audit events.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountAuditActionSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOCS_AUDIT_PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/audit-log.md');

describe('Arc 4 Wave 2.B sub-slice 8.20.c docs audit-log action catalog completeness', () => {
  const body = readFileSync(DOCS_AUDIT_PAGE, 'utf8');

  it('every AccountAuditAction enum value has a row in the docs action catalog', () => {
    for (const action of AccountAuditActionSchema.options) {
      const re = new RegExp(`\\|\\s*\`${action.replace(/\./g, '\\.')}\``);
      expect(
        body,
        `docs audit-log.md is missing a catalog row for ${action} — add a row to the "Action catalog" table.`,
      ).toMatch(re);
    }
  });

  it('every action row in the docs page maps to a known enum value (catches stale rows)', () => {
    const accepted = new Set<string>(AccountAuditActionSchema.options);
    // Match every backtick-quoted action token in column 1 of the
    // catalog table. The regex anchors on a leading `|` (table cell
    // boundary) so prose mentions don't trip the guard.
    const tokens = new Set<string>(
      Array.from(body.matchAll(/\|\s*`([a-z_]+(?:\.[a-z_]+)+)`/g), (m) => m[1] as string),
    );
    for (const t of tokens) {
      expect(accepted.has(t), `docs audit-log.md references unknown action ${t}`).toBe(true);
    }
  });
});
