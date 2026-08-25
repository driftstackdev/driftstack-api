// W511.C — drift guard for apps/marketing-site/src/pages/docs/sdk-python.astro.
// V-704 Python SDK quickstart (companion to V-703 TypeScript). Drift
// here either changes the install path (would mislead pip users) or
// breaks the sync↔async parity commitment that's central to the SDK
// design.
//
//   • V-704 doc-comment framing + V-703 companion.
//   • Published PyPI pre-1.0 install with lockfile/constraint guidance.
//   • Python ≥ 3.10 + mypy --strict ready.
//   • Construct: Driftstack(api_key=os.environ[...]) + base_url override.
//   • Reuse client across process (httpx-pooled + thread/asyncio-safe).
//   • sessions.create no target URL, sessions.navigate to URL.
//   • 5-method session-drive surface: navigate / interact / wait /
//     capture / destroy (idempotent).
//   • iterate(limit=...) lazy cursor walker.
//   • DriftstackError + RateLimitError + ValidationError subclasses
//     with status / problem_type / message / problem dict.
//   • Sync↔async parity: AsyncDriftstack mirror.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/sdk-python.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W511.C apps/marketing-site/src/pages/docs/sdk-python.astro content parity', () => {
  const body = read(LIB);

  it("V-704 framing pinned: 'Python SDK quickstart. Companion to V-703 (TypeScript SDK). Same skeleton, Python-idiomatic examples. Pitched at teams running scrapers, data pipelines, or ML inference where Driftstack supplies the browser leg.' — pinned so the V-704 + V-703 cross-reference + the target-audience framing (scrapers / pipelines / ML inference) all survive (drift to dropping the V-703 anchor would orphan the sister-SDK reference)", () => {
    expect(body).toMatch(
      /\/\/ V-704 — Python SDK quickstart\. Companion to V-703 \(TypeScript SDK\)\.\s*\/\/ Same skeleton, Python-idiomatic examples\. Pitched at teams running\s*\/\/ scrapers, data pipelines, or ML inference where Driftstack supplies\s*\/\/ the browser leg\./,
    );
  });

  it('published PyPI pre-1.0 install and reproducibility guidance are pinned', () => {
    expect(body).toContain('python -m pip install driftstack-sdk');
    expect(body).toMatch(/published on PyPI and remains pre-1\.0 with an Alpha\s*classifier/);
    expect(body).toMatch(
      /Pin a compatible version in your requirements or lockfile for\s*reproducible deployments/,
    );
    expect(body).not.toMatch(/git checkout <exact-commit>|pip install \.\/packages\/sdk-python/);
  });

  it('SEO promises inline capture outputs, not a customer recordings API', () => {
    expect(body).toMatch(
      /description="Use the Driftstack Python SDK to start browser sessions and capture screenshots, DOM snapshots, or PDFs inline from sync or async Python\."/,
    );
    expect(body).not.toMatch(/pull recordings|recordings API/i);
  });

  it("Python ≥ 3.10 + mypy --strict + type-stubs commitment pinned: 'Python ≥ 3.10 is supported. The package ships type stubs; mypy --strict works against the public surface without further config.' — pinned so the 3.10-minimum + mypy-strict commitments survive (drift to a different Python floor would create marketing↔setup.cfg divergence; drift to dropping mypy --strict would let typed users question type completeness)", () => {
    expect(body).toMatch(
      /Python ≥ 3\.10 is supported\. The package ships type stubs;\s*<code>mypy --strict<\/code> works against the public surface\s*without further config\./,
    );
  });

  it("Construct-client framing pinned: 'from driftstack import Driftstack' + 'Driftstack(api_key=os.environ[\"DRIFTSTACK_API_KEY\"])' + base_url kwarg override comment + 'Reuse one client across your process. It is internally pooled via httpx and safe for concurrent use across threads or asyncio tasks.' — pinned so the import + env-var + base_url-override + httpx-pooled-reusable framing survives (drift to dropping the 'safe for concurrent use' guarantee would let users create unnecessary client churn)", () => {
    expect(body).toMatch(/from driftstack import Driftstack/);
    expect(body).toMatch(/client = Driftstack\(api_key=os\.environ\["DRIFTSTACK_API_KEY"\]\)/);
    expect(body).toMatch(/# base_url kwarg overrides the default https:\/\/api\.driftstack\.dev/);
    expect(body).toMatch(
      /Reuse one client across your process\. It is internally pooled\s*via <code>httpx<\/code> and safe for concurrent use across\s*threads or asyncio tasks\./,
    );
  });

  it('session-create no-target-URL framing pinned: \'The session-create call does not take a target URL. Drive the session to a URL with client.sessions.navigate(session_id, {"url": "https://example.com"}). Session ids are prefixed ses_.\' — pinned so the no-URL-on-create + separate-navigate + ses_-prefix commitments survive (drift to claiming session-create takes a URL would mislead customers about the API contract)', () => {
    expect(body).toMatch(
      /The session-create call does not take a target URL\. Drive the\s*session to a URL with\s*<code>client\.sessions\.navigate\(session_id, \{`\{"url": "https:\/\/example\.com"\}`\}\)<\/code>\./,
    );
    expect(body).toMatch(/Session ids are prefixed <code>ses_<\/code>\./);
  });

  it("5-method session-drive surface: navigate / interact / wait / capture / destroy (idempotent) + 'no built-in wait-until-terminal helper' framing — pinned so the 5-method surface + the explicit no-magic-wait-helper + idempotent-destroy commitments survive (drift to claiming a wait-until-terminal helper exists would mislead customers about the API; drift to dropping 'idempotent' on destroy would let customers fear double-destroy)", () => {
    expect(body).toMatch(
      /<code>navigate<\/code>, <code>interact<\/code>,\s*<code>wait<\/code>, <code>capture<\/code>/,
    );
    expect(body).toMatch(/There is no built-in &ldquo;wait until terminal&rdquo; helper —/);
    expect(body).toMatch(/client\.sessions\.destroy\(session\["id"\]\) {2}# idempotent/);
  });

  it("iterate() lazy-cursor walker pinned: 'iterate walks every cursor page and stops on next_cursor: null. The single-page form is client.sessions.list(...).' + sync + async forms — pinned so the iterate()-walks-all + list()-single-page distinction + sync/async sync↔async parity survive (drift to dropping the list() single-page form would force callers to use the iterator even when one page suffices)", () => {
    expect(body).toMatch(/for s in client\.sessions\.iterate\(limit=50\):/);
    expect(body).toMatch(/from driftstack import AsyncDriftstack/);
    expect(body).toMatch(/async for s in ac\.sessions\.iterate\(limit=50\):/);
    expect(body).toMatch(
      /<code>iterate<\/code> walks every cursor page and stops on\s*<code>next_cursor: null<\/code>\./,
    );
  });

  it('DriftstackError + RateLimitError + ValidationError RFC 9457 fields are pinned', () => {
    expect(body).toMatch(
      /Every SDK method raises a <code>DriftstackError<\/code> subclass\s*on non-2xx responses\. The exception carries\s*<code>status<\/code>, <code>problem_type<\/code> \(the RFC 9457\s*URI\), <code>message<\/code>, and <code>problem<\/code> \(the full\s*parsed problem dict, e\.g\. <code>exc\.problem\["retry_after_seconds"\]<\/code>\)\./,
    );
    expect(body).toMatch(/from driftstack\.errors import RateLimitError, ValidationError/);
  });

  it("Sync↔async parity framing pinned: 'Every method on Driftstack has a mirror on AsyncDriftstack. The async variant returns coroutines and async iterators; the sync variant blocks the caller. Pick the one that fits your runtime; do not mix them in a single call-chain.' — pinned so the 1:1-mirror commitment + the 'do not mix in single call-chain' guidance survive (drift to ambiguously claiming mixing is fine would invite event-loop pitfalls)", () => {
    expect(body).toMatch(
      /Every method on <code>Driftstack<\/code> has a mirror on\s*<code>AsyncDriftstack<\/code>\. The async variant returns\s*coroutines and async iterators; the sync variant blocks the\s*caller\. Pick the one that fits your runtime; do not mix them in\s*a single call-chain\./,
    );
  });

  it('6-related-doc cluster pins canonical API, crypto, TypeScript, webhook, cost and error-code destinations so every next-step remains discoverable', () => {
    expect(body).toMatch(/<a href="\/api-reference\/">Curated API map<\/a>/);
    expect(body).toMatch(/<a href="\/docs\/sdk-python-crypto-orders\/">Crypto orders<\/a>/);
    expect(body).toMatch(/<a href="\/docs\/sdk-typescript\/">TypeScript SDK<\/a>/);
    expect(body).toMatch(/<a href="\/docs\/webhooks\/">Webhooks<\/a>/);
    expect(body).toMatch(/<a href="\/docs\/cost-monitoring\/">Cost monitoring<\/a>/);
    expect(body).toMatch(/<a href="\/docs\/error-codes\/">Error codes<\/a>/);
    expect(body).not.toMatch(
      /href="\/(?:api-reference|docs\/sdk-python-crypto-orders|docs\/sdk-typescript|docs\/webhooks|docs\/cost-monitoring|docs\/error-codes)"/,
    );
    expect(body).toContain('complete interactive reference');
  });

  it('paid customer-key and Free desktop-device boundary is explicit', () => {
    expect(body).toContain('SDK automation requires an API-enabled paid tier');
    expect(body).toContain('<code>ds_live_…</code> customer API key');
    expect(body).toContain('<code>ds_test_…</code> device credential');
    expect(body).toContain('not an SDK');
    expect(body).toContain('sandbox key');
  });

  it("developers@driftstack.dev + 'within one business day' SLA pinned — pinned so the developer-channel routing + 1-business-day response commitment stays consistent across SDK pages (drift to a different SLA would create cross-page divergence)", () => {
    expect(body).toMatch(
      /<a href="mailto:developers@driftstack\.dev">developers@driftstack\.dev<\/a>\.\s*We respond within one business day\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
