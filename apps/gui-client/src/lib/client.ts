// Driftstack HTTP client for the GUI.
//
// Note: we do NOT use `@driftstack/sdk` here yet. The published SDK
// imports `node:crypto` for webhook signature verification, which
// isn't browser-compatible — Vite errors with "createHmac is not
// exported by __vite-browser-external" when the GUI bundle tries to
// pull it in. Two real fixes are queued for a follow-up SDK commit:
//   1) split the webhook helper into its own subpath export so the
//      browser bundle never sees it, OR
//   2) replace `node:crypto` with the Web Crypto API for an
//      isomorphic build.
// Either is more work than this GUI phase needs, so for GUI2 we use
// a hand-written fetch wrapper covering the narrow surface the GUI
// actually calls (sessions list/create/destroy). Switch to the SDK
// once the isomorphic fix lands; the resource shapes are identical.

export interface Session {
  id: string;
  account_id: string;
  api_key_id: string;
  status: 'creating' | 'ready' | 'busy' | 'destroyed' | 'errored';
  archetype: string;
  label: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  last_state_at: string | null;
  destroyed_at: string | null;
}

export interface SessionsListPage {
  data: Session[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface ProblemDoc {
  type: string;
  title: string;
  status: number;
  detail?: string;
  [key: string]: unknown;
}

export class DriftstackError extends Error {
  status: number;
  problemType: string | null;
  problem: ProblemDoc | null;

  constructor(
    message: string,
    opts: { status?: number; problemType?: string | null; problem?: ProblemDoc | null } = {},
  ) {
    super(message);
    this.name = 'DriftstackError';
    this.status = opts.status ?? 0;
    this.problemType = opts.problemType ?? null;
    this.problem = opts.problem ?? null;
  }
}

export interface DriftstackClient {
  listSessions(): Promise<SessionsListPage>;
  createSession(): Promise<Session>;
  destroySession(id: string): Promise<void>;
}

export function buildClient(apiKey: string | null, baseUrl: string): DriftstackClient | null {
  if (apiKey === null || apiKey.length === 0) return null;
  return new HttpClient(apiKey, baseUrl.replace(/\/+$/, ''));
}

class HttpClient implements DriftstackClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
  ) {}

  async listSessions(): Promise<SessionsListPage> {
    return await this.request<SessionsListPage>('GET', '/v1/sessions');
  }

  async createSession(): Promise<Session> {
    return await this.request<Session>('POST', '/v1/sessions', {});
  }

  async destroySession(id: string): Promise<void> {
    await this.request<void>('DELETE', `/v1/sessions/${encodeURIComponent(id)}`);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = this.baseUrl + path;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      accept: 'application/json',
      'user-agent': 'driftstack-gui/0.0.1',
    };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new DriftstackError(transportMessage(err), { status: 0 });
    }

    if (res.status === 204 || res.headers.get('content-length') === '0') {
      return undefined as T;
    }

    const text = await res.text();

    if (res.ok) {
      if (text.length === 0) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new DriftstackError('failed to parse JSON response body', { status: res.status });
      }
    }

    // Non-2xx — try problem+json.
    let problem: ProblemDoc | null = null;
    try {
      const parsed = JSON.parse(text) as ProblemDoc;
      if (typeof parsed.type === 'string' && typeof parsed.title === 'string') {
        problem = parsed;
      }
    } catch {
      // fall through
    }
    if (problem !== null) {
      throw new DriftstackError(problem.detail ?? problem.title, {
        status: res.status,
        problemType: problem.type,
        problem,
      });
    }
    throw new DriftstackError(`HTTP ${res.status.toString()}: ${text.slice(0, 200)}`, {
      status: res.status,
    });
  }
}

function transportMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return 'request timed out';
    return err.message;
  }
  return 'network failure';
}
