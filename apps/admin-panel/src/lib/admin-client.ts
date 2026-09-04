// Shared client-side data layer + formatters for the admin panel.
//
// Phase-0 of the admin-panel redesign (docs/internal/2026-06-02-admin-panel-
// redesign-plan.md). Every page previously re-implemented an inline
// `authedFetch` (bearer from localStorage + PUBLIC_API_BASE_URL +
// credentials:include) plus `escapeHtml` / `fmtIso`. This module is the single
// source of truth so every (re)built page fetches REAL data identically and
// renders consistently — no more per-page drift, no mock placeholders.
//
// Client-side only: uses localStorage + fetch, imported from page <script>s.
// The bearer is the web-session token the app.driftstack.io SSO bridge writes
// to admin.driftstack.io's localStorage (see AdminLayout).

import { resolveApiBaseUrl } from './api-base-url.js';

const SESSION_TOKEN_KEY = 'ds_web_session_token';

/** The admin's web-session bearer (SSO bridge), or null if absent / storage blocked. */
export function adminToken(): string | null {
  try {
    return localStorage.getItem(SESSION_TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * Authed fetch against the admin API: bearer from the SSO-bridge session token,
 * base URL from PUBLIC_API_BASE_URL (prod-fail-fast via resolveApiBaseUrl),
 * credentials included. Faithful replacement for the per-page inline authedFetch.
 */
export function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = adminToken();
  const headers = new Headers(init.headers);
  if (token !== null) headers.set('authorization', 'Bearer ' + token);
  return fetch(resolveApiBaseUrl() + path, { ...init, headers, credentials: 'include' });
}

/** Non-2xx admin API response — carries the status + any RFC-7807 problem body. */
export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail: unknown = null,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

/**
 * adminFetch + JSON parse. Throws AdminApiError on a non-2xx response (using the
 * problem-details `title` when present) so callers have one error path to render.
 */
export async function adminFetchJson<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await adminFetch(path, init);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const title =
      body !== null &&
      typeof body === 'object' &&
      'title' in body &&
      typeof (body as { title: unknown }).title === 'string'
        ? (body as { title: string }).title
        : `Request failed (${res.status.toString()})`;
    throw new AdminApiError(res.status, title, body);
  }
  return body as T;
}

const HTML_ESCAPE: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** XSS-safe escape for values interpolated into innerHTML. Matches the prior per-page escaper. */
export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPE[c] ?? c);
}

/** ISO timestamp → "YYYY-MM-DD HH:MM:SS UTC" (the admin-panel display convention). */
export function fmtIso(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

/** Thousands-separated integer: 12345 → "12,345". Rounds non-integers. */
export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/**
 * Integer cents → currency string: (19900, 'EUR') → "€199.00". All money in the
 * platform is integer cents (see the cost layer), so callers pass cents directly.
 */
export function fmtCents(cents: number, currency = 'EUR'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}
