import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LAYOUT = readFileSync(
  resolve(REPO_ROOT, 'apps/customer-dashboard/src/layouts/DashboardLayout.astro'),
  'utf8',
);

describe('customer command-palette account-id copy', () => {
  it('exposes combobox/listbox selection and restores focus when the palette closes', () => {
    expect(LAYOUT).toMatch(/role="combobox"/);
    expect(LAYOUT).toMatch(/aria-controls="command-palette-results"/);
    expect(LAYOUT).toMatch(/aria-activedescendant=""/);
    expect(LAYOUT).toMatch(/id="command-palette-results"[\s\S]*?role="listbox"/);
    expect(LAYOUT).toContain("li.id = 'command-palette-option-' + String(i)");
    expect(LAYOUT).toContain("li.setAttribute('aria-selected', i === active ? 'true' : 'false')");
    expect(LAYOUT).toContain("input.setAttribute('aria-expanded', 'true')");
    expect(LAYOUT).toContain("input.setAttribute('aria-expanded', 'false')");
    expect(LAYOUT).toContain('previousFocus = document.activeElement instanceof HTMLElement');
    expect(LAYOUT).toContain('previousFocus.focus()');
  });

  it('keeps outcome feedback available after the command palette closes', () => {
    expect(LAYOUT).toMatch(/data-command-status/);
    expect(LAYOUT).toMatch(/role="status"/);
    expect(LAYOUT).toMatch(/aria-live="polite"/);
    expect(LAYOUT).toMatch(/aria-atomic="true"/);
    expect(LAYOUT).toMatch(/function showCommandStatus\(message\)/);
    expect(LAYOUT).toContain("commandStatus.classList.remove('hidden')");
  });

  it('copies the active team id without replacing it with the personal account id', () => {
    expect(LAYOUT).toContain("activeOwnerId = localStorage.getItem('ds_act_as_account') || ''");
    expect(LAYOUT).toMatch(
      /var accountIdPromise = activeOwnerId\s*\? Promise\.resolve\(activeOwnerId\)/,
    );
    expect(LAYOUT).toContain("'Active team account ID copied.'");
  });

  it('bounds personal-account lookup and reports timeout, clipboard, and signed-out failures', () => {
    expect(LAYOUT).toMatch(/function copyAccountId\(\)/);
    expect(LAYOUT).toContain('var copyAccountInFlight = false');
    expect(LAYOUT).toContain('controller.abort();\n          }, 10_000)');
    expect(LAYOUT).toContain('signal: controller.signal');
    expect(LAYOUT).toContain("error && error.name === 'AbortError'");
    expect(LAYOUT).toContain('Account ID lookup timed out — try again.');
    expect(LAYOUT).toContain('check clipboard permission and try again');
    expect(LAYOUT).toContain('sign in again');
    expect(LAYOUT).toMatch(/label: 'Copy account ID',[\s\S]*?run: copyAccountId/);
  });
});
