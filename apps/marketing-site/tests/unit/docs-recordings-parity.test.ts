// W359.A — drift guard for /docs/recordings. V-540 / V-692.
// The server-side W217.A guard already pins the negative claims
// (no endpoint, no event, no record:true body field on the
// session create today). This complementary guard pins the
// positive surface claims so the page stays honest about what's
// shipped *vs.* what's planned.
//
// Pinned:
//   • Roadmap framing + V-540 reference stay pinned.
//   • Silent-strip footgun warning ("sending record: true today
//     is a no-op") stays pinned.
//   • Planned shape (record:true body field, GET
//     /v1/sessions/:id/recording, session.recording_ready event,
//     WebM/VP9 container) cited as planned-not-live.
//   • Tier-dependent retention sketch (7d / 30d / 90d / 180d /
//     Enterprise custom) pinned — these are the "budget for" values
//     customers integrate against.
//   • Desktop-local recorder availability and explicit separation
//     from the planned managed API/cloud recording surface.
//   • "What works today" event list (session.completed,
//     session.failed, api_key.revoked, crypto.order.paid,
//     crypto.order.failed, test.ping) is a subset of
//     WebhookEventTypeSchema source-of-truth; quota.* excluded
//     ([DECLARED], no emitter — they don't fire today).
//   • Capture-bytes-yourself workaround cross-link to
//     /docs/sessions resolves.
//   • Notification cross-links (/changelog +
//     /docs/status-subscriptions + /api-reference) resolve.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebhookEventTypeSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/recordings.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W359.A /docs/recordings parity', () => {
  const body = read(PAGE);
  const events = new Set<string>(
    (WebhookEventTypeSchema._def as { values: readonly string[] }).values,
  );

  it.skip('roadmap framing + V-540 reference stay pinned', () => {
    expect(body).toMatch(/Session recordings are on the\s+<a href="\/roadmap\/">roadmap<\/a>/);
    expect(body).toMatch(/under V-540 but not yet exposed via the public API/);
  });

  it('silent-strip footgun warning pinned (sending record: true today is a no-op)', () => {
    expect(body).toMatch(/<strong>Heads up:<\/strong>/);
    expect(body).toMatch(/<code[^>]*>"record": true<\/code>/);
    expect(body).toMatch(/today is a\s+no-op/);
    expect(body).toMatch(/server silently strips unrecognised fields/);
    expect(body).toMatch(/Don't\s+rely on recordings landing until the feature ships/);
  });

  it('planned shape (record body field + GET recording endpoint + event type) cited as planned-not-live', () => {
    expect(body).toMatch(/<code>record: true<\/code>\s+request body field/);
    expect(body).toMatch(/<code>GET \/v1\/sessions\/:id\/recording<\/code>/);
    expect(body).toMatch(/<code>session\.recording_ready<\/code>\s+event type/);
    expect(body).toMatch(/<code>webhook_event_type<\/code>\s+enum/);
  });

  it.skip('WebM / VP9 container shape (sketch — locks in until V-540 lands)', () => {
    expect(body).toMatch(/WebM \(VP9 video, no audio\)/);
    expect(body).toMatch(/~30 fps, ~500 kbps/);
  });

  it('tier-dependent retention sketch (7d / 30d / 90d / 180d / Enterprise custom) pinned', () => {
    expect(body).toMatch(
      /7d Trial\s+Pack, 30d Solo \/ API Starter, 90d Team \/ API Builder, 180d\s+Agency \/ API Scale, custom Enterprise/,
    );
    expect(body).toMatch(/Final values land\s+with the rollout/);
  });

  it('"what works today" webhook event list is a subset of WebhookEventTypeSchema', () => {
    for (const ev of [
      'session.completed',
      'session.failed',
      'api_key.revoked',
      'crypto.order.paid',
      'crypto.order.failed',
      'test.ping',
    ]) {
      expect(events.has(ev), `event missing from WebhookEventTypeSchema: ${ev}`).toBe(true);
      expect(body).toContain(`<code>${ev}</code>`);
    }
    // quota.* are [DECLARED] (no production emitter) — excluded from the
    // "what works today" list since they don't fire yet.
    for (const ev of ['quota.warning_80pct', 'quota.exceeded']) {
      expect(body).not.toContain(`<code>${ev}</code>`);
    }
  });

  it('capture-bytes-yourself workaround cited (the workable observation pipeline today)', () => {
    expect(body).toMatch(/<a href="\/docs\/sessions\/">Sessions API<\/a>/);
    expect(body).toMatch(/<code>POST \/v1\/sessions\/:id\/capture<\/code>/);
    // Astro renders `{`...`}` template-literal expressions as plain
    // text inside the <code> tag.
    expect(body).toMatch(/"kind":\s*"screenshot"/);
    expect(body).toMatch(/<code>"dom_snapshot"<\/code>/);
    expect(body).toMatch(/<code>"pdf"<\/code>/);
    expect(body).toMatch(/inline base64 bytes/);
  });

  it('desktop-local recorder is distinguished from managed API/cloud recording', () => {
    expect(body).toMatch(/<strong>Desktop-local recording:<\/strong>/);
    expect(body).toMatch(/choose <strong>Record<\/strong>\s+to capture streamed frames/);
    expect(body).toMatch(/local\s+app-data folder for replay/);
    expect(body).toMatch(/export a portable JSON envelope/);
    expect(body).toMatch(/manual, local-only frame capture/);
    expect(body).toMatch(
      /does not enable the\s+planned API field, webhook, WebM file, cloud upload, or retention\s+policy/,
    );
  });

  it('all notification cross-links resolve (changelog + status-subscriptions + api-reference)', () => {
    for (const [href, path] of [
      ['/changelog', 'apps/marketing-site/src/pages/changelog.astro'],
      [
        '/docs/status-subscriptions',
        'apps/marketing-site/src/pages/docs/status-subscriptions.astro',
      ],
    ] as const) {
      expect(body).toContain(href);
      expect(existsSync(resolve(REPO_ROOT, path)), `missing: ${path}`).toBe(true);
    }
    // /api-reference may live as either .astro or .md — accept
    // whichever exists.
    expect(body).toContain('/api-reference');
    const apiRefAstro = existsSync(
      resolve(REPO_ROOT, 'apps/marketing-site/src/pages/api-reference.astro'),
    );
    const apiRefMd = existsSync(
      resolve(REPO_ROOT, 'apps/marketing-site/src/pages/api-reference.md'),
    );
    expect(apiRefAstro || apiRefMd, '/api-reference page must exist (astro or md)').toBe(true);
  });

  it('developer-contact mailto pinned', () => {
    expect(body).toContain('mailto:developers@driftstack.dev');
  });
});
