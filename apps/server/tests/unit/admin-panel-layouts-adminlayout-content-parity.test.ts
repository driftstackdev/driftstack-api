// Drift guard for apps/admin-panel/src/layouts/AdminLayout.astro.
// Pins the V-219 brand + the noindex,nofollow staff-only posture +
// the 11-item nav + the "Staff-only surface. All actions audit-
// logged." footer note.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/layouts/AdminLayout.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('admin-panel layouts/AdminLayout content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('2026-05-29 branded confirm + prompt modals: the [data-ds-confirm] + [data-ds-prompt] overlays + the global window.driftstackConfirm / window.driftstackPrompt helpers are present (admin-side replacement for native confirm/prompt — "no alert boxes"). Drift breaks every admin page that awaits these before a destructive/reason-collecting action', () => {
    expect(body).toMatch(/data-ds-confirm\b/);
    expect(body).toMatch(/data-ds-prompt\b/);
    expect(body).toMatch(/data-ds-prompt-input/);
    expect(body).toMatch(/data-ds-prompt-input aria-label="Response"/);
    expect(body).toMatch(/window\.driftstackConfirm = function \(message, opts\)/);
    expect(body).toMatch(/window\.driftstackPrompt = function \(message, opts\)/);
  });

  it('2026-05-29 modal UX hardening: body scroll-lock while open + backdrop-click-to-dismiss — pinned so the admin modals behave like professional dialogs (no background scroll, click-outside cancels)', () => {
    expect(body).toMatch(/document\.body\.style\.overflow = 'hidden'/);
    expect(body).toMatch(/document\.body\.style\.overflow = ''/);
    expect(body).toMatch(/if \(e\.target === overlay\)/);
  });

  it('a11y focus restore: both modals capture the trigger (document.activeElement) on open and return focus to it on close — pinned so keyboard operators keep their place after a confirm/prompt (WCAG 2.4.3 dialog pattern)', () => {
    expect(body.match(/var prevFocus = document\.activeElement;/g)?.length).toBe(2);
    expect(body.match(/if \(prevFocus && prevFocus\.focus\) prevFocus\.focus\(\);/g)?.length).toBe(
      2,
    );
  });

  it('a11y focus trap: both modals cycle Tab/Shift+Tab within their focusable controls so keyboard focus cannot escape to the page behind the overlay (WCAG 2.4.3 dialog pattern)', () => {
    expect(body.match(/if \(e\.key === 'Tab'\)/g)?.length).toBe(2);
    expect(body).toMatch(/e\.shiftKey && document\.activeElement === f\[0\]/);
  });

  it('Props contract pinned: title (required) + description (optional, defaults to staff-only-tagline). Drift to a different shape would break every admin page', () => {
    expect(body).toMatch(/interface Props \{\s*title: string;\s*description\?: string;\s*\}/);
    expect(body).toMatch(/description = 'Driftstack admin panel — Driftstack staff only\.'/);
  });

  it('noindex,nofollow staff-only posture pinned (CRITICAL): admin panel must NEVER be indexed by search engines. Drift to dropping the noindex would leak admin URLs to search crawlers — a real security/operational issue', () => {
    expect(body).toMatch(/<!-- Admin panel must NEVER be indexed; staff-only surface\. -->/);
    expect(body).toMatch(/<meta name="robots" content="noindex,nofollow" \/>/);
  });

  it('V-219/Fleet brand pinned: L2 mark + W2 wordmark (DRIFTSTACK black-italic two-tone) + "admin" pill (staff-context indicator). Drift to dropping the admin pill would let staff confuse the admin surface with the customer dashboard at a glance', () => {
    expect(body).toContain(
      '<span class="font-sans font-black italic tracking-tight">DRIFT<span class="text-tk-accent">STACK</span></span>',
    );
    expect(body).toMatch(
      /rounded-full bg-tk-accent\/10 px-2 py-0\.5 font-mono text-xs uppercase tracking-wide text-tk-accent/,
    );
    expect(body).toMatch(/admin\s*<\/span>/);
  });

  it("12-item admin nav pinned (Overview / Accounts / Cost / Audit log / Incidents / Status subs / Sessions / Fleet / API keys / Webhook DLQ / Rate limits / Atlas priority). Drift to dropping any would break admin's at-a-glance nav for an operational surface staff use daily", () => {
    expect(body).toMatch(/\{ href: '\/', label: 'Overview' \}/);
    expect(body).toMatch(/\{ href: '\/accounts', label: 'Accounts' \}/);
    expect(body).toMatch(/\{ href: '\/cost', label: 'Cost' \}/);
    expect(body).toMatch(/\{ href: '\/audit-log', label: 'Audit log' \}/);
    expect(body).toMatch(/\{ href: '\/incidents', label: 'Incidents' \}/);
    expect(body).toMatch(/\{ href: '\/status-subscribers', label: 'Status subs' \}/);
    expect(body).toMatch(/\{ href: '\/sessions', label: 'Sessions' \}/);
    expect(body).toMatch(/\{ href: '\/fleet', label: 'Fleet' \}/);
    expect(body).toMatch(/\{ href: '\/api-keys', label: 'API keys' \}/);
    expect(body).toMatch(/\{ href: '\/webhook-dlq', label: 'Webhook DLQ' \}/);
    expect(body).toMatch(/\{ href: '\/rate-limit-overrides', label: 'Rate limits' \}/);
    expect(body).toMatch(/\{ href: '\/atlas-priority-queue', label: 'Atlas priority' \}/);
  });

  it("Title-suffix pattern pinned: '<title> · Driftstack admin' (unconditional, unlike the docs Header which has a homepage special-case). Drift to dropping the suffix would let admin tabs become indistinguishable from customer tabs in browser tab strips", () => {
    expect(body).toMatch(/const fullTitle = `\$\{title\} · Driftstack admin`;/);
  });

  it("Staff-only audit-logged footer note pinned: 'Staff-only surface. All actions audit-logged.' — drift to softening would let staff forget that admin actions are tracked. Pinning this reinforces the slice 122/129/130/133/164 audit-IP work", () => {
    expect(body).toMatch(/<p>Staff-only surface\. All actions audit-logged\.<\/p>/);
  });

  it('isActive() prefix-match pattern: exact OR href + slash. Drift to exact-only would break nav highlighting on every subpage (e.g. /accounts/:id wouldn\'t highlight "Accounts")', () => {
    expect(body).toMatch(/pathname === item\.href \|\| pathname\.startsWith\(item\.href \+ '\/'\)/);
  });
});
