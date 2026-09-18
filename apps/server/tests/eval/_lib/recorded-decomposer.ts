// The RECORDED planner tier: the REAL `ClaudeAgentDecomposer` driven by a
// replaying fetch. It exercises the real response parsing, the real plan cut at
// MAX_PLAN_INTENTS, the real selector validation and the real usage accounting —
// with no network, no key and no non-determinism.
//
// ⛔ THIS REPOSITORY CARRIES NO RECORDINGS, AND THE BASELINE SAYS SO. A
// recording is the model's own output on a given day; authoring one by hand and
// filing it under `recordings/` would be a fabricated record that verifies
// green — internally consistent, externally false. Producing real ones needs a
// live call, which the harness's own rules put out of scope for this change. So
// `recordings/` is empty, `plannerMode` in the baseline is `scripted`, and
// `loadRecordings` REFUSES rather than degrading to something that looks like a
// recorded number. The unmeasured case stays failing.
//
// KEEPING RECORDINGS HONEST once they exist:
//  1. `promptSha256` is recomputed from the CURRENT system prompt on every run.
//     A mismatch names the repair as RE-RECORD THE EVAL FIXTURES — never "update
//     the pin". A pin that is edited to match is worse than no pin, because it
//     certifies stale evidence as current.
//  2. `requestDigest` is the digest of the request the decomposer ACTUALLY
//     builds. The replaying fetch compares and refuses on mismatch instead of
//     serving the recording, so a prompt or message-assembly change cannot be
//     answered with a reply to a different question.
//  3. Superseded recordings are kept, never overwritten. When a prompt change
//     flips a task's outcome, the PAIR of recordings is the evidence.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { __TEST_ONLY__ } from '../../../src/services/agent-decomposer-claude.js';

export interface EvalRecording {
  taskId: string;
  recordedAt: string;
  model: string;
  promptSha256: string;
  requestDigest: string;
  /** The Anthropic response envelope exactly as it came back. */
  responseBody: unknown;
}

export class RecordedPlannerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordedPlannerUnavailableError';
  }
}

export class RecordingMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordingMismatchError';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** The hash of the live system prompt, recomputed every run — never read from a file. */
export function currentPromptSha256(): string {
  return sha256(__TEST_ONLY__.SYSTEM_PROMPT);
}

/**
 * Digest of the request the decomposer builds, over the three fields that decide
 * what the model was actually asked: model, system prompt, messages. Deliberately
 * NOT the whole body — `max_tokens` and `stream` are transport knobs whose change
 * does not invalidate a recorded answer, and folding them in would force a
 * re-record for a reason that is not about the question.
 */
export function digestRequestBody(bodyText: string): string {
  const parsed = JSON.parse(bodyText) as {
    model?: unknown;
    system?: unknown;
    messages?: unknown;
  };
  return sha256(
    JSON.stringify({
      model: parsed.model,
      system: parsed.system,
      messages: parsed.messages,
    }),
  );
}

/**
 * A fetch that serves exactly one recorded reply, and only to the question it
 * was recorded for.
 *
 * ⛔ THE COMPARISON IS THE POINT. Serving the recording regardless of what was
 * asked would make every prompt change invisible and every completion number a
 * statement about a request nobody made.
 */
export function replayingFetch(recording: EvalRecording): typeof globalThis.fetch {
  const impl = (_url: string | URL, init?: RequestInit): Promise<Response> => {
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const digest = digestRequestBody(bodyText);
    if (digest !== recording.requestDigest) {
      return Promise.reject(
        new RecordingMismatchError(
          `the request does not match the recording for ${recording.taskId} (built ${digest}, recorded ${recording.requestDigest}) — RE-RECORD THE EVAL FIXTURES; do not edit the digest`,
        ),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(recording.responseBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return impl as unknown as typeof globalThis.fetch;
}

/**
 * Load every recording in `dir`.
 *
 * Returns an EMPTY map when the directory holds none. Callers must treat that as
 * "the recorded tier is unavailable" — never as "the recorded tier passed".
 */
export function loadRecordings(dir: string): Map<string, EvalRecording> {
  const out = new Map<string, EvalRecording>();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const parsed = JSON.parse(readFileSync(resolve(dir, entry), 'utf8')) as EvalRecording;
    out.set(parsed.taskId, parsed);
  }
  return out;
}

/** The repair instruction, in one place so every failure says the same thing. */
export const RE_RECORD_INSTRUCTION =
  'RE-RECORD THE EVAL FIXTURES (run the live recorder against the fictional test sites, keep the superseded file) — do NOT edit the pin to match.';

/**
 * Check a recording against the live prompt. Returns null when current.
 *
 * ⚠️ The failure message must name the repair as a re-record. "Update the pin"
 * is how a harness rots: the number keeps rendering, and it is now a number
 * about a prompt that no longer exists.
 */
export function staleRecordingReason(recording: EvalRecording): string | null {
  const live = currentPromptSha256();
  if (recording.promptSha256 === live) return null;
  return `recording ${recording.taskId} was captured against system prompt ${recording.promptSha256.slice(0, 12)}… but the live prompt is ${live.slice(0, 12)}… — ${RE_RECORD_INSTRUCTION}`;
}
