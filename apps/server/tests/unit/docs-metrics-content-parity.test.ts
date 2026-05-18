// Arc 6 docs.metrics — `apps/docs/src/pages/reference/metrics.md`
// content parity. Pins the page against the metrics-registry catalog
// + the /metrics route source so any new counter or route rename
// breaks CI.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { METRIC_NAMES } from '../../src/services/metrics-registry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOCS_PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/reference/metrics.md');
const ROUTE_FILE = resolve(REPO_ROOT, 'apps/server/src/routes/metrics.ts');

describe('Arc 6 docs.metrics — apps/docs/src/pages/reference/metrics.md parity', () => {
  it('docs page file exists at the expected path', () => {
    expect(existsSync(DOCS_PAGE)).toBe(true);
  });

  const body = readFileSync(DOCS_PAGE, 'utf8');
  const routeSource = readFileSync(ROUTE_FILE, 'utf8');

  it('frontmatter declares the layout + title + description', () => {
    expect(body).toMatch(/layout: \.\.\/\.\.\/layouts\/DocLayout\.astro/);
    expect(body).toMatch(/title: Prometheus metrics/);
    expect(body).toMatch(/description: .+Prometheus-format scrape endpoint/i);
  });

  it('documents the GET /metrics endpoint that the route source exposes', () => {
    expect(routeSource).toMatch(/app\.get\('\/metrics'/);
    expect(body).toMatch(/GET \/metrics/);
  });

  it('documents the bearer-token auth gate (matches METRICS_SCRAPE_TOKEN env var name)', () => {
    expect(routeSource).toMatch(/scrapeToken/);
    expect(body).toMatch(/Bearer <METRICS_SCRAPE_TOKEN>/);
  });

  it('documents the 401 + 503 reject paths', () => {
    expect(body).toMatch(/401/);
    expect(body).toMatch(/503/);
  });

  it('documents the exposition format content-type', () => {
    expect(body).toMatch(/text\/plain; version=0\.0\.4/);
  });

  it('catalogue page covers every entry in METRIC_NAMES', () => {
    for (const metricName of Object.values(METRIC_NAMES)) {
      expect(body.includes(metricName), `docs page must reference ${metricName}`).toBe(true);
    }
  });

  it('mentions the bounded-cardinality invariant (no account-id labels)', () => {
    expect(body).toMatch(/bounded label/i);
    // Word-wrap may split "no" from "account-id labels" so allow any
    // whitespace in between including newlines.
    expect(body).toMatch(/no[\s\S]*?account-id labels/i);
  });

  it('linked from reference/errors.md cross-references section', () => {
    const errorsPath = resolve(REPO_ROOT, 'apps/docs/src/pages/reference/errors.md');
    const errors = readFileSync(errorsPath, 'utf8');
    expect(errors).toMatch(/\/reference\/metrics/);
  });
});
