// The owner tools ask for a fresh two-factor code and retry (security sweep #17).
//
// The server now answers secret reveal / write / delete and the price edit with a
// 403 carrying `requires_mfa_step_up` when the admin session's second factor is more
// than five minutes old. Without a way to prove it again from the panel, the owner's
// only recourse was to sign out and in — so the panel's request helper asks for a
// code once, proves it through POST /v1/auth/mfa/step-up, and repeats the request.
//
// Runs the helper exactly as the page ships it: the page's request functions are
// read out of index.astro and executed against a recording fetch.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = resolve(HERE, '..', '..', 'src', 'pages', 'index.astro');

type Sent = { url: string; init: RequestInit };
type AuthedFetch = (path: string, init?: RequestInit) => Promise<Response>;

/** The page's authedFetch + sendAuthed, bound to a scripted fetch and prompt. */
function loadHelper(
  responses: Response[],
  answer: string | null,
): {
  authedFetch: AuthedFetch;
  sent: Sent[];
  prompts: string[];
} {
  const source = readFileSync(PAGE, 'utf8');
  const start = source.indexOf('      function authedFetch(path, init) {');
  const end = source.indexOf('      // Replace the unavailable tier shell');
  expect(start, 'the step-up helper was not found in index.astro').toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const sent: Sent[] = [];
  const prompts: string[] = [];
  const queue = [...responses];
  const window = {
    driftstackFetchWithDeadline: (url: string, init: RequestInit): Promise<Response> => {
      sent.push({ url, init });
      const next = queue.shift();
      if (next === undefined) throw new Error(`unexpected request ${url}`);
      return Promise.resolve(next);
    },
    prompt: (message: string): string | null => {
      prompts.push(message);
      return answer;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const build = new Function(
    'window',
    'apiBaseUrl',
    'token',
    `${source.slice(start, end)}\nreturn authedFetch;`,
  ) as (w: typeof window, base: string, token: string) => AuthedFetch;
  return { authedFetch: build(window, 'https://api.example.test', 'ws-token'), sent, prompts };
}

function problem(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

const STEP_UP = {
  type: 'https://errors.driftstack.dev/mfa-step-up-required',
  status: 403,
  requires_mfa_step_up: true,
  reason: 'expired',
};

describe('the owner tools ask for a fresh code and retry', () => {
  it('CRITICAL a step-up refusal prompts once, proves the code, and repeats the same request', async () => {
    const { authedFetch, sent, prompts } = loadHelper(
      [
        problem(403, STEP_UP),
        new Response(JSON.stringify({ via: 'totp' }), { status: 200 }),
        new Response(JSON.stringify({ name: 'k', value: 'v' }), { status: 200 }),
      ],
      ' 123456 ',
    );
    const res = await authedFetch('/v1/admin/owner/secrets/k/reveal', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(prompts).toHaveLength(1);
    expect(sent.map((s) => `${s.init.method ?? 'GET'} ${s.url}`)).toEqual([
      'POST https://api.example.test/v1/admin/owner/secrets/k/reveal',
      'POST https://api.example.test/v1/auth/mfa/step-up',
      'POST https://api.example.test/v1/admin/owner/secrets/k/reveal',
    ]);
    expect(JSON.parse(String(sent[1]?.init.body))).toEqual({ code: '123456' });
    for (const s of sent) {
      expect((s.init.headers as Record<string, string>).authorization).toBe('Bearer ws-token');
    }
  });

  it('a recovery code is sent as one', async () => {
    const { authedFetch, sent } = loadHelper(
      [
        problem(403, STEP_UP),
        new Response('{}', { status: 200 }),
        new Response(null, { status: 204 }),
      ],
      'abcd-efgh-ijkl',
    );
    await authedFetch('/v1/admin/owner/secrets/k', { method: 'DELETE' });
    expect(JSON.parse(String(sent[1]?.init.body))).toEqual({ recovery_code: 'abcd-efgh-ijkl' });
  });

  it('a cancelled prompt, a failed proof, or any other 403 returns the refusal without a retry', async () => {
    const cancelled = loadHelper([problem(403, STEP_UP)], null);
    expect(
      (await cancelled.authedFetch('/v1/admin/owner/pricing/x', { method: 'PATCH' })).status,
    ).toBe(403);
    expect(cancelled.sent).toHaveLength(1);

    const wrong = loadHelper([problem(403, STEP_UP), problem(401, { status: 401 })], '000000');
    expect((await wrong.authedFetch('/v1/admin/owner/pricing/x', { method: 'PATCH' })).status).toBe(
      403,
    );
    expect(wrong.sent).toHaveLength(2);

    const plain = loadHelper([problem(403, { status: 403, type: 'forbidden' })], '123456');
    expect((await plain.authedFetch('/v1/admin/overview')).status).toBe(403);
    expect(plain.prompts).toEqual([]);
    expect(plain.sent).toHaveLength(1);
  });
});
