// Unknown keys on a harness intent RESULT are stripped and counted, not fatal.
//
// ⛔ WHY (2026-09-18). The harness shipped two result keys it considered additive
// (`focus_tap_unoccluded_checked` on send_keys, `hit_via_own_label` on perceive
// elements). Every per-intent result schema in schemas/harness-control-protocol.ts
// is `.strict()`, so until the control plane declared them EVERY such result
// failed its contract: typed steps failed, and pre-tap looks fell back to
// unchecked taps. Nobody was hurt only because no turn ran in the window. An
// additive key breaking a dispatch is an outage waiting to happen.
//
// The rule agreed with the harness owner (A3):
//   · a key we DECODE is validated exactly as before — a wrong type or value on
//     a known key is still a contract failure, and the strict schema still
//     rejects it;
//   · a key we do NOT model is removed from the value the executor sees (never
//     passed through: nothing downstream may act on a field it does not know),
//     and it is COUNTED, so an operator can see what the device started sending.
//
// HOW. The strict schemas are NOT loosened. This module walks the strict schema
// alongside the decoded value and drops every key that no schema at that
// position declares; the strict schema then parses what is left. So the
// known-key contract is byte-for-byte today's — union variant selection, literal
// discriminators, refinements and all — and the only new behaviour is that a
// key nothing declares no longer reaches the strict check.
//
// "Declared" is decided against the UNION of every variant at a position, not
// against the variant that ends up matching. A key that one variant declares is
// a key we decode; if it arrives on a variant that forbids it (e.g. navigate's
// `loadedAtTimeout: false`, or `results_visible` on a truncated search) that is a
// wrong value on a known key, and it must still fail — stripping it would let a
// strip-mode union silently re-route the result to another variant.
//
// Positions the walker cannot see into (z.unknown, z.record, passthrough,
// preprocess, anything it does not model) are left untouched, so the strict
// schema decides there exactly as it did before. Unmodelled means fail CLOSED.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { HarnessIntentName } from '../schemas/harness-control-protocol.js';
import type { Logger } from '../lib/logger.js';
import { METRIC_NAMES, type MetricsRegistry } from './metrics-registry.js';

/** Distinct unknown key paths tracked per result. A device can put any number
 *  of keys in an 8 MiB payload; past this the rest are still STRIPPED, just not
 *  individually named or counted, and `truncated` says so. */
export const UNKNOWN_RESULT_KEY_PATHS_MAX = 256;
/** Characters kept of one key name. Key names come from the device. */
export const UNKNOWN_RESULT_KEY_NAME_MAX_CHARS = 64;
/** Characters kept of one dotted path (a deep path of long names). */
export const UNKNOWN_RESULT_KEY_PATH_MAX_CHARS = 200;
/** Key paths named in one log line. The count rides alongside. */
export const UNKNOWN_RESULT_KEY_LOG_NAMES_MAX = 8;
/** Log the first result of each kind, then every Nth, with the running count. */
export const UNKNOWN_RESULT_KEY_LOG_EVERY = 100;
/** Distinct (intent, key set) kinds throttled individually. Past this, new kinds
 *  share one per-intent bucket — never evicting, so rotating key names cannot
 *  re-trigger the "first one" line, and never going silent either. */
export const UNKNOWN_RESULT_KEY_LOG_KINDS_MAX = 128;

/** Beyond this nesting the walker stops and leaves the value to the strict
 *  schema. Result schemas are a few levels deep; this guards a recursive one. */
const MAX_DEPTH = 32;

/** One accepted result that carried keys the control plane does not model. */
export interface UnknownResultKeysReport {
  readonly intent: HarnessIntentName;
  /** Distinct sanitised dotted paths, array indices collapsed to `[]` so 200
   *  perceive elements carrying one new key are ONE path, not 200. */
  readonly keyPaths: readonly string[];
  /** True when more than UNKNOWN_RESULT_KEY_PATHS_MAX distinct paths were seen. */
  readonly truncated: boolean;
}

export type UnknownResultKeysObserver = (report: UnknownResultKeysReport) => void;

export interface UnknownKeyPrune {
  /** The value with every undeclared key removed. The SAME reference as the
   *  input when nothing was removed, so the common case allocates nothing. */
  readonly value: unknown;
  readonly unknownKeyPaths: readonly string[];
  readonly truncated: boolean;
}

/**
 * A key name from the device, made safe for a log line: only `[A-Za-z0-9_-]`
 * survive (anything else becomes `?`, so a name cannot forge a path separator,
 * a newline or a terminal escape), and it is length-capped with a `~` marker.
 */
export function sanitiseKeyName(key: string): string {
  const clean = key.replace(/[^A-Za-z0-9_-]/g, '?');
  return clean.length > UNKNOWN_RESULT_KEY_NAME_MAX_CHARS
    ? `${clean.slice(0, UNKNOWN_RESULT_KEY_NAME_MAX_CHARS)}~`
    : clean;
}

function childPath(parent: string, key: string): string {
  const joined = parent === '' ? sanitiseKeyName(key) : `${parent}.${sanitiseKeyName(key)}`;
  return joined.length > UNKNOWN_RESULT_KEY_PATH_MAX_CHARS
    ? `${joined.slice(0, UNKNOWN_RESULT_KEY_PATH_MAX_CHARS)}~`
    : joined;
}

/** The schemas that can describe the value at one position, flattened out of
 *  unions and wrappers. `open` means some candidate accepts keys this walker
 *  cannot enumerate, so nothing at or below this position may be removed. */
interface Candidates {
  objects: z.AnyZodObject[];
  arrays: z.ZodArray<z.ZodTypeAny>[];
  tuples: z.ZodTuple[];
  open: boolean;
}

/** Schema kinds that cannot hold keys at all: they contribute nothing to a
 *  position that holds an object, and do not make it open. */
function isScalar(schema: z.ZodTypeAny): boolean {
  return (
    schema instanceof z.ZodString ||
    schema instanceof z.ZodNumber ||
    schema instanceof z.ZodBoolean ||
    schema instanceof z.ZodLiteral ||
    schema instanceof z.ZodEnum ||
    schema instanceof z.ZodNativeEnum ||
    schema instanceof z.ZodNull ||
    schema instanceof z.ZodUndefined ||
    schema instanceof z.ZodBigInt ||
    schema instanceof z.ZodDate ||
    schema instanceof z.ZodNaN ||
    schema instanceof z.ZodNever ||
    schema instanceof z.ZodVoid ||
    schema instanceof z.ZodSymbol
  );
}

function collect(schema: z.ZodTypeAny, into: Candidates, depth: number): void {
  if (depth > MAX_DEPTH) {
    into.open = true;
    return;
  }
  if (schema instanceof z.ZodObject) {
    const def = (schema as z.AnyZodObject)._def;
    // A passthrough object or one with a catchall accepts extra keys on
    // purpose; they are not "unknown" to it, so they are not ours to remove.
    if (def.unknownKeys === 'passthrough' || !(def.catchall instanceof z.ZodNever)) {
      into.open = true;
    } else {
      into.objects.push(schema as z.AnyZodObject);
    }
    return;
  }
  if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion) {
    for (const option of schema.options as readonly z.ZodTypeAny[]) {
      collect(option, into, depth + 1);
    }
    return;
  }
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    collect(schema.unwrap() as z.ZodTypeAny, into, depth + 1);
    return;
  }
  if (schema instanceof z.ZodDefault) {
    collect(schema.removeDefault() as z.ZodTypeAny, into, depth + 1);
    return;
  }
  if (schema instanceof z.ZodEffects) {
    // A preprocess rewrites the input BEFORE its inner schema sees it, so the
    // inner schema's keys say nothing about the raw value. Refinements and
    // transforms receive the raw value, so the inner schema describes it.
    if (schema._def.effect.type === 'preprocess') {
      into.open = true;
      return;
    }
    collect(schema.innerType() as z.ZodTypeAny, into, depth + 1);
    return;
  }
  if (schema instanceof z.ZodBranded) {
    collect(schema.unwrap() as z.ZodTypeAny, into, depth + 1);
    return;
  }
  if (schema instanceof z.ZodReadonly) {
    collect(schema._def.innerType as z.ZodTypeAny, into, depth + 1);
    return;
  }
  if (schema instanceof z.ZodPipeline) {
    collect(schema._def.in as z.ZodTypeAny, into, depth + 1);
    return;
  }
  if (schema instanceof z.ZodLazy) {
    collect(schema.schema as z.ZodTypeAny, into, depth + 1);
    return;
  }
  if (schema instanceof z.ZodIntersection) {
    collect(schema._def.left as z.ZodTypeAny, into, depth + 1);
    collect(schema._def.right as z.ZodTypeAny, into, depth + 1);
    return;
  }
  if (schema instanceof z.ZodArray) {
    into.arrays.push(schema as z.ZodArray<z.ZodTypeAny>);
    return;
  }
  if (schema instanceof z.ZodTuple) {
    into.tuples.push(schema as z.ZodTuple);
    return;
  }
  if (isScalar(schema)) return;
  // z.unknown / z.any / z.record / z.map / anything not modelled above: its keys
  // are data, or at least not something this walker can enumerate. Leave the
  // whole subtree to the strict schema — fail closed, exactly as before.
  into.open = true;
}

interface Acc {
  readonly paths: Set<string>;
  truncated: boolean;
}

function record(acc: Acc, path: string): void {
  if (acc.paths.has(path)) return;
  if (acc.paths.size >= UNKNOWN_RESULT_KEY_PATHS_MAX) {
    acc.truncated = true;
    return;
  }
  acc.paths.add(path);
}

function pruneAt(
  schemas: readonly z.ZodTypeAny[],
  value: unknown,
  path: string,
  acc: Acc,
  depth: number,
): unknown {
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return value;
  const at: Candidates = { objects: [], arrays: [], tuples: [], open: false };
  for (const schema of schemas) collect(schema, at, 0);
  if (at.open) return value;

  if (Array.isArray(value)) {
    if (at.arrays.length === 0 && at.tuples.length === 0) return value;
    let changed = false;
    const out = value.map((item: unknown, index) => {
      const elementSchemas: z.ZodTypeAny[] = at.arrays.map((a) => a.element);
      for (const tuple of at.tuples) {
        const positional = (tuple.items as readonly z.ZodTypeAny[])[index];
        const itemSchema = positional ?? (tuple._def.rest as z.ZodTypeAny | null);
        if (itemSchema !== null && itemSchema !== undefined) elementSchemas.push(itemSchema);
      }
      if (elementSchemas.length === 0) return item;
      const next = pruneAt(elementSchemas, item, `${path}[]`, acc, depth + 1);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }

  if (at.objects.length === 0) return value;
  let changed = false;
  const kept: Array<[string, unknown]> = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const declaredBy: z.ZodTypeAny[] = [];
    for (const object of at.objects) {
      const shape = object.shape as Record<string, z.ZodTypeAny>;
      // hasOwnProperty, not `in`: a device key named `__proto__` or
      // `constructor` must not read as declared through the prototype.
      if (Object.prototype.hasOwnProperty.call(shape, key)) {
        const declared = shape[key];
        if (declared !== undefined) declaredBy.push(declared);
      }
    }
    const here = childPath(path, key);
    if (declaredBy.length === 0) {
      record(acc, here);
      changed = true;
      continue;
    }
    const next = pruneAt(declaredBy, child, here, acc, depth + 1);
    if (next !== child) changed = true;
    kept.push([key, next]);
  }
  // Object.fromEntries defines own data properties, so even a key that could
  // touch a prototype via assignment cannot; only declared keys reach here.
  return changed ? Object.fromEntries(kept) : value;
}

/**
 * Remove every key the schema does not declare at its position, at every
 * nesting level the schema describes, and report the sanitised paths removed.
 * Pure: the input is never mutated.
 */
export function pruneUnknownKeys(schema: z.ZodTypeAny, value: unknown): UnknownKeyPrune {
  const acc: Acc = { paths: new Set(), truncated: false };
  const pruned = pruneAt([schema], value, '', acc, 0);
  return { value: pruned, unknownKeyPaths: [...acc.paths], truncated: acc.truncated };
}

/**
 * Counts and logs unknown result keys. One per process: bootstrap hands its
 * `observe` to the fleet registry, which threads it into every connection's
 * dispatch correlator.
 *
 * ⛔ THE METRIC IS LABELLED BY INTENT ONLY. The intent comes from the pending
 * dispatch (a closed server-side enum), never from the frame. Key names come
 * from the device and are unbounded, so they go in the rate-limited log line and
 * never in a label — one label value per key name would be a never-evicted series
 * per name the device ever sends.
 */
export class UnknownResultKeyReporter {
  private readonly kinds = new Map<string, number>();

  constructor(
    private readonly deps: {
      readonly metrics?: MetricsRegistry;
      readonly logger?: Logger | null;
    } = {},
  ) {}

  readonly observe: UnknownResultKeysObserver = (report) => {
    if (report.keyPaths.length === 0) return;
    try {
      this.deps.metrics?.inc(
        METRIC_NAMES.harnessIntentResultUnknownKeyTotal,
        { intent: report.intent },
        report.keyPaths.length,
      );
    } catch {
      /* metrics are best-effort: a broken registry must not fail the result */
    }
    const occurrences = this.throttle(report);
    if (occurrences === null) return;
    try {
      this.deps.logger?.warn(
        {
          component: 'harness-intent-result',
          event: 'intent_result_unknown_keys',
          intent: report.intent,
          unknownKeys: report.keyPaths.slice(0, UNKNOWN_RESULT_KEY_LOG_NAMES_MAX),
          unknownKeyCount: report.keyPaths.length,
          truncated: report.truncated,
          occurrences,
        },
        'harness intent result carried keys this control plane does not model — they were STRIPPED and the result was ACCEPTED; declare them in the result schema if the executor needs their value',
      );
    } catch {
      /* logging is best-effort for the same reason */
    }
  };

  /** First of each kind, then every Nth; the returned count is the running
   *  total for that kind, or null when this one is not logged. */
  private throttle(report: UnknownResultKeysReport): number | null {
    // Keyed on a digest of the sorted paths, not the paths themselves: a report
    // can carry 256 paths of ~200 chars (~51KB), and 128 retained kinds of that
    // would pin megabytes for a log throttle. A digest is 40 chars per kind.
    const digest = createHash('sha1')
      .update([...report.keyPaths].sort().join('\n'))
      .digest('hex');
    let kind = `${report.intent} ${digest}`;
    if (!this.kinds.has(kind) && this.kinds.size >= UNKNOWN_RESULT_KEY_LOG_KINDS_MAX) {
      // Overflow buckets are keyed by the closed intent enum, so at most one per
      // intent exists beyond the cap: bounded, and never fully silent.
      kind = `${report.intent} <overflow>`;
    }
    const next = (this.kinds.get(kind) ?? 0) + 1;
    this.kinds.set(kind, next);
    return next === 1 || next % UNKNOWN_RESULT_KEY_LOG_EVERY === 0 ? next : null;
  }
}
