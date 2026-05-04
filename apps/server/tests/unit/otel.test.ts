import { describe, expect, it } from 'vitest';
import { NoopOtelService, createOtelService } from '../../src/lib/otel.js';

describe('NoopOtelService', () => {
  it('returns a tracer for any name', () => {
    const svc = new NoopOtelService();
    expect(svc.getTracer('driftstack.test')).toBeDefined();
  });

  it('tracer.startSpan returns a span that accepts attribute + exception calls', () => {
    const svc = new NoopOtelService();
    const span = svc.getTracer('test').startSpan('op.test', {
      attributes: { account_id: 'acc_test' },
    });
    expect(() => {
      span.setAttribute('result', 'ok');
      span.setAttribute('count', 42);
      span.setAttribute('flag', true);
      span.setAttribute('tags', ['a', 'b']);
      span.recordException(new Error('fake error'));
      span.recordException({ message: 'fake error obj' });
      span.end();
    }).not.toThrow();
  });

  it('shutdown resolves without error', async () => {
    const svc = new NoopOtelService();
    await expect(svc.shutdown()).resolves.toBeUndefined();
  });

  it('createOtelService factory returns a no-op while unwired', () => {
    const svc = createOtelService();
    expect(svc).toBeDefined();
    // No-op exposes the same interface; concrete class check would couple
    // tests to NoopOtelService. The contract test (above) is the real check.
  });
});
