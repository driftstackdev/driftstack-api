// W608.A — drift guard for apps/gui-client/src/lib/SettingsContext.tsx.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/SettingsContext.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W608.A apps/gui-client/src/lib/SettingsContext.tsx content parity', () => {
  const body = read(LIB);

  it('SettingsContext framing: single-source-of-truth for apiKey + baseUrl + V-239 AccountSelfProfile (cap-gating UX) + refreshAccountMe manual refresh + V-242 telemetry init/reconfigure pinned', () => {
    expect(body).toMatch(/\/\/ Settings context — single source of truth for the API key \+ base/);
    expect(body).toMatch(/\/\/ URL across the React tree\./);
    expect(body).toMatch(
      /\/\/ V-239: also fetches \+ exposes the AccountSelfProfile \(V-237 endpoint\)/,
    );
    expect(body).toMatch(
      /\/\/ so views can render "X \/ Y concurrent sessions" \+ "P \/ Q profiles"/,
    );
    expect(body).toMatch(/\/\/ gates without each view re-fetching independently\. `accountMe` is/);
    expect(body).toMatch(
      /\/\/ null while loading or when no apiKey is set; `refreshAccountMe\(\)`/,
    );
    expect(body).toMatch(/\/\/ is exposed so views \(Sessions, Profiles\) can refresh after a/);
    expect(body).toMatch(/\/\/ create\/destroy that mutates the count\./);
  });

  it('SettingsContextValue interface + SettingsProvider + V-242 telemetry re-init on baseUrl/optIn change + soft-fail accountMe (null → ungated UI) pinned', () => {
    expect(body).toMatch(/^interface SettingsContextValue \{$/m);
    expect(body).toMatch(/settings: DriftstackSettings;/);
    expect(body).toMatch(/loading: boolean;/);
    expect(body).toMatch(/client: DriftstackClient \| null;/);
    expect(body).toMatch(
      /\/\*\* V-239 — current account's tier \+ caps \+ usage\. Null while loading or unauthenticated\. \*\//,
    );
    expect(body).toMatch(/accountMe: AccountSelfProfile \| null;/);
    expect(body).toMatch(/refreshAccountMe: \(\) => Promise<void>;/);
    expect(body).toMatch(/update: \(next: Partial<DriftstackSettings>\) => Promise<void>;/);
    expect(body).toMatch(
      /^export const SettingsContext = createContext<SettingsContextValue \| null>\(null\);$/m,
    );
    expect(body).toMatch(/export function SettingsProvider/);
    expect(body).toMatch(
      /\/\/ V-242 — re-init telemetry whenever baseUrl or telemetryOptIn changes\./,
    );
    expect(body).toMatch(/\/\/ initTelemetry is idempotent \+ reconfigure-safe;/);
    expect(body).toMatch(
      /initTelemetry\(\{ baseUrl: settings\.baseUrl, optIn: settings\.telemetryOptIn \}\);/,
    );
    expect(body).toMatch(
      /const client = useMemo\(\s*\n\s*\(\) => buildClient\(settings\.apiKey, settings\.baseUrl\),/,
    );
    expect(body).toMatch(/\/\/ Soft-fail: leave accountMe null \+ don't surface the error here\./);
    expect(body).toMatch(/\/\/ Views consuming accountMe should treat null as "cap unknown;/);
    expect(body).toMatch(/\/\/ don't gate"\./);
    expect(body).toMatch(/^export function useSettings\(\): SettingsContextValue \{$/m);
    expect(body).toMatch(
      /if \(!ctx\) throw new Error\('useSettings must be used inside <SettingsProvider>'\);/,
    );
    expect(existsSync(LIB)).toBe(true);
  });
});
