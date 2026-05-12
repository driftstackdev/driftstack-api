// W468.C — drift guard for apps/gui-client/src/lib/session-events.ts.
// V-534.C session-event diff layer. Drift here either breaks the
// terminated-as-distinct-event-kind detection (UI loses the
// dedicated 'session just ended' hook and has to re-derive
// terminal transitions from raw state-changed events) or drops
// the alphabetical-by-sessionId sort (consumer assertion test
// breaks when polling returns sessions in different orders
// across ticks).
//
//   • V-534.C framing pinned: 'session-event detection layer.' +
//     'Sessions don't yet have a server-side SSE feed; that needs
//     a control-plane slice to add a `/v1/sessions/stream`
//     endpoint (sister-tooling to the existing /v1/status/stream).
//     Until that lands, the GUI polls /v1/sessions/list and diffs
//     against the previous snapshot.'
//   • Drop-in-replacement framing pinned: 'Same shape as a real
//     SSE consumer would have, so swapping to a real SSE source
//     later is a drop-in replacement.'
//   • SessionEventKind 4-value union ('added'|'state-changed'|
//     'terminated'|'removed').
//   • SessionEvent 4-field (kind + sessionId + session 'AS OF the
//     snapshot that produced this event' framing + previousStatus
//     optional 'For state-changed').
//   • TERMINAL_STATUSES const tuple readonly ['destroyed',
//     'errored'].
//   • diffSessionSnapshots 4-rule framing JSDoc pinned (added +
//     state-changed + terminated 'Subset of state-changed;
//     surfaced separately for ergonomics — UIs typically want a
//     distinct hook for "session just ended".' + removed 'rare
//     in practice').
//   • Stable-ordering framing 'events are sorted by sessionId so
//     the same input produces the same output regardless of array
//     ordering between calls.' + 'Pure function — caller owns
//     snapshot storage.'
//   • SessionBuckets 3-field (active ready/busy + pending creating
//     + terminated destroyed/errored).
//   • subscribeSessionEvents framing pinned 'Polling cadence is
//     fixed at intervalMs; jitter is the caller's responsibility
//     if they need it. Errors from the snapshot source are
//     reported via onError; the loop continues running so a
//     transient failure doesn't kill the subscription.'
//   • subscribeSessionEvents: previousSnapshot accumulator + stopped
//     flag + onEvents only fires when events.length > 0 +
//     onError?.(err) optional chaining.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/session-events.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W468.C apps/gui-client/src/lib/session-events.ts content parity', () => {
  const body = read(LIB);

  it("V-534.C framing pinned: 'V-534.C — session-event detection layer.' + 'Sessions don't yet have a server-side SSE feed; that needs a control-plane slice to add a `/v1/sessions/stream` endpoint (sister-tooling to the existing /v1/status/stream). Until that lands, the GUI polls /v1/sessions/list and diffs against the previous snapshot.'", () => {
    expect(body).toMatch(/\/\/ V-534\.C — session-event detection layer\./);
    expect(body).toMatch(
      /\/\/ Sessions don't yet have a server-side SSE feed; that needs a control-\s*\n?\s*\/\/ plane slice to add a `\/v1\/sessions\/stream` endpoint \(sister-tooling\s*\n?\s*\/\/ to the existing \/v1\/status\/stream\)\. Until that lands, the GUI polls\s*\n?\s*\/\/ \/v1\/sessions\/list and diffs against the previous snapshot\./,
    );
  });

  it("Drop-in-replacement framing pinned: 'The diff layer means UI surfaces (V-534.D control panel, V-534.E stream view) can subscribe to per-session change events instead of re-rendering the entire list every tick. Same shape as a real SSE consumer would have, so swapping to a real SSE source later is a drop-in replacement.'", () => {
    expect(body).toMatch(
      /\/\/ The diff layer means UI surfaces \(V-534\.D control panel, V-534\.E\s*\n?\s*\/\/ stream view\) can subscribe to per-session change events instead of\s*\n?\s*\/\/ re-rendering the entire list every tick\. Same shape as a real SSE\s*\n?\s*\/\/ consumer would have, so swapping to a real SSE source later is a\s*\n?\s*\/\/ drop-in replacement\./,
    );
  });

  it("SessionEventKind 4-value union ('added'|'state-changed'|'terminated'|'removed'); SessionEvent 4-field (kind + sessionId + session 'AS OF the snapshot that produced this event. For removed, this is the PRIOR snapshot's row' + previousStatus optional 'For state-changed: the prior status. Undefined for other kinds.')", () => {
    expect(body).toMatch(
      /export type SessionEventKind = 'added' \| 'state-changed' \| 'terminated' \| 'removed';/,
    );
    expect(body).toMatch(
      /export interface SessionEvent \{\s*\n?\s*kind: SessionEventKind;\s*\n?\s*sessionId: string;\s*\n?\s*\/\*\* The session row AS OF the snapshot that produced this event\.\s*\n?\s*\*\s*For 'removed', this is the PRIOR snapshot's row \(the session\s*\n?\s*\*\s*is no longer in the new snapshot\)\. \*\/\s*\n?\s*session: Session;\s*\n?\s*\/\*\* For 'state-changed': the prior status\. Undefined for other kinds\. \*\/\s*\n?\s*previousStatus\?: Session\['status'\];\s*\n?\s*\}/,
    );
  });

  it("TERMINAL_STATUSES const ReadonlyArray<Session['status']> = ['destroyed', 'errored']", () => {
    expect(body).toMatch(
      /const TERMINAL_STATUSES: ReadonlyArray<Session\['status'\]> = \['destroyed', 'errored'\];/,
    );
  });

  it("diffSessionSnapshots JSDoc framing pinned: 4 rules (added + state-changed + terminated 'Subset of state-changed; surfaced separately for ergonomics — UIs typically want a distinct hook for \"session just ended\"' + removed 'happens when the server-side pagination evicted the row or the customer revoked access; rare in practice') + 'Stable ordering: events are sorted by sessionId so the same input produces the same output regardless of array ordering between calls.' + 'Pure function — caller owns snapshot storage.'", () => {
    expect(body).toMatch(
      /\*\s+- 'added': session exists in `next` but not `prev`\.\s*\n?\s*\*\s+- 'state-changed': session exists in both, status differs\.\s*\n?\s*\*\s+- 'terminated': session moved to a terminal status in this tick\.\s*\n?\s*\*\s+\(Subset of state-changed; surfaced separately for ergonomics —\s*\n?\s*\*\s+UIs typically want a distinct hook for "session just ended"\.\)/,
    );
    expect(body).toMatch(
      /\*\s+- 'removed': session existed in `prev` but is missing from `next`\.\s*\n?\s*\*\s+This happens when the server-side pagination evicted the row\s*\n?\s*\*\s+or the customer revoked access; rare in practice\./,
    );
    expect(body).toMatch(
      /\*\s*Stable ordering: events are sorted by sessionId so the same input\s*\n?\s*\*\s*produces the same output regardless of array ordering between calls\./,
    );
    expect(body).toMatch(/\*\s*Pure function — caller owns snapshot storage\./);
  });

  it("diffSessionSnapshots: isTerminating ternary (kind: 'terminated' : 'state-changed') for status-change branch + alphabetical sort events.sort((a,b) => a.sessionId.localeCompare(b.sessionId))", () => {
    expect(body).toMatch(
      /const isTerminating =\s*\n?\s*!TERMINAL_STATUSES\.includes\(prior\.status\) && TERMINAL_STATUSES\.includes\(session\.status\);\s*\n?\s*events\.push\(\{\s*\n?\s*kind: isTerminating \? 'terminated' : 'state-changed',\s*\n?\s*sessionId: id,\s*\n?\s*session,\s*\n?\s*previousStatus: prior\.status,\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /events\.sort\(\(a, b\) => a\.sessionId\.localeCompare\(b\.sessionId\)\);/,
    );
  });

  it("SessionBuckets 3-field: active 'Status === ready or busy. The session is running and the customer can interact with it.' + pending 'Status === creating. Session is provisioning; not yet interactive.' + terminated 'Status === destroyed or errored. Terminal state.'", () => {
    expect(body).toMatch(
      /export interface SessionBuckets \{\s*\n?\s*\/\*\* Status === 'ready' or 'busy'\. The session is running and the\s*\n?\s*\*\s*customer can interact with it\. \*\/\s*\n?\s*active: readonly Session\[\];\s*\n?\s*\/\*\* Status === 'creating'\. Session is provisioning; not yet\s*\n?\s*\*\s*interactive\. \*\/\s*\n?\s*pending: readonly Session\[\];\s*\n?\s*\/\*\* Status === 'destroyed' or 'errored'\. Terminal state\. \*\/\s*\n?\s*terminated: readonly Session\[\];\s*\n?\s*\}/,
    );
  });

  it("bucketSessions: terminated first via TERMINAL_STATUSES.includes; status === 'creating' → pending; else → active (the 'ready' / 'busy' default)", () => {
    expect(body).toMatch(
      /export function bucketSessions\(sessions: readonly Session\[\]\): SessionBuckets \{\s*\n?\s*const active: Session\[\] = \[\];\s*\n?\s*const pending: Session\[\] = \[\];\s*\n?\s*const terminated: Session\[\] = \[\];\s*\n?\s*for \(const s of sessions\) \{\s*\n?\s*if \(TERMINAL_STATUSES\.includes\(s\.status\)\) \{\s*\n?\s*terminated\.push\(s\);\s*\n?\s*\} else if \(s\.status === 'creating'\) \{\s*\n?\s*pending\.push\(s\);\s*\n?\s*\} else \{\s*\n?\s*active\.push\(s\);\s*\n?\s*\}\s*\n?\s*\}/,
    );
  });

  it("subscribeSessionEvents framing pinned: 'Polling cadence is fixed at intervalMs; jitter is the caller's responsibility if they need it. Errors from the snapshot source are reported via onError; the loop continues running so a transient failure doesn't kill the subscription.' + SubscribeOpts 4-field with intervalMs default 2000 + onError optional", () => {
    expect(body).toMatch(
      /\*\s*Polling cadence is fixed at `intervalMs`; jitter is the caller's\s*\n?\s*\*\s*responsibility if they need it\. Errors from the snapshot source\s*\n?\s*\*\s*are reported via `onError`; the loop continues running so a\s*\n?\s*\*\s*transient failure doesn't kill the subscription\./,
    );
    expect(body).toMatch(
      /\/\*\* Polling interval \(ms\)\. Default 2000\. \*\/\s*\n?\s*intervalMs\?: number;/,
    );
  });

  it('subscribeSessionEvents impl: previousSnapshot accumulator + stopped flag + events.length > 0 → opts.onEvents(events) gate + opts.onError?.(err) optional chaining; tick reschedules via !stopped setTimeout(tick, interval); return unsubscribe sets stopped + clearTimeout', () => {
    expect(body).toMatch(
      /export function subscribeSessionEvents\(opts: SubscribeOpts\): \(\) => void \{\s*\n?\s*const interval = opts\.intervalMs \?\? 2000;\s*\n?\s*let previousSnapshot: readonly Session\[\] = \[\];\s*\n?\s*let stopped = false;\s*\n?\s*let handle: ReturnType<typeof setTimeout> \| null = null;/,
    );
    expect(body).toMatch(
      /if \(events\.length > 0\) opts\.onEvents\(events\);\s*\n?\s*\} catch \(err\) \{\s*\n?\s*opts\.onError\?\.\(err\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /void tick\(\);\s*\n?\s*return \(\) => \{\s*\n?\s*stopped = true;\s*\n?\s*if \(handle !== null\) clearTimeout\(handle\);\s*\n?\s*\};/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
