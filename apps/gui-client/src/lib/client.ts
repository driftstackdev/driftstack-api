// Driftstack SDK client.
//
// Now that @driftstack/sdk@0.1.1 ships an isomorphic webhook helper
// (Web Crypto API instead of node:crypto, see V-029 SDK-B), the
// browser bundle resolves cleanly and we use the published SDK
// directly. The hand-written fetch wrapper that GUI2 used as a
// workaround is gone.

import { Driftstack, type Session } from '@driftstack/sdk';
import { record } from './log-buffer';

export type { Session };
export { DriftstackError } from '@driftstack/sdk';

export type DriftstackClient = Driftstack;

// W609 — Dev Logs productivity: mirror every FAILING API call into the
// in-app log buffer (lib/log-buffer). Views catch SDK errors and render
// friendly banners, which never touch console.* — so before this, the
// Dev Logs panel sat empty exactly when an operator was staring at an
// error. Success responses are NOT logged (the 2-fps frame poll would
// flood 500 entries in ~4 minutes); failures are rare + load-bearing.
function loggingFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? 'GET';
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  return globalThis.fetch(input, init).then(
    (res) => {
      if (!res.ok) record('error', [`[api] ${method} ${url} → ${res.status} ${res.statusText}`]);
      return res;
    },
    (err: unknown) => {
      record('error', [`[api] ${method} ${url} → network failure: ${String(err)}`]);
      throw err;
    },
  );
}

export function buildClient(apiKey: string | null, baseUrl: string): DriftstackClient | null {
  if (apiKey === null || apiKey.length === 0) return null;
  return new Driftstack({
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    fetch: loggingFetch,
  });
}
