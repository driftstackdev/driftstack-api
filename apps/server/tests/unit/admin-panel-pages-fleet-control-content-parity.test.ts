import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/fleet.astro');
const body = readFileSync(PAGE, 'utf8');

describe('admin fleet control single-flight feedback', () => {
  it('rejects overlapping control commands before opening another confirmation', () => {
    expect(body).toMatch(/if \(!token \|\| controlInFlight\) return;/);
    expect(body).toMatch(/controlInFlight = true;/);
    expect(body).toMatch(/controlInFlight = false;/);
  });

  it('disables every node command and labels the active command while it is in flight', () => {
    expect(body).toMatch(/querySelectorAll\('button\[data-control\]'\)/);
    expect(body).toMatch(/control\.disabled = true;/);
    expect(body).toMatch(/btn\.textContent = controlPendingLabel\(cmd\);/);
    expect(body).toMatch(/btn\.setAttribute\('aria-busy', 'true'\);/);
  });

  it('restores controls and the active button in the finally path', () => {
    expect(body).toMatch(/control\.disabled = outcomeUnknown;/);
    expect(body).toMatch(/btn\.textContent = originalText;/);
    expect(body).toMatch(/btn\.removeAttribute\('aria-busy'\);/);
    expect(body).toMatch(/btn\.disabled = outcomeUnknown;/);
  });

  it('treats a timed-out asynchronous command as terminally uncertain for that node', () => {
    expect(body).toMatch(/const uncertainControlNodes = new Set\(\);/);
    expect(body).toMatch(/if \(err && err\.name === 'AbortError'\)/);
    expect(body).toMatch(/uncertainControlNodes\.add\(String\(nodeId\)\);/);
    expect(body).toMatch(/const refreshed = await load\(\);/);
    expect(body).toContain('Controls for this node are locked for this page.');
    expect(body).toContain('do not send the command again blindly.');
    expect(body).toContain('Outcome unknown — verify, then reload');
  });
});
