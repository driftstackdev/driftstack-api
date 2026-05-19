// Drift guard for apps/server/src/routes/metrics.ts. Pins the Arc 4
// Wave 2.B sub-slice 8.18 GET /metrics Prometheus scrape — exposition-
// format content-type + METRICS_SCRAPE_TOKEN bearer auth + 503-on-
// missing-token + 401-on-mismatch. Drift to a different content-type
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
      /\/\/ Scraped by VictoriaMetrics \/ Prometheus \/ Grafana Agent\. The content\s*\n?\s*\/\/ type is `text\/plain; version=0\.0\.4` per the exposition-format spec;\s*\n?\s*\/\/ scrapers reject anything else\./,
    );
  });

  it("METRICS_SCRAPE_TOKEN bearer-auth framing pinned: 'bearer-token gated by METRICS_SCRAPE_TOKEN env var. The route is exposed publicly (so external scrapers can reach it without needing an internal-only path), but the token prevents unauthenticated readers from harvesting internal counters. The deploy bridge writes the token to /etc/driftstack/api.env; the value is rotated on the same cadence as other internal credentials.' — pinned so the public-exposure + bearer-gates-harvesting + deploy-bridge-writes-env + cadence-rotation contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ Auth: bearer-token gated by METRICS_SCRAPE_TOKEN env var\. The route\s*\n?\s*\/\/ is exposed publicly \(so external scrapers can reach it without\s*\n?\s*\/\/ needing an internal-only path\), but the token prevents unauthenticated\s*\n?\s*\/\/ readers from harvesting internal counters\. The deploy bridge writes\s*\n?\s*\/\/ the token to \/etc\/driftstack\/api\.env; the value is rotated on the\s*\n?\s*\/\/ same cadence as other internal credentials\./,
    );
  });

  it("503-on-missing-config framing pinned: 'If METRICS_SCRAPE_TOKEN is unset, the route returns 503 — surfaces a missing-config bug early rather than silently exposing internals.' — pinned so the fail-closed-on-missing-config + surface-misconfig-early contract stays documented (drift to fail-open would let an unset env var silently expose counters)", () => {
    expect(body).toMatch(
      /\/\/ If METRICS_SCRAPE_TOKEN is unset, the route returns 503 — surfaces a\s*\n?\s*\/\/ missing-config bug early rather than silently exposing internals\./,
    );
  });

  it("MetricsRoutesDeps 2-field shape pinned: registry: MetricsRegistry + scrapeToken: string | null. Drift to dropping the null branch would force callers to invent a sentinel value to express 'no token wired'", () => {
    expect(body).toMatch(/export interface MetricsRoutesDeps \{/);
    expect(body).toMatch(/readonly registry: MetricsRegistry;/);
    expect(body).toMatch(/readonly scrapeToken: string \| null;/);
  });

  it('503 fail-closed branch pinned: scrapeToken null OR empty-string → 503 metrics scrape token not configured. + 401 wrong-bearer branch: authz mismatch → 401 unauthorized. Drift to dropping the empty-string branch would let a literally-empty token pass; drift to comparing tokens with !== (non-constant-time) on user-controlled input is acceptable here because the 503 fast-fail rejects before any comparison runs for the unset case', () => {
    expect(body).toMatch(
      /if \(deps\.scrapeToken === null \|\| deps\.scrapeToken\.length === 0\) \{\s*\n?\s*reply\.code\(503\);\s*\n?\s*return \{ error: 'metrics scrape token not configured' \};/,
    );
    expect(body).toMatch(
      /const authz = req\.headers\.authorization;\s*\n?\s*const expected = `Bearer \$\{deps\.scrapeToken\}`;\s*\n?\s*if \(authz !== expected\) \{\s*\n?\s*reply\.code\(401\);\s*\n?\s*return \{ error: 'unauthorized' \};/,
    );
  });

  it("exposition-format content-type pinned: 'text/plain; version=0.0.4; charset=utf-8'. Drift to dropping the `version=0.0.4` parameter would make some scrapers reject the response (Prometheus checks the version parameter for protocol-version negotiation)", () => {
    expect(body).toMatch(
      /reply\.header\('content-type', 'text\/plain; version=0\.0\.4; charset=utf-8'\);\s*\n?\s*return deps\.registry\.render\(\);/,
    );
  });
});
