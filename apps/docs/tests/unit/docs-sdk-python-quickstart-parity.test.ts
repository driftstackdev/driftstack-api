// W260.A — drift-guard for docs.driftstack.dev/sdk/python-quickstart.
// Previous revision:
//   - claimed `err.problem.type` / `err.problem.detail` / `err.request_id`
//     attributes; the live DriftstackError carries `problem_type` +
//     `problem: dict` (no request_id field).
//   - linked to /webhooks/signature-rotation, /sdk/async-patterns,
//     /api/idempotency — none of which exist.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/python-quickstart.md');
const ERRORS = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/errors.py');
const PYPROJECT = resolve(REPO_ROOT, 'packages/sdk-python/pyproject.toml');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W260.A docs/sdk/python-quickstart ↔ live Python SDK parity', () => {
  const doc = read(DOC);
  const errors = read(ERRORS);

  it('does not access fictional err.problem.type / err.problem.detail attributes', () => {
    expect(doc).not.toMatch(/err\.problem\.type\b/);
    expect(doc).not.toMatch(/err\.problem\.detail\b/);
  });

  it('error-handling sample uses fields that actually exist', () => {
    for (const field of ['err.status', 'err.problem_type', 'err.problem']) {
      expect(doc).toContain(field);
    }
    expect(errors).toMatch(/self\.status\s*=/);
    expect(errors).toMatch(/self\.problem_type\s*=/);
    expect(errors).toMatch(/self\.problem:\s*dict/);
  });

  it('does not claim an err.request_id attribute (not on the live class)', () => {
    expect(doc).not.toMatch(/err\.request_id\b/);
    expect(errors).not.toMatch(/self\.request_id\b/);
  });

  it('does not link to fictional docs pages', () => {
    expect(doc).not.toMatch(/\/webhooks\/signature-rotation/);
    expect(doc).not.toMatch(/\/sdk\/async-patterns/);
    expect(doc).not.toMatch(/\/api\/idempotency/);
  });

  it('every internal cross-link resolves to a real docs page', () => {
    const links = [...doc.matchAll(/\]\((\/[a-z0-9/-]+\/?)\)/g)]
      .map((m) => m[1]!)
      .filter((href) => /^\/(guides|webhooks|sdk|api|reference|quickstart)/.test(href));
    expect(links.length).toBeGreaterThan(2);
    const missing: string[] = [];
    for (const href of links) {
      const stem = href.replace(/^\//, '').replace(/\/$/, '');
      const candidates = [`${stem}.md`, `${stem}.astro`, `${stem}/index.md`, `${stem}/index.astro`];
      if (!candidates.some((c) => existsSync(resolve(REPO_ROOT, 'apps/docs/src/pages', c)))) {
        missing.push(href);
      }
    }
    expect(missing).toEqual([]);
  });

  it('Python version requirement matches pyproject.toml requires-python', () => {
    const pyproject = read(PYPROJECT);
    expect(pyproject).toMatch(/requires-python\s*=\s*['"]>=3\.10['"]/);
    expect(doc).toMatch(/Python 3\.10\+/);
  });

  it('cites both sync Driftstack + AsyncDriftstack as the live exports', () => {
    expect(doc).toMatch(/from driftstack import Driftstack\b/);
    expect(doc).toMatch(/from driftstack import AsyncDriftstack\b/);
    const init = read(resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/__init__.py'));
    expect(init).toMatch(/Driftstack\b/);
    expect(init).toMatch(/AsyncDriftstack\b/);
  });

  it('cites verify_webhook_signature as the live signature-helper export', () => {
    expect(doc).toMatch(/verify_webhook_signature/);
    const sig = read(resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/webhook_signature.py'));
    expect(sig).toMatch(/def\s+verify_webhook_signature\b/);
  });

  it('W567: response models accessed by attribute, not dict-subscript (capture/get_state return pydantic models)', () => {
    // sessions.capture() / get_state() return CaptureResponse / SessionState
    // pydantic models — `screenshot["id"]` (no such field; BaseModel has no
    // __getitem__) would crash. Guard the prior bug + pin the real fields.
    expect(doc).not.toMatch(/screenshot\["id"\]/);
    expect(doc).not.toMatch(/state\["(url|title)"\]/);
    expect(doc).toMatch(/screenshot\.byte_size/);
    expect(doc).toMatch(/state\.url/);
  });

  it('pins the paid SDK prerequisite and actionable Free 403 branch', () => {
    expect(doc).toMatch(/Any paid Driftstack tier, including Manual/);
    expect(doc).toMatch(/A `ds_live_…` customer API key/);
    expect(doc).toMatch(/restricted\s*`ds_test_…` device credential/);
    expect(doc).toMatch(/err\.status == 403 and "apiAccess"/);
    expect(doc).toMatch(/Upgrade to resume this key unless it was revoked or expired/);
  });
});
