import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = readFileSync(
  resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/team/accept.astro'),
  'utf8',
);

describe('team invitation acceptance reliability', () => {
  it('bounds the single-use acceptance request and clears its timer', () => {
    expect(PAGE).toContain('const ACCEPT_TIMEOUT_MS = 15_000;');
    expect(PAGE).toContain('const controller = new AbortController();');
    expect(PAGE).toContain('window.setTimeout(() => controller.abort(), ACCEPT_TIMEOUT_MS)');
    expect(PAGE).toContain('signal: controller.signal');
    expect(PAGE).toContain('.finally(() => window.clearTimeout(timeout))');
    expect(PAGE).toContain("err && err.name === 'AbortError'");
    expect(PAGE).toContain('The request took too long, so you may already be on the team.');
    expect(PAGE).toContain("Don't use this link again — open Team to check.");
    expect(PAGE).toContain("If you don't have access, ask the team owner for a new invite.");
    expect(PAGE).toContain('Open Team to check access');
    expect(PAGE).toContain('ask the team owner for a new invite');
  });

  it('treats 2xx as terminal authority without parsing a replay-producing body', () => {
    expect(PAGE).toContain('let acceptResponseAccepted = false;');
    expect(PAGE).toMatch(/if \(r\.ok\) \{\s*acceptResponseAccepted = true;\s*return;\s*\}/);
    expect(PAGE).toMatch(/if \(acceptResponseAccepted\) \{/);
    expect(PAGE).toContain("You're on the team, but this page couldn't open it.");
    expect(PAGE).not.toMatch(/if \(r\.ok\) return r\.json\(\)/);
  });

  it('preserves the authenticated token contract and recovery routing', () => {
    expect(PAGE).toContain("localStorage.getItem('ds_web_session_token')");
    expect(PAGE).toContain("authorization: 'Bearer ' + sessionToken");
    expect(PAGE).toContain('body: JSON.stringify({ token: token })');
    expect(PAGE).toContain("window.location.href = '/team/'");
    expect(PAGE).toContain("'/login/?next=' + next");
    expect(PAGE).toContain("'/signup/?next=' + next");
  });
});
