// W527.B — drift guard for apps/admin-panel/tailwind.config.mjs.
// S25 2026-07-06 framing update: the old "verbatim palette parity
// across marketing-site + customer-dashboard + admin-panel" claim is
// SUPERSEDED — marketing-site (2026-07-03) and customer-dashboard
// (S24 2026-07-06, commit 6a988b359) both RETIRED their legacy
// oxblood/slate utility ladders in favor of the two-axis tk-* token
// system (#722F37 lives on as --accent-strong on the oxblood axis).
// Admin-panel deliberately still carries the legacy ladders (it was
// not part of the Fleet v2 redesign); these pins now guard ADMIN'S
// OWN palette staying anchored at the locked #722F37 accent, not a
// cross-app byte-parity that no longer exists. Admin-panel matches
// dashboard's 'plugins:[]' posture (no @tailwindcss/typography —
// admin pages are forms/tables, no prose).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/admin-panel/tailwind.config.mjs');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W527.B apps/admin-panel/tailwind.config.mjs content parity', () => {
  const body = read(LIB);

  it("Shared-with-marketing framing pinned: 'Design tokens shared with the marketing site (apps/marketing-site/tailwind.config.mjs). Keep these synchronised — the customer experience reads as one product, not two.' + @type JSDoc + 8-extension content glob. S25 2026-07-06: the source comment is a historical artifact — marketing-site (2026-07-03) + customer-dashboard (S24) retired their verbatim ladders for the tk-* token system, so this no longer describes a live 3-app sync; pinned as-is until admin-panel's own Fleet v2 port updates the comment", () => {
    expect(body).toMatch(/\/\*\* @type \{import\('tailwindcss'\)\.Config\} \*\//);
    expect(body).toMatch(
      /\/\/ Design tokens shared with the marketing site \(apps\/marketing-site\/\s*\/\/ tailwind\.config\.mjs\)\. Keep these synchronised — the customer\s*\/\/ experience reads as one product, not two\./,
    );
    expect(body).toMatch(/content: \['\.\/src\/\*\*\/\*\.\{astro,html,js,jsx,md,mdx,ts,tsx\}'\],/);
  });

  it("Oxblood palette pinned: 11-step (50→950) palette anchored at #722F37 700 base. S25 2026-07-06: formerly framed as verbatim cross-app parity with marketing-site + customer-dashboard — SUPERSEDED (both retired their oxblood ladders for the tk-* token axes; #722F37 lives on there as --accent-strong). Admin-panel is now the sole carrier of the legacy ladder; pinned so ADMIN's own palette stays anchored at the locked founder accent", () => {
    expect(body).toMatch(/\/\/ Oxblood — locked accent per founder direction \(#722F37\)\./);
    expect(body).toMatch(/oxblood: \{/);
    expect(body).toMatch(/50: '#fbf3f4',/);
    expect(body).toMatch(/100: '#f5e1e3',/);
    expect(body).toMatch(/200: '#ebbfc4',/);
    expect(body).toMatch(/300: '#dc939c',/);
    expect(body).toMatch(/400: '#c8606e',/);
    expect(body).toMatch(/500: '#a83b4d',/);
    expect(body).toMatch(/600: '#8d2c3e',/);
    expect(body).toMatch(/700: '#722F37', \/\/ base — primary accent, locked/);
    expect(body).toMatch(/800: '#5e2730',/);
    expect(body).toMatch(/900: '#4f242b',/);
    expect(body).toMatch(/950: '#2b0f15',/);
  });

  it("Slate palette pinned: 11-step (50→950) palette. S25 2026-07-06: formerly framed as verbatim cross-app parity with marketing-site + customer-dashboard — SUPERSEDED (marketing retired its slate ladder 2026-07-03; the dashboard's S24 config keeps only a trimmed slate subset for 2 legacy consumers). Pinned so ADMIN's own neutral scale doesn't drift", () => {
    expect(body).toMatch(/slate: \{/);
    expect(body).toMatch(/50: '#f8fafc',/);
    expect(body).toMatch(/100: '#f1f5f9',/);
    expect(body).toMatch(/200: '#e2e8f0',/);
    expect(body).toMatch(/300: '#cbd5e1',/);
    expect(body).toMatch(/400: '#94a3b8',/);
    expect(body).toMatch(/500: '#64748b',/);
    expect(body).toMatch(/600: '#475569',/);
    expect(body).toMatch(/700: '#334155',/);
    expect(body).toMatch(/800: '#1e293b',/);
    expect(body).toMatch(/900: '#0f172a',/);
    expect(body).toMatch(/950: '#020617',/);
  });

  it("fontFamily + maxWidth + plugins-empty framing pinned: Geist+system sans + Berkeley-Mono+ui-monospace mono + 65ch prose + 'plugins: []' (admin-panel matches customer-dashboard's no-typography-plugin posture — admin is forms/tables, no prose) — pinned so the cross-app font-stack parity + 65ch-prose-cap + no-typography-plugin commitment survives", () => {
    expect(body).toMatch(/sans: \['Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'\],/);
    expect(body).toMatch(
      /mono: \['Berkeley Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'\],/,
    );
    expect(body).toMatch(/maxWidth: \{\s*prose: '65ch',\s*\},/);
    expect(body).toMatch(/plugins: \[\],/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
