// A server-sent-events reader that can send headers.
//
// GUI audit #15 — the browser EventSource cannot set headers, so the account
// key (which never expires) rode in the notifications stream's URL on every
// launch, where any intermediary that logs URLs — a CDN or edge in front of the
// API, a corporate TLS-inspecting proxy — saw it. This reads the same stream
// with `fetch`, which CAN send `Authorization: Bearer …` (the server's
// requireAuthEventSource reads that header first).
//
// It behaves like EventSource where the subscriber (lib/notifications.ts)
// depends on it: 'open' when the stream is up; on a drop, readyState
// CONNECTING, an 'error', then a reconnect after the retry delay; on a refused
// connection (a non-200 or non-event-stream answer), readyState CLOSED and an
// 'error' — no retry, exactly as the WHATWG spec's "fail the connection".
// Frames dispatch as MessageEvents named by their `event:` field.

/** The part of EventSource the notifications subscriber uses. */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (ev: Event) => void): void;
  removeEventListener(type: string, listener: (ev: Event) => void): void;
  close(): void;
}

export type EventSourceCtor = new (url: string) => EventSourceLike;

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;
const DEFAULT_RETRY_MS = 3_000;

export class HeaderEventSource extends EventTarget implements EventSourceLike {
  private state = CONNECTING;
  private controller: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private retryMs = DEFAULT_RETRY_MS;
  private lastEventId = '';

  constructor(
    private readonly url: string,
    private readonly headers: Readonly<Record<string, string>>,
  ) {
    super();
    void this.connect();
  }

  get readyState(): number {
    return this.state;
  }

  close(): void {
    this.state = CLOSED;
    this.controller?.abort();
    this.controller = null;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private async connect(): Promise<void> {
    if (this.state === CLOSED) return;
    this.state = CONNECTING;
    const controller = new AbortController();
    this.controller = controller;
    let res: Response;
    try {
      res = await fetch(this.url, {
        headers: {
          accept: 'text/event-stream',
          ...this.headers,
          ...(this.lastEventId !== '' ? { 'last-event-id': this.lastEventId } : {}),
        },
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch {
      if (!controller.signal.aborted) this.dropped();
      return;
    }
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !type.toLowerCase().startsWith('text/event-stream') || res.body === null) {
      await res.body?.cancel().catch(() => undefined);
      if (this.state === CLOSED) return;
      // "Fail the connection": terminal, like a browser EventSource.
      this.state = CLOSED;
      this.dispatchEvent(new Event('error'));
      return;
    }
    if (this.state === CLOSED) {
      await res.body.cancel().catch(() => undefined);
      return;
    }
    this.state = OPEN;
    this.dispatchEvent(new Event('open'));
    try {
      await this.read(res.body);
    } catch {
      /* a broken stream is a drop, handled below */
    }
    if (controller.signal.aborted || this.state === CLOSED) return;
    this.dropped();
  }

  /** A transient drop: CONNECTING, an 'error', then reconnect after the delay. */
  private dropped(): void {
    this.state = CONNECTING;
    this.dispatchEvent(new Event('error'));
    if (this.state === CLOSED) return; // the error handler gave up on us
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, this.retryMs);
  }

  private async read(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventType = '';
    let data: string[] = [];
    const dispatch = (): void => {
      if (data.length > 0) {
        this.dispatchEvent(
          new MessageEvent(eventType === '' ? 'message' : eventType, {
            data: data.join('\n'),
            lastEventId: this.lastEventId,
          }),
        );
      }
      eventType = '';
      data = [];
    };
    try {
      while (this.state !== CLOSED) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.search(/\r\n|\r|\n/)) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + (buffer.startsWith('\r\n', nl) ? 2 : 1));
          if (line === '') {
            dispatch();
            continue;
          }
          if (line.startsWith(':')) continue; // a comment / heartbeat
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          let value = colon === -1 ? '' : line.slice(colon + 1);
          if (value.startsWith(' ')) value = value.slice(1);
          if (field === 'event') eventType = value;
          else if (field === 'data') data.push(value);
          else if (field === 'id' && !value.includes('\0')) this.lastEventId = value;
          else if (field === 'retry' && /^\d+$/.test(value)) this.retryMs = Number(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
