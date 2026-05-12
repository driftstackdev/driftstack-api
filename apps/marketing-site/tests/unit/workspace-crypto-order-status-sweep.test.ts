// W278.B — workspace-wide sweep guard for CryptoOrderStatusSchema.
// Customer-facing docs cite specific status values in JSON examples
// and status-machine diagrams. Pin every `"status":` JSON token to
// a real schema member so we don't invent fictional states like
// `confirmed` or `expired`.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CryptoOrderStatusSchema } from '@driftstack/api-types';

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

const liveStatuses = new Set(CryptoOrderStatusSchema.options);

// Only inspect crypto-order context: pages with "crypto" in path or
// crypto-order shorthand in body.
const cryptoContextFiles = allFiles.filter((f) => {
  if (/crypto/i.test(f)) return true;
  const body = read(f);
  return /\bord_<|ord_[a-z0-9]+/.test(body);
});

// Status tokens cited in JSON-shape `"status": "<value>"`.
const statusRe = /["']status["']\s*:\s*["']([a-z][a-z_-]+)["']/g;

// Other status-like enums that may legitimately appear in
// crypto-order docs (HTTP status, webhook delivery status, etc.).
const ALLOWED_NON_CRYPTO_STATUS = new Set([
  'pending', // overlap with crypto
  'failed', // overlap
  'paid', // crypto
  'partial', // crypto
  'confirming', // crypto
  'cancelled', // crypto
  'delivered',
  'replayed',
  'received',
  'failed_permanently',
  'dlq',
  'active', // subscription
  'past_due',
  'canceled',
  'incomplete',
  'trialing',
  'unpaid',
  'creating', // session
  'ready',
  'busy',
  'destroyed',
  'errored',
  'open', // billing
  'closed',
]);

describe('W278.B workspace-wide crypto-order status sweep', () => {
  it('every cited "status": <value> in a crypto-order doc context is real', () => {
    const offenders: { file: string; status: string }[] = [];
    for (const f of cryptoContextFiles) {
      const body = read(f);
      const matches = [...body.matchAll(statusRe)];
      for (const m of matches) {
        const token = m[1]!;
        if (ALLOWED_NON_CRYPTO_STATUS.has(token)) continue;
        if (!liveStatuses.has(token as never)) {
          offenders.push({ file: f.slice(REPO_ROOT.length + 1), status: token });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
