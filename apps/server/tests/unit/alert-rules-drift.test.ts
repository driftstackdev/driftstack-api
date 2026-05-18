// Arc 4 Wave 2.B sub-slice 8.21 (v2-#8) — alert rules drift guard.
//
// Pins ops/alerts/driftstack.yml against METRIC_NAMES so renaming a
// counter without updating the alert rule breaks CI before the alert
// silently stops firing in prod.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { METRIC_NAMES } from '../../src/services/metrics-registry.js';

const ALERT_YAML_PATH = resolve(__dirname, '../../../../ops/alerts/driftstack.yml');

describe('Arc 4 Wave 2.B sub-slice 8.21 alert rules drift guard', () => {
  const yamlText = readFileSync(ALERT_YAML_PATH, 'utf-8');

  it('alert rules file mentions every counter from METRIC_NAMES at least once', () => {
    for (const metric of Object.values(METRIC_NAMES)) {
      expect(yamlText, `alert rules file must reference ${metric}`).toContain(metric);
    }
  });

  it('every metric reference in the alert YAML maps to a known METRIC_NAMES entry', () => {
    // Extract every `driftstack_*_total` token from the YAML; each
    // must be registered in METRIC_NAMES or this guard rejects.
    const knownMetrics = new Set<string>(Object.values(METRIC_NAMES));
    const tokens = new Set<string>(yamlText.match(/driftstack_[a-z_]+_total/g) ?? []);
    for (const t of tokens) {
      expect(knownMetrics.has(t), `unknown metric in alert YAML: ${t}`).toBe(true);
    }
  });

  it('every alert has summary + description annotations', () => {
    // Cheap structural check — every `alert:` line must be followed
    // (somewhere in the same group) by `summary:` and `description:`
    // lines. Catches forgotten annotations on new alerts.
    const alertLines = yamlText.split('\n').filter((l) => l.trim().startsWith('- alert:'));
    expect(alertLines.length).toBeGreaterThan(0);
    const summaryCount = (yamlText.match(/summary: /g) ?? []).length;
    const descCount = (yamlText.match(/description: /g) ?? []).length;
    expect(summaryCount).toBe(alertLines.length);
    expect(descCount).toBe(alertLines.length);
  });

  it('every alert declares a severity label', () => {
    const alertLines = yamlText.split('\n').filter((l) => l.trim().startsWith('- alert:'));
    const severityLines = (yamlText.match(/severity: /g) ?? []).length;
    expect(severityLines).toBe(alertLines.length);
  });
});
