// W468.B — drift guard for apps/gui-client/src/lib/session-control.ts.
// V-534.D session controller surface. Drift here either breaks the
// optimistic-destroy state-update (the spinner in the UI never
// appears because state.destroying isn't populated before the API
// call) or drops the terminal-status sweep in publish (sessions
// stuck in state.destroying forever because the poll-tick comparison
// missed terminal-status filtering).
//
//   • V-534.D framing pinned + 'Sits on top of V-534.C
//     subscribeSessionEvents and provides the imperative actions
//     a UI surface needs: destroy a session, force a refresh, swap
//     polling cadence. Holds the latest snapshot internally so
//     consumers don't have to wire their own state cache.'
//   • Imports: 5 named from './session-events' (bucketSessions +
//     diffSessionSnapshots + subscribeSessionEvents + type
//     SessionBuckets + type SessionEvent) + type Session from
//     './client'.
//   • ControllerState 5-field (sessions + buckets + destroying
//     ReadonlySet + lastError 2-kind union 'fetch'|'destroy' +
//     lastEvents).
//   • SessionControllerDeps: fetchSnapshot + destroySession +
//     intervalMs default 2000.
//   • SessionController 5-method (subscribe + getState + destroy
//     + refresh + stop) with optimistic-destroy framing 'Optimistic
//     — the controller marks the session as destroying immediately,
//     fires the API call, then waits for the next poll-tick to
//     confirm the terminal status.'
//   • EMPTY_STATE: empty buckets + new Set + lastError null +
//     lastEvents [].
//   • fetchSnapshot wrapper recomputes buckets + stillDestroying
//     filter (terminal-id removal AND missing-from-next removal).
//   • destroy: optimistic add → publish → try await destroySession;
//     catch remaining-set spread + lastError + throw err.
//   • refresh: same recompute + stillDestroying logic + lastError
//     fallback on catch.
//   • subscribe: listener(state) prime call before adding to set.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/session-control.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W468.B apps/gui-client/src/lib/session-control.ts content parity', () => {
  const body = read(LIB);

  it("V-534.D framing pinned: 'V-534.D — session control surface.' + 'Sits on top of V-534.C `subscribeSessionEvents` and provides the imperative actions a UI surface needs: destroy a session, force a refresh, swap polling cadence. Holds the latest snapshot internally so consumers don't have to wire their own state cache.' + 'Pure TypeScript (no React); the UI component layer wraps this in a hook. Keeping the controller plain TS makes it testable in vitest without a DOM.'", () => {
    expect(body).toMatch(/\/\/ V-534\.D — session control surface\./);
    expect(body).toMatch(
      /\/\/ Sits on top of V-534\.C `subscribeSessionEvents` and provides the\s*\n?\s*\/\/ imperative actions a UI surface needs: destroy a session, force a\s*\n?\s*\/\/ refresh, swap polling cadence\. Holds the latest snapshot internally\s*\n?\s*\/\/ so consumers don't have to wire their own state cache\./,
    );
    expect(body).toMatch(
      /\/\/ Pure TypeScript \(no React\); the UI component layer wraps this in a\s*\n?\s*\/\/ hook\. Keeping the controller plain TS makes it testable in vitest\s*\n?\s*\/\/ without a DOM\./,
    );
  });

  it("Imports: 5 named from './session-events' (bucketSessions + diffSessionSnapshots + subscribeSessionEvents + type SessionBuckets + type SessionEvent) + type Session from './client'", () => {
    expect(body).toMatch(
      /import \{\s*\n?\s*bucketSessions,\s*\n?\s*diffSessionSnapshots,\s*\n?\s*subscribeSessionEvents,\s*\n?\s*type SessionBuckets,\s*\n?\s*type SessionEvent,\s*\n?\s*\} from '\.\/session-events';\s*\n?\s*import type \{ Session \} from '\.\/client';/,
    );
  });

  it("ControllerState 5-field: sessions readonly + buckets SessionBuckets + destroying ReadonlySet<string> 'UI uses this for spinner state' + lastError 2-kind union ('fetch'|'destroy') + lastEvents readonly SessionEvent[]", () => {
    expect(body).toMatch(
      /export interface ControllerState \{\s*\n?\s*\/\*\* Latest snapshot from the server\. \*\/\s*\n?\s*sessions: readonly Session\[\];\s*\n?\s*\/\*\* Bucketed view for tabbed UIs\. \*\/\s*\n?\s*buckets: SessionBuckets;\s*\n?\s*\/\*\* Per-session in-flight destroy\. UI uses this for spinner state\. \*\/\s*\n?\s*destroying: ReadonlySet<string>;\s*\n?\s*\/\*\* Most recent error from the polling loop or a destroy call\. \*\/\s*\n?\s*lastError: \{ kind: 'fetch' \| 'destroy'; sessionId\?: string; error: unknown \} \| null;\s*\n?\s*\/\*\* Most recent diff against the prior snapshot\. \*\/\s*\n?\s*lastEvents: readonly SessionEvent\[\];\s*\n?\s*\}/,
    );
  });

  it("SessionControllerDeps 3-field: fetchSnapshot framing 'Source of session snapshots; typically `() => client.sessions.list({}).then(p => p.data)`' + destroySession 'Imperative destroy; typically `(id) => client.sessions.destroy(id)`' + intervalMs default 2000", () => {
    expect(body).toMatch(
      /export interface SessionControllerDeps \{\s*\n?\s*\/\*\* Source of session snapshots; typically `\(\) => client\.sessions\.list\(\{\}\)\.then\(p => p\.data\)`\. \*\/\s*\n?\s*fetchSnapshot: \(\) => Promise<readonly Session\[\]>;\s*\n?\s*\/\*\* Imperative destroy; typically `\(id\) => client\.sessions\.destroy\(id\)`\. \*\/\s*\n?\s*destroySession: \(sessionId: string\) => Promise<void>;\s*\n?\s*\/\*\* Polling cadence \(ms\)\. Default 2000\. \*\/\s*\n?\s*intervalMs\?: number;\s*\n?\s*\}/,
    );
  });

  it("SessionController 5-method with optimistic-destroy framing: 'Optimistic — the controller marks the session as destroying immediately, fires the API call, then waits for the next poll-tick to confirm the terminal status.'", () => {
    expect(body).toMatch(
      /\/\*\* Trigger a destroy\. Optimistic — the controller marks the session\s*\n?\s*\*\s*as 'destroying' immediately, fires the API call, then waits for\s*\n?\s*\*\s*the next poll-tick to confirm the terminal status\. \*\/\s*\n?\s*destroy\(sessionId: string\): Promise<void>;/,
    );
  });

  it('EMPTY_STATE constant: empty sessions array + buckets {active:[],pending:[],terminated:[]} + new Set() destroying + lastError null + lastEvents []', () => {
    expect(body).toMatch(
      /const EMPTY_STATE: ControllerState = \{\s*\n?\s*sessions: \[\],\s*\n?\s*buckets: \{ active: \[\], pending: \[\], terminated: \[\] \},\s*\n?\s*destroying: new Set\(\),\s*\n?\s*lastError: null,\s*\n?\s*lastEvents: \[\],\s*\n?\s*\};/,
    );
  });

  it('createSessionController: subscribeSessionEvents fetchSnapshot wrapper recomputes buckets + stillDestroying filter (terminalIds remove + missing-from-next remove) + publish; intervalMs ?? 2000', () => {
    expect(body).toMatch(
      /const unsubscribePoll = subscribeSessionEvents\(\{\s*\n?\s*fetchSnapshot: async \(\) => \{\s*\n?\s*const next = await deps\.fetchSnapshot\(\);/,
    );
    expect(body).toMatch(
      /const buckets = bucketSessions\(next\);\s*\n?\s*const stillDestroying = new Set<string>\(\);\s*\n?\s*const terminalIds = new Set\(buckets\.terminated\.map\(\(s\) => s\.id\)\);\s*\n?\s*for \(const id of state\.destroying\) \{\s*\n?\s*if \(!terminalIds\.has\(id\) && next\.some\(\(s\) => s\.id === id\)\) \{\s*\n?\s*stillDestroying\.add\(id\);\s*\n?\s*\}\s*\n?\s*\}/,
    );
    expect(body).toMatch(/intervalMs: deps\.intervalMs \?\? 2000,/);
  });

  it("subscribe: listener(state) prime call BEFORE the listeners.add framing 'Fire current state once so consumers can prime their UI.'", () => {
    expect(body).toMatch(
      /subscribe\(listener\) \{\s*\n?\s*listeners\.add\(listener\);\s*\n?\s*\/\/ Fire current state once so consumers can prime their UI\.\s*\n?\s*listener\(state\);\s*\n?\s*return \(\) => listeners\.delete\(listener\);\s*\n?\s*\},/,
    );
  });

  it("destroy: optimistic add → publish → try await destroySession; catch remaining-set delete + lastError {kind:'destroy', sessionId, error} + throw err", () => {
    expect(body).toMatch(
      /async destroy\(sessionId\) \{\s*\n?\s*const optimistic = new Set\(state\.destroying\);\s*\n?\s*optimistic\.add\(sessionId\);\s*\n?\s*publish\(\{ \.\.\.state, destroying: optimistic \}\);\s*\n?\s*try \{\s*\n?\s*await deps\.destroySession\(sessionId\);\s*\n?\s*\} catch \(err\) \{\s*\n?\s*const remaining = new Set\(state\.destroying\);\s*\n?\s*remaining\.delete\(sessionId\);\s*\n?\s*publish\(\{\s*\n?\s*\.\.\.state,\s*\n?\s*destroying: remaining,\s*\n?\s*lastError: \{ kind: 'destroy', sessionId, error: err \},\s*\n?\s*\}\);\s*\n?\s*throw err;\s*\n?\s*\}\s*\n?\s*\},/,
    );
  });

  it("refresh: same buckets + stillDestroying recompute + lastError fallback on catch ({kind:'fetch', error: err}); stop: unsubscribePoll() + listeners.clear()", () => {
    expect(body).toMatch(
      /async refresh\(\) \{\s*\n?\s*try \{\s*\n?\s*const next = await deps\.fetchSnapshot\(\);\s*\n?\s*const buckets = bucketSessions\(next\);\s*\n?\s*const events = diffSessionSnapshots\(state\.sessions, next\);/,
    );
    expect(body).toMatch(
      /\} catch \(err\) \{\s*\n?\s*publish\(\{ \.\.\.state, lastError: \{ kind: 'fetch', error: err \} \}\);\s*\n?\s*\}\s*\n?\s*\},/,
    );
    expect(body).toMatch(
      /stop\(\) \{\s*\n?\s*unsubscribePoll\(\);\s*\n?\s*listeners\.clear\(\);\s*\n?\s*\},/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
