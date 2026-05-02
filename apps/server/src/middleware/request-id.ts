// Request ID propagation: trust an inbound `x-request-id` header if present,
// otherwise generate one. Fastify's built-in `genReqId` covers generation;
// this hook surfaces the id on the response so callers can correlate.

import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

function requestIdPlugin(app: FastifyInstance, _opts: unknown, done: (err?: Error) => void): void {
  app.addHook('onSend', (request, reply, payload, hookDone) => {
    reply.header('x-request-id', request.id);
    hookDone(null, payload);
  });
  done();
}

export default fp(requestIdPlugin, { name: 'request-id' });
