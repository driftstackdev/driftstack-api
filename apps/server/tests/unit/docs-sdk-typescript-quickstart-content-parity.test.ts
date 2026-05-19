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

  it('ESM-only + CommonJS dynamic-import escape-hatch pinned (drift to silently providing CJS would mislead customers about the module format; drift to dropping the dynamic-import note would orphan customers stuck on CJS)', () => {
    expect(body).toMatch(/ESM-only and ships full TypeScript types/);
    expect(body).toMatch(
      /CommonJS\s+consumers that can't migrate need to use dynamic `import\(\)`/,
    );
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

  it('concurrent-slot framing pinned: slot held until destroy OR idle timeout fires (drift to claiming auto-cleanup-on-error would mislead customers into not writing the try/finally — a real bug source). Spans 2 lines inside a code-comment so allow the // continuation', () => {
    expect(body).toMatch(
      /concurrent slot stays held until you do or\s*\n?\s*\/\/?\s*the per-tier idle timeout fires/,
    );
  });
});
