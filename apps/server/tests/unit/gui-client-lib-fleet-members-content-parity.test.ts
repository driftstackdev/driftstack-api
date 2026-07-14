// W469.B — drift guard for apps/gui-client/src/lib/fleet-members.ts.
// V-346 Fleet member registry. Drift here either drops the
// baseUrl trailing-slash strip on add/update (downstream
// `${baseUrl}/version` ends up with `//version` and Apache+nginx
// reverse proxies handle this inconsistently — fleet view shows
// random pings as down) or breaks the 5s AbortController timeout
// on pingFleetMember (a hung member blocks the fleet view forever
// and the customer can't tell which Mac mini is broken).
//
//   • V-346 framing pinned: 'Fleet member registry. CRUD over
//     tauri-plugin-store.' + '"fleet member" is a Driftstack
//     control-plane API server the founder runs locally on a Mac
//     mini in a fleet (i.e. multiple Mac minis, each running an
//     api-server instance + driver, fronted by the GUI). Each
//     entry is just a label + base URL; the fleet view pings
//     each member's /version on demand to surface status.'
//   • Mirrors-V-244 framing pinned: 'Stored under settings.json
//     keyed separately from settings + proxies (mirrors the V-244
//     proxies.ts pattern). Local-only — no server round-trip; the
//     founder owns the fleet topology.'
//   • FleetMember 5-field + FleetMemberDraft 3-field.
//   • STORE_FILE 'settings.json' + FLEET_KEY 'fleetMembers'.
//   • addFleetMember + updateFleetMember: baseUrl.replace(/\/+$/, '')
//     trailing-slash strip on BOTH paths.
//   • validateDraft: label/baseUrl required + URL constructor
//     try/catch + protocol must be http:/https:.
//   • FleetMemberPing 6-field with driver 3-union + playwrightBrowser
//     3-union.
//   • pingFleetMember: AbortController 5s timeout via setTimeout +
//     performance.now() duration + driver/playwright_browser
//     enum-narrow + clearTimeout in finally.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/fleet-members.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W469.B apps/gui-client/src/lib/fleet-members.ts content parity', () => {
  const body = read(LIB);

  it("V-346 framing pinned: 'V-346 — Fleet member registry. CRUD over tauri-plugin-store.' + 'A \"fleet member\" is a Driftstack control-plane API server the founder runs locally on a Mac mini in a fleet (i.e. multiple Mac minis, each running an api-server instance + driver, fronted by the GUI). Each entry is just a label + base URL; the fleet view pings each member's /version on demand to surface status.'", () => {
    expect(body).toMatch(/\/\/ V-346 — Fleet member registry\. CRUD over tauri-plugin-store\./);
    expect(body).toMatch(
      /\/\/ A "fleet member" is a Driftstack control-plane API server the\s*\n?\s*\/\/ founder runs locally on a Mac mini in a fleet \(i\.e\. multiple\s*\n?\s*\/\/ Mac minis, each running an api-server instance \+ driver, fronted\s*\n?\s*\/\/ by the GUI\)\. Each entry is just a label \+ base URL; the fleet\s*\n?\s*\/\/ view pings each member's \/version on demand to surface status\./,
    );
  });

  it("Mirrors-V-244 framing pinned: 'Stored under settings.json keyed separately from settings + proxies (mirrors the V-244 proxies.ts pattern). Local-only — no server round-trip; the founder owns the fleet topology.'", () => {
    expect(body).toMatch(
      /\/\/ Stored under settings\.json keyed separately from settings \+ proxies\s*\n?\s*\/\/ \(mirrors the V-244 proxies\.ts pattern\)\. Local-only — no server\s*\n?\s*\/\/ round-trip; the founder owns the fleet topology\./,
    );
  });

  it("FleetMember 5-field: id + label + baseUrl 'same shape as the GUI's primary base URL' + notes nullable + createdAt 'ISO8601 created timestamp. Hand-set by the GUI; not server-authoritative.'", () => {
    expect(body).toMatch(
      /export interface FleetMember \{\s*\n?\s*id: string;\s*\n?\s*label: string;\s*\n?\s*\/\*\* e\.g\. http:\/\/10\.0\.0\.5:3000 — same shape as the GUI's primary base URL\. \*\/\s*\n?\s*baseUrl: string;\s*\n?\s*notes: string \| null;\s*\n?\s*\/\*\* ISO8601 created timestamp\. Hand-set by the GUI; not server-authoritative\. \*\/\s*\n?\s*createdAt: string;\s*\n?\s*\}/,
    );
  });

  it("FleetMemberDraft 3-field (label + baseUrl + notes — no id/createdAt) + STORE_FILE 'settings.json' + FLEET_KEY 'fleetMembers'", () => {
    expect(body).toMatch(
      /export interface FleetMemberDraft \{\s*\n?\s*label: string;\s*\n?\s*baseUrl: string;\s*\n?\s*notes: string \| null;\s*\n?\s*\}/,
    );
    expect(body).toMatch(/const STORE_FILE = 'settings\.json';/);
    expect(body).toMatch(/const FLEET_KEY = 'fleetMembers';/);
  });

  it("addFleetMember + updateFleetMember: baseUrl.replace(/\\/+$/, '') trailing-slash strip on BOTH paths (downstream `${baseUrl}/version` would double-slash without it)", () => {
    expect(body).toMatch(
      /export async function addFleetMember\(draft: FleetMemberDraft\): Promise<FleetMember> \{\s*\n?\s*const all = await listFleetMembers\(\);\s*\n?\s*const next: FleetMember = \{\s*\n?\s*id: mintId\(\),\s*\n?\s*label: draft\.label,\s*\n?\s*baseUrl: draft\.baseUrl\.replace\(\/\\\/\+\$\/, ''\),/,
    );
    expect(body).toMatch(
      /const updated: FleetMember = \{\s*\n?\s*\.\.\.\(all\[idx\] as FleetMember\),\s*\n?\s*label: patch\.label,\s*\n?\s*baseUrl: patch\.baseUrl\.replace\(\/\\\/\+\$\/, ''\),\s*\n?\s*notes: patch\.notes,\s*\n?\s*\};/,
    );
  });

  it("validateDraft: label.trim().length === 0 → 'Required.' + baseUrl.trim().length === 0 → 'Required.' + new URL() try/catch → 'Invalid URL.' + protocol must be http:/https: → 'Must be http:// or https:// URL.'", () => {
    expect(body).toMatch(
      /export function validateDraft\(d: FleetMemberDraft\): DraftValidation \{\s*\n?\s*const errors: Partial<Record<keyof FleetMemberDraft, string>> = \{\};\s*\n?\s*if \(d\.label\.trim\(\)\.length === 0\) errors\.label = 'Required\.';\s*\n?\s*if \(d\.baseUrl\.trim\(\)\.length === 0\) \{\s*\n?\s*errors\.baseUrl = 'Required\.';\s*\n?\s*\} else \{\s*\n?\s*try \{\s*\n?\s*const u = new URL\(d\.baseUrl\);\s*\n?\s*if \(u\.protocol !== 'http:' && u\.protocol !== 'https:'\) \{\s*\n?\s*errors\.baseUrl = 'Must be http:\/\/ or https:\/\/ URL\.';\s*\n?\s*\}\s*\n?\s*\} catch \{\s*\n?\s*errors\.baseUrl = 'Invalid URL\.';\s*\n?\s*\}\s*\n?\s*\}/,
    );
  });

  it("FleetMemberPing 6-field: ok + durationMs + version optional 'From /version on the target. Undefined when ping failed.' + driver 3-union ('mock'|'webkit'|'playwright') + playwrightBrowser 3-union ('webkit'|'chromium'|'firefox') + error optional 'When ping failed: short human-readable error.'", () => {
    expect(body).toMatch(
      /export interface FleetMemberPing \{\s*\n?\s*ok: boolean;\s*\n?\s*durationMs: number;\s*\n?\s*\/\*\* From \/version on the target\. Undefined when ping failed\. \*\/\s*\n?\s*version\?: string;\s*\n?\s*driver\?: 'mock' \| 'webkit' \| 'playwright';\s*\n?\s*playwrightBrowser\?: 'webkit' \| 'chromium' \| 'firefox';\s*\n?\s*\/\*\* When ping failed: short human-readable error\. \*\/\s*\n?\s*error\?: string;\s*\n?\s*\}/,
    );
  });

  it("pingFleetMember: V-346 framing 'fetch /version on the member; resolves with shape suitable for the FleetView. Uses fetch with a 5s timeout via AbortController.' + performance.now() duration + 5000ms AbortController.abort + fetch with signal + !res.ok → `HTTP ${res.status.toString()}` error fallback", () => {
    expect(body).toMatch(
      /\*\s*V-346 — fetch \/version on the member; resolves with shape suitable\s*\n?\s*\*\s*for the FleetView\. Uses fetch with a 5s timeout via AbortController\./,
    );
    expect(body).toMatch(
      /const start = performance\.now\(\);\s*const ctrl = new AbortController\(\);\s*const timer = setTimeout\(\(\) => ctrl\.abort\(\), 5000\);\s*try \{\s*const res = await fetch\(`\$\{member\.baseUrl\}\/version`, \{ signal: ctrl\.signal \}\);\s*const dur = Math\.round\(performance\.now\(\) - start\);\s*if \(!res\.ok\) \{\s*await disposeResponseBody\(res\);\s*return \{ ok: false, durationMs: dur, error: `HTTP \$\{res\.status\.toString\(\)\}` \};\s*\}/,
    );
  });

  it('pingFleetMember bounds diagnostic JSON, narrows enums, humanizes local failures, and always clears its deadline', () => {
    expect(body).toMatch(/import \{ readBoundedDiagnosticJson \} from '\.\/read-bounded-json';/);
    expect(body).toMatch(/import \{ humanizeError \} from '\.\/humanize-error';/);
    expect(body).toMatch(
      /const body = await readBoundedDiagnosticJson<\{\s*version\?: unknown;\s*driver\?: unknown;\s*playwright_browser\?: unknown;\s*\}>\(res\);/,
    );
    expect(body).toMatch(
      /if \(body\.driver === 'mock' \|\| body\.driver === 'webkit' \|\| body\.driver === 'playwright'\) \{\s*\n?\s*out\.driver = body\.driver;\s*\n?\s*\}\s*\n?\s*if \(\s*\n?\s*body\.playwright_browser === 'webkit' \|\|\s*\n?\s*body\.playwright_browser === 'chromium' \|\|\s*\n?\s*body\.playwright_browser === 'firefox'\s*\n?\s*\) \{\s*\n?\s*out\.playwrightBrowser = body\.playwright_browser;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /\} catch \(err\) \{\s*const dur = Math\.round\(performance\.now\(\) - start\);\s*const message = humanizeError\(\s*err,\s*"Couldn't reach this fleet member\. Check its URL and try again\.",\s*\);\s*return \{ ok: false, durationMs: dur, error: message \};\s*\} finally \{\s*clearTimeout\(timer\);\s*\}/,
    );
    expect(body).not.toMatch(/err instanceof Error \? err\.message/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
