// Cross-source invariant: webhook-rotation-reminder + byok-anthropic-
// rotation-reminder MUST share the same 3-constant set (60-day threshold
// + 7-day cooldown + 90-day rotation target). They're parallel features
// covering different secret classes; drift would create inconsistent
// customer experience ("why does my BYOK reminder fire at day 30 but my
// webhook reminder fires at day 60?").

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const WEBHOOK = resolve(REPO_ROOT, 'apps/server/src/services/webhook-rotation-reminder.ts');
const BYOK = resolve(REPO_ROOT, 'apps/server/src/services/byok-anthropic-rotation-reminder.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function extractConst(src: string, name: string): number | null {
  const m = src.match(new RegExp(`const ${name} = (\\d+);`));
  return m ? Number(m[1]) : null;
}

describe('rotation-reminder cross-source invariant (webhook + byok-anthropic share constants)', () => {
  const webhookSrc = read(WEBHOOK);
  const byokSrc = read(BYOK);

  it('REMINDER_THRESHOLD_DAYS matches across webhook + byok-anthropic services', () => {
    const w = extractConst(webhookSrc, 'REMINDER_THRESHOLD_DAYS');
    const b = extractConst(byokSrc, 'REMINDER_THRESHOLD_DAYS');
    expect(w).not.toBeNull();
    expect(b).not.toBeNull();
    expect(w).toBe(b);
    expect(w).toBe(60); // pin the canonical value too
  });

  it('COOLDOWN_DAYS matches across webhook + byok-anthropic services', () => {
    const w = extractConst(webhookSrc, 'COOLDOWN_DAYS');
    const b = extractConst(byokSrc, 'COOLDOWN_DAYS');
    expect(w).not.toBeNull();
    expect(b).not.toBeNull();
    expect(w).toBe(b);
    expect(w).toBe(7);
  });

  it('ROTATION_TARGET_DAYS matches across webhook + byok-anthropic services', () => {
    const w = extractConst(webhookSrc, 'ROTATION_TARGET_DAYS');
    const b = extractConst(byokSrc, 'ROTATION_TARGET_DAYS');
    expect(w).not.toBeNull();
    expect(b).not.toBeNull();
    expect(w).toBe(b);
    expect(w).toBe(90);
  });

  it('MS_PER_DAY matches across webhook + byok-anthropic services', () => {
    expect(webhookSrc).toMatch(/const MS_PER_DAY = 24 \* 60 \* 60 \* 1000;/);
    expect(byokSrc).toMatch(/const MS_PER_DAY = 24 \* 60 \* 60 \* 1000;/);
  });

  it("byok-anthropic-rotation-reminder header explicitly cross-references the webhook pattern: 'Mirrors v2-#10.5 (webhook secret rotation reminder) for the per-account BYOK Anthropic API key.' — pinned so the parallel-feature relationship stays documented (drift on one without the other would orphan this cross-reference)", () => {
    expect(byokSrc).toMatch(
      /\/\/ Mirrors v2-#10\.5 \(webhook secret rotation reminder\) for the\s*\/\/ per-account BYOK Anthropic API key\./,
    );
  });
});
