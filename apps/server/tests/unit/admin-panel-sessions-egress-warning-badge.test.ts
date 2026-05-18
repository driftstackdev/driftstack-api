// Arc 5 EGRESS eg.5.c — admin-panel proxy-warning badge drift guard.
// Same surface as the customer-dashboard eg.5/5.b badge but on the
// admin operator surface where support staff inspect cross-account
// sessions for incident tickets.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/sessions.astro');

describe('Arc 5 EGRESS eg.5.c admin-panel sessions proxy-warning badge', () => {
  const body = readFileSync(PAGE, 'utf8');

  it('admin row defensively reads egress_capabilities.warnings', () => {
    expect(body).toMatch(
      /s\.egress_capabilities && Array\.isArray\(s\.egress_capabilities\.warnings\)/,
    );
  });

  it('admin badge has amber bg + amber-700 text (matches customer dashboard severity cue, slightly darker for the admin light theme)', () => {
    expect(body).toMatch(/bg-amber-500\/10/);
    expect(body).toMatch(/text-amber-700/);
    expect(body).toMatch(/⚠ proxy /);
  });

  it('badge inserts inside the status table cell — admin sessions list is a tabular layout, not the customer dashboard ul/li', () => {
    // Same status-pill close + IIFE that returns the badge HTML.
    expect(body).toMatch(/escapeHtml\(s\.status\) \+[\s\S]+?'<\/span>' \+/);
  });

  it('badge title attribute carries the full warnings list with escapeHtml escaping', () => {
    expect(body).toMatch(/title="' \+\s*escapeHtml\(w\.join\(', '\)\)/);
  });
});
