// SessionsResource — typed methods for /v1/sessions and /v1/sessions/:id/*.

import type {
  CaptureRequestInput,
  CaptureResponse,
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

  /** Destroy the session. Idempotent. */
  destroy(sessionId: string): Promise<void> {
    return this.http.request<void>({
      method: 'DELETE',
      path: `/v1/sessions/${encodeURIComponent(sessionId)}`,
    });
  }
}
