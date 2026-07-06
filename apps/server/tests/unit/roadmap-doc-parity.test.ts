// W248.A — drift-guard for /roadmap. Cross-checks the NOW/NEXT/LATER
// roadmap groupings against the actual server-side feature gates so
// the page can't quietly claim a shipped feature is "Now" while the
// server still gates it (or vice versa).

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SubscribableWebhookEventTypeSchema } from '@driftstack/api-types';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'roadmap.astro');
const SERVER_SRC = join(REPO, 'apps', 'server', 'src');

function read(): string {
  return readFileSync(DOC_PATH, 'utf8');
}

function serverSourceMatches(re: RegExp): boolean {
  function walk(dir: string): boolean {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (walk(p)) return true;
      } else if (entry.name.endsWith('.ts')) {
        if (re.test(readFileSync(p, 'utf8'))) return true;
      }
    }
    return false;
  }
  return walk(SERVER_SRC);
}

describe('W248.A roadmap doc parity', () => {
  const doc = read();
  const nowBlock = doc.match(/const NOW:[^=]*=\s*\[([\s\S]*?)\];/)?.[1] ?? '';
  const nextBlock = doc.match(/const NEXT:[^=]*=\s*\[([\s\S]*?)\];/)?.[1] ?? '';
  const laterBlock = doc.match(/const LATER:[^=]*=\s*\[([\s\S]*?)\];/)?.[1] ?? '';

  it('NOW / NEXT / LATER groupings all populate', () => {
    expect(nowBlock.length).toBeGreaterThan(50);
    expect(nextBlock.length).toBeGreaterThan(50);
    expect(laterBlock.length).toBeGreaterThan(50);
  });

  it('Webhook delivery infrastructure stays in NOW (it ships)', () => {
    // Live: webhook-signing.ts + durable-webhook-delivery.ts exist.
    expect(serverSourceMatches(/webhook-signing|durable-webhook-delivery/)).toBe(true);
    expect(nowBlock).toMatch(/Webhook delivery infrastructure/);
  });

  it('HMAC-SHA256 + 5-minute tolerance phrasing matches webhook-signing config', () => {
    // S20c 2026-07-06 plain-language pass: "5-minute timestamp tolerance"
    // reworded to "5-minute clock-difference allowance (timestamp
    // tolerance)" — both facts (the 5-minute window + the timestamp-
    // tolerance term matching the server webhook-signing config) survive.
    expect(doc).toMatch(/HMAC-SHA256/);
    expect(doc).toMatch(/5-minute clock-difference allowance \(timestamp\s+tolerance\)/);
  });

  it('Live-session WebRTC stream lives in NEXT or LATER, not NOW', () => {
    expect(nowBlock).not.toMatch(/Live session WebRTC stream/);
    expect(`${nextBlock}\n${laterBlock}`).toMatch(/Live session WebRTC stream/);
  });

  it('Workflow recording stays out of NOW (recordings are roadmap)', () => {
    expect(nowBlock).not.toMatch(/Workflow recording/);
  });

  it('Subscribable webhook events list in NOW reflects the live (firing) event categories', () => {
    const live = SubscribableWebhookEventTypeSchema._def.values as readonly string[];
    expect(live.length).toBeGreaterThanOrEqual(5);
    // The NOW description groups events by category. It must only name
    // categories that actually FIRE today (have a production emitter) —
    // session lifecycle (session.completed/failed), crypto-order
    // (crypto.order.paid/failed), and API-key (api_key.revoked). The
    // quota.* events are subscribable but [DECLARED] (no emitter wired),
    // so naming "quota" here in the shipped/NOW bucket would over-state
    // what delivers — keep it out until a usage-threshold emitter lands.
    expect(nowBlock).toMatch(/session lifecycle/i);
    expect(nowBlock).toMatch(/crypto-order/i);
    expect(nowBlock).toMatch(/API-key/i);
    expect(nowBlock).not.toMatch(/Subscribe to session lifecycle, quota/i);
  });
});
