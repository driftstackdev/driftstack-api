import { describe, expect, it, vi } from 'vitest';
import type { SessionLoginResponse } from '@driftstack/api-types';
import type { TransportError } from '../../src/errors.js';
import type { HttpClient } from '../../src/http.js';
import { SessionsResource } from '../../src/resources/sessions.js';

type RequestOptions = {
  method: string;
  path: string;
  body?: unknown;
};

describe('SessionsResource.login', () => {
  it('posts credentials to the encoded session login path and retains the submitted branch', async () => {
    const response = {
      submitted: true,
      credentials_truncated: false,
      logged_in: false,
      post_login_url: 'https://example.test/challenge',
      duration_ms: 12_450,
    } satisfies SessionLoginResponse;
    const request = vi.fn((_options: RequestOptions) => Promise.resolve(response));
    const sessions = new SessionsResource({ request } as unknown as HttpClient);
    const body = { username: 'user@example.test', password: 'not-logged' };

    const result = await sessions.login('ses/with space', body);

    expect(request).toHaveBeenCalledWith({
      method: 'POST',
      path: '/v1/sessions/ses%2Fwith%20space/login',
      body,
    });
    expect(result).toEqual(response);
    if (!result.credentials_truncated) {
      expect(result.submitted).toBe(true);
      expect(result.post_login_url).toBe('https://example.test/challenge');
    }
  });

  it('retains the strict safe-refusal branch without inventing a URL', async () => {
    const response = {
      submitted: false,
      credentials_truncated: true,
      logged_in: false,
      duration_ms: 600_000,
    } satisfies SessionLoginResponse;
    const request = vi.fn((_options: RequestOptions) => Promise.resolve(response));
    const sessions = new SessionsResource({ request } as unknown as HttpClient);

    const result = await sessions.login('ses_123', {
      username: 'user@example.test',
      password: 'not-logged',
    });

    expect(result).toEqual(response);
    if (result.credentials_truncated) {
      expect(result.submitted).toBe(false);
      expect(result.logged_in).toBe(false);
      expect(result).not.toHaveProperty('post_login_url');
    }
  });

  it.each([
    {
      submitted: true,
      credentials_truncated: true,
      logged_in: false,
      duration_ms: 1,
    },
    {
      submitted: false,
      credentials_truncated: true,
      logged_in: false,
      post_login_url: 'https://example.test/leak',
      duration_ms: 1,
    },
    {
      submitted: true,
      credentials_truncated: false,
      logged_in: true,
      duration_ms: 600_001,
    },
    {
      submitted: true,
      credentials_truncated: false,
      logged_in: true,
      duration_ms: 1,
      unexpected: true,
    },
    {
      credentials_truncated: false,
      logged_in: true,
      duration_ms: 1,
    },
  ])('rejects a malformed successful response as a transport error: %#', async (response) => {
    const request = vi.fn((_options: RequestOptions) => Promise.resolve(response));
    const sessions = new SessionsResource({ request } as unknown as HttpClient);

    const pending = sessions.login('ses_123', {
      username: 'user@example.test',
      password: 'not-logged',
    });

    await expect(pending).rejects.toMatchObject({
      name: 'TransportError',
      kind: 'transport',
      status: 200,
      message: 'invalid session login response body',
    } satisfies Partial<TransportError>);
  });
});
