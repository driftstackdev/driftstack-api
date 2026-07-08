// #137 — detect when a simulator window terminated WITHOUT a clean close: a native
// WKWebView renderer crash, a force-kill, or an OS-level termination — the founder's
// "the simulator window just closes itself". A JS error paints the fail-visible fatal
// overlay (the window STAYS up), and an intentional close runs our teardown, so a
// window that simply VANISHES died below the JS layer where nothing can catch it.
//
// We can't catch that in-process, but we can leave a breadcrumb: each live simulator
// heartbeats a per-session marker into localStorage; a clean teardown clears it; on
// the NEXT simulator boot any marker whose heartbeat has gone stale is a prior window
// that died without a clean close → we record it (level 'error', so log-buffer flushes
// it straight to dev-log-simulator.txt) so the crash is retrievable after the fact.
//
// Per-session keys + a stale-age threshold (not a single shared flag) so that a second
// simulator window opening alongside a healthy one is NOT mistaken for a crash of the
// first: a still-heartbeating sibling's marker is fresh, only a dead window's goes stale.

import { record } from './log-buffer';

const PREFIX = 'ds:sim:live:';
export const HEARTBEAT_MS = 4000;
// A marker is "stale" (its window died) once its last heartbeat is older than this.
// 3× the interval tolerates a couple of missed ticks on a briefly-janky-but-alive main
// thread before we call it a crash — and a clean close followed by a quick relaunch
// (< STALE_MS) reads its own just-cleared/fresh marker as alive, never a false crash.
export const STALE_MS = HEARTBEAT_MS * 3;

interface LiveMarker {
  at: number;
  url: string;
  sid: string;
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, val: string): void {
  try {
    localStorage.setItem(key, val);
  } catch {
    /* best-effort — a private-mode / disabled storage must never break the window */
  }
}
function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* best-effort */
  }
}
function markerKeys(): string[] {
  try {
    const out: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k !== null && k.startsWith(PREFIX)) out.push(k);
    }
    return out;
  } catch {
    return [];
  }
}

/** PURE (exported for tests): given the prior markers + the current time + our own
 *  session id, decide which markers are abnormal exits and the note to record for
 *  each. A marker for `selfSid`, a not-yet-stale (still-heartbeating) sibling, or a
 *  null entry is skipped; an unparseable/legacy marker is swept with an empty note. */
export function evaluateStaleMarkers(
  entries: ReadonlyArray<{ key: string; raw: string | null }>,
  now: number,
  selfSid: string,
): Array<{ key: string; note: string }> {
  const out: Array<{ key: string; note: string }> = [];
  for (const { key, raw } of entries) {
    if (key === PREFIX + selfSid) continue; // never flag our own marker
    if (raw === null) continue;
    let m: Partial<LiveMarker> | null;
    try {
      m = JSON.parse(raw) as Partial<LiveMarker>;
    } catch {
      m = null;
    }
    const at = m !== null && typeof m.at === 'number' ? m.at : null;
    if (at === null) {
      // Unparseable / legacy marker — sweep it quietly (no crash claim we can't back).
      out.push({ key, note: '' });
      continue;
    }
    if (now - at < STALE_MS) continue; // still-heartbeating sibling → alive, leave it
    const url = m !== null && typeof m.url === 'string' && m.url !== '' ? m.url : '(unknown url)';
    out.push({
      key,
      note:
        `#137 abnormal exit: a simulator window terminated WITHOUT a clean close ` +
        `(likely a WebKit renderer crash or force-kill) — last alive ${Math.round((now - at) / 1000)}s ` +
        `ago on ${url}. No JS error was captured, so this was a native/below-JS termination; ` +
        `check ~/Library/Logs/DiagnosticReports + recordings/dev-log-simulator.txt for that window.`,
    });
  }
  return out;
}

/** Call ONCE at simulator boot. Sweeps prior markers (recording any crashed window),
 *  then starts this window's heartbeat. Returns a stop() the caller MUST invoke on a
 *  clean teardown (effect cleanup / pagehide) so this window leaves no breadcrumb. */
export function startSimulatorCrashMarker(
  sessionId: string,
  now: () => number = () => Date.now(),
): () => void {
  const selfKey = PREFIX + sessionId;
  // 1) Sweep prior markers: a stale one = a window that died without a clean close.
  const entries = markerKeys().map((key) => ({ key, raw: safeGet(key) }));
  for (const { key, note } of evaluateStaleMarkers(entries, now(), sessionId)) {
    if (note !== '') record('error', [note]);
    safeRemove(key);
  }
  // 2) Heartbeat our own marker.
  const url = typeof location !== 'undefined' ? location.href : '';
  const beat = (): void => safeSet(selfKey, JSON.stringify({ at: now(), url, sid: sessionId }));
  beat();
  const timer = setInterval(beat, HEARTBEAT_MS);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    safeRemove(selfKey); // clean teardown → no breadcrumb on the next boot
  };
}
