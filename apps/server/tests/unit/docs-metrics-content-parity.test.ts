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

/**
 * Counters that are registered but deliberately NOT on the public catalogue
 * page, each with the reason and what makes it publishable.
 *
 * ⛔ THIS PAGE IS CUSTOMER-VISIBLE. It says "for operators, not API consumers",
 * which is guidance about who needs it, not a restriction on who can read it:
 * it ships on the public docs site with every other reference page. So the rule
 * "nothing customer-visible mentions AI credits before launch" applies to it
 * exactly as it applies to the OpenAPI document and the SDKs.
 *
 * ⛔ AND THE EXEMPTION IS TWO-SIDED, like every other roster in this suite. An
 * entry naming a metric that is not in METRIC_NAMES fails, and an entry whose
 * metric HAS reached the page fails too — so the day AI credits launch, the
 * table gains two rows and this map empties, rather than quietly outliving the
 * reason it was written.
 */
const WITHHELD_UNTIL_LAUNCH = new Map<string, string>([
  [
    METRIC_NAMES.aiCreditsShadowLostTotal,
    'AI credits are built and dark (DRIFTSTACK_AI_CREDITS_MODE defaults to off and no account is ' +
      'on them). Document it, and remove this entry, in the change that makes credits live.',
  ],
  [
    METRIC_NAMES.aiCreditsBoundExceededTotal,
    'Withheld for the same reason as the shadow-lost counter beside it: until AI credits launch, ' +
      'nothing a customer can read may name them.',
  ],
]);

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

  it('catalogue page covers every entry in METRIC_NAMES, except the ones withheld until their feature launches', () => {
    for (const metricName of Object.values(METRIC_NAMES)) {
      if (WITHHELD_UNTIL_LAUNCH.has(metricName)) continue;
      expect(body.includes(metricName), `docs page must reference ${metricName}`).toBe(true);
    }
  });

  it('CRITICAL every withheld metric really is absent from the page, and really is a metric. This page is on the PUBLIC docs site, so an entry here is a promise that a customer cannot read the name of an unreleased feature — and an entry naming a metric that no longer exists is an exemption that exempts nothing, which reads as reviewed and hides the next one.', () => {
    const catalogue = new Set<string>(Object.values(METRIC_NAMES));
    for (const [metricName, why] of WITHHELD_UNTIL_LAUNCH) {
      expect(catalogue.has(metricName), `${metricName} is withheld but not in METRIC_NAMES`).toBe(
        true,
      );
      expect(
        body.includes(metricName),
        `${metricName} is withheld (${why}) and yet appears on the public metrics page`,
      ).toBe(false);
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
