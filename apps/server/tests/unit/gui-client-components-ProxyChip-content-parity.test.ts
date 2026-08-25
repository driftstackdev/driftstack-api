// W486.C-2 — drift guard for apps/gui-client/src/components/ProxyChip.tsx.
// Operator-UI polish wave (2026-05-21). Pins the no-credential-leak rule
// + the click-outside-to-close behavior + the SOCKS5 detail-row taxonomy;
// visible-text contract lives in apps/gui-client/tests/unit/ProxyChip.test.tsx.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/components/ProxyChip.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W486.C-2 apps/gui-client/src/components/ProxyChip.tsx content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('NEVER renders proxy.password — pinned so a screen-share / screenshot leak surface stays closed even after a careless prop spread refactor (Auth row shows yes / no only; the password property is in the Tauri store and never crosses this component boundary)', () => {
    expect(body).not.toMatch(/proxy\.password/);
    expect(body).toMatch(/auth = proxy\.username !== null && proxy\.username\.length > 0/);
  });

  it('click-outside-to-close: mousedown listener attached on document while open and removed on cleanup — pinned so the popover does not stay stuck open when the customer drags focus elsewhere (which would obscure the row underneath)', () => {
    expect(body).toMatch(/document\.addEventListener\('mousedown', onClickOutside\)/);
    expect(body).toMatch(/document\.removeEventListener\('mousedown', onClickOutside\)/);
  });

  it("popover detail-row taxonomy pinned: Label / Host / Port / Auth / Added — pinned so a refactor cannot drop the proxy-id-prefix header or reorder the rows (host comes before port in every saved-proxies admin tool the customer's used; staying consistent matters)", () => {
    expect(body).toMatch(/<DetailRow label="Label" value=\{proxy\.label\} \/>/);
    expect(body).toMatch(/<DetailRow label="Host" value=\{proxy\.host\} mono \/>/);
    expect(body).toMatch(/<DetailRow label="Port" value=\{String\(proxy\.port\)\} mono \/>/);
    expect(body).toMatch(/<DetailRow label="Auth" value=\{auth \? 'yes' : 'no'\} \/>/);
    expect(body).toMatch(/<DetailRow\s*label="Added"/);
  });

  it("'no proxy' affordance when proxy is null — pinned so a row without a binding doesn't render a blank chip (the customer would assume the field was elided rather than uninitialized)", () => {
    expect(body).toMatch(/no proxy/);
  });

  it("popover header announces SOCKS5 + 8-char id prefix — pinned so the protocol marker stays visible in the chrome (the codebase grows non-SOCKS5 transports in v2; this'll need expansion then, and the parity break flags it)", () => {
    expect(body).toMatch(/<span className="section-label">SOCKS5<\/span>/);
    expect(body).toMatch(/\{proxy\.id\.slice\(0, 8\)\}…/);
  });

  it('button surface is role-correct for a popover trigger: aria-haspopup="dialog" + aria-expanded={open} — pinned so screen readers announce the trigger as a disclosure control', () => {
    expect(body).toMatch(/aria-haspopup="dialog"/);
    expect(body).toMatch(/aria-expanded=\{open\}/);
  });
});
