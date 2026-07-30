import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const CONTRACT = resolve(REPO_ROOT, 'docs/internal/cross-agent-control-plane-contract.md');

describe('direct-login control-plane contract', () => {
  const body = readFileSync(CONTRACT, 'utf8');

  it('pins producer ownership and delivery-only correlator slack without claiming activation', () => {
    expect(body).toMatch(/Login targets an exact \*\*600,000ms producer wall \+/);
    expect(body).toMatch(/15,000ms delivery slack = 615,000ms correlation\*\*/);
    expect(body).toMatch(/not an\s*\n?early producer-loss detector/);
    expect(body).toMatch(
      /honest worker-first result is not yet proved to publish at or below\s*\n?600,000ms/,
    );
    expect(body).toMatch(
      /producer fence must make that public result bound executable before activation/,
    );
    expect(body).toMatch(/contract-only and does \*\*not\*\* activate public direct login/);
    expect(body).toMatch(/real\s*\n?direct driver consumes the intent/);
    expect(body).toMatch(/durable public\s*\n?operation transport spans the 615-second lifetime/);
    expect(body).toMatch(/SDK defaults, nginx and the proxied edge/);
    expect(body).toMatch(/mock-driver 200 is not capability\s*\n?evidence/);
    expect(body).toMatch(/currently shipped driver advertises a\s*\n?non-real login capability/);
    expect(body).toMatch(/route fails with 503 before session lookup or operation claim/);
    expect(body).not.toMatch(/615,000ms public request timeout/);
  });
});
