// W279.B — workspace-wide sweep guard for SessionStatusSchema.
// Docs cite session status values in JSON examples + state-machine
// diagrams. Pin every `"status":` JSON-context token to a real
// schema member when it appears in a session-context page.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStatusSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const targets = [
  resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs'),
  resolve(REPO_ROOT, 'apps/docs/src/pages'),
];
const allFiles = targets.flatMap((d) => walk(d)).filter((f) => /\.(astro|md)$/.test(f));

const liveStatuses = new Set(SessionStatusSchema.options);

// Session-context: file path or body mentions "session" prominently
// (excluding crypto + webhook + subscription pages which also use a
// status enum).
const sessionContextFiles = allFiles.filter((f) => {
  if (/(archetype|crypto|webhook|subscription|billing|order)/i.test(f)) return false;
  if (!/sessions?\b/i.test(f)) {
    // Fall back to body match — file mentions "session" + "status".
    const body = read(f);
    return /session/i.test(body) && /\bstatus\b/i.test(body);
  }
  return true;
});

const statusRe = /["']status["']\s*:\s*["']([a-z][a-z_-]+)["']/g;

// Statuses that are valid in adjacent docs domains but not session.
const ALLOWED_NON_SESSION_STATUS = new Set([
  // S33 2026-07-07 (fable-truth-audit) — the agent-session harness
  // sub-resources (cookies/history/files/downloads: harness-control-
  // protocol discriminated responses) and profile trim (TrimResult)
  // cite their own status vocabulary in docs examples; every value is
  // schema-traced, not a session status.
  'ok',
  'unavailable',
  'timeout',
  'error',
  'resume_requested',
  'delivered',
  'failed',
  'failed_permanently',
  'replayed',
  'dlq',
  'received',
  'pending',
  'paid',
  'confirming',
  'partial',
  'cancelled',
  'active',
  'open',
  'closed',
  'past_due',
  'trialing',
  'unpaid',
  // System / incident status enums on the /api/status endpoint
  // documentation. Component-level health ("operational" /
  // "monitoring" / "investigating" / "identified" / "resolved")
  // is a separate schema from SessionStatusSchema.
  'operational',
  'monitoring',
  'investigating',
  'identified',
  'resolved',
  // W393 — the POST /v1/agent-sessions/:id/resume endpoint's response
  // acknowledgement field ({"status":"resume_requested"}); an ack value,
  // NOT a session lifecycle status (SessionStatusSchema).
  'resume_requested',
]);

describe('W279.B workspace-wide session-status sweep', () => {
  it('every cited "status": <value> in a session-context doc is real', () => {
    const offenders: { file: string; status: string }[] = [];
    for (const f of sessionContextFiles) {
      const body = read(f);
      const matches = [...body.matchAll(statusRe)];
      for (const m of matches) {
        const token = m[1]!;
        if (ALLOWED_NON_SESSION_STATUS.has(token)) continue;
        if (!liveStatuses.has(token as never)) {
          offenders.push({ file: f.slice(REPO_ROOT.length + 1), status: token });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
