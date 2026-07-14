import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

import { installDashboardDeadline } from './dashboard-test-runtime';

type DashboardWindow = JSDOM['window'] & {
  driftstackWriteClipboard: (value: unknown) => Promise<void>;
};

let currentWindow: JSDOM['window'] | undefined;
afterEach(() => {
  currentWindow?.close();
  currentWindow = undefined;
});

function setup(): DashboardWindow {
  const dom = new JSDOM('', { runScripts: 'outside-only' });
  currentWindow = dom.window;
  installDashboardDeadline(dom.window);
  return dom.window as DashboardWindow;
}

describe('dashboard clipboard helper', () => {
  it('writes an exact string and adopts the clipboard promise', async () => {
    const window = setup();
    const writes: string[] = [];
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText(value: string) {
          writes.push(value);
          return Promise.resolve();
        },
      },
    });

    await expect(window.driftstackWriteClipboard('pay_123')).resolves.toBeUndefined();
    expect(writes).toEqual(['pay_123']);
  });

  it('normalizes unavailable, synchronous, asynchronous, and invalid-value failures', async () => {
    const window = setup();
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    await expect(window.driftstackWriteClipboard('pay_123')).rejects.toThrow(
      /clipboard unavailable/i,
    );

    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText() {
          throw new Error('synchronous denial');
        },
      },
    });
    await expect(window.driftstackWriteClipboard('pay_123')).rejects.toThrow(/synchronous denial/i);

    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText() {
          return Promise.reject(new Error('asynchronous denial'));
        },
      },
    });
    await expect(window.driftstackWriteClipboard('pay_123')).rejects.toThrow(
      /asynchronous denial/i,
    );
    await expect(window.driftstackWriteClipboard(null)).rejects.toThrow(/must be a string/i);
  });
});
