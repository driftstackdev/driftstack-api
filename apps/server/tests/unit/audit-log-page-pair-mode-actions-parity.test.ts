// Arc 4 Wave 2.B sub-slice 8.20.b (v2-#8) — dashboard audit log
// MUST surface the three pair-mode actions in both ACTION_LABEL
// (label map) and FILTER_OPTIONS (filter dropdown). Otherwise the
// customer sees the raw `agent_session.pair_mode.takeover` action
// key + can't filter to those rows specifically — defeats the
// observability surface added in 8.20.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountAuditActionSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const AUDIT_LOG_PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/audit-log.astro');

const PAIR_MODE_ACTIONS = [
  'agent_session.pair_mode.takeover',
  'agent_session.pair_mode.handback',
  'agent_session.pair_mode.timeout',
  // Slice 6 follow-up 2026-05-20 — Slice 3 /:id/mode handler now
  // emits an audit row too. Treated as part of the same pair-mode-
  // adjacent action family for surface-coverage purposes.
  'agent_session.mode.changed',
] as const;

describe('Arc 4 Wave 2.B sub-slice 8.20.b pair-mode audit log surface parity', () => {
  const body = readFileSync(AUDIT_LOG_PAGE, 'utf8');

  it('every pair-mode action is declared in the AccountAuditActionSchema enum', () => {
    const accepted = new Set(AccountAuditActionSchema.options);
    for (const action of PAIR_MODE_ACTIONS) {
      expect(accepted.has(action), `${action} missing from AccountAuditActionSchema`).toBe(true);
    }
  });

  it('audit-log.astro ACTION_LABEL map covers every pair-mode action', () => {
    for (const action of PAIR_MODE_ACTIONS) {
      const re = new RegExp(`'${action.replace(/\./g, '\\.')}':\\s*'[^']+'`);
      expect(body, `ACTION_LABEL missing entry for ${action}`).toMatch(re);
    }
  });

  it('audit-log.astro FILTER_OPTIONS includes a filter for every pair-mode action', () => {
    for (const action of PAIR_MODE_ACTIONS) {
      const re = new RegExp(`value:\\s*'${action.replace(/\./g, '\\.')}'`);
      expect(body, `FILTER_OPTIONS missing entry for ${action}`).toMatch(re);
    }
  });
});
