import { describe, expect, it, vi } from 'vitest';
import {
  boundedDeepLinkUrls,
  installAppDeepLinkSources,
} from '../../src/lib/app-deep-link-listener';

describe('boundedDeepLinkUrls', () => {
  it('accepts only bounded, clean driftstack URLs', () => {
    const valid = 'driftstack://session/open?session_id=agt_123';
    expect(
      boundedDeepLinkUrls([
        valid,
        'https://attacker.invalid/',
        'driftstack://session/open\n?session_id=bad',
        `driftstack://session/open?session_id=${'a'.repeat(8_192)}`,
        42,
      ]),
    ).toEqual([valid]);
    expect(boundedDeepLinkUrls({ urls: [valid] })).toEqual([]);
  });

  it('caps a native delivery batch at eight URLs', () => {
    const payload = Array.from(
      { length: 12 },
      (_, index) => `driftstack://session/open?session_id=agt_${index}`,
    );
    expect(boundedDeepLinkUrls(payload)).toEqual(payload.slice(0, 8));
  });
});

describe('installAppDeepLinkSources', () => {
  it('registers both live sources before consuming the cold-start URL', async () => {
    const order: string[] = [];
    const onUrls = vi.fn();
    let pluginHandler: ((urls: string[]) => void) | undefined;
    let forwardedHandler: ((payload: unknown) => void) | undefined;
    const pluginUnlisten = vi.fn();
    const forwardedUnlisten = vi.fn();

    const stop = await installAppDeepLinkSources(
      {
        onOpenUrl: (handler) => {
          order.push('plugin-listen');
          pluginHandler = handler;
          return Promise.resolve(pluginUnlisten);
        },
        onForwardedUrl: (handler) => {
          order.push('forwarded-listen');
          forwardedHandler = handler;
          return Promise.resolve(forwardedUnlisten);
        },
        getCurrent: () => {
          order.push('get-current');
          return Promise.resolve(['driftstack://session/open?session_id=agt_cold']);
        },
      },
      onUrls,
    );

    expect(order.slice(0, 2).sort()).toEqual(['forwarded-listen', 'plugin-listen']);
    expect(order[2]).toBe('get-current');
    expect(onUrls).toHaveBeenCalledWith(['driftstack://session/open?session_id=agt_cold']);

    pluginHandler?.(['driftstack://session/open?session_id=agt_plugin']);
    forwardedHandler?.(['driftstack://session/open?session_id=agt_forwarded']);
    expect(onUrls).toHaveBeenCalledTimes(3);

    stop();
    expect(pluginUnlisten).toHaveBeenCalledOnce();
    expect(forwardedUnlisten).toHaveBeenCalledOnce();
  });

  it('briefly deduplicates the same URL across native sources, then permits a later reopen', async () => {
    let clock = 10_000;
    let pluginHandler: ((urls: string[]) => void) | undefined;
    let forwardedHandler: ((payload: unknown) => void) | undefined;
    const onUrls = vi.fn();
    const url = 'driftstack://session/open?session_id=agt_same';

    await installAppDeepLinkSources(
      {
        onOpenUrl: (handler) => {
          pluginHandler = handler;
          return Promise.resolve(() => undefined);
        },
        onForwardedUrl: (handler) => {
          forwardedHandler = handler;
          return Promise.resolve(() => undefined);
        },
        getCurrent: () => Promise.resolve([url]),
      },
      onUrls,
      { now: () => clock },
    );

    pluginHandler?.([url]);
    forwardedHandler?.([url]);
    expect(onUrls).toHaveBeenCalledTimes(1);

    clock += 2_000;
    forwardedHandler?.([url]);
    expect(onUrls).toHaveBeenCalledTimes(2);
  });

  it('keeps healthy sources active when another registration or cold query fails', async () => {
    let forwardedHandler: ((payload: unknown) => void) | undefined;
    const onUrls = vi.fn();
    await installAppDeepLinkSources(
      {
        onOpenUrl: () => Promise.reject(new Error('plugin unavailable')),
        onForwardedUrl: (handler) => {
          forwardedHandler = handler;
          return Promise.resolve(() => undefined);
        },
        getCurrent: () => Promise.reject(new Error('query unavailable')),
      },
      onUrls,
    );

    forwardedHandler?.(['driftstack://session/open?session_id=agt_live']);
    expect(onUrls).toHaveBeenCalledWith(['driftstack://session/open?session_id=agt_live']);
  });

  it('does not deliver or retain listeners after cancellation', async () => {
    const abort = new AbortController();
    const unlisten = vi.fn();
    const onUrls = vi.fn();
    let releaseRegistration: (() => void) | undefined;
    const registrationBlocked = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });

    const installing = installAppDeepLinkSources(
      {
        onOpenUrl: async () => {
          await registrationBlocked;
          return unlisten;
        },
        getCurrent: () => Promise.resolve(['driftstack://session/open?session_id=agt_cancelled']),
      },
      onUrls,
      { signal: abort.signal },
    );
    abort.abort();
    releaseRegistration?.();
    await installing;

    expect(unlisten).toHaveBeenCalledOnce();
    expect(onUrls).not.toHaveBeenCalled();
  });
});
