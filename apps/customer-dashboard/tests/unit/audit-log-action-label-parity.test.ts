// W339.A — drift guard for the /audit-log page action-label
// taxonomy. Three things must stay in sync with the server-side
// AccountAuditActionSchema enum:
//
//   1. ACTION_LABEL map keys — every action the server can emit
//      must have a customer-facing label, otherwise the page
//      renders the raw slug.
//   2. FILTER_OPTIONS list — every filter option value must be a
//      valid AccountAuditAction, otherwise selecting the filter
//      issues an ?action= query the server rejects.
//   3. Neither side cites an action that isn't in the schema —
//      catches typo'd / renamed slugs.
//
// V-480 added profile.exported + profile.imported to the schema;
// this test pins the dashboard to keep up.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountAuditActionSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/audit-log.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W339.A /audit-log action-label parity with AccountAuditActionSchema', () => {
  const page = read(PAGE);
  const schemaActions = new Set<string>(
    (AccountAuditActionSchema._def as { values: readonly string[] }).values,
  );

  // ACTION_LABEL is a Record<string, string> declared inline near
  // the top of the page. Grab its key set. Keys can have any number
  // of dot-separated segments (e.g. `agent_session.pair_mode.takeover`).
  const labelKeys = new Set<string>(
    [...page.matchAll(/^\s*'([a-z_]+(?:\.[a-z_]+)+)':\s*'[^']+',/gm)].map((m) => m[1]!),
  );

  // FILTER_OPTIONS is a const array of { value, label } literals.
  // The value field is what we care about.
  const filterValues = new Set<string>(
    [...page.matchAll(/\{\s*value:\s*'([a-z_]+(?:\.[a-z_]+)+)',/g)].map((m) => m[1]!),
  );

  it('every action in AccountAuditActionSchema has an ACTION_LABEL entry', () => {
    const missing = [...schemaActions].filter((a) => !labelKeys.has(a));
    expect(missing).toEqual([]);
  });

  it('every action in AccountAuditActionSchema is filterable from the dropdown', () => {
    const missing = [...schemaActions].filter((a) => !filterValues.has(a));
    expect(missing).toEqual([]);
  });

  it('no ACTION_LABEL key is missing from AccountAuditActionSchema (catches typos)', () => {
    const offenders = [...labelKeys].filter((a) => !schemaActions.has(a));
    expect(offenders).toEqual([]);
  });

  it('no FILTER_OPTIONS value is missing from AccountAuditActionSchema (catches typos)', () => {
    const offenders = [...filterValues].filter((a) => !schemaActions.has(a));
    expect(offenders).toEqual([]);
  });

  it('FILTER_OPTIONS opens with an "All events" empty-string option for clearing', () => {
    expect(page).toMatch(/\{\s*value:\s*'',\s*label:\s*'All events'\s*\}/);
  });

  it('AccountAuditActionSchema is non-trivially large (catches accidental enum truncation)', () => {
    // The schema today has 27 actions. If something drops below
    // 20, somebody likely truncated the enum by mistake.
    expect(schemaActions.size).toBeGreaterThanOrEqual(20);
  });
});
