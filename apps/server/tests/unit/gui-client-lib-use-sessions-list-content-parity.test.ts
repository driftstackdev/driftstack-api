// W472.B — drift guard for apps/gui-client/src/lib/use-sessions-list.ts.
// V-534.O useSessionsList hook. Drift here either swaps the limit
// default from 25 (sessions panel suddenly renders 50+ rows, blows
// the layout + breaks pagination caching) or breaks the
// nextCursor surface (UI loses pagination handle and can't fetch
// the next page).
//
//   • V-534.O framing pinned: 'useSessionsList hook.' + 'Fetches
//     GET /v1/sessions and exposes a loading/error/ready state
//     machine + a refetch fn. Mirrors useAccountCost (V-534.H) /
//     useCryptoCheckout (V-534.J): direct fetch against baseUrl
//     + apiKey from SettingsContext until an SDK client.sessions.
//     list() lands.'
//   • SessionListItem 5-field (id + status + url + createdAt +
//     endedAt nullable).
//   • SessionsListResponse 2-field (sessions array + nextCursor
//     nullable).
//   • UseSessionsListOpts: limit? 'Page size. Default 25.' +
//     manual?.
//   • limit default 25 + URL `${baseUrl}/v1/sessions?limit=${limit.
//     toString()}` exact.
//   • Same V-534 state-machine pattern as Q/H/AH/AO/BA + useCallback
//     deps include limit.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/use-sessions-list.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W472.B apps/gui-client/src/lib/use-sessions-list.ts content parity', () => {
  const body = read(LIB);

  it("V-534.O framing pinned: 'V-534.O — useSessionsList hook.' + 'Fetches GET /v1/sessions and exposes a loading/error/ready state machine + a refetch fn. Mirrors useAccountCost (V-534.H) / useCryptoCheckout (V-534.J): direct fetch against baseUrl + apiKey from SettingsContext until an SDK client.sessions.list() lands.'", () => {
    expect(body).toMatch(/\/\/ V-534\.O — useSessionsList hook\./);
    expect(body).toMatch(
      /\/\/ Fetches GET \/v1\/sessions and exposes a loading\/error\/ready state\s*\/\/ machine \+ a refetch fn\. Mirrors useAccountCost \(V-534\.H\) \/\s*\/\/ useCryptoCheckout \(V-534\.J\): direct fetch against baseUrl \+ apiKey\s*\/\/ from SettingsContext until an SDK client\.sessions\.list\(\) lands\./,
    );
  });

  it('SessionListItem 5-field (id + status + url + createdAt + endedAt nullable); SessionsListResponse 2-field (sessions: SessionListItem[] + nextCursor nullable)', () => {
    expect(body).toMatch(
      /export interface SessionListItem \{\s*id: string;\s*status: string;\s*url: string;\s*createdAt: string;\s*endedAt: string \| null;\s*\}/,
    );
    expect(body).toMatch(
      /export interface SessionsListResponse \{\s*sessions: SessionListItem\[\];\s*nextCursor: string \| null;\s*\}/,
    );
  });

  it("UseSessionsListOpts: limit? 'Page size. Default 25.' + manual? 'Disable auto-fetch on mount. Default false.'", () => {
    expect(body).toMatch(
      /export interface UseSessionsListOpts \{\s*\/\*\* Page size\. Default 25\. \*\/\s*limit\?: number;\s*\/\*\* Disable auto-fetch on mount\. Default false\. \*\/\s*manual\?: boolean;\s*\}/,
    );
  });

  it('limit default 25 + URL `${baseUrl}/v1/sessions?limit=${limit.toString()}` exact (.toString() preserved for explicit number-to-string cast)', () => {
    expect(body).toMatch(/const limit = opts\.limit \?\? 25;/);
    expect(body).toMatch(
      /const res = await fetchWithDeadline\(\s*`\$\{baseUrl\}\/v1\/sessions\?limit=\$\{limit\.toString\(\)\}`,\s*\{\s*method: 'GET',\s*signal: controller\.signal,\s*headers: \{\s*authorization: `Bearer \$\{settings\.apiKey\}`,\s*accept: 'application\/json',/,
    );
  });

  it('State machine retains manual behavior while reads are single-flight, sequence-gated, and dependency/unmount-aborted', () => {
    expect(body).toMatch(
      /export type SessionsListState =\s*\| \{ kind: 'idle' \}\s*\| \{ kind: 'loading' \}\s*\| \{ kind: 'ready'; data: SessionsListResponse \}\s*\| \{ kind: 'error'; message: string \};/,
    );
    expect(body).toMatch(
      /const \[state, setState\] = useState<SessionsListState>\(\s*opts\.manual === true \? \{ kind: 'idle' \} : \{ kind: 'loading' \},\s*\);/,
    );
    expect(body).toMatch(/const requestRef = useRef<AbortController \| null>\(null\);/);
    expect(body).toMatch(
      /const fetcher = useCallback\(async \(\): Promise<void> => \{\s*if \(inFlightRef\.current\) return;/,
    );
    expect(body).toMatch(
      /if \(sequence === sequenceRef\.current\) setState\(\{ kind: 'ready', data: body \}\);/,
    );
    expect(body).toMatch(
      /useEffect\(\s*\(\) => \(\) => \{\s*sequenceRef\.current \+= 1;\s*requestRef\.current\?\.abort\(\);\s*requestRef\.current = null;\s*inFlightRef\.current = false;\s*\},\s*\[settings\.apiKey, settings\.baseUrl, limit\],/,
    );
    expect(body).toMatch(
      /useEffect\(\(\) => \{\s*if \(opts\.manual === true\) return;\s*void fetcher\(\);\s*\}, \[fetcher, opts\.manual\]\);\s*return \{ state, refetch: fetcher \};/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
