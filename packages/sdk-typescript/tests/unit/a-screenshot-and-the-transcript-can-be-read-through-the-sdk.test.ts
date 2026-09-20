// A screenshot and the transcript can be read through the SDK.
//
// A `capture` step hands back a `captureId`, and the conversation lives behind
// an event stream. Neither was reachable from this SDK: a program had to write
// its own binary fetch and its own SSE reader. These arms drive the real
// HttpClient through a fake fetch, so the request the SDK assembles, the way it
// reads a body that is not JSON, and the bounds it holds a stream to are all
// exercised.

import { describe, expect, it, vi } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { HttpClient } from '../../src/http.js';
import {
  AGENT_MESSAGE_STREAM_TIMEOUT_MS,
  AgentSessionsResource,
  type AgentTranscriptEvent,
} from '../../src/resources/agent-sessions.js';
import { NotFoundError, RateLimitError, TransportError } from '../../src/errors.js';

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

function resourceWith(
  respond: (call: Captured, attempt: number) => Response | Promise<Response>,
  retry: { maxAttempts: number; sleep?: (ms: number) => Promise<void> } = { maxAttempts: 0 },
): { sessions: AgentSessionsResource; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    const call = { url: href, init };
    calls.push(call);
    return Promise.resolve(respond(call, calls.length));
  });
  const http = new HttpClient({
    apiKey: 'ds_live_test',
    baseUrl: 'http://api.test',
    fetch: fetchImpl,
    retry,
  });
  return { sessions: new AgentSessionsResource(http), calls };
}

function headersOf(c: Captured | undefined): Record<string, string> {
  return (c?.init?.headers ?? {}) as Record<string, string>;
}

function problem(status: number, type: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ type, title: 'x', status, detail: 'd', ...extra }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

// ── Screenshots ───────────────────────────────────────────────────────────────

// The smallest valid PNG, and bytes that are not valid UTF-8: reading either as
// text and back would corrupt it, which is what a JSON-only client does.
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80,
]);

function image(bytes: Uint8Array, contentType: string): Response {
  // A Blob, because the DOM typings do not accept a bare Uint8Array as a body.
  return new Response(new Blob([new Uint8Array(bytes)]), {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

describe('getCapture fetches the screenshot behind a captureId', () => {
  it('asks for the capture of that session with the API key, and returns the bytes exactly as sent, with the media type the server gave them', async () => {
    const { sessions, calls } = resourceWith(() => image(PNG, 'image/png'));
    const shot = await sessions.getCapture('agt_1', 'cap_9');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://api.test/v1/agent-sessions/agt_1/captures/cap_9');
    expect(calls[0]?.init?.method).toBe('GET');
    expect(headersOf(calls[0]).authorization).toBe('Bearer ds_live_test');
    expect(calls[0]?.init?.body).toBeUndefined();

    expect(shot.contentType).toBe('image/png');
    expect(shot.bytes).toBeInstanceOf(Uint8Array);
    expect([...shot.bytes]).toEqual([...PNG]);
  });

  it('says image/jpeg for a JPEG, read from the Content-Type header without its parameters', async () => {
    const { sessions } = resourceWith(() => image(PNG, 'Image/JPEG; charset=binary'));
    expect((await sessions.getCapture('agt_1', 'cap_9')).contentType).toBe('image/jpeg');
  });

  it('escapes both ids, so an id with a slash cannot reach a different route', async () => {
    const { sessions, calls } = resourceWith(() => image(PNG, 'image/png'));
    await sessions.getCapture('agt/../x', 'cap 1/2');
    expect(calls[0]?.url).toBe(
      'http://api.test/v1/agent-sessions/agt%2F..%2Fx/captures/cap%201%2F2',
    );
  });

  it('a screenshot that is no longer kept is a NotFoundError, not an empty image', async () => {
    const { sessions } = resourceWith(() => problem(404, PROBLEM_TYPES.NotFound));
    await expect(sessions.getCapture('agt_1', 'cap_gone')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('is retried like any other GET: a failure that passes is not the caller’s problem', async () => {
    const { sessions, calls } = resourceWith(
      (_call, attempt) =>
        attempt === 1 ? problem(500, PROBLEM_TYPES.Internal) : image(PNG, 'image/png'),
      { maxAttempts: 2, sleep: () => Promise.resolve() },
    );
    const shot = await sessions.getCapture('agt_1', 'cap_9');
    expect(calls).toHaveLength(2);
    expect([...shot.bytes]).toEqual([...PNG]);
  });

  it('refuses a body that declares itself larger than the 8 MiB response ceiling, before reading it', async () => {
    const { sessions } = resourceWith(
      () =>
        new Response(new Blob([new Uint8Array(PNG)]), {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': String(8 * 1024 * 1024 + 1) },
        }),
    );
    const err = await sessions.getCapture('agt_1', 'cap_9').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).message).toMatch(/exceeds 8388608-byte limit/);
  });
});

// ── The transcript ────────────────────────────────────────────────────────────

const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8' };

const entryFrame = (index: number, role: string, body: string): string =>
  `id: ${index.toString()}\nevent: transcript.entry\ndata: ${JSON.stringify({
    index,
    entry: { role, body, at: '2026-09-19T00:00:00.000Z' },
  })}\n\n`;

interface OpenStream {
  response: Response;
  push: (text: string) => void;
  end: () => void;
  cancelled: () => boolean;
}

/** A stream the test feeds by hand, that errors the way fetch does when its signal aborts. */
function openStream(init: RequestInit | undefined): OpenStream {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let wasCancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      init?.signal?.addEventListener('abort', () => {
        try {
          c.error(new DOMException('The operation was aborted.', 'AbortError'));
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      wasCancelled = true;
    },
  });
  return {
    response: new Response(body, { status: 200, headers: SSE_HEADERS }),
    push: (text) => controller?.enqueue(encoder.encode(text)),
    end: () => controller?.close(),
    cancelled: () => wasCancelled,
  };
}

async function collect(
  events: AsyncGenerator<AgentTranscriptEvent, void, void>,
): Promise<AgentTranscriptEvent[]> {
  const out: AgentTranscriptEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('transcript reads the conversation, then follows it live', () => {
  it('yields each entry in order with its index, and skips the keep-alive comments, a frame that is not JSON, and an event name it does not know', async () => {
    let stream: OpenStream | undefined;
    const { sessions, calls } = resourceWith((call) => {
      stream = openStream(call.init);
      stream.push(': stream open\n\n');
      stream.push(entryFrame(0, 'user', 'Open the invoices page.'));
      // A frame split across two network chunks is still one frame.
      const second = entryFrame(1, 'agent', 'navigate https://portal.example.test/invoices');
      stream.push(second.slice(0, 25));
      stream.push(second.slice(25));
      stream.push(': heartbeat 2026-09-19T00:00:30.000Z\n\n');
      stream.push('event: transcript.entry\ndata: {not json\n\n');
      stream.push('event: something.new\ndata: {"index":7,"entry":{}}\n\n');
      stream.push(entryFrame(2, 'user', 'And the total?'));
      stream.end();
      return stream.response;
    });

    const events = await collect(sessions.transcript('agt_1'));

    expect(events.map((e) => [e.index, e.entry.role, e.entry.body])).toEqual([
      [0, 'user', 'Open the invoices page.'],
      [1, 'agent', 'navigate https://portal.example.test/invoices'],
      [2, 'user', 'And the total?'],
    ]);
    expect(calls[0]?.url).toBe('http://api.test/v1/agent-sessions/agt_1/transcript');
    expect(calls[0]?.init?.method).toBe('GET');
    const h = headersOf(calls[0]);
    expect(h.authorization).toBe('Bearer ds_live_test');
    expect(h.accept).toBe('text/event-stream');
    expect(h['Last-Event-ID'], 'a first read replays from the beginning').toBeUndefined();
  });

  it('lastEventId is sent as Last-Event-ID so the stream resumes after it — including 0, which is an index and not "unset"', async () => {
    const { sessions, calls } = resourceWith((call) => {
      const s = openStream(call.init);
      s.end();
      return s.response;
    });
    await collect(sessions.transcript('agt_1', { lastEventId: 0 }));
    await collect(sessions.transcript('agt_1', { lastEventId: 41 }));
    expect(headersOf(calls[0])['Last-Event-ID']).toBe('0');
    expect(headersOf(calls[1])['Last-Event-ID']).toBe('41');
  });

  it('leaving the loop closes the connection, so reading "what is there now" does not leave a stream open', async () => {
    let stream: OpenStream | undefined;
    const { sessions } = resourceWith((call) => {
      stream = openStream(call.init);
      stream.push(entryFrame(0, 'user', 'one'));
      stream.push(entryFrame(1, 'agent', 'two'));
      // Never ended: the server keeps a transcript stream open.
      return stream.response;
    });

    const seen: number[] = [];
    const transcriptLength = 2;
    for await (const event of sessions.transcript('agt_1')) {
      seen.push(event.index);
      if (event.index === transcriptLength - 1) break;
    }
    expect(seen).toEqual([0, 1]);
    expect(stream?.cancelled(), 'the body was cancelled when the loop was left').toBe(true);
  });

  it('aborting the signal ends the loop quietly, without an error to catch', async () => {
    const abort = new AbortController();
    const { sessions } = resourceWith((call) => {
      const s = openStream(call.init);
      s.push(entryFrame(0, 'user', 'one'));
      return s.response;
    });
    const seen: number[] = [];
    for await (const event of sessions.transcript('agt_1', { signal: abort.signal })) {
      seen.push(event.index);
      abort.abort();
    }
    expect(seen).toEqual([0]);
  });

  it('a signal that is already aborted opens nothing', async () => {
    const abort = new AbortController();
    abort.abort();
    const { sessions, calls } = resourceWith(() => openStream(undefined).response);
    expect(await collect(sessions.transcript('agt_1', { signal: abort.signal }))).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('holds the stream to an absolute time limit — 50 minutes by default, the same as a message — and says so with a TransportError when it passes', async () => {
    const timeouts: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((fn: () => void, ms?: number) => {
        timeouts.push(ms ?? 0);
        return realSetTimeout(fn, ms);
      });
    try {
      const { sessions } = resourceWith((call) => {
        const s = openStream(call.init);
        s.end();
        return s.response;
      });
      await collect(sessions.transcript('agt_1'));
      expect(timeouts).toContain(AGENT_MESSAGE_STREAM_TIMEOUT_MS);
    } finally {
      spy.mockRestore();
    }

    // And the limit is enforced: a stream that outlives it fails, it does not hang.
    const { sessions } = resourceWith((call) => {
      const s = openStream(call.init);
      s.push(entryFrame(0, 'user', 'one'));
      return s.response; // never ends
    });
    const seen: number[] = [];
    const err = await (async () => {
      for await (const event of sessions.transcript('agt_1', { timeoutMs: 20 })) {
        seen.push(event.index);
      }
    })().catch((e: unknown) => e);
    expect(seen).toEqual([0]);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).message).toBe('request timed out');
  });

  it('holds the whole stream to the 8 MiB response ceiling', async () => {
    const { sessions } = resourceWith((call) => {
      const s = openStream(call.init);
      const filler = `: ${'x'.repeat(1024 * 1024)}\n\n`;
      for (let i = 0; i < 9; i += 1) s.push(filler);
      s.end();
      return s.response;
    });
    const err = await collect(sessions.transcript('agt_1')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).message).toMatch(/exceeds 8388608-byte limit/);
  });

  it('the eleventh open stream is a RateLimitError that says how long to wait', async () => {
    const { sessions } = resourceWith(
      () =>
        new Response(
          JSON.stringify({
            type: PROBLEM_TYPES.RateLimited,
            title: 'Too Many Requests',
            status: 429,
            detail: 'At most 10 concurrent transcript streams are allowed per account.',
            retry_after_seconds: 30,
          }),
          { status: 429, headers: { 'content-type': 'application/problem+json' } },
        ),
    );
    const err = await collect(sessions.transcript('agt_1')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterSeconds).toBe(30);
  });

  it('an unknown session is a NotFoundError, and a 200 that is not an event stream is a TransportError rather than an empty transcript', async () => {
    const missing = resourceWith(() => problem(404, PROBLEM_TYPES.NotFound));
    await expect(collect(missing.sessions.transcript('agt_x'))).rejects.toBeInstanceOf(
      NotFoundError,
    );

    const json = resourceWith(
      () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const err = await collect(json.sessions.transcript('agt_1')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).message).toMatch(/expected an event stream/);
  });

  it('is never retried: a stream that fails to open is one request, because the caller knows where to resume from', async () => {
    const { sessions, calls } = resourceWith(() => problem(500, PROBLEM_TYPES.Internal), {
      maxAttempts: 3,
      sleep: () => Promise.resolve(),
    });
    await collect(sessions.transcript('agt_1')).catch(() => undefined);
    expect(calls).toHaveLength(1);
  });
});
