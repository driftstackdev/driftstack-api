// Arc 5 EGRESS eg.5 (v2-#3) — drift guard for the proxy-warning
// badge rendering on the customer dashboard's active-sessions row.
//
// The badge surfaces when the harness-reported
// egress_capabilities.warnings is non-empty so the customer sees
// proxy-health issues (udp_unsupported_by_proxy,
// dns_remote_resolve_unsupported_by_proxy, etc.) at a glance —
// no detail-panel open required.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/sessions.astro');

describe('Arc 5 EGRESS eg.5 dashboard sessions proxy-warning badge', () => {
  const body = readFileSync(PAGE, 'utf8');

  it('activeLi() reads egress_capabilities.warnings defensively', () => {
    expect(body).toMatch(
      /s\.egress_capabilities && Array\.isArray\(s\.egress_capabilities\.warnings\)/,
    );
  });

  it('warning badge renders only when warnings.length > 0', () => {
    expect(body).toMatch(/warnings\.length > 0/);
  });

  it('warning badge has amber color + ⚠ glyph (customer-visible severity cue)', () => {
    expect(body).toMatch(/bg-amber-500\/10/);
    expect(body).toMatch(/text-amber-400/);
    expect(body).toMatch(/⚠ proxy /);
  });

  it('warning badge title attribute carries the full warnings list (escaped hover tooltip)', () => {
    expect(body).toMatch(/title="' \+\s*escapeHtml\(warnings\.join\(', '\)\)/);
  });

  it('badge inserts after the status pill (semantic ordering — status first, capability-warning second)', () => {
    expect(body).toMatch(
      /escapeHtml\(s\.status\) \+[\s\S]+?'<\/span>' \+[\s\S]+?warningBadge \+[\s\S]+?'<\/div>'/,
    );
  });
});
