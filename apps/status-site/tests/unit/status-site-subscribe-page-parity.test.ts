// W353.B — drift guard for status.driftstack.io /subscribe. The
// page posts to the V-540.B-11 double-opt-in subscribe endpoint.
// Pins:
//
//   • POST /v1/status/subscribe is registered on the server.
//   • Page checks the spec'd response statuses: 202 (queued for
//     confirmation), 400 (invalid email), 429 (rate-limited).
//   • Double-opt-in copy explicitly mentions: confirmation email +
//     one-click unsubscribe + "two emails per incident max" framing.
//   • PUBLIC_API_BASE_URL fallback default (api.driftstack.dev).
//   • Stays a no-framework HTML form (inline script only) so the
//     page renders even when the control plane is degraded.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/status-site/src/pages/subscribe.astro');
const SERVER_SRC = resolve(REPO_ROOT, 'apps/server/src');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function serverRegisters(re: RegExp): boolean {
  function walk(dir: string): boolean {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (walk(p)) return true;
      } else if (e.name.endsWith('.ts')) {
        if (re.test(read(p))) return true;
      }
    }
    return false;
  }
  return walk(SERVER_SRC);
}

describe('W353.B status-site /subscribe parity', () => {
  const body = read(PAGE);

  it('posts to /v1/status/subscribe (registered on the server)', () => {
    expect(body).toMatch(/\/v1\/status\/subscribe/);
    expect(serverRegisters(/['"]\/v1\/status\/subscribe['"]/)).toBe(true);
  });

  it("handles 202 (queued for confirmation) — the spec'd success status", () => {
    // Double-opt-in means the server returns 202 on a queued email,
    // not 200. Pin so a future server flip to 200 forces the page
    // copy to update.
    // Wave 1119 / Slice 1119.3 C1 — the 202 branch now swaps the form
    // for a dedicated confirm pane (see status-site-subscribe-page-
    // content-parity.test.ts for the full pane assertions); the
    // "confirmation email" + "Confirmation email sent" strings still
    // anchor the success surface so a server-side flip would still
    // force a copy review.
    expect(body).toMatch(/res\.status === 202/);
    expect(body).toMatch(/Confirmation email sent to/);
    expect(body).toMatch(/confirmation/i);
  });

  it('handles 400 (invalid email) + 429 (rate-limited) explicitly', () => {
    expect(body).toMatch(/res\.status === 400/);
    expect(body).toMatch(/res\.status === 429/);
    expect(body).toMatch(/Too many subscribe attempts/);
  });

  it('double-opt-in framing claim stays pinned (no unconditional "subscribed!" message)', () => {
    expect(body).toMatch(/Double-opt-in/);
    // The success message MUST hedge — "Check your inbox" not
    // "You're subscribed". Pin both directions.
    expect(body).not.toMatch(/You're now subscribed/i);
    expect(body).not.toMatch(/Successfully subscribed/i);
  });

  it('unsubscribe + frequency claim pinned (one-click unsubscribe; posted / at most hourly while open / resolved — V-768 corrected the false two-email cap)', () => {
    expect(body).toMatch(/[Uu]nsubscribe with one\s*click/);
    expect(body).toMatch(/at most\s*once an hour while it stays open/);
    expect(body).not.toMatch(/emails per incident maximum/i);
  });

  it('no marketing/promotional email claim stays pinned', () => {
    expect(body).toMatch(/never send marketing or promotional/i);
  });

  it('PUBLIC_API_BASE_URL fallback defaults to api.driftstack.dev', () => {
    expect(body).toMatch(/PUBLIC_API_BASE_URL\s*\?\?\s*['"]https:\/\/api\.driftstack\.dev['"]/);
  });

  it('stays a no-framework inline-script page (renders during control-plane outages)', () => {
    // Pin the `is:inline` Astro flag — it inlines the script + lets
    // the page render even when the bundler chain is broken.
    expect(body).toMatch(/<script is:inline/);
    // Negative guard: no SDK import / framework hydration directive.
    expect(body).not.toMatch(/client:load|client:idle|client:visible/);
  });
});
