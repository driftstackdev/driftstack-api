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
      /\/\/ Fetches GET \/v1\/sessions and exposes a loading\/error\/ready state\s*\n?\s*\/\/ machine \+ a refetch fn\. Mirrors useAccountCost \(V-534\.H\) \/\s*\n?\s*\/\/ useCryptoCheckout \(V-534\.J\): direct fetch against baseUrl \+ apiKey\s*\n?\s*\/\/ from SettingsContext until an SDK client\.sessions\.list\(\) lands\./,
    );
  });

  it('SessionListItem 5-field (id + status + url + createdAt + endedAt nullable); SessionsListResponse 2-field (sessions: SessionListItem[] + nextCursor nullable)', () => {
    expect(body).toMatch(
      /export interface SessionListItem \{\s*\n?\s*id: string;\s*\n?\s*status: string;\s*\n?\s*url: string;\s*\n?\s*createdAt: string;\s*\n?\s*endedAt: string \| null;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export interface SessionsListResponse \{\s*\n?\s*sessions: SessionListItem\[\];\s*\n?\s*nextCursor: string \| null;\s*\n?\s*\}/,
    );
  });

  it("UseSessionsListOpts: limit? 'Page size. Default 25.' + manual? 'Disable auto-fetch on mount. Default false.'", () => {
    expect(body).toMatch(
      /export interface UseSessionsListOpts \{\s*\n?\s*\/\*\* Page size\. Default 25\. \*\/\s*\n?\s*limit\?: number;\s*\n?\s*\/\*\* Disable auto-fetch on mount\. Default false\. \*\/\s*\n?\s*manual\?: boolean;\s*\n?\s*\}/,
    );
  });

  it('limit default 25 + URL `${baseUrl}/v1/sessions?limit=${limit.toString()}` exact (.toString() preserved for explicit number-to-string cast)', () => {
    expect(body).toMatch(/const limit = opts\.limit \?\? 25;/);
    expect(body).toMatch(
      /const res = await fetch\(`\$\{baseUrl\}\/v1\/sessions\?limit=\$\{limit\.toString\(\)\}`, \{\s*\n?\s*method: 'GET',\s*\n?\s*headers: \{\s*\n?\s*authorization: `Bearer \$\{settings\.apiKey\}`,\s*\n?\s*accept: 'application\/json',\s*\n?\s*\},\s*\n?\s*\.\.\.\(signal !== undefined \? \{ signal \} : \{\}\),\s*\n?\s*\}\);/,
    );
  });

  it("Same V-534 polling state-machine pattern: SessionsListState 4-variant union + manual?-aware initial state + no-apiKey 'No API key configured.' + readApiErrorMessage delegation + instance-of-Error catch + useEffect manual gate; useCallback deps [settings.apiKey, settings.baseUrl, limit]; abort-in-flight audit fix adds abortRef + AbortController setup/cleanup + isActive-gated apply() + AbortError swallow + separate no-arg refetch useCallback", () => {
    expect(body).toMatch(
      /export type SessionsListState =\s*\n?\s*\| \{ kind: 'idle' \}\s*\n?\s*\| \{ kind: 'loading' \}\s*\n?\s*\| \{ kind: 'ready'; data: SessionsListResponse \}\s*\n?\s*\| \{ kind: 'error'; message: string \};/,
    );
    expect(body).toMatch(
      /const \[state, setState\] = useState<SessionsListState>\(\s*\n?\s*opts\.manual === true \? \{ kind: 'idle' \} : \{ kind: 'loading' \},\s*\n?\s*\);/,
    );
    expect(body).toMatch(/const abortRef = useRef<AbortController \| null>\(null\);/);
    expect(body).toMatch(
      /const fetcher = useCallback\(\s*\n?\s*async \(signal\?: AbortSignal, isActive\?: \(\) => boolean\): Promise<void> => \{\s*\n?\s*const apply = \(next: SessionsListState\): void => \{\s*\n?\s*if \(isActive === undefined \|\| isActive\(\)\) setState\(next\);\s*\n?\s*\};/,
    );
    expect(body).toMatch(/if \(err instanceof Error && err\.name === 'AbortError'\) return;/);
    expect(body).toMatch(/\},\s*\n?\s*\[settings\.apiKey, settings\.baseUrl, limit\],\s*\n?\s*\);/);
    expect(body).toMatch(
      /useEffect\(\(\) => \{\s*\n?\s*if \(opts\.manual === true\) return;\s*\n?\s*let active = true;\s*\n?\s*const controller = new AbortController\(\);\s*\n?\s*abortRef\.current = controller;\s*\n?\s*void fetcher\(controller\.signal, \(\) => active\);\s*\n?\s*return \(\) => \{\s*\n?\s*active = false;\s*\n?\s*controller\.abort\(\);\s*\n?\s*\};\s*\n?\s*\}, \[fetcher, opts\.manual\]\);/,
    );
    expect(body).toMatch(
      /const refetch = useCallback\(\(\): Promise<void> => fetcher\(\), \[fetcher\]\);\s*\n?\s*return \{ state, refetch \};/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
