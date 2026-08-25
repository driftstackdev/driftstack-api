// W461.C — drift guard for apps/gui-client/src/lib/client.ts.
// V-029 SDK-B isomorphic SDK wiring. Drift here either drops the
// trailing-slash strip on baseUrl (every URL ends up with '//'
// somewhere and fetch normalizes some but not all paths
// inconsistently — auth flows break under specific Safari rules)
// or re-introduces the hand-written fetch wrapper that broke the
// browser bundle before V-029 SDK-B shipped Web Crypto API
// signature support.
//
//   • V-029 SDK-B framing pinned: '@driftstack/sdk@0.1.1 ships an
//     isomorphic webhook helper (Web Crypto API instead of
//     node:crypto, see V-029 SDK-B), the browser bundle resolves
//     cleanly and we use the published SDK directly. The hand-
//     written fetch wrapper that GUI2 used as a workaround is gone.'
//   • Imports: { Driftstack, type Session } from '@driftstack/sdk'.
//   • Re-exports: type Session + named DriftstackError.
//   • Type alias: DriftstackClient = Driftstack.
//   • buildClient(apiKey, baseUrl): null-or-empty apiKey → null;
//     trailing-slash strip via baseUrl.replace(/\/+$/, '').

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/client.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W461.C apps/gui-client/src/lib/client.ts content parity', () => {
  const body = read(LIB);

  it("V-029 SDK-B framing pinned: 'Driftstack SDK client.' + '@driftstack/sdk@0.1.1 ships an isomorphic webhook helper (Web Crypto API instead of node:crypto, see V-029 SDK-B), the browser bundle resolves cleanly and we use the published SDK directly. The hand-written fetch wrapper that GUI2 used as a workaround is gone.'", () => {
    expect(body).toMatch(/\/\/ Driftstack SDK client\./);
    expect(body).toMatch(
      /\/\/ Now that @driftstack\/sdk@0\.1\.1 ships an isomorphic webhook helper\s*\/\/ \(Web Crypto API instead of node:crypto, see V-029 SDK-B\), the\s*\/\/ browser bundle resolves cleanly and we use the published SDK\s*\/\/ directly\. The hand-written fetch wrapper that GUI2 used as a\s*\/\/ workaround is gone\./,
    );
  });

  it('Imports: { Driftstack, type Session } from "@driftstack/sdk" single combined import', () => {
    expect(body).toMatch(/import \{ Driftstack, type Session \} from '@driftstack\/sdk';/);
  });

  it('Re-exports: export type { Session } + export { DriftstackError } from @driftstack/sdk (both surfaced through the gui-client lib boundary)', () => {
    expect(body).toMatch(/export type \{ Session \};/);
    expect(body).toMatch(/export \{ DriftstackError \} from '@driftstack\/sdk';/);
  });

  it('Type alias: DriftstackClient = Driftstack (gui-client-side public type for the SDK instance)', () => {
    expect(body).toMatch(/export type DriftstackClient = Driftstack;/);
  });

  it('buildClient(apiKey, baseUrl, effectiveAccount=null, onUnauthorized?): null-or-empty apiKey → null early return; otherwise new Driftstack({apiKey, baseUrl trailing-slash-stripped, fetch: authFetch (a 401-observer pass-through over loggingFetch), effectiveAccount when non-null}) — W609 Dev Logs fetch seam + workspace half-2 scoping + central 401 re-auth', () => {
    expect(body).toContain('effectiveAccount: string | null = null,');
    expect(body).toContain('onUnauthorized?: () => void,');
    expect(body).toContain('if (apiKey === null || apiKey.length === 0) return null;');
    expect(body).toContain("baseUrl: baseUrl.replace(/\\/+$/, ''),");
    expect(body).toContain('fetch: authFetch,');
    // authFetch is a pure pass-through over loggingFetch that NOTIFIES on 401.
    expect(body).toContain('loggingFetch(input, init)');
    expect(body).toMatch(/if \(res\.status === 401\) onUnauthorized\?\.\(\);/);
    expect(body).toContain('...(effectiveAccount !== null ? { effectiveAccount } : {}),');
  });

  it("W609 loggingFetch — Dev Logs productivity seam: non-ok responses record('error', ['[api] <method> <url> → <status>']) + network failures record + rethrow; successes NOT logged (the 2-fps frame poll would flood the 500-entry ring in ~4 min). Pinned so the panel keeps showing API failures (the founder-reported empty-Dev-Logs-during-error case)", () => {
    expect(body).toMatch(/import \{ record \} from '\.\/log-buffer';/);
    expect(body).toMatch(
      /function loggingFetch\(input: RequestInfo \| URL, init\?: RequestInit\): Promise<Response> \{/,
    );
    expect(body).toMatch(
      /if \(!res\.ok\) record\('error', \[`\[api\] \$\{method\} \$\{url\} → \$\{res\.status\} \$\{res\.statusText\}`\]\);/,
    );
    expect(body).toMatch(
      /record\('error', \[`\[api\] \$\{method\} \$\{url\} → network failure: \$\{String\(err\)\}`\]\);/,
    );
    expect(body).toMatch(/throw err;/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
