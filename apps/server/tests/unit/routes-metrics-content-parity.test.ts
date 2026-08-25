// Drift guard for apps/server/src/routes/metrics.ts. Pins the Arc 4
// Wave 2.B sub-slice 8.18 GET /metrics Prometheus scrape — exposition-
// format content-type + METRICS_SCRAPE_TOKEN bearer auth + 503-on-
// missing-token + 401-on-mismatch + no-store on every outcome. Drift to a different content-type
// would make Prometheus / VictoriaMetrics scrapers reject the
// response; drift to a default-public-on-missing-token would leak
// internal counters.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/metrics.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('routes/metrics content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("Arc 4 Wave 2.B sub-slice 8.18 module-level framing pinned: 'GET /metrics Prometheus scrape. Scraped by VictoriaMetrics / Prometheus / Grafana Agent. The content type is text/plain; version=0.0.4 per the exposition-format spec; scrapers reject anything else.' — pinned so the 8.18 anchor + 3-scraper-roster + exposition-format-spec-content-type contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ Arc 4 Wave 2\.B sub-slice 8\.18 \(v2-#8\) — GET \/metrics Prometheus scrape\./,
    );
    expect(body).toMatch(
      /\/\/ Scraped by VictoriaMetrics \/ Prometheus \/ Grafana Agent\. The content\s*\/\/ type is `text\/plain; version=0\.0\.4` per the exposition-format spec;\s*\/\/ scrapers reject anything else\./,
    );
  });

  it("METRICS_SCRAPE_TOKEN bearer-auth framing pinned: 'bearer-token gated by METRICS_SCRAPE_TOKEN env var. The route is exposed publicly (so external scrapers can reach it without needing an internal-only path), but the token prevents unauthenticated readers from harvesting internal counters. The deploy bridge writes the token to /opt/driftstack/api/.env; the value is rotated on the same cadence as other internal credentials.' — pinned so the public-exposure + bearer-gates-harvesting + deploy-bridge-writes-env + cadence-rotation contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ Auth: bearer-token gated by METRICS_SCRAPE_TOKEN env var\. The route\s*\/\/ is exposed publicly \(so external scrapers can reach it without\s*\/\/ needing an internal-only path\), but the token prevents unauthenticated\s*\/\/ readers from harvesting internal counters\. The deploy bridge writes\s*\/\/ the token to \/opt\/driftstack\/api\/\.env; the value is rotated on the\s*\/\/ same cadence as other internal credentials\./,
    );
  });

  it("503-on-missing-config framing pinned: 'If METRICS_SCRAPE_TOKEN is unset, the route returns 503 — surfaces a missing-config bug early rather than silently exposing internals.' — pinned so the fail-closed-on-missing-config + surface-misconfig-early contract stays documented (drift to fail-open would let an unset env var silently expose counters)", () => {
    expect(body).toMatch(
      /\/\/ If METRICS_SCRAPE_TOKEN is unset, the route returns 503 — surfaces a\s*\/\/ missing-config bug early rather than silently exposing internals\./,
    );
  });

  it("MetricsRoutesDeps 2-field shape pinned: registry: MetricsRegistry + scrapeToken: string | null. Drift to dropping the null branch would force callers to invent a sentinel value to express 'no token wired'", () => {
    expect(body).toMatch(/export interface MetricsRoutesDeps \{/);
    expect(body).toMatch(/readonly registry: MetricsRegistry;/);
    expect(body).toMatch(/readonly scrapeToken: string \| null;/);
  });

  it('typed 503/401 branches retain constant-time comparison and Bearer challenge', () => {
    expect(body).toContain("reply.header('cache-control', 'no-store');");
    expect(body).toContain(
      "import { FeatureUnavailableError, UnauthorizedError } from '../lib/errors.js';",
    );
    expect(body).toContain('if (deps.scrapeToken === null || deps.scrapeToken.length === 0) {');
    expect(body).toContain(
      "throw new FeatureUnavailableError('Metrics scraping is not configured.');",
    );
    expect(body).toMatch(/import \{ timingSafeEqual \} from 'node:crypto';/);
    expect(body).toMatch(/const authz = req\.headers\.authorization;/);
    expect(body).toMatch(/const expected = `Bearer \$\{deps\.scrapeToken\}`;/);
    expect(body).toContain(
      'if (authzBuf.length !== expectedBuf.length || !timingSafeEqual(authzBuf, expectedBuf)) {',
    );
    expect(body).toContain("reply.header('www-authenticate', 'Bearer realm=\"metrics\"');");
    expect(body).toContain(
      "throw new UnauthorizedError('Metrics scrape token missing or invalid.');",
    );
    // Regression guard: the plain non-constant-time compare must not return.
    expect(body).not.toMatch(/if \(authz !== expected\)/);
    expect(body).not.toContain("return { error: 'unauthorized' };");
  });

  it("exposition-format content-type pinned: 'text/plain; version=0.0.4; charset=utf-8'. Drift to dropping the `version=0.0.4` parameter would make some scrapers reject the response (Prometheus checks the version parameter for protocol-version negotiation)", () => {
    expect(body).toMatch(
      /reply\.header\('content-type', 'text\/plain; version=0\.0\.4; charset=utf-8'\);\s*return deps\.registry\.render\(\);/,
    );
  });
});
