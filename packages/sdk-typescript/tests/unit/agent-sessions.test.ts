// AI-D SDK — unit tests for AgentSessionsResource.
//
// Pin the wire contract: method/path/body shape per endpoint, plus
// URL-encoding on the id parameter so labels with spaces or slashes
// don't break route matching.

import { describe, expect, it } from 'vitest';
import {
  AGENT_MESSAGE_STREAM_TIMEOUT_MS,
  AgentSessionsResource,
} from '../../src/resources/agent-sessions.js';
import type { HttpClient } from '../../src/http.js';

interface RecordedRequest {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  transport?: 'json' | 'event-stream';
}

function makeFakeHttp<T>(reply: T): { http: HttpClient; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  type RecordedOptions = {
    method: string;
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
    timeoutMs?: number;
  };
  const record = <R>(opts: RecordedOptions, transport: 'json' | 'event-stream') => {
    const recorded: RecordedRequest = { method: opts.method, path: opts.path };
    if (transport === 'event-stream') recorded.transport = transport;
    if (opts.body !== undefined) recorded.body = opts.body;
    if (opts.headers !== undefined) recorded.headers = opts.headers;
    if (opts.timeoutMs !== undefined) recorded.timeoutMs = opts.timeoutMs;
    calls.push(recorded);
    return Promise.resolve(reply as unknown as R);
  };
  const http = {
    request: <R>(opts: RecordedOptions) => record<R>(opts, 'json'),
    requestEventStream: <R>(opts: RecordedOptions) => record<R>(opts, 'event-stream'),
  } as unknown as HttpClient;
  return { http, calls };
}

describe('AgentSessionsResource', () => {
  it('create POSTs /v1/agent-sessions with the body verbatim', async () => {
    const reply = {
      id: 'agt_xxx',
      account_id: 'acc_1',
      driftstack_session_id: null,
      status: 'active' as const,
      closed_reason: null,
      token_budget_total: 100_000,
      token_budget_remaining: 100_000,
      transcript_length: 0,
      created_at: '2026-05-16T00:00:00Z',
      updated_at: '2026-05-16T00:00:00Z',
    };
    const { http, calls } = makeFakeHttp(reply);
    const res = new AgentSessionsResource(http);
    const out = await res.create({ token_budget: 50_000 });
    expect(calls).toEqual([
      { method: 'POST', path: '/v1/agent-sessions', body: { token_budget: 50_000 } },
    ]);
    expect(out).toEqual(reply);
  });

  it('create with no body sends {} (so the server defaults token_budget)', async () => {
    const { http, calls } = makeFakeHttp({});
    const res = new AgentSessionsResource(http);
    await res.create();
    expect(calls[0]).toEqual({ method: 'POST', path: '/v1/agent-sessions', body: {} });
  });

  it('v2-#19 create with { idempotencyKey } forwards the `Idempotency-Key` header so server-side dedupe collapses retries onto one row', async () => {
    const { http, calls } = makeFakeHttp({});
    const res = new AgentSessionsResource(http);
    await res.create({}, { idempotencyKey: 'idem-abc-123' });
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/v1/agent-sessions',
      body: {},
      headers: { 'Idempotency-Key': 'idem-abc-123' },
    });
  });

  it('v2-#19 create without idempotencyKey does NOT send the header (header is opt-in)', async () => {
    const { http, calls } = makeFakeHttp({});
    const res = new AgentSessionsResource(http);
    await res.create({ token_budget: 1000 });
    expect(calls[0]?.headers).toBeUndefined();
  });

  it('get GETs /v1/agent-sessions/{id} (URL-encoded)', async () => {
    const { http, calls } = makeFakeHttp({});
    const res = new AgentSessionsResource(http);
    await res.get('agt xyz');
    expect(calls).toEqual([{ method: 'GET', path: '/v1/agent-sessions/agt%20xyz' }]);
  });

  it('message POSTs /v1/agent-sessions/{id}/message with { user_message }', async () => {
    const reply = {
      kind: 'plan-executed' as const,
      session: {
        id: 'agt_1',
        account_id: 'acc_1',
        driftstack_session_id: null,
        status: 'active' as const,
        closed_reason: null,
        token_budget_total: 100_000,
        token_budget_remaining: 99_000,
        transcript_length: 2,
        created_at: '2026-05-16T00:00:00Z',
        updated_at: '2026-05-16T00:00:01Z',
      },
      intents: [{ kind: 'navigate' as const, url: 'https://example.com' }],
      results: [
        {
          kind: 'success' as const,
          intent: { kind: 'navigate' as const, url: 'https://example.com' },
          summary: 'navigated',
        },
      ],
      ok: true,
    };
    const { http, calls } = makeFakeHttp(reply);
    const res = new AgentSessionsResource(http);
    const out = await res.message('agt_1', 'open https://example.com');
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/v1/agent-sessions/agt_1/message',
        body: { user_message: 'open https://example.com' },
        headers: { accept: 'text/event-stream' },
        timeoutMs: AGENT_MESSAGE_STREAM_TIMEOUT_MS,
        transport: 'event-stream',
      },
    ]);
    expect(out.kind).toBe('plan-executed');
  });

  it('message with opts.byokApiKey sets the x-byok-anthropic-api-key header so callers do not have to construct the header by hand (BYOK convenience layer; matches the server-side header reading at apps/server/src/routes/agent-sessions.ts)', async () => {
    const reply = {
      kind: 'clarify' as const,
      session: {
        id: 'agt_1',
        account_id: 'acc_1',
        driftstack_session_id: null,
        status: 'active' as const,
        closed_reason: null,
        token_budget_total: 100_000,
        token_budget_remaining: 99_000,
        transcript_length: 2,
        created_at: '2026-05-16T00:00:00Z',
        updated_at: '2026-05-16T00:00:01Z',
      },
      clarifying_question: 'be specific',
    };
    const { http, calls } = makeFakeHttp(reply);
    const res = new AgentSessionsResource(http);
    await res.message('agt_1', 'hi', { byokApiKey: 'sk-ant-test-byok' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers).toEqual({
      accept: 'text/event-stream',
      'x-byok-anthropic-api-key': 'sk-ant-test-byok',
    });
  });

  it('message without opts sends only the SSE accept header (never an empty BYOK header)', async () => {
    const { http, calls } = makeFakeHttp({});
    const res = new AgentSessionsResource(http);
    await res.message('agt_1', 'hi');
    expect(calls[0]?.headers).toEqual({ accept: 'text/event-stream' });
  });

  it('message with opts.byokApiKey === "" (empty string) omits the byok header — cross-SDK parity with the Go SDK\'s `opts != nil && opts.ByokAPIKey != ""` shape and the Python SDK\'s same-shape guard (closes the slice 105/106 round-trip skip)', async () => {
    // Without the `byokApiKey.length > 0` guard at agent-sessions.ts:186,
    // an empty-string opts payload would send `x-byok-anthropic-api-key:`
    // on the wire. The server's slice 105 fix normalises that to absent
    // — but skipping client-side saves the round-trip header AND keeps
    // the three SDKs (TS / Python / Go) wire-identical for this case.
    const { http, calls } = makeFakeHttp({});
    const res = new AgentSessionsResource(http);
    await res.message('agt_1', 'hi', { byokApiKey: '' });
    expect(calls[0]?.headers).toEqual({ accept: 'text/event-stream' });
  });

  it('message lets a caller override the 50-minute absolute stream backstop', async () => {
    const { http, calls } = makeFakeHttp({});
    const res = new AgentSessionsResource(http);
    await res.message('agt_1', 'hi', { timeoutMs: 90_000 });
    expect(calls[0]?.timeoutMs).toBe(90_000);
    expect(calls[0]?.transport).toBe('event-stream');
  });

  it('message with opts.approveConsequentialActions maps each approval to the wire snake_case approve_consequential_actions (W443/W445 Approve/Deny round-trip: the consumer passes back the {category, matchedText} a prior confirmation_required result echoed)', async () => {
    const { http, calls } = makeFakeHttp({});
    const res = new AgentSessionsResource(http);
    await res.message('agt_1', 'place the order', {
      approveConsequentialActions: [{ category: 'purchase', matchedText: 'buy now' }],
    });
    expect(calls[0]?.body).toEqual({
      user_message: 'place the order',
      approve_consequential_actions: [{ category: 'purchase', matched_text: 'buy now' }],
    });
  });

  it('message with an empty approveConsequentialActions array omits the field entirely (matches the route optional schema — no empty array on the wire)', async () => {
    const { http, calls } = makeFakeHttp({});
    const res = new AgentSessionsResource(http);
    await res.message('agt_1', 'hi', { approveConsequentialActions: [] });
    expect(calls[0]?.body).toEqual({ user_message: 'hi' });
  });

  it('close DELETEs /v1/agent-sessions/{id} (URL-encoded)', async () => {
    const { http, calls } = makeFakeHttp(undefined as unknown as void);
    const res = new AgentSessionsResource(http);
    await res.close('agt with space');
    expect(calls).toEqual([{ method: 'DELETE', path: '/v1/agent-sessions/agt%20with%20space' }]);
  });

  // Arc 2 sub-slice 8.9 (v2-#8) — pair-mode takeover/handback SDK
  // wrappers. The route landed at server-side in 8.9 but the SDK
  // didn't have method wrappers — customers calling them had to
  // construct the request via the raw http client. These pin the
  // wire shape (method, path, body) so the customer-side SDK call
  // matches the server-side handler 1:1.
  it('takeover POSTs /v1/agent-sessions/{id}/takeover with { client_id }', async () => {
    const reply = { pair_mode_state: { kind: 'takeover-pending' } };
    const { http, calls } = makeFakeHttp(reply);
    const res = new AgentSessionsResource(http);
    const out = await res.takeover('agt_1', 'cli_a');
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/v1/agent-sessions/agt_1/takeover',
        body: { client_id: 'cli_a' },
      },
    ]);
    expect(out.pair_mode_state.kind).toBe('takeover-pending');
  });

  it('takeover URL-encodes the session id (so labels with slashes do not break route matching)', async () => {
    const { http, calls } = makeFakeHttp({ pair_mode_state: { kind: 'takeover-pending' } });
    const res = new AgentSessionsResource(http);
    await res.takeover('agt/with/slash', 'cli_b');
    expect(calls[0]?.path).toBe('/v1/agent-sessions/agt%2Fwith%2Fslash/takeover');
  });

  it('handback POSTs /v1/agent-sessions/{id}/handback with empty body', async () => {
    const reply = { pair_mode_state: { kind: 'handback-pending' } };
    const { http, calls } = makeFakeHttp(reply);
    const res = new AgentSessionsResource(http);
    const out = await res.handback('agt_1');
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/v1/agent-sessions/agt_1/handback',
        body: {},
      },
    ]);
    expect(out.pair_mode_state.kind).toBe('handback-pending');
  });

  // LK.3 — re-mint a LiveKit JWT for the agent session room. The
  // server-side route is admin-scope-free (any owner of the session
  // can mint a token) so the SDK helper has no special-case auth.
  it('livekitToken POSTs /v1/agent-sessions/{id}/livekit-token with no body', async () => {
    const reply = {
      ws_url: 'wss://mac-007.driftstack.dev:8443',
      room: 'agt_lk',
      token: 'eyJhbGciOiJIUzI1NiJ9.fake',
      participant_identity: 'subscriber_acc_1',
      expires_at: '2026-05-19T00:00:00Z',
    };
    const { http, calls } = makeFakeHttp(reply);
    const res = new AgentSessionsResource(http);
    const out = await res.livekitToken('agt_lk');
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/v1/agent-sessions/agt_lk/livekit-token',
      },
    ]);
    expect(out.ws_url).toBe('wss://mac-007.driftstack.dev:8443');
    expect(out.token).toBe('eyJhbGciOiJIUzI1NiJ9.fake');
    expect(out.expires_at).toBe('2026-05-19T00:00:00Z');
  });

  it('livekitToken URL-encodes the session id (so ids with slashes do not break route matching)', async () => {
    const reply = {
      ws_url: 'wss://mac-008.driftstack.dev:8443',
      room: 'agt_with/slash',
      token: 'eyJhbGciOiJIUzI1NiJ9.fake',
      participant_identity: 'subscriber_acc_2',
      expires_at: '2026-05-19T00:00:00Z',
    };
    const { http, calls } = makeFakeHttp(reply);
    const res = new AgentSessionsResource(http);
    await res.livekitToken('agt_with/slash');
    expect(calls[0]!.path).toBe('/v1/agent-sessions/agt_with%2Fslash/livekit-token');
  });
});
