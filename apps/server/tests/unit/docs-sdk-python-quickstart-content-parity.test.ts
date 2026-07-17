// Drift guard for apps/docs/src/pages/sdk/python-quickstart.md.
// Pins the Python 3.10+ contract, the dual sync/async client shape,
// the httpx-backed framing, and the context-manager cleanup pattern.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/python-quickstart.md');
const PY_SDK_ERRORS = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/errors.py');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('docs sdk/python-quickstart content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('tier-limit subclass name is QuotaExceededError, NOT TierLimitError. The Python SDK names the tier-limit error class QuotaExceededError (only the TS SDK kept the historical TierLimitError name). A doc telling Python users to catch TierLimitError would raise ImportError/AttributeError (regression: the granular-handling list once named TierLimitError).', () => {
    // Source of truth: the Python SDK defines QuotaExceededError and NOT TierLimitError.
    const sdk = read(PY_SDK_ERRORS);
    expect(sdk).toMatch(/class QuotaExceededError\(/);
    expect(sdk).not.toMatch(/class TierLimitError\b/);

    // The doc must reference the class the Python SDK actually exports.
    expect(body).toMatch(/`QuotaExceededError`/);
    expect(body).not.toMatch(/`TierLimitError`/);
  });

  it('title + description front-matter pinned', () => {
    expect(body).toMatch(/title: Python quickstart/);
    expect(body).toMatch(
      /description: 5-minute getting-started for the driftstack-sdk Python client\. Sync \+ async/,
    );
  });

  it('Python 3.10+ version contract pinned: the SDK uses modern type hints + structural matches. Drift to dropping the version floor would surprise customers on 3.9 hitting parse errors', () => {
    expect(body).toMatch(/Python 3\.10\+ \(the SDK uses modern type hints \+ structural matches\)/);
  });

  it('dual sync (`Driftstack`) + async (`AsyncDriftstack`) client shape pinned: drift to silently dropping the async client would break FastAPI/asyncio integrations; drift to dropping sync would break script/Flask/Django consumers', () => {
    expect(body).toMatch(/sync \(`Driftstack`\) and async\s*\n?\s*\(`AsyncDriftstack`\) clients/);
    expect(body).toMatch(/off the same wire shape/);
  });

  it('install command pinned: pip + uv + poetry — 3 supported install paths. Drift to dropping uv or poetry would orphan customers using those package managers', () => {
    expect(body).toMatch(/pip install driftstack-sdk/);
    expect(body).toMatch(/uv add driftstack-sdk/);
    expect(body).toMatch(/poetry add driftstack-sdk/);
  });

  it('httpx-backed framing pinned: async client uses httpx.AsyncClient + opens pool inside `async with` + sync client uses synchronous httpx.Client with context-manager support. Drift to a different HTTP backend would surprise customers building on httpx-specific instrumentation', () => {
    expect(body).toMatch(/The async client is `httpx\.AsyncClient`-backed/);
    expect(body).toMatch(/only opens the\s+connection pool inside `async with`/);
    expect(body).toMatch(/synchronous `httpx\.Client`/);
  });

  it('context-manager cleanup pattern pinned: `with Driftstack(...) as client:` for explicit pool cleanup. Drift to dropping would normalize httpx connection-pool leaks in customer scripts', () => {
    expect(body).toMatch(/`with Driftstack\(\.\.\.\) as client:`/);
    expect(body).toMatch(/explicit pool cleanup/);
  });

  it('canonical session-lifecycle pattern pinned: with-block + create + navigate + capture + get_state + try/finally + destroy. Drift to skipping any step loses the session-driving template customers copy-paste', () => {
    expect(body).toMatch(/client\.sessions\.create\(\{"label": "demo"\}\)/);
    expect(body).toMatch(/client\.sessions\.navigate\(sid, \{"url": "https:\/\/example\.com"\}\)/);
    expect(body).toMatch(/client\.sessions\.capture\(sid, \{"kind": "screenshot"\}\)/);
    expect(body).toMatch(/client\.sessions\.get_state\(sid\)/);
    expect(body).toMatch(/client\.sessions\.destroy\(sid\)/);
  });

  it('paid SDK and Free desktop boundary plus actionable 403 detail are pinned', () => {
    expect(body).toMatch(/Any paid Driftstack tier, including Manual/);
    expect(body).toMatch(/A `ds_live_…` customer API key/);
    expect(body).toMatch(/restricted\s*\n?\s*`ds_test_…` device credential/);
    expect(body).toMatch(/err\.status == 403 and "apiAccess"/);
    expect(body).toMatch(/Upgrade to resume this key unless it was revoked or expired/);
  });
});
