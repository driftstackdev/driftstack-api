// Every metric the server emits is registered at boot.
//
// `MetricsRegistry.inc` throws on an unregistered counter. Emit sites therefore
// either take the process down or, where the call site guards itself, swallow
// the error and record nothing — and the second case is the dangerous one,
// because the metric simply never appears and the dashboard shows a flat line
// that looks exactly like "this never happens".
//
// Found by mutation while adding the retention-purge counter: deleting its
// `registerCounter` call from bootstrap turned nothing red. The counter is on
// an erasure path, so its emit is deliberately non-fatal — which means the
// registration going missing would have been undetectable at runtime AND in the
// suite. A guarded emit needs its registration checked somewhere else, and this
// is that somewhere.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SERVER_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const BOOTSTRAP = resolve(SERVER_SRC, 'lib', 'bootstrap.ts');
const REGISTRY = resolve(SERVER_SRC, 'services', 'metrics-registry.ts');

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Metric keys referenced at an emit site (`metrics.inc(METRIC_NAMES.x, …)`). */
function emitted(): string[] {
  const found = new Set<string>();
  for (const file of tsFilesUnder(SERVER_SRC)) {
    if (file === REGISTRY || file === BOOTSTRAP) continue;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\.(?:inc|observe|set)\(\s*METRIC_NAMES\.(\w+)/g)) {
      found.add(m[1]!);
    }
  }
  return [...found].sort();
}

/** Metric keys registered during boot. */
function registered(): string[] {
  const src = readFileSync(BOOTSTRAP, 'utf8');
  const found = new Set<string>();
  for (const m of src.matchAll(/register(?:Counter|Gauge|Histogram)\(\s*METRIC_NAMES\.(\w+)/g)) {
    found.add(m[1]!);
  }
  return [...found].sort();
}

/**
 * Service files the application never constructs. Kept in step with
 * `tick-services-are-wired-invariant`, which is the guard that establishes the
 * roster; this one only needs to know that emitting from these files does not
 * count as emitting at all.
 */
const UNWIRED_SOURCES = ['services/durable-webhook-delivery.ts'];

/** Metric keys emitted from at least one file the application actually runs. */
function emittedFromLiveCode(): Set<string> {
  const found = new Set<string>();
  for (const file of tsFilesUnder(SERVER_SRC)) {
    if (file === REGISTRY || file === BOOTSTRAP) continue;
    if (UNWIRED_SOURCES.some((u) => file.endsWith(u))) continue;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\.(?:inc|observe|set)\(\s*METRIC_NAMES\.(\w+)/g)) {
      found.add(m[1]!);
    }
  }
  return found;
}

describe('every emitted metric is registered at boot', () => {
  const emits = emitted();
  const regs = registered();

  it('CRITICAL the scan found emit sites and registrations. Either coming back empty would make the check below vacuously true — and the failure it guards is itself an absence, so a silent scan failure would hide exactly the same thing twice.', () => {
    expect(emits.length, 'metric keys referenced at emit sites').toBeGreaterThan(3);
    expect(regs.length, 'metric keys registered in bootstrap').toBeGreaterThan(3);
    expect(emits, 'a known emitted metric must survive the scan').toContain('rateLimitTotal');
  });

  it('CRITICAL no metric is emitted without being registered. An unregistered counter makes `inc` throw — fatal at an unguarded call site, and silently nothing at a guarded one, which leaves a dashboard showing a flat line indistinguishable from "this never happens".', () => {
    const unregistered = emits.filter((name) => !regs.includes(name));
    expect(
      unregistered.sort(),
      'metric(s) emitted but never registered in bootstrap — add a registerCounter/Gauge call:',
    ).toEqual([]);
  });

  it('CRITICAL no metric is emitted ONLY from code the application never runs. Both webhook delivery counters were registered at boot and emitted solely from DurableWebhookWorker, which is wired nowhere — so in production they could never increment. A dashboard showed a flat zero, which reads exactly like "no webhooks are configured", and a total delivery outage would have produced no signal at all.', () => {
    const live = emittedFromLiveCode();
    const deadOnly = regs.filter((name) => emits.includes(name) && !live.has(name)).sort();
    expect(
      deadOnly,
      'metric(s) whose only emit site is in an unwired service — emit them from the code that actually runs:',
    ).toEqual([]);
  });

  it('the retention-purge counter specifically is registered, since its emit is non-fatal by design and would otherwise fail invisibly', () => {
    expect(regs, 'retentionPurgeTotal must be registered at boot').toContain('retentionPurgeTotal');
  });
});
