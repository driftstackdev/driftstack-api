// Drift guard for apps/customer-dashboard/src/pages/proxies.astro.
// Customer-facing /proxies page (saved-config library). 2026-06-17 — migrated
// off the dead /v1/proxies saved-proxies stub (which 503'd "not yet shipped")
// onto the LIVE account-proxies API (/v1/account/me/proxies), the same backend
// the desktop app uses. Drift here either breaks that wiring or drops the
// write-only-secret framing.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/proxies.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('apps/customer-dashboard/src/pages/proxies.astro content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('source comment documents the LIVE account-proxies API migration (no stale /v1/proxies stub framing)', () => {
    expect(body).toMatch(/account-proxies API \(\/v1\/account\/me\/proxies/);
    expect(body).toMatch(/the same backend the desktop app uses/i);
    // The old EG-API-1.5 "503 not yet wired" activation-gate framing is gone.
    expect(body).not.toMatch(/POST 503s and the customer sees/);
  });

  it('resolveApiBaseUrl wired — no hardcoded prod URL (W192 single-source-of-truth pattern)', () => {
    expect(body).toMatch(/import \{ resolveApiBaseUrl \} from '\.\.\/lib\/api-base-url';/);
    expect(body).toMatch(/const apiBaseUrl = resolveApiBaseUrl\(\);/);
    expect(body).not.toMatch(/'https:\/\/api\.driftstack\.dev'/);
  });

  it('SOCKS5 create form: label + host + port + username/password optional inputs (the inert UDP checkbox is gone — the live API has no udp_associate field)', () => {
    expect(body).toMatch(/<input\s+id="proxy-label"[^>]*maxlength="120"/);
    expect(body).toMatch(/<input\s+id="proxy-host"[^>]*maxlength="253"/);
    expect(body).toMatch(/<input\s+id="proxy-port"[^>]*type="number"[^>]*min="1"[^>]*max="65535"/);
    expect(body).toMatch(
      /<input\s+id="proxy-password"[^>]*type="password"[^>]*autocomplete="new-password"/,
    );
    expect(body).not.toMatch(/id="proxy-udp"/);
  });

  it('save-proxy handler POSTs to /v1/account/me/proxies with the flat AccountProxyInput body { label, scheme:"socks5", host, port, username, password }', () => {
    expect(body).toMatch(/fetch\(apiBaseUrl \+ '\/v1\/account\/me\/proxies'/);
    expect(body).toMatch(/method: 'POST'/);
    expect(body).toMatch(/scheme: 'socks5',/);
    // password is write-only — sent as `password || null`, never re-read.
    expect(body).toMatch(/password: password \|\| null,/);
    // The dead /v1/proxies stub path + its 503 activation-gate handling are gone.
    expect(body).not.toMatch(/fetch\(apiBaseUrl \+ '\/v1\/proxies'/);
    expect(body).not.toMatch(/res\.status === 503/);
  });

  it('list fetch wires GET /v1/account/me/proxies with the web-session-token Bearer + renders the scheme/host:port row + empty state', () => {
    expect(body).toMatch(/await fetch\(apiBaseUrl \+ '\/v1\/account\/me\/proxies'/);
    expect(body).toMatch(/'No saved proxies yet\.'/);
    // Row renders the live metadata shape (scheme + host:port + secret marker).
    expect(body).toMatch(/escapeHtml\(p\.scheme\)/);
    expect(body).toMatch(/escapeHtml\(p\.host\)/);
    expect(body).toMatch(/p\.has_secret \? ' · 🔒 config'/);
  });

  it('delete handler wires DELETE /v1/account/me/proxies/<id> via delegated click + branded driftstackConfirm guard', () => {
    expect(body).toMatch(/method: 'DELETE'/);
    expect(body).toMatch(/'\/v1\/account\/me\/proxies\/' \+ encodeURIComponent\(id\)/);
    expect(body).toMatch(/window\.driftstackConfirm\('Delete this saved proxy\?'/);
  });

  it('test handler POSTs /v1/account/me/proxies/<id>/test and reads the server-side probe result { ok, latency_ms } | { ok:false, reason }', () => {
    expect(body).toMatch(/'\/v1\/account\/me\/proxies\/' \+ encodeURIComponent\(tid\) \+ '\/test'/);
    expect(body).toMatch(/res\.ok && b\.ok/);
    expect(body).toMatch(/b\.latency_ms/);
    expect(body).toMatch(/b\.reason/);
  });

  it('UDP-ASSOCIATE rationale copy retained as form guidance (not a stylistic note) — pins the WebRTC reason so a copy-edit does not lose the signal', () => {
    expect(body).toMatch(/UDP ASSOCIATE/);
    expect(body).toMatch(/WebRTC/);
  });

  it('Phase 2 OpenVPN + Phase 3 WireGuard egress-backend roadmap cards pinned', () => {
    expect(body).toMatch(/Phase 2[\s\S]*?OpenVPN/);
    expect(body).toMatch(/Phase 3[\s\S]*?WireGuard/);
    expect(body).toMatch(/Apple\s+Virtualization\.framework Lightweight VM/);
  });

  it('founder-priority OpenVPN form: label + .ovpn textarea (256KB) + optional creds + save button; posts the flat scheme:"openvpn" body with host/port parsed from the remote directive; 400-handler keeps the directive-rejection hint', () => {
    expect(body).toMatch(/<section[^>]*data-create-openvpn-form/);
    expect(body).toMatch(/<input\s+id="ovpn-label"[^>]*maxlength="120"/);
    expect(body).toMatch(/<textarea\s+id="ovpn-blob"[^>]*maxlength="262144"/);
    expect(body).toMatch(
      /<input\s+id="ovpn-password"[^>]*type="password"[^>]*autocomplete="new-password"/,
    );
    expect(body).toMatch(/data-action="save-openvpn"/);
    expect(body).toMatch(/scheme: 'openvpn',/);
    expect(body).toMatch(/config_blob: blob/);
    // host/port extracted from the `remote <host> <port>` directive client-side.
    expect(body).toContain('const remoteMatch =');
    expect(body).toContain('host: ovpnHost,');
    expect(body).toContain('port: ovpnPort,');
    expect(body).toMatch(/`client`\s+and\s+`remote <host> <port>` directives/);
    expect(body).toMatch(/res\.status === 400/);
  });
});
