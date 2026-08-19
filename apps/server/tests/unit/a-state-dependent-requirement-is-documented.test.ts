// V-932 — a requirement no JSON Schema can express, and the document did not
// mention it either.
//
// `POST /v1/agent-sessions/{id}/input-event` accepts `client_id` as optional,
// and that is correct: a manual-mode session does not need one. But the handler
// REQUIRES it for pair-mode sessions, twice over — the first event, which fires
// the takeover-request transition, is rejected without it, and every later event
// must carry the same `client_id` that owns `human-driving`.
//
// Neither rule is expressible as `required`: both depend on the session's
// current `pair_mode_state`, which the schema cannot see. So the schema is right
// to leave the field optional, and the only place the rule can live is the
// endpoint's prose. The published description said `client_id?: string` and
// stopped — no mention of pair mode, takeover or human-driving anywhere in its
// 805 characters. A pair-mode caller building from the document omitted it and
// learned the rule from a 400.
//
// V-931 is why this file exists. That entry mistook a handler-enforced
// requirement for a documentation defect because it read the schema and not the
// code below the parse. The lesson generalises: where validation lives in the
// handler, the schema cannot carry it and the description has to.
//
// The customer docs were already correct and complete on this
// (apps/docs/src/pages/api/agent-sessions.md), which is why nothing was broken —
// only the machine-readable contract, which is what SDK users generate from, was
// silent.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SPEC = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/agent-sessions.ts');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/api/agent-sessions.md');
const PATH = '/v1/agent-sessions/{id}/input-event';

interface SpecShape {
  paths: Record<
    string,
    {
      post?: {
        description?: string;
        requestBody?: {
          content: {
            'application/json': {
              schema: { required?: string[]; properties?: Record<string, unknown> };
            };
          };
        };
      };
    }
  >;
}

function operation(): { description?: string; required?: string[]; hasClientId: boolean } {
  const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as SpecShape;
  const post = spec.paths[PATH]?.post;
  const schema = post?.requestBody?.content['application/json'].schema;
  return {
    ...(post?.description !== undefined ? { description: post.description } : {}),
    ...(schema?.required !== undefined ? { required: schema.required } : {}),
    hasClientId: schema?.properties?.['client_id'] !== undefined,
  };
}

describe('V-932 a state-dependent requirement is documented', () => {
  it('CRITICAL the endpoint is published with a description and an optional client_id. The arms below assert what a STRING contains; a missing description would be undefined and every match would fail loudly rather than silently — asserted anyway because the optionality is half the finding.', () => {
    const op = operation();
    expect(op.description, 'the endpoint carries prose').toBeDefined();
    expect(op.hasClientId, 'client_id is published').toBe(true);
    expect(
      op.required ?? [],
      'client_id is NOT statically required — manual mode does not need it',
    ).not.toContain('client_id');
  });

  it('CRITICAL the description states when client_id becomes mandatory. It cannot be `required` in the schema, because whether it is needed depends on the session pair_mode_state the schema cannot see — so prose is the only carrier, and prose that omits it leaves a 400 as the only way to discover the rule.', () => {
    const d = operation().description ?? '';
    for (const phrase of ['pair-mode session', 'takeover-request', 'human-driving']) {
      expect(d, `the description names ${phrase}`).toContain(phrase);
    }
  });

  it('CRITICAL the handler still enforces both legs, so the description is not describing a rule that stopped existing. This is the pairing V-931 got wrong by checking one side: a documented requirement with no code behind it is fiction, and code with no documentation behind it is a surprise.', () => {
    const route = readFileSync(ROUTE, 'utf8');
    expect(route, 'the takeover-trigger leg').toContain(
      'client_id is required when the first input-event in pair mode fires the takeover-request transition',
    );
    expect(route, 'the human-driving leg').toContain(
      'client_id is required for pair-mode input and must match the client that owns human-driving',
    );
  });

  it('CRITICAL the customer docs still carry the same rule. They were correct before the document was, and they are the longer-form explanation the description now points a reader towards; if they lose it, the machine-readable one-liner becomes the only account of a two-leg rule.', () => {
    expect(readFileSync(DOC, 'utf8'), 'the docs page explains the pair-mode requirement').toMatch(
      /`client_id` is \*\*required for every pair-mode session\*\*/,
    );
  });
});
