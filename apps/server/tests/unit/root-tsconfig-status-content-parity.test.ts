// W623 — drift guard for root tsconfig.json + status.md (2 files).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

describe('W623 root tsconfig.json + status.md content parity', () => {
  it('tsconfig.json: composite-project files=[] + 8 references (apps/server + 7 packages including api-types + behavioural-simulation + recapture-automation + recipe-library + sdk-typescript + webhook-delivery + webrtc-streaming) pinned', () => {
    const body = read('tsconfig.json');
    expect(body).toMatch(/"files": \[\]/);
    expect(body).toMatch(/"references": \[/);
    expect(body).toMatch(/\{ "path": "\.\/apps\/server" \}/);
    expect(body).toMatch(/\{ "path": "\.\/packages\/api-types" \}/);
    expect(body).toMatch(/\{ "path": "\.\/packages\/behavioural-simulation" \}/);
    expect(body).toMatch(/\{ "path": "\.\/packages\/recapture-automation" \}/);
    expect(body).toMatch(/\{ "path": "\.\/packages\/recipe-library" \}/);
    expect(body).toMatch(/\{ "path": "\.\/packages\/sdk-typescript" \}/);
    expect(body).toMatch(/\{ "path": "\.\/packages\/webhook-delivery" \}/);
    expect(body).toMatch(/\{ "path": "\.\/packages\/webrtc-streaming" \}/);
    expect(existsSync(resolve(REPO_ROOT, 'tsconfig.json'))).toBe(true);
  });

  it('status.md: Driftstack API current-status doc + Last-updated 2026-05-11 + Wave 42 V-530.E multi-touch CLOSED + Autopilot active + 25-substantive-V-NNN-slices-overnight + Phase-3 closed series (V-530 A-E + V-532 A-D + V-533 A-C) + V-540.B 12 E2E specs + 6-customer-URL TLS 1.3 Full-strict mode + 1565/1565 tests green at cdfa176 + V-205/V-211/V-455/V-278 persistent rules + Postmark approval awaiting (2026-05-09 submission) pinned', () => {
    const body = read('status.md');
    expect(body).toMatch(/^# Driftstack API — current status$/m);
    expect(body).toMatch(/\*\*Last updated:\*\* 2026-05-11/);
    expect(body).toMatch(
      /\*\*Most recent wave:\*\* Wave 42 \(V-530\.E multi-touch gestures; V-530 series CLOSED\)/,
    );
    expect(body).toMatch(/\*\*Mode:\*\* Autopilot active\./);
    expect(body).toMatch(/^## W26-W42 — overnight rollup$/m);
    expect(body).toMatch(/\*\*25 substantive V-NNN slices\*\*/);
    expect(body).toMatch(/V-655 \(V-NNN customer-surface scrub of 44 files\) is staged/);
    expect(body).toMatch(/Phase-3 series CLOSED this window:/);
    expect(body).toMatch(/\*\*V-530\*\* \(behavioural-simulation\) — A \+ B \+ C \+ D \+ E\./);
    expect(body).toMatch(/\*\*V-532\*\* \(recipe-library\) — A \+ B \+ C \+ D\./);
    expect(body).toMatch(/\*\*V-533\*\* \(recapture-automation\) — A \+ B \+ C/);
    expect(body).toMatch(/V-540\.B \(E2E coverage\) shipped 12 specs/);
    expect(body).toMatch(/Tests: \*\*1565\/1565 green across 139 test files\*\*/);
    expect(body).toMatch(/^## What's live right now$/m);
    expect(body).toMatch(
      /All 6 customer-facing URLs HTTP 200 with TLS 1\.3 end-to-end \(Cloudflare/,
    );
    expect(body).toMatch(/Full strict mode\):/);
    expect(body).toMatch(/^- https:\/\/driftstack\.io\/ — marketing site \(Cloudflare Pages\)$/m);
    expect(body).toMatch(/^- https:\/\/docs\.driftstack\.io\/ — docs site \(Cloudflare Pages\)$/m);
    expect(body).toMatch(
      /^- https:\/\/app\.driftstack\.io\/ — customer dashboard \(Cloudflare Pages\)$/m,
    );
    expect(body).toMatch(
      /^- https:\/\/api\.driftstack\.dev\/health — Fastify control plane \(Hetzner production\)$/m,
    );
    expect(body).toMatch(
      /^- https:\/\/staging\.driftstack\.dev\/health — staging mirror \(Hetzner staging\)$/m,
    );
    expect(body).toMatch(/^## Persistent rules holding$/m);
    expect(body).toMatch(/\*\*V-205 attribution\.\*\*/);
    expect(body).toMatch(/`Driftstack <dev@driftstack\.dev>` author on every/);
    expect(body).toMatch(/\*\*V-211 anonymity\.\*\*/);
    expect(body).toMatch(/\*\*V-455 audit\*\* — fully closed/);
    expect(body).toMatch(
      /\*\*V-278 LIVE\*\* — `https:\/\/api\.driftstack\.dev\/health` returns 200/,
    );
    expect(body).toMatch(/^## Awaiting external input$/m);
    expect(body).toMatch(
      /\*\*Postmark account approval\*\* — submitted 2026-05-09 via postmarkapp\.com\/help\./,
    );
    expect(body).toMatch(/\*\*F-003\*\* OAuth — pending Client IDs \+ secrets/);
    expect(body).toMatch(/\*\*V-528 GitHub-private flip\*\* — runbook lands W17/);
    expect(body).toMatch(/\*\*V-205 history scrub\*\* — gated on V-528 privatization/);
    expect(body).toMatch(/^## Reference docs$/m);
    expect(existsSync(resolve(REPO_ROOT, 'status.md'))).toBe(true);
  });
});
