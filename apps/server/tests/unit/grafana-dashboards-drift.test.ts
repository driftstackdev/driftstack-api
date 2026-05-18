// Arc 4 Wave 2.B sub-slice 8.22 (v2-#8) — Grafana dashboard drift guard.
//
// Pins ops/grafana/*.json against METRIC_NAMES so renaming a counter
// without updating the dashboard breaks CI before the panel silently
// goes blank in prod.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { METRIC_NAMES } from '../../src/services/metrics-registry.js';

const PAIR_MODE_PATH = resolve(__dirname, '../../../../ops/grafana/pair-mode-dashboard.json');
const BUNDLED_LLM_PATH = resolve(__dirname, '../../../../ops/grafana/bundled-llm-dashboard.json');

interface GrafanaDashboard {
  uid: string;
  title: string;
  panels: Array<{
    title: string;
    targets?: Array<{ expr?: string }>;
  }>;
}

describe('Arc 4 Wave 2.B sub-slice 8.22 Grafana dashboards drift guard', () => {
  const pairModeJson = readFileSync(PAIR_MODE_PATH, 'utf-8');
  const bundledLlmJson = readFileSync(BUNDLED_LLM_PATH, 'utf-8');
  const pairMode = JSON.parse(pairModeJson) as GrafanaDashboard;
  const bundledLlm = JSON.parse(bundledLlmJson) as GrafanaDashboard;

  it('pair-mode dashboard parses + has stable uid', () => {
    expect(pairMode.uid).toBe('driftstack-pair-mode');
    expect(pairMode.title).toContain('Pair-mode');
    expect(pairMode.panels.length).toBeGreaterThan(0);
  });

  it('bundled-llm dashboard parses + has stable uid', () => {
    expect(bundledLlm.uid).toBe('driftstack-bundled-llm');
    expect(bundledLlm.title).toContain('Bundled-LLM');
    expect(bundledLlm.panels.length).toBeGreaterThan(0);
  });

  it('pair-mode dashboard references driftstack_pair_mode_transition_total', () => {
    expect(pairModeJson).toContain(METRIC_NAMES.pairModeTransitionTotal);
  });

  it('bundled-llm dashboard references both bundled-LLM counters', () => {
    expect(bundledLlmJson).toContain(METRIC_NAMES.bundledLlmRequestTotal);
    expect(bundledLlmJson).toContain(METRIC_NAMES.bundledLlmErrorTotal);
  });

  it('every metric reference in either dashboard maps to a known METRIC_NAMES entry', () => {
    const knownMetrics = new Set<string>(Object.values(METRIC_NAMES));
    const tokens = new Set<string>([
      ...(pairModeJson.match(/driftstack_[a-z_]+_total/g) ?? []),
      ...(bundledLlmJson.match(/driftstack_[a-z_]+_total/g) ?? []),
    ]);
    for (const t of tokens) {
      expect(knownMetrics.has(t), `unknown metric in dashboard JSON: ${t}`).toBe(true);
    }
  });

  it('every panel target carries a non-empty expr', () => {
    for (const dashboard of [pairMode, bundledLlm]) {
      for (const panel of dashboard.panels) {
        for (const target of panel.targets ?? []) {
          expect(
            target.expr,
            `${dashboard.uid} panel '${panel.title}' is missing target.expr`,
          ).toBeTruthy();
          expect(target.expr?.length ?? 0).toBeGreaterThan(0);
        }
      }
    }
  });
});
