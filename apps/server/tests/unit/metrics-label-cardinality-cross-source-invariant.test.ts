// Every metric label key registered anywhere must be enum-shaped.
//
// `services/metrics-registry.ts` states the rule in its own header:
//
//   "Label cardinality: callers MUST keep label values bounded (enum-like).
//    The registry doesn't enforce this — it would punish legitimate dynamic
//    label use — but high-cardinality labels (account_id, session_id) WILL
//    blow up the scrape size."
//
// That comment is already pinned, by `services-metrics-registry-content-parity`.
// Pinning the comment freezes what the file SAYS; it cannot notice a caller
// registering `['account_id']` tomorrow. This file checks the thing the comment
// is about.
//
// Why it is worth a guard rather than trust: the registry keys each series by a
// composite of its label VALUES in a `Map` that is never evicted. An enum-shaped
// label costs a bounded number of entries forever; one per-account or per-session
// label costs one entry per account or session, for the life of the process. The
// failure mode is not a wrong number — it is a control plane whose memory climbs
// until it is restarted, and a Prometheus scrape that grows with the customer
// base. Silent until it is an outage, and invisible to every functional test.
//
// The registry deliberately does NOT enforce this at runtime (the comment
// explains why: it would punish legitimate dynamic label use). So the enforcement
// has to live here, at the registration sites, where the keys are literals.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const REGISTRATION_START = /register(?:Counter|Gauge|Histogram)\s*\(/g;
/** The trailing array literal of a registration call is its labelKeys. */
const TRAILING_ARRAY = /\[([^\]]*)\]\s*,?\s*$/s;

/**
 * The argument list of the call opening at `open`, found by balancing parens
 * while skipping string literals.
 *
 * ⛔ This replaced `/register…\((.*?)\);/gs`, and the difference is not style.
 * Non-greedy `.*?` stops at the FIRST `);` — including one inside the HELP
 * STRING, which is prose and routinely contains parentheses. Measured: the
 * LiveKit mint counter's help text ended a clause with `…/livekit-token (LK.3);`,
 * so the captured body stopped before the label array, `TRAILING_ARRAY` found
 * nothing, and that registration contributed ZERO keys.
 *
 * It was invisible in both directions. The recorded key list below was pinned at
 * 16 when the truth was 17 — a pin frozen around an extraction bug reads exactly
 * like a pin frozen around a fact. Worse, the CRITICAL unbounded-key arm never
 * saw those keys either: a counter registered with `['session_id']` would have
 * passed silently for as long as its help text contained a `);`. That arm exists
 * because such a label costs one never-evicted map entry per session forever.
 *
 * Found only because an unrelated edit removed the `);` from that help string and
 * the pin went red for what looked like the wrong reason.
 */
function argumentList(text: string, open: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i]!;
    if (quote !== null) {
      if (c === '\\') {
        i += 1;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

interface Registration {
  file: string;
  /** First argument as written, e.g. `METRIC_NAMES.unhandledRejectionTotal`. */
  metric: string;
  labelKeys: string[];
}

function collectRegistrations(): Registration[] {
  const found: Registration[] = [];
  for (const file of sourceFiles(SRC)) {
    if (file.endsWith('metrics-registry.ts')) continue; // the definition itself
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(REGISTRATION_START)) {
      const body = argumentList(text, text.indexOf('(', match.index + match[0].length - 1));
      if (body === null) continue;
      const arr = TRAILING_ARRAY.exec(body.trim());
      const labelKeys = arr === null ? [] : [...arr[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
      const metric = (body.split(',')[0] ?? '').trim();
      found.push({ file, metric, labelKeys });
    }
  }
  return found;
}

/**
 * Keys whose value space grows with usage rather than with the code. `_id`
 * covers the two the registry names by example; the rest are the near
 * neighbours that would cost exactly the same way.
 */
function isUnbounded(key: string): boolean {
  if (key === 'id' || key.endsWith('_id')) return true;
  return [
    'uuid',
    'email',
    'ip',
    'token',
    'url',
    'path',
    'user',
    'account',
    'session',
    'customer',
    'hash',
  ].includes(key);
}

/**
 * Registrations that deliberately carry no labels. One entry today: a process-wide
 * counter with nothing to break down by. Recorded rather than pattern-matched so
 * that a site yielding zero keys is either a stated decision or a broken parse,
 * and never ambiguous.
 */
const LABELLESS_METRICS: readonly string[] = ['METRIC_NAMES.unhandledRejectionTotal'];

describe('metric label cardinality', () => {
  const registrations = collectRegistrations();

  it('the scan actually finds the registration sites — a regex that matched nothing would pass every assertion below', () => {
    // Anti-vacuity. These floors are deliberately below the current counts (22
    // sites, 16 distinct keys) so ordinary additions do not trip them, while a
    // scan that silently stops matching does.
    expect(registrations.length).toBeGreaterThanOrEqual(18);
    const distinct = new Set(registrations.flatMap((r) => r.labelKeys));
    expect(distinct.size).toBeGreaterThanOrEqual(12);
  });

  it('CRITICAL no registered label key is identifier-shaped. The registry keys each series by its label VALUES in a Map that is never evicted, so one per-account or per-session label costs an entry per account for the life of the process — memory that climbs until restart and a scrape that grows with the customer base, invisible to every functional test.', () => {
    const offenders = registrations
      .flatMap((r) => r.labelKeys.map((key) => ({ key, file: r.file })))
      .filter(({ key }) => isUnbounded(key))
      .map(({ key, file }) => `${key} (${file.slice(file.indexOf('/src/') + 1)})`);
    expect(offenders).toEqual([]);
  });

  it("CRITICAL every registration yields label keys, or is recorded as deliberately label-less. The two floors above count SITES and DISTINCT KEYS, and a truncated parse reduces neither — it empties one site's list while the site is still found and the other twenty still contribute keys. That is exactly how a `);` inside a help string hid a registration from the identifier-shaped-key arm: 21 sites still matched, 16 distinct keys still exceeded the floor of 12, and the one site that mattered contributed nothing. Floor the EXTRACTION, not just the discovery.", () => {
    // ⛔ Keyed on the METRIC, not the file. Keyed on the file, this arm was
    // vacuous: the one deliberately label-less counter lives in bootstrap.ts, so
    // the exemption covered EVERY registration in bootstrap.ts — 12 of the 22.
    // Caught by mutation, not by review: deleting a real label array left the arm
    // green.
    const unexplained = registrations
      .filter((r) => r.labelKeys.length === 0 && !LABELLESS_METRICS.includes(r.metric))
      .map((r) => `${r.metric} (${r.file.slice(r.file.indexOf('/src/') + 1)})`);
    expect(
      unexplained,
      'registration(s) yielding no label keys — either the parse broke on this site or the metric is genuinely label-less and belongs in LABELLESS_METRICS:',
    ).toEqual([]);
    // Rot: a recorded exemption that gains labels must leave the list, or the
    // roster grows a fossil that makes the guard look more thorough than it is.
    expect(
      LABELLESS_METRICS.filter(
        (m) => !registrations.some((r) => r.metric === m && r.labelKeys.length === 0),
      ),
      'recorded label-less metric(s) that now carry labels — remove the entry:',
    ).toEqual([]);
  });

  it('records the label keys in use, so adding one is a visible decision rather than a silent widening', () => {
    const distinct = [...new Set(registrations.flatMap((r) => r.labelKeys))].sort();
    // Exact, not a superset: a new key should red this and be acknowledged. The
    // arm above decides whether it is ALLOWED; this one makes it noticed.
    expect(distinct).toEqual([
      'actor_type',
      'arm',
      'bucket',
      'from',
      'job_type',
      'kind',
      'limiter',
      'method',
      'outcome',
      'prefix',
      'result_kind',
      'role',
      'route',
      'status_class',
      'template',
      'terminal_state',
      'to',
    ]);
  });
});
