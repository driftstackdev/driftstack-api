// SessionsResource — typed methods for /v1/sessions and /v1/sessions/:id/*.

import type {
  CaptureRequestInput,
  CaptureResponse,
  ExtractRequest,
  ExtractResponse,
  SearchRequestInput,
  SearchResponse,
  SessionLoginRequest,
  SessionLoginResponse,
  CreateSessionRequest,
  InteractRequest,
  InteractResponse,
  NavigateRequestInput,
  NavigateResponse,
  PaginationQueryInput,
  Session,
  SessionState,
  WaitRequest,
  WaitResponse,
} from '@driftstack/api-types';
import type { HttpClient } from '../http.js';
import { iteratePaginated } from '../pagination.js';

export interface SessionsListPage {
  data: Session[];
  has_more: boolean;
  next_cursor: string | null;
}

export class SessionsResource {
  constructor(private readonly http: HttpClient) {}

  /** Create a new session. */
  create(body: CreateSessionRequest = {}): Promise<Session> {
    return this.http.request<Session>({ method: 'POST', path: '/v1/sessions', body });
  }

  /** List sessions for the current account, newest first. */
  list(query: PaginationQueryInput = {}): Promise<SessionsListPage> {
    return this.http.request<SessionsListPage>({
      method: 'GET',
      path: '/v1/sessions',
      query: {
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      },
    });
  }

  /**
   * Lazily iterate every session for the calling account, walking
   * cursor pages automatically. `opts.limit` controls per-page size;
   * the iterator transparently fetches the next page once the current
   * one is exhausted, and stops on `next_cursor: null`.
   *
   * @example
   *   for await (const session of client.sessions.iterate({ limit: 50 })) {
   *     console.log(session.id);
   *   }
   */
  iterate(opts: { limit?: number } = {}): AsyncGenerator<Session, void, void> {
    return iteratePaginated<Session>((cursor) =>
      this.list({
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        ...(cursor !== null ? { cursor } : {}),
      }),
    );
  }

  /** Navigate the session to a URL. */
  navigate(sessionId: string, body: NavigateRequestInput): Promise<NavigateResponse> {
    return this.http.request<NavigateResponse>({
      method: 'POST',
      path: `/v1/sessions/${encodeURIComponent(sessionId)}/navigate`,
      body,
    });
  }

  /** Send an interaction (tap, type, scroll, press) to the session. */
  interact(sessionId: string, body: InteractRequest): Promise<InteractResponse> {
    return this.http.request<InteractResponse>({
      method: 'POST',
      path: `/v1/sessions/${encodeURIComponent(sessionId)}/interact`,
      body,
    });
  }

  /** Wait for a condition to be satisfied (selector, url, time). */
  wait(sessionId: string, body: WaitRequest): Promise<WaitResponse> {
    return this.http.request<WaitResponse>({
      method: 'POST',
      path: `/v1/sessions/${encodeURIComponent(sessionId)}/wait`,
      body,
    });
  }

  /** Fetch the session record (account / api-key / status / archetype /
   *  egress capabilities / 4 timestamps). For the LIVE in-browser state
   *  (URL / title / cookies / localStorage) use `getState()` below. */
  get(sessionId: string): Promise<Session> {
    return this.http.request<Session>({
      method: 'GET',
      path: `/v1/sessions/${encodeURIComponent(sessionId)}`,
    });
  }

  /** Snapshot current session state (URL, title, cookies, localStorage). */
  getState(sessionId: string): Promise<SessionState> {
    return this.http.request<SessionState>({
      method: 'GET',
      path: `/v1/sessions/${encodeURIComponent(sessionId)}/state`,
    });
  }

  /** Capture a screenshot, DOM snapshot, or PDF. */
  capture(sessionId: string, body: CaptureRequestInput): Promise<CaptureResponse> {
    return this.http.request<CaptureResponse>({
      method: 'POST',
      path: `/v1/sessions/${encodeURIComponent(sessionId)}/capture`,
      body,
    });
  }

  /** Read structured data from the page — a batch of named extractions
   *  (text / attribute / list). Returns the values keyed by each name. */
  extract(sessionId: string, body: ExtractRequest): Promise<ExtractResponse> {
    return this.http.request<ExtractResponse>({
      method: 'POST',
      path: `/v1/sessions/${encodeURIComponent(sessionId)}/extract`,
      body,
    });
  }

  /** Find the search field, type the query realistically, and submit
   *  (defaults to submitting). Returns whether it submitted + optionally
   *  whether results became visible. */
  search(sessionId: string, body: SearchRequestInput): Promise<SearchResponse> {
    return this.http.request<SearchResponse>({
      method: 'POST',
      path: `/v1/sessions/${encodeURIComponent(sessionId)}/search`,
      body,
    });
  }

  /** Heuristic credential login — types the username + password and submits.
   *  `logged_in` is the post-submit assessment (a captcha / 2FA / login-required
   *  landing yields false, never a false positive). */
  login(sessionId: string, body: SessionLoginRequest): Promise<SessionLoginResponse> {
    return this.http.request<SessionLoginResponse>({
      method: 'POST',
      path: `/v1/sessions/${encodeURIComponent(sessionId)}/login`,
      body,
    });
  }

  /** Destroy the session. Idempotent. */
  destroy(sessionId: string): Promise<void> {
    return this.http.request<void>({
      method: 'DELETE',
      path: `/v1/sessions/${encodeURIComponent(sessionId)}`,
    });
  }
}
