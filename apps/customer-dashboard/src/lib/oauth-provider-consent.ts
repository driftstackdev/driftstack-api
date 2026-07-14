const LIMITS = {
  clientId: 128,
  redirectUri: 2048,
  state: 256,
  challenge: 128,
  scope: 1024,
  response: 64 * 1024,
} as const;

export interface OAuthAuthorizeRequest {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scope: string;
  query: string;
}

export interface OAuthStageResult {
  authorizationId: string;
  clientId: string;
  clientLabel: string;
  redirectUri: string;
  state: string;
  scopes: readonly string[];
}

function one(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? (values[0] ?? null) : null;
}

/** Capture one canonical, bounded authorization request and reject parameter pollution. */
export function captureOAuthAuthorizeRequest(search: string): OAuthAuthorizeRequest | null {
  const params = new URLSearchParams(search);
  const clientId = one(params, 'client_id');
  const redirectUri = one(params, 'redirect_uri');
  const state = one(params, 'state');
  const codeChallenge = one(params, 'code_challenge');
  const method = one(params, 'code_challenge_method');
  const scopeValues = params.getAll('scope');
  if (
    clientId === null ||
    clientId.length === 0 ||
    clientId.length > LIMITS.clientId ||
    redirectUri === null ||
    redirectUri.length === 0 ||
    redirectUri.length > LIMITS.redirectUri ||
    state === null ||
    state.length < 8 ||
    state.length > LIMITS.state ||
    codeChallenge === null ||
    codeChallenge.length < 43 ||
    codeChallenge.length > LIMITS.challenge ||
    method !== 'S256' ||
    scopeValues.length > 1
  ) {
    return null;
  }
  const scope = scopeValues[0] ?? '';
  if (scope.length > LIMITS.scope) return null;

  const canonical = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  if (scope.length > 0) canonical.set('scope', scope);
  return {
    clientId,
    redirectUri,
    state,
    codeChallenge,
    scope,
    query: canonical.toString(),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Treat API output as untrusted and bind displayed consent to the captured request. */
export function parseOAuthStageResult(
  value: unknown,
  request: OAuthAuthorizeRequest,
): OAuthStageResult | null {
  const body = record(value);
  const client = record(body?.client);
  const scopes = body?.scope;
  if (
    typeof body?.authorization_id !== 'string' ||
    body.authorization_id.length === 0 ||
    body.authorization_id.length > 128 ||
    client?.client_id !== request.clientId ||
    typeof client.label !== 'string' ||
    client.label.length === 0 ||
    client.label.length > 120 ||
    body.redirect_uri !== request.redirectUri ||
    body.state !== request.state ||
    !Array.isArray(scopes) ||
    scopes.length > 32 ||
    !scopes.every((scope) => typeof scope === 'string' && scope.length <= 64)
  ) {
    return null;
  }
  const requestedScopes = new Set(request.scope.split(/\s+/).filter(Boolean));
  if (!scopes.every((scope) => requestedScopes.has(scope))) return null;
  return {
    authorizationId: body.authorization_id,
    clientId: request.clientId,
    clientLabel: client.label,
    redirectUri: request.redirectUri,
    state: request.state,
    scopes,
  };
}

export function parseOAuthApprovalCode(value: unknown, stage: OAuthStageResult): string | null {
  const body = record(value);
  return typeof body?.code === 'string' &&
    body.code.length > 0 &&
    body.code.length <= 256 &&
    body.redirect_uri === stage.redirectUri &&
    body.state === stage.state
    ? body.code
    : null;
}

function callbackUrl(redirectUri: string): URL {
  if (redirectUri.length > LIMITS.redirectUri) throw new Error('unsafe OAuth callback');
  const url = new URL(redirectUri);
  const localHttp =
    url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (
    (url.protocol !== 'https:' && !localHttp) ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    throw new Error('unsafe OAuth callback');
  }
  return url;
}

/** Preserve registered query state while replacing OAuth-owned callback fields. */
export function buildOAuthCallbackUrl(
  redirectUri: string,
  state: string,
  result: { code: string } | { error: 'access_denied' },
): string {
  if (state.length < 8 || state.length > LIMITS.state) throw new Error('unsafe OAuth state');
  const url = callbackUrl(redirectUri);
  url.searchParams.delete('code');
  url.searchParams.delete('error');
  if ('code' in result) {
    if (result.code.length === 0 || result.code.length > 256) throw new Error('unsafe OAuth code');
    url.searchParams.set('code', result.code);
  } else {
    url.searchParams.set('error', result.error);
  }
  url.searchParams.set('state', state);
  return url.toString();
}

export function oauthCallbackHost(redirectUri: string): string {
  return callbackUrl(redirectUri).host;
}

/** Read JSON without allowing an upstream response to allocate unbounded memory. */
export async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > LIMITS.response) {
    throw new Error('OAuth response too large');
  }
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > LIMITS.response) {
        await reader.cancel();
        throw new Error('OAuth response too large');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return text.length === 0 ? null : JSON.parse(text);
}
