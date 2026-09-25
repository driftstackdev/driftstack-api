// Found in the developer logs (item 8, 2026-09-24): ERROR lines that ended in a
// bare `{}`. An error-like object whose fields are not enumerable — a
// DOMException, an Event, a library's own error class — serialises to `{}`
// through JSON.stringify, so the line named nothing about what failed.

import { beforeEach, describe, expect, it } from 'vitest';
import { clearLogEntries, getLogEntries, record } from '../../src/lib/log-buffer';

function logged(...args: unknown[]): string {
  record('error', args);
  return getLogEntries().at(-1)?.text ?? '';
}

beforeEach(() => {
  clearLogEntries();
});

describe('an error object is logged by its name, not as empty braces', () => {
  it('CRITICAL a DOMException says its name and message', () => {
    const text = logged(
      '[room] failed:',
      new DOMException('The operation was aborted.', 'AbortError'),
    );
    expect(text).toMatch(/AbortError/);
    expect(text).not.toMatch(/\{\}$/);
  });

  it('CRITICAL an Event says what kind of event it was', () => {
    expect(logged('[room] failed:', new Event('error'))).toBe('[room] failed: [Event error]');
  });

  it('an object with a non-enumerable message says it', () => {
    const o = Object.create(null, {
      name: { value: 'ConnectionError', enumerable: false },
      message: { value: 'could not establish signal connection', enumerable: false },
    }) as object;
    expect(logged(o)).toBe('ConnectionError: could not establish signal connection');
  });

  it('an ordinary object still logs as JSON, and an empty one is named, not `{}`', () => {
    expect(logged({ a: 1 })).toBe('{"a":1}');
    expect(logged({})).toBe('[Object]');
  });
});
