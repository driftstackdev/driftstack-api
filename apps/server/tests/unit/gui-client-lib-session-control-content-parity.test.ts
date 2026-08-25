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
      /\/\/ Sits on top of V-534\.C `subscribeSessionEvents` and provides the\s*\/\/ imperative actions a UI surface needs: destroy a session, force a\s*\/\/ refresh, swap polling cadence\. Holds the latest snapshot internally\s*\/\/ so consumers don't have to wire their own state cache\./,
    );
    expect(body).toMatch(
      /\/\/ Pure TypeScript \(no React\); the UI component layer wraps this in a\s*\/\/ hook\. Keeping the controller plain TS makes it testable in vitest\s*\/\/ without a DOM\./,
    );
  });

  it("Imports: 5 named from './session-events' (bucketSessions + diffSessionSnapshots + subscribeSessionEvents + type SessionBuckets + type SessionEvent) + type Session from './client'", () => {
    expect(body).toMatch(
      /import \{\s*bucketSessions,\s*diffSessionSnapshots,\s*subscribeSessionEvents,\s*type SessionBuckets,\s*type SessionEvent,\s*\} from '\.\/session-events';\s*import type \{ Session \} from '\.\/client';/,
    );
  });

  it("ControllerState 5-field: sessions readonly + buckets SessionBuckets + destroying ReadonlySet<string> 'UI uses this for spinner state' + lastError 2-kind union ('fetch'|'destroy') + lastEvents readonly SessionEvent[]", () => {
    expect(body).toMatch(
      /export interface ControllerState \{\s*\/\*\* Latest snapshot from the server\. \*\/\s*sessions: readonly Session\[\];\s*\/\*\* Bucketed view for tabbed UIs\. \*\/\s*buckets: SessionBuckets;\s*\/\*\* Per-session in-flight destroy\. UI uses this for spinner state\. \*\/\s*destroying: ReadonlySet<string>;\s*\/\*\* Most recent error from the polling loop or a destroy call\. \*\/\s*lastError: \{ kind: 'fetch' \| 'destroy'; sessionId\?: string; error: unknown \} \| null;\s*\/\*\* Most recent diff against the prior snapshot\. \*\/\s*lastEvents: readonly SessionEvent\[\];\s*\}/,
    );
  });

  it("SessionControllerDeps 3-field: fetchSnapshot framing 'Source of session snapshots; typically `() => client.sessions.list({}).then(p => p.data)`' + destroySession 'Imperative destroy; typically `(id) => client.sessions.destroy(id)`' + intervalMs default 2000", () => {
    expect(body).toMatch(
      /export interface SessionControllerDeps \{\s*\/\*\* Source of session snapshots; typically `\(\) => client\.sessions\.list\(\{\}\)\.then\(p => p\.data\)`\. \*\/\s*fetchSnapshot: \(\) => Promise<readonly Session\[\]>;\s*\/\*\* Imperative destroy; typically `\(id\) => client\.sessions\.destroy\(id\)`\. \*\/\s*destroySession: \(sessionId: string\) => Promise<void>;\s*\/\*\* Polling cadence \(ms\)\. Default 2000\. \*\/\s*intervalMs\?: number;\s*\}/,
    );
  });

  it("SessionController 5-method with optimistic-destroy framing: 'Optimistic — the controller marks the session as destroying immediately, fires the API call, then waits for the next poll-tick to confirm the terminal status.'", () => {
    expect(body).toMatch(
      /\/\*\* Trigger a destroy\. Optimistic — the controller marks the session\s*\*\s*as 'destroying' immediately, fires the API call, then waits for\s*\*\s*the next poll-tick to confirm the terminal status\. \*\/\s*destroy\(sessionId: string\): Promise<void>;/,
    );
  });

  it('EMPTY_STATE constant: empty sessions array + buckets {active:[],pending:[],terminated:[]} + new Set() destroying + lastError null + lastEvents []', () => {
    expect(body).toMatch(
      /const EMPTY_STATE: ControllerState = \{\s*sessions: \[\],\s*buckets: \{ active: \[\], pending: \[\], terminated: \[\] \},\s*destroying: new Set\(\),\s*lastError: null,\s*lastEvents: \[\],\s*\};/,
    );
  });

  it('createSessionController: subscribeSessionEvents fetchSnapshot wrapper recomputes buckets + stillDestroying filter (terminalIds remove + missing-from-next remove) + publish; intervalMs ?? 2000', () => {
    expect(body).toMatch(
      /const unsubscribePoll = subscribeSessionEvents\(\{\s*fetchSnapshot: async \(\) => \{\s*const next = await deps\.fetchSnapshot\(\);/,
    );
    expect(body).toMatch(
      /const buckets = bucketSessions\(next\);\s*const stillDestroying = new Set<string>\(\);\s*const terminalIds = new Set\(buckets\.terminated\.map\(\(s\) => s\.id\)\);\s*for \(const id of state\.destroying\) \{\s*if \(!terminalIds\.has\(id\) && next\.some\(\(s\) => s\.id === id\)\) \{\s*stillDestroying\.add\(id\);\s*\}\s*\}/,
    );
    expect(body).toMatch(/intervalMs: deps\.intervalMs \?\? 2000,/);
  });

  it("subscribe: listener(state) prime call BEFORE the listeners.add framing 'Fire current state once so consumers can prime their UI.'", () => {
    expect(body).toMatch(
      /subscribe\(listener\) \{\s*listeners\.add\(listener\);\s*\/\/ Fire current state once so consumers can prime their UI\.\s*listener\(state\);\s*return \(\) => listeners\.delete\(listener\);\s*\},/,
    );
  });

  it("destroy: optimistic add → publish → try await destroySession; catch remaining-set delete + lastError {kind:'destroy', sessionId, error} + throw err", () => {
    expect(body).toMatch(
      /async destroy\(sessionId\) \{\s*const optimistic = new Set\(state\.destroying\);\s*optimistic\.add\(sessionId\);\s*publish\(\{ \.\.\.state, destroying: optimistic \}\);\s*try \{\s*await deps\.destroySession\(sessionId\);\s*\} catch \(err\) \{\s*const remaining = new Set\(state\.destroying\);\s*remaining\.delete\(sessionId\);\s*publish\(\{\s*\.\.\.state,\s*destroying: remaining,\s*lastError: \{ kind: 'destroy', sessionId, error: err \},\s*\}\);\s*throw err;\s*\}\s*\},/,
    );
  });

  it("refresh: same buckets + stillDestroying recompute + lastError fallback on catch ({kind:'fetch', error: err}); stop: unsubscribePoll() + listeners.clear()", () => {
    expect(body).toMatch(
      /async refresh\(\) \{\s*try \{\s*const next = await deps\.fetchSnapshot\(\);\s*const buckets = bucketSessions\(next\);\s*const events = diffSessionSnapshots\(state\.sessions, next\);/,
    );
    expect(body).toMatch(
      /\} catch \(err\) \{\s*publish\(\{ \.\.\.state, lastError: \{ kind: 'fetch', error: err \} \}\);\s*\}\s*\},/,
    );
    expect(body).toMatch(/stop\(\) \{\s*unsubscribePoll\(\);\s*listeners\.clear\(\);\s*\},/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
