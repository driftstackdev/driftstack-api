// An unpriced-model refusal reaches Sentry once per model, carrying the model id
// and the route and nothing else.
//
// Why Sentry at all: nothing scrapes production's /metrics, so the
// `model_unpriced` counter and its alert rule reach nobody there. Why once: the
// first refusal is the news, and a busy session would otherwise send one event per
// turn for the same fault. Why nothing else: the event leaves the process for a
// third party, and the only facts needed to fix the fault are which id lacks a
// price and where it was refused.

import { describe, expect, it } from 'vitest';
import {
  createUnpricedModelReporter,
  reportUnpricedModel,
} from '../../src/lib/report-unpriced-model.js';
import type { SentryClient, SentryMessage } from '../../src/lib/sentry.js';

function recordingSentry(opts: { throws?: boolean } = {}): {
  client: SentryClient;
  messages: SentryMessage[];
} {
  const messages: SentryMessage[] = [];
  return {
    messages,
    client: {
      isInitialized: true,
      captureException: () => {},
      captureMessage: (m) => {
        if (opts.throws === true) throw new Error('sentry down');
        messages.push(m);
      },
      addBreadcrumb: () => {},
      flush: () => Promise.resolve(true),
      close: () => Promise.resolve(true),
    },
  };
}

const TURN = '/v1/agent-sessions/:id/message' as const;
const CREATE = '/v1/agent-sessions' as const;

describe('an unpriced model is reported to Sentry once per model, with no customer data', () => {
  it('CRITICAL the first refusal of a model sends one error event carrying only the model id and the route', () => {
    const report = createUnpricedModelReporter();
    const sentry = recordingSentry();

    expect(report(sentry.client, { model: 'claude-mystery-9', route: TURN })).toBe(true);

    expect(sentry.messages).toHaveLength(1);
    const event = sentry.messages[0]!;
    expect(event.level).toBe('error');
    expect(event.tags).toEqual({ kind: 'model_unpriced', route: TURN });
    expect(event.extra).toEqual({ model: 'claude-mystery-9', route: TURN });
    // One Sentry issue per model, however many turns it refuses.
    expect(event.fingerprint).toEqual(['bundled-llm', 'model_unpriced', 'claude-mystery-9']);
    expect(event.message).toContain('claude-mystery-9');
    expect(Object.keys(event).sort()).toEqual(['extra', 'fingerprint', 'level', 'message', 'tags']);
  });

  it('CRITICAL the same model is reported at most once, on either route, while a different model is reported on its own', () => {
    const report = createUnpricedModelReporter();
    const sentry = recordingSentry();

    expect(report(sentry.client, { model: 'claude-mystery-9', route: TURN })).toBe(true);
    expect(report(sentry.client, { model: 'claude-mystery-9', route: TURN })).toBe(false);
    expect(report(sentry.client, { model: 'claude-mystery-9', route: CREATE })).toBe(false);
    expect(report(sentry.client, { model: 'claude-mystery-10', route: CREATE })).toBe(true);

    expect(sentry.messages.map((m) => m.extra?.['model'])).toEqual([
      'claude-mystery-9',
      'claude-mystery-10',
    ]);
  });

  it('a Sentry client that throws never breaks the refusal, and the model is not retried on every turn', () => {
    const report = createUnpricedModelReporter();
    const broken = recordingSentry({ throws: true });
    expect(() => report(broken.client, { model: 'claude-mystery-9', route: TURN })).not.toThrow();
    expect(report(broken.client, { model: 'claude-mystery-9', route: TURN })).toBe(false);
  });

  it('with no Sentry client there is nothing to send, and a later client still gets the report', () => {
    const report = createUnpricedModelReporter();
    expect(report(undefined, { model: 'claude-mystery-9', route: TURN })).toBe(false);
    const sentry = recordingSentry();
    expect(report(sentry.client, { model: 'claude-mystery-9', route: TURN })).toBe(true);
  });

  it('memory is bounded: an oversized id is cut, and past the tracked-model bound new ids are not reported', () => {
    const report = createUnpricedModelReporter();
    const sentry = recordingSentry();
    const long = `claude-${'x'.repeat(500)}`;
    report(sentry.client, { model: long, route: TURN });
    expect(String(sentry.messages[0]!.extra?.['model']).length).toBe(100);

    for (let i = 0; i < 200; i += 1) report(sentry.client, { model: `m-${i}`, route: TURN });
    expect(sentry.messages).toHaveLength(64);
  });

  it('each reporter has its own memory, and the process-wide one is a single shared instance', async () => {
    const a = createUnpricedModelReporter();
    const b = createUnpricedModelReporter();
    const sentry = recordingSentry();
    expect(a(sentry.client, { model: 'claude-mystery-9', route: TURN })).toBe(true);
    expect(b(sentry.client, { model: 'claude-mystery-9', route: TURN })).toBe(true);

    const again = await import('../../src/lib/report-unpriced-model.js');
    expect(again.reportUnpricedModel).toBe(reportUnpricedModel);
  });
});
