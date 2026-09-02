// "Notification stream disconnected, when already auto connected this alert
// doesn't clear" (owner item N-7).
//
// The banner was accurate and the transport was genuinely dead. After six
// consecutive EventSource errors the subscriber called es.close() and reported
// 'closed' — deliberately, so the user got an actionable state instead of a
// permanent "reconnecting…". But that was terminal for the life of the app:
// nothing ever rebuilt the source, so when connectivity came back the machine
// was online and the banner stayed up with no way to clear it.
//
// Two defects, and they are the same shape as the input-congestion freeze:
//   1. "consecutive" was counted with no decay, so six unrelated blips hours
//      apart tripped the give-up as if they were one bad minute;
//   2. the give-up had no exit.
//
// These arms pin the RECOVERY. That the give-up still happens is not in
// question — a source that has failed six times running should be replaced.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { subscribeNotifications } from '../../src/lib/notifications';

/** Minimal EventSource double: records instances so a re-arm is observable. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  url: string;
  closed = false;
  private readonly listeners = new Map<string, Set<(e: Event) => void>>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(k: string, fn: (e: Event) => void): void {
    if (!this.listeners.has(k)) this.listeners.set(k, new Set());
    this.listeners.get(k)?.add(fn);
  }
  removeEventListener(k: string, fn: (e: Event) => void): void {
    this.listeners.get(k)?.delete(fn);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  /** Fire an event as the browser would. */
  emit(kind: string): void {
    for (const fn of this.listeners.get(kind) ?? []) fn(new Event(kind));
  }
  listenerCount(kind: string): number {
    return this.listeners.get(kind)?.size ?? 0;
  }
}

function subscribe(states: string[]) {
  return subscribeNotifications({
    url: 'https://api.example/v1/notifications',
    onEvent: () => undefined,
    onState: (s) => states.push(s),
    eventSourceFactory: FakeEventSource as unknown as typeof EventSource,
  });
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a run of errors is counted in TIME, not just in sequence', () => {
  it('does not give up on six blips spread far apart', () => {
    const states: string[] = [];
    const stop = subscribe(states);
    const es = FakeEventSource.instances[0];
    if (es === undefined) throw new Error('no source');
    // Six errors, each well after the previous — not a burst, so not a run.
    for (let i = 0; i < 6; i += 1) {
      es.readyState = 0;
      es.emit('error');
      vi.advanceTimersByTime(120_000);
    }
    expect(es.closed, 'a source failing once every two minutes must not be abandoned').toBe(false);
    expect(states).not.toContain('closed');
    stop();
  });

  it('still gives up on a genuine burst', () => {
    // Vacuity control: the bounded give-up must survive the decay fix, or the
    // arm above passes because nothing ever gives up.
    const states: string[] = [];
    const stop = subscribe(states);
    const es = FakeEventSource.instances[0];
    if (es === undefined) throw new Error('no source');
    for (let i = 0; i < 6; i += 1) {
      es.readyState = 0;
      es.emit('error');
    }
    expect(es.closed).toBe(true);
    expect(states).toContain('closed');
    stop();
  });
});

describe('giving up on a source is not giving up forever', () => {
  it('rebuilds the subscription after a backoff and reports connecting', () => {
    const states: string[] = [];
    const stop = subscribe(states);
    const first = FakeEventSource.instances[0];
    if (first === undefined) throw new Error('no source');
    for (let i = 0; i < 6; i += 1) {
      first.readyState = 0;
      first.emit('error');
    }
    expect(FakeEventSource.instances).toHaveLength(1);

    vi.advanceTimersByTime(15_000);

    // THE FIX: a second source exists, so recovery is automatic and the banner
    // clears itself once it opens.
    expect(FakeEventSource.instances.length).toBeGreaterThan(1);
    expect(states.filter((s) => s === 'connecting').length).toBeGreaterThan(1);
    stop();
  });

  it('carries the LISTENERS onto the rebuilt source', () => {
    // A re-armed source with no listeners would be connected and deliver
    // nothing — worse than staying closed, because the banner would clear while
    // notifications silently stopped.
    const states: string[] = [];
    const stop = subscribe(states);
    const first = FakeEventSource.instances[0];
    if (first === undefined) throw new Error('no source');
    for (let i = 0; i < 6; i += 1) {
      first.readyState = 0;
      first.emit('error');
    }
    vi.advanceTimersByTime(15_000);
    const second = FakeEventSource.instances[FakeEventSource.instances.length - 1];
    if (second === undefined) throw new Error('no re-armed source');
    expect(second.listenerCount('error')).toBeGreaterThan(0);
    expect(second.listenerCount('open')).toBeGreaterThan(0);
    // And the PER-KIND listeners, which are the ones that actually deliver
    // notifications. open/error alone would give a source that reconnects and
    // silently drops every event — the banner clears, the feature stays dead.
    const kinds = ['cost.threshold_alert', 'incident.broadcast', 'session.errored'];
    const wired = kinds.filter((k) => second.listenerCount(k) > 0);
    expect(
      wired.length,
      `re-armed source wired no kind listeners (${kinds.join(', ')})`,
    ).toBeGreaterThan(0);
    stop();
  });

  it('a caller that unsubscribes is not re-armed behind its back', () => {
    // The close handle must be final. A timer that fires after teardown would
    // reopen a stream the caller explicitly stopped.
    const states: string[] = [];
    const stop = subscribe(states);
    const first = FakeEventSource.instances[0];
    if (first === undefined) throw new Error('no source');
    for (let i = 0; i < 6; i += 1) {
      first.readyState = 0;
      first.emit('error');
    }
    stop();
    const afterStop = FakeEventSource.instances.length;
    vi.advanceTimersByTime(600_000);
    expect(FakeEventSource.instances).toHaveLength(afterStop);
  });
});
