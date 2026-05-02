// Driftstack SDK client.
//
// Now that @driftstack/sdk@0.1.1 ships an isomorphic webhook helper
// (Web Crypto API instead of node:crypto, see V-029 SDK-B), the
// browser bundle resolves cleanly and we use the published SDK
// directly. The hand-written fetch wrapper that GUI2 used as a
// workaround is gone.

import { Driftstack, type Session } from '@driftstack/sdk';

export type { Session };
export { DriftstackError } from '@driftstack/sdk';

export type DriftstackClient = Driftstack;

export function buildClient(apiKey: string | null, baseUrl: string): DriftstackClient | null {
  if (apiKey === null || apiKey.length === 0) return null;
  return new Driftstack({ apiKey, baseUrl: baseUrl.replace(/\/+$/, '') });
}
