import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/fleet.astro');
const body = readFileSync(PAGE, 'utf8');

describe('admin fleet control single-flight feedback', () => {
  it('ships neutral freshness and a staff-gated manual refresh', () => {
    expect(body).toContain('Waiting for live data');
    expect(body).toContain('Live fleet state is unavailable until loaded.');
    expect(body).toMatch(/data-refresh\s+disabled\s+aria-disabled="true"/);
    expect(body).toMatch(/function getToken\(\) \{[\s\S]*?try \{[\s\S]*?\} catch \{/);
    expect(body).toContain("refreshBtn.addEventListener('click', loadWithLive)");
    expect(body).toMatch(/if \(loaded === true\) setLiveState\('ready'\)/);
  });

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
    expect(body).toMatch(/uncertainControlNodes\.add\(String\(nodeId\)\);/);
    expect(body).toMatch(/const refreshed = await load\(\);/);
    expect(body).toMatch(/if \(commandStarted\)/);
    expect(body).toContain('the connection failed before a definitive response arrived');
    expect(body).toMatch(/r\.status >= 500 \|\| \(r\.status >= 200 && r\.status < 300\)/);
    expect(body).toContain('Controls for this node are locked for this page.');
    expect(body).toContain('do not send the command again blindly.');
    expect(body).toContain('Outcome unknown — verify, then reload');
  });

  it('humanizes unknown control failures instead of rendering a raw HTTP status', () => {
    expect(body).toContain("requestErrorMessage(\n                  new Error('HTTP ' + r.status)");
    expect(body).toContain('the control request was not accepted');
    expect(body).not.toContain("showBanner('Cannot ' + cmd + ' — HTTP '");
  });

  it('strictly validates the whole fleet page before publishing healthy or empty state', () => {
    expect(body).toContain('function parseFleetPage(value)');
    expect(body).toContain('function parseHeartbeat(value)');
    expect(body).toMatch(/!isRecord\(value\) \|\| !Array\.isArray\(value\.data\)/);
    expect(body).toMatch(/const rows = parseFleetPage\(body\);/);
    expect(body).toMatch(/if \(seen\.has\(row\.id\)\) throw new Error/);
    expect(body).toContain('Invalid live fleet response.');
    expect(body).not.toContain('const rows = body.data || []');
  });

  it('refreshes before publishing an accepted command without erasing the acceptance', () => {
    expect(body).toMatch(/if \(r\.status === 202\) \{\s*const refreshed = await load\(\);/);
    expect(body).toContain('the node accepted it asynchronously');
    expect(body).toContain('Fleet state could not be refreshed; verify Health / Last seen');
  });
});
