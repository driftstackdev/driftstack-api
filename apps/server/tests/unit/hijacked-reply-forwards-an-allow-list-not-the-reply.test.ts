// `hijackedReplyHeaders` forwards a NAMED SET, never whatever is on the reply.
//
// SCOPE, measured before writing this: the behaviour here is already covered
// end to end. Replacing the allow-list with a blanket `getHeaders()` copy reds
// `private-response-cache-cors`; dropping the request id reds two arms in
// `a-hijacked-stream-keeps-the-headers-the-pipeline-computed`. Nothing was
// uncovered. This is defence in depth on one specific count, and it should not
// be read as having closed a gap.
//
// The count is why it exists. The blanket-copy regression reds exactly ONE arm,
// and that arm needs a live app, a hijacked SSE route and a disallowed-origin
// fixture to reach the assertion. The property it defends is a security one:
// `@fastify/cors` puts `access-control-allow-credentials` on the reply before
// the handler runs, while the SSE routes decide the origin question themselves
// and deliberately emit NO CORS headers for a refused origin. A blanket copy
// re-attaches that header to a stream whose origin was just refused — telling a
// browser credentials are permitted where policy said they are not.
//
// One arm, three moving parts away from the function, for that. Here the same
// regression is a two-line unit failure naming the leaked header.

import { describe, expect, it } from 'vitest';
import type { FastifyReply } from 'fastify';
import { hijackedReplyHeaders } from '../../src/lib/hijacked-reply.js';

/** The shape the helper actually consumes: getHeader + request.id. */
function replyDouble(
  headers: Record<string, string | number | string[]>,
  id?: string,
): FastifyReply {
  return {
    getHeader: (name: string) => headers[name.toLowerCase()],
    getHeaders: () => headers,
    ...(id === undefined ? {} : { request: { id } }),
  } as unknown as FastifyReply;
}

describe('hijackedReplyHeaders forwards an allow-list, not the reply', () => {
  it('CRITICAL a refused-origin stream does not inherit CORS credentials', () => {
    // Exactly the state @fastify/cors leaves behind: the credentials header is
    // already on the reply when the route decides to emit no CORS at all.
    const forwarded = hijackedReplyHeaders(
      replyDouble({
        'access-control-allow-credentials': 'true',
        'access-control-allow-origin': 'https://evil.example',
        'x-ratelimit-remaining': '41',
      }),
    );
    expect(
      Object.keys(forwarded).sort(),
      'a hijacked stream inherited a CORS header. The routes emit no CORS for a refused origin; ' +
        'forwarding these tells the browser credentials are allowed where policy refused them',
    ).not.toContain('access-control-allow-credentials');
    expect(Object.keys(forwarded)).not.toContain('access-control-allow-origin');
    // …while still carrying what it is supposed to.
    expect(forwarded['x-ratelimit-remaining']).toBe('41');
  });

  it('CRITICAL the forwarded set is the named list, not everything present', () => {
    const forwarded = hijackedReplyHeaders(
      replyDouble({
        'x-ratelimit-limit': '100',
        'x-ratelimit-remaining': '99',
        'x-ratelimit-reset': '60',
        'x-ratelimit-bucket': 'global',
        'ratelimit-limit': '100',
        'ratelimit-remaining': '99',
        'ratelimit-reset': '60',
        'set-cookie': 'session=secret',
        'content-type': 'application/json',
        'x-internal-debug': 'on',
      }),
    );
    // An allow-list means additions are deliberate: anything new on the reply
    // stays behind until someone names it.
    expect(Object.keys(forwarded).sort()).toEqual([
      'ratelimit-limit',
      'ratelimit-remaining',
      'ratelimit-reset',
      'x-ratelimit-bucket',
      'x-ratelimit-limit',
      'x-ratelimit-remaining',
      'x-ratelimit-reset',
    ]);
    expect(
      Object.keys(forwarded),
      'a stream must not inherit a Set-Cookie the pipeline set for a different response',
    ).not.toContain('set-cookie');
  });

  it('CRITICAL the request id is taken from the request, where the onSend hook has not run', () => {
    // It is NOT on the reply at hijack time — that is the subtlety that defeated
    // the one call site which had otherwise got this right.
    const forwarded = hijackedReplyHeaders(replyDouble({ 'x-ratelimit-limit': '5' }, 'req-42'));
    expect(forwarded['x-request-id']).toBe('req-42');
  });

  it('CRITICAL a degenerate reply yields headers rather than throwing', () => {
    // A header helper that throws fails the connection outright — worse than the
    // missing header it exists to fix. Both guards are exercised: no getHeader,
    // and no request.
    expect(() => hijackedReplyHeaders({} as unknown as FastifyReply)).not.toThrow();
    expect(hijackedReplyHeaders({} as unknown as FastifyReply)).toEqual({});
    const idOnly = hijackedReplyHeaders({
      request: { id: 'req-7' },
    } as unknown as FastifyReply);
    expect(idOnly).toEqual({ 'x-request-id': 'req-7' });
  });
});
