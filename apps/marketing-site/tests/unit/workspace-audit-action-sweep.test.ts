// W277.B — workspace-wide sweep guard for AccountAuditActionSchema
// citations. The audit-log surfaces (customer dashboard /audit-log,
// docs reference, marketing copy) cite specific action names. Pin
// every `"action":` JSON-context token to a real schema member so
// docs don't invent plausible-but-fake audit actions.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountAuditActionSchema } from '@driftstack/api-types';

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
  resolve(REPO_ROOT, 'apps/marketing-site/src/pages'),
  resolve(REPO_ROOT, 'apps/docs/src/pages'),
  resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages'),
];
const allFiles = targets.flatMap((d) => walk(d)).filter((f) => /\.(astro|md)$/.test(f));

const liveActions = new Set(AccountAuditActionSchema.options);

// Only inspect tokens cited as JSON-shape `"action": "<name>"` — the
// canonical AccountAuditEntry envelope shape. Avoids matching
// unrelated dotted identifiers.
const actionRe = /["']action["']\s*:\s*["']([a-z][a-z0-9_]+\.[a-z][a-z0-9_]+)["']/g;

describe('W277.B workspace-wide audit-action sweep', () => {
  it('every cited "action": "<name>" maps to AccountAuditActionSchema', () => {
    const offenders: { file: string; action: string }[] = [];
    for (const f of allFiles) {
      const body = read(f);
      const matches = [...body.matchAll(actionRe)];
      for (const m of matches) {
        const token = m[1]!;
        if (!liveActions.has(token as never)) {
          offenders.push({ file: f.slice(REPO_ROOT.length + 1), action: token });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
