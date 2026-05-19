// Wave 29-400 §1+§2 telemetry consumer — fork-side WTFLogAlways events
// parser + per-session aggregator. Per Tier-2 verdict 2026-05-19 (Option
// A locked), the GUI status panel lives in the Tauri shell window
// chrome and shows "spoofing was/wasn't applied" without injecting any
// DOM into the rendered page.
//
// Source schema: docs/internal/driftstack-telemetry-event-schema-for-
// gui-panel.md (Agent 1 → Agent 2 handoff). Reads WTFLogAlways stderr
// lines from the WebContent process tree, parses each per the documented
// regexes, and reduces them to a per-session status snapshot the GUI
// status panel renders.
//
// This module is pure-functional: no I/O, no Tauri / WebSocket / IPC.
// Those land in a separate slice when the harness daemon ↔ Tauri shell
// channel spec lands (file 07). Keeps the regex + state-machine core
// unit-testable in isolation.

/** Atlas slot — the V-510 lookup serves from one of two memory-mapped
 *  segments. Priority = auto-learn-pre-seeded; main = the base atlas. */
export type AtlasSlot = 'main' | 'priority';

/** Per-context AFP fallback fire site (Wave 29-399 §1). */
export type AfpContext = 'toDataURL' | 'toBlob' | 'Worker';

/** Per-context probe-signature emission (Wave 29-399 §2). */
export type ProbeSigContext = 'toDataURL' | 'toBlob' | 'Worker';

/** Hook identifiers for the per-WebKit-hook fire counters. Mirrors the
 *  existing `[Driftstack-VNNN]` log tag families. */
export type HookTag = 'V185' | 'V184' | 'V241' | 'V166-DASA' | 'V374' | 'V375' | 'V186';

/** Initial atlas inventory state (one entry per slot). */
export interface AtlasSlotState {
  loaded: boolean;
  bytes: number;
  entryCount: number;
  format: string | null;
  fileMtimeEpoch: number | null;
  path: string | null;
}

/** Per-session aggregated state surfaced to the GUI status panel. */
export interface SessionTelemetryState {
  /** From the Archetype init event, e.g. "iphone17_ios18_7_safari26_4". */
  archetypeId: string | null;
  atlas: Record<AtlasSlot, AtlasSlotState>;
  /** V-510 atlas-substitution hits per slot. Cap mirrors the fork's
   *  per-process 50-hit log throttle — we still count log lines but
   *  the fork stops emitting past 50. */
  v510Hits: Record<AtlasSlot, number>;
  /** Hook fires per V-tag (V-185 / V-184 / V-241 / V-166-DASA / etc). */
  hookFires: Record<HookTag, number>;
  /** AFP fallback fires per context (W29399 §1). */
  afpFires: Record<AfpContext, number>;
  /** Probe-signature emissions per context (W29399 §2). When
   *  DRIFTSTACK_PROBE_SIGNATURE_EMIT=1 lights up. */
  probeSigEmissions: Record<ProbeSigContext, number>;
  /** Lines the parser skipped because they didn't match any known
   *  schema entry. Useful as a drift signal — bump when the fork ships
   *  a new event we don't recognise. */
  unknownLines: number;
}

export function emptySessionTelemetryState(): SessionTelemetryState {
  const emptySlot = (): AtlasSlotState => ({
    loaded: false,
    bytes: 0,
    entryCount: 0,
    format: null,
    fileMtimeEpoch: null,
    path: null,
  });
  return {
    archetypeId: null,
    atlas: { main: emptySlot(), priority: emptySlot() },
    v510Hits: { main: 0, priority: 0 },
    hookFires: {
      V185: 0,
      V184: 0,
      V241: 0,
      'V166-DASA': 0,
      V374: 0,
      V375: 0,
      V186: 0,
    },
    afpFires: { toDataURL: 0, toBlob: 0, Worker: 0 },
    probeSigEmissions: { toDataURL: 0, toBlob: 0, Worker: 0 },
    unknownLines: 0,
  };
}

// Regex per event family. Each captures only the fields the
// aggregator needs (slot, context, archetype) — we discard
// per-entry op/len/etc. since they don't surface on the panel.
const RX_V510_HIT = /\[Driftstack-V510-HIT\] slot=(main|priority)\b/;
const RX_ATLAS_MAPPED =
  /\[Driftstack\] V510Atlas\[(main|priority)\]: mapped (\d+) from (\S+); (\d+) entries; format=(\S+); file_mtime=(\d+)/;
const RX_ATLAS_NOT_PRESENT =
  /\[Driftstack\] V510Atlas\[(main|priority)\]: not present at (\S+) — disabled/;
const RX_AFP_FALLBACK =
  /\[Driftstack-W29399-S1-AFP-Fallback-Fired\] context=(toDataURL|toBlob|Worker)\b/;
const RX_PROBE_SIG = /\[Driftstack-W29399-S2-ProbeSig-(toDataURL|toBlob|Worker)\b/;
const RX_HOOK = /\[Driftstack-(V185|V184|V241|V166-DASA|V374|V375|V186)\]/;
const RX_ARCHETYPE_INIT = /\[Driftstack-Archetype-Init\] archetype=(\S+)/;

/** Apply a single WTFLogAlways stderr line to the state in-place,
 *  returning the updated reference for chaining. Unknown lines
 *  increment `unknownLines`; the state object is otherwise untouched.
 *  The fork emits one event per line; multi-line events are not
 *  expected (and would currently break the parser — defer until any
 *  such event ships). */
export function applyEventLine(state: SessionTelemetryState, line: string): SessionTelemetryState {
  // Cheap prefix-gate to skip non-driftstack lines (most WebKit stderr).
  if (!line.includes('[Driftstack')) return state;

  const v510Hit = RX_V510_HIT.exec(line);
  if (v510Hit && v510Hit[1]) {
    const slot = v510Hit[1] as AtlasSlot;
    state.v510Hits[slot] += 1;
    return state;
  }

  const atlasMapped = RX_ATLAS_MAPPED.exec(line);
  if (atlasMapped && atlasMapped[1]) {
    const slot = atlasMapped[1] as AtlasSlot;
    state.atlas[slot] = {
      loaded: true,
      bytes: Number(atlasMapped[2]),
      path: atlasMapped[3] ?? null,
      entryCount: Number(atlasMapped[4]),
      format: atlasMapped[5] ?? null,
      fileMtimeEpoch: Number(atlasMapped[6]),
    };
    return state;
  }

  const atlasNotPresent = RX_ATLAS_NOT_PRESENT.exec(line);
  if (atlasNotPresent && atlasNotPresent[1]) {
    const slot = atlasNotPresent[1] as AtlasSlot;
    state.atlas[slot] = {
      loaded: false,
      bytes: 0,
      entryCount: 0,
      format: null,
      fileMtimeEpoch: null,
      path: atlasNotPresent[2] ?? null,
    };
    return state;
  }

  const afp = RX_AFP_FALLBACK.exec(line);
  if (afp && afp[1]) {
    const ctx = afp[1] as AfpContext;
    state.afpFires[ctx] += 1;
    return state;
  }

  const probe = RX_PROBE_SIG.exec(line);
  if (probe && probe[1]) {
    const ctx = probe[1] as ProbeSigContext;
    state.probeSigEmissions[ctx] += 1;
    return state;
  }

  const hook = RX_HOOK.exec(line);
  if (hook && hook[1]) {
    const tag = hook[1] as HookTag;
    state.hookFires[tag] += 1;
    return state;
  }

  const arch = RX_ARCHETYPE_INIT.exec(line);
  if (arch && arch[1]) {
    state.archetypeId = arch[1];
    return state;
  }

  state.unknownLines += 1;
  return state;
}

/** Reduce a full log stream to a single snapshot. Mostly useful for
 *  tests + recovery on attach-to-existing-session paths. */
export function reduceEventStream(lines: Iterable<string>): SessionTelemetryState {
  const state = emptySessionTelemetryState();
  for (const line of lines) applyEventLine(state, line);
  return state;
}

/** Spoofing status as surfaced on the panel. */
export type SpoofingStatus = 'active' | 'partial' | 'inactive';

/** Derive a coarse status from the aggregated state. Per the schema:
 *    active   — at least one substitution category fired
 *    partial  — atlas loaded but no hits AND no hook fires
 *    inactive — atlas not loaded AND no hook fires AND no AFP/probe */
export function deriveSpoofingStatus(state: SessionTelemetryState): SpoofingStatus {
  const anyV510Hits = state.v510Hits.main > 0 || state.v510Hits.priority > 0;
  const anyHookFires = Object.values(state.hookFires).some((n) => n > 0);
  const anyAfp = Object.values(state.afpFires).some((n) => n > 0);
  const anyProbeSig = Object.values(state.probeSigEmissions).some((n) => n > 0);
  if (anyV510Hits || anyHookFires || anyAfp || anyProbeSig) return 'active';
  const atlasLoaded = state.atlas.main.loaded || state.atlas.priority.loaded;
  if (atlasLoaded) return 'partial';
  return 'inactive';
}
