// Every label an alert rule filters on actually exists on the metric.
//
// A PromQL selector that names a label the series does not carry matches
// NOTHING. It is not an error — Prometheus evaluates it happily, gets an empty
// vector, and the rule sits at zero forever. The alert page still exists, still
// appears in the rule list, still shows green. It simply cannot fire.
//
// Measured before writing this: renaming `outcome` to `result` on the
// email counter's registration in bootstrap.ts left the entire suite green
// (26,355 passing). `SecurityCriticalEmailFailing` filters on
// `outcome!="ok"`, so after that rename the one alert standing between a
// Postmark outage and customers permanently locked out of password reset
// would have matched zero series and never fired. Nothing anywhere noticed.
//
// The label names live in two files that have no reason to be edited together:
// the registration array in bootstrap.ts and a quoted string inside a YAML
// expression. There is no compiler across that boundary and no test was
// watching it, which is exactly the shape of gap that survives for months.
//
// Both directions are checked, because both break the alert:
//   - a matcher naming a label the metric does not have  -> matches nothing
//   - a `by (...)` grouping on a label no referenced metric has -> empty result
//
// Related: `emitted-metrics-are-registered-invariant` checks that the metric
// exists and is emitted from live code; this one checks that the alert can
// actually select it once it does.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const BOOTSTRAP = resolve(REPO_ROOT, 'apps/server/src/lib/bootstrap.ts');
const REGISTRY = resolve(REPO_ROOT, 'apps/server/src/services/metrics-registry.ts');
const ALERTS = resolve(REPO_ROOT, 'ops/alerts/driftstack.yml');

/** METRIC_NAMES key -> exported Prometheus series name. */
function promNames(): Map<string, string> {
  const src = readFileSync(REGISTRY, 'utf8');
  const out = new Map<string, string>();
  for (const m of src.matchAll(/(\w+):\s*'(driftstack_[a-z_]+)'/g)) out.set(m[1]!, m[2]!);
  return out;
}

/**
 * Series name -> the label set it is registered with.
 *
 * The whole `registerX(...)` call is captured and the LAST bracketed array
 * taken. Splitting on commas instead would truncate at the first comma inside
 * a help string — the first draft of this scan did exactly that and parsed
 * only 7 of 21 metrics, then reported ten mismatches that were all artifacts
 * of its own parser. A scan that half-works produces confident nonsense.
 */
function registeredLabels(): Map<string, Set<string>> {
  const src = readFileSync(BOOTSTRAP, 'utf8');
  const names = promNames();
  const out = new Map<string, Set<string>>();
  for (const m of src.matchAll(
    /register(?:Counter|Gauge|Histogram)\(\s*METRIC_NAMES\.(\w+)((?:[^()]|\([^()]*\))*)\)/gs,
  )) {
    const prom = names.get(m[1]!);
    if (prom === undefined) continue;
    const arrays = [...m[2]!.matchAll(/\[([^\]]*)\]/g)];
    const last = arrays.at(-1);
    out.set(
      prom,
      last === undefined
        ? new Set<string>()
        : new Set([...last[1]!.matchAll(/'([a-z_]+)'/g)].map((l) => l[1]!)),
    );
  }
  return out;
}

interface Rule {
  readonly name: string;
  readonly expr: string;
}

function rules(): Rule[] {
  const yaml = readFileSync(ALERTS, 'utf8');
  return [...yaml.matchAll(/- alert: (\w+)[\s\S]*?expr: \|\n([\s\S]*?)\n\s*(?:for|labels):/g)].map(
    (m) => ({ name: m[1]!, expr: m[2]! }),
  );
}

interface Matcher {
  readonly rule: string;
  readonly metric: string;
  readonly label: string;
}

/** Every `metric{label=…}` selector across every rule. */
function selectorMatchers(): Matcher[] {
  const out: Matcher[] = [];
  for (const { name, expr } of rules()) {
    for (const sel of expr.matchAll(/(driftstack_[a-z_]+)\{([^}]*)\}/g)) {
      for (const lm of sel[2]!.matchAll(/(\w+)\s*(?:=~|!~|!=|=)/g)) {
        out.push({ rule: name, metric: sel[1]!, label: lm[1]! });
      }
    }
  }
  return out;
}

describe('every label an alert filters on exists on the metric it selects', () => {
  it('CRITICAL the scans found real data on both sides. An empty label map or an empty matcher list would make every check below compare nothing to nothing and pass — and the bug being guarded is itself "the selector matched nothing", so a broken scan would hide the failure using the failure.', () => {
    const labels = registeredLabels();
    const matchers = selectorMatchers();

    expect(labels.size, 'metrics whose label set was parsed from bootstrap').toBe(promNames().size);
    expect(rules().length, 'alert rules parsed from the YAML').toBeGreaterThan(10);
    expect(matchers.length, 'label matchers found across all rules').toBeGreaterThan(5);
    expect(
      labels.get('driftstack_email_send_total'),
      'a known label set must survive the parse',
    ).toContain('outcome');
  });

  it('CRITICAL no rule filters on a label the metric does not carry. Such a selector matches an empty vector rather than erroring, so the rule evaluates to nothing forever: the alert still exists, still lists as healthy, and can never fire.', () => {
    const labels = registeredLabels();
    const wrong = selectorMatchers()
      .filter(({ metric, label }) => {
        const known = labels.get(metric);
        return known !== undefined && !known.has(label);
      })
      .map(
        ({ rule, metric, label }) =>
          `${rule}: ${metric}{${label}=…} — registered labels are [${[...(labels.get(metric) ?? [])].sort().join(', ')}]`,
      )
      .sort();

    expect(
      wrong,
      'alert selector(s) naming a label the metric is not registered with — the rule can never fire:',
    ).toEqual([]);
  });

  it('CRITICAL every selected metric is one this codebase actually registers. A rule naming a series that does not exist is the same silent nothing, and would slip past the check above because an unknown metric has no label set to contradict.', () => {
    const labels = registeredLabels();
    const unknown = [...new Set(selectorMatchers().map((m) => m.metric))]
      .filter((metric) => !labels.has(metric))
      .sort();

    expect(unknown, 'alert rule(s) selecting a metric this server never registers:').toEqual([]);
  });

  it('CRITICAL every `by (...)` grouping names a label at least one referenced metric carries. Grouping by a label nothing has collapses the result to an empty vector, which fails the same silent way as a bad matcher.', () => {
    const labels = registeredLabels();
    const bad: string[] = [];
    for (const { name, expr } of rules()) {
      const referenced = [...new Set(expr.match(/driftstack_[a-z_]+/g) ?? [])].filter((m) =>
        labels.has(m),
      );
      if (referenced.length === 0) continue;
      for (const group of expr.matchAll(/\bby\s*\(([^)]*)\)/g)) {
        for (const label of group[1]!.match(/\w+/g) ?? []) {
          if (referenced.every((m) => !labels.get(m)!.has(label))) {
            bad.push(`${name}: by (${label}) — no referenced metric carries it`);
          }
        }
      }
    }
    expect(bad.sort(), 'alert rule(s) grouping by a label no selected metric has:').toEqual([]);
  });
});
