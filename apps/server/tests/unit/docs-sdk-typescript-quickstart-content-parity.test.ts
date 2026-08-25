// Drift guard for apps/docs/src/pages/sdk/typescript-quickstart.md.
// Pins the 4-step quickstart flow + the ESM-only/Node-18+ contract
// + the construction-doesn't-network claim.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/typescript-quickstart.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('docs sdk/typescript-quickstart content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('title + description front-matter pinned', () => {
    expect(body).toMatch(/title: TypeScript \/ Node\.js quickstart/);
    expect(body).toMatch(
      /description: 5-minute getting-started for the @driftstack\/sdk TypeScript client/,
    );
  });

  it('Node.js version contract pinned: Node 18+ minimum + Node 22 LTS recommended (drift to dropping the version floor would surprise customers who try the SDK on older Node versions and hit runtime failures)', () => {
    expect(body).toMatch(/Node\.js 18\+/);
    expect(body).toMatch(/Node 22 LTS recommended/);
    expect(body).toMatch(/`engines\.node: ">=18"`/);
  });

  it('dual-publish (ESM + CommonJS via conditional exports) pinned (2026-06-24). The previous pin asserted "ESM-only ... CommonJS consumers ... dynamic import()" but @driftstack/sdk is dual-published (package.json main ./dist/index.cjs + exports["."].require) so both import and require work — the prior claim misled CJS consumers. Drift back to an ESM-only claim would re-introduce the falsehood.', () => {
    expect(body).toMatch(/dual-published \(ESM \+ CommonJS via conditional/);
    expect(body).toMatch(
      /Both `import` and\s*\n?`require\('@driftstack\/sdk'\)` work out of the box\./,
    );
    // The stale ESM-only claim must NOT return.
    expect(body).not.toMatch(/ESM-only and ships full TypeScript types/);
  });

  it("client construction doesn't network pinned: 'The constructor doesn't make any network calls. Authentication is deferred to the first request' — drift would mislead customers about the validation timing", () => {
    expect(body).toMatch(/The constructor doesn't make any network calls\./);
    expect(body).toMatch(/Authentication is\s+deferred to the first request/);
  });

  it('4-step quickstart flow pinned: install / configure / run-session / cleanup. Drift to skipping the destroy() step would normalize concurrent-slot leaks; drift to skipping navigate→capture→getState would lose the canonical session-driving pattern', () => {
    expect(body).toMatch(/npm install @driftstack\/sdk/);
    expect(body).toMatch(/import \{ Driftstack \} from '@driftstack\/sdk'/);
    expect(body).toMatch(/client\.sessions\.create\(\{ label: 'demo' \}\)/);
    expect(body).toMatch(
      /client\.sessions\.navigate\(session\.id, \{[\s\S]*url: 'https:\/\/example\.com'/,
    );
    expect(body).toMatch(/client\.sessions\.capture\(session\.id, \{[\s\S]*kind: 'screenshot'/);
    expect(body).toMatch(/client\.sessions\.destroy\(session\.id\)/);
  });

  it('concurrent-slot framing pinned: slot held until YOU destroy — no idle timeout on any tier, only the free-tier 20-minute duration cap (S36 2026-07-07 fable-truth-audit: the per-tier-idle-timeout comment was fictional; the try/finally rationale stands). Spans lines inside a code-comment so allow the // continuation', () => {
    expect(body).toMatch(
      /the concurrent slot stays held until you do\.\s*\/\/ There is no idle timeout on any tier/,
    );
    expect(body).not.toMatch(/per-tier idle timeout/);
  });

  it('paid SDK and Free desktop boundary plus actionable 403 detail are pinned', () => {
    expect(body).toMatch(/Any paid Driftstack tier, including Manual/);
    expect(body).toMatch(/A `ds_live_…` customer API key/);
    expect(body).toMatch(/restricted\s*`ds_test_…` device credential/);
    expect(body).toMatch(/err\.status === 403 && err\.detail\?\.includes\('apiAccess'\) === true/);
    expect(body).toMatch(
      /Upgrade to\s*\/\/ resume this key unless it was separately revoked or expired/,
    );
  });
});
