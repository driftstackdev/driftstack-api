// Accepts registerCounter OR registerGauge. The catalog was counter-only when
// this guard was written, so it hardcoded registerCounter; the first gauge to
// land (scheduledJobChainPending) would otherwise have failed a check that was
// really asserting "is registered at boot", not "is a counter". Widened rather
// than exempted — the property worth holding is registration, and a gauge that
// is emitted but never registered fails exactly as badly as a counter.
//
// Arc 7 obs cross-cutting — every counter in METRIC_NAMES MUST be
// pre-registered at BOTH the production bootstrap site AND the
// integration-test fixture. A new counter that lands the catalog
// + the call-site but forgets one of the two bootstrap-side
// registrations silently emits no data in that environment.
//
// This sweep test reads both files as text and asserts every
// METRIC_NAMES value appears as a `registerCounter(...)` argument.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { METRIC_NAMES } from '../../src/services/metrics-registry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const BOOTSTRAP_SRC = resolve(REPO_ROOT, 'apps/server/src/lib/bootstrap.ts');
const TEST_FIXTURE_SRC = resolve(
  REPO_ROOT,
  'apps/server/tests/integration/_helpers/build-test-app.ts',
);

describe('METRIC_NAMES ↔ bootstrap registration parity', () => {
  const bootstrap = readFileSync(BOOTSTRAP_SRC, 'utf8');
  const testFixture = readFileSync(TEST_FIXTURE_SRC, 'utf8');

  it('bootstrap.ts pre-registers every counter in METRIC_NAMES', () => {
    for (const [catalogKey, metricName] of Object.entries(METRIC_NAMES)) {
      // The registration sites use the catalog reference
      // (METRIC_NAMES.foo), not the string literal. Looking for the
      // catalog access form catches the canonical pattern.
      const ref = `METRIC_NAMES.${catalogKey}`;
      expect(
        bootstrap.includes(ref),
        `bootstrap.ts must pre-register ${catalogKey} (${metricName})`,
      ).toBe(true);
      // Plus the registerCounter call should appear in the same
      // file. Confirm by looking for `registerCounter(\n      METRIC_NAMES.foo,`
      // -ish; lenient on whitespace.
      expect(bootstrap).toMatch(
        new RegExp(`register(?:Counter|Gauge)\\(\\s*METRIC_NAMES\\.${catalogKey}\\b`, 's'),
      );
    }
  });

  it('build-test-app.ts pre-registers every counter in METRIC_NAMES', () => {
    for (const [catalogKey, metricName] of Object.entries(METRIC_NAMES)) {
      const ref = `METRIC_NAMES.${catalogKey}`;
      expect(
        testFixture.includes(ref),
        `build-test-app.ts must pre-register ${catalogKey} (${metricName})`,
      ).toBe(true);
      expect(testFixture).toMatch(
        new RegExp(`register(?:Counter|Gauge)\\(\\s*METRIC_NAMES\\.${catalogKey}\\b`, 's'),
      );
    }
  });

  it('METRIC_NAMES has at least the 15 counters Arc 7 obs.x landed', () => {
    // Sanity: catch accidental removals. Match the obs.1-obs.15
    // counter surface (some entries pre-date Arc 7, hence ≥15).
    expect(Object.keys(METRIC_NAMES).length).toBeGreaterThanOrEqual(15);
  });

  it('every METRIC_NAMES value follows the driftstack_* prefix convention', () => {
    for (const [catalogKey, metricName] of Object.entries(METRIC_NAMES)) {
      expect(metricName, `${catalogKey} must use the driftstack_ prefix`).toMatch(/^driftstack_/);
    }
  });

  it('METRIC_NAMES values are lowercase_snake_case (Prometheus convention)', () => {
    for (const [catalogKey, metricName] of Object.entries(METRIC_NAMES)) {
      expect(
        metricName,
        `${catalogKey}'s value must be lowercase_snake_case (Prometheus convention)`,
      ).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});
