import pino, { type Logger as PinoLogger } from 'pino';
import type { Config } from './config.js';
import { redactUrlQueryTokens, redactText } from './redact-url.js';

/**
 * V-494 follow-up — err serializer. Pino's std `err` serializer copies the
 * error's `message`, `stack`, `type`, AND every other own-enumerable property —
 * ApiError.detail (set on every API error) + extensions, an upstream SDK/HTTP
 * error's nested cause/config/response (which can carry request headers, an api
 * key, a token), etc. `redact.paths` (key-based on the LOG object) can't reach a
 * credential embedded inside that free text. Redacting only message+stack left
 * detail/extensions/nested-cause UNredacted, so a caught error citing an
 * upstream/SSE `...?ds_token=` / OAuth `?code=` / `Bearer <token>` / `user:pass@`
 * URL in any of those props would land in the logs in plaintext (the log-channel
 * sibling of the lib/sentry.ts exception scrub). So run redactText over EVERY
 * string value in the serialized error (recursively, depth-capped). redactText
 * is a byte-identical no-op on credential-free strings, so this never mangles
 * clean diagnostic text. Over-depth and cyclic subtrees are REPLACED rather
 * than returned: returning the original object at the cap would retain the very
 * credential strings the cap is supposed to protect (and retain JSON cycles).
 */
const MAX_ERR_REDACT_DEPTH = 6;
const REDACTED_ERR_STRUCTURE = '[redacted: structure limit]';
// Static Pino redact paths only match known locations on the outer log object.
// Upstream SDK errors commonly bury headers/config several levels below `err`,
// so inspect each nested PROPERTY KEY too. Canonicalising case + separators
// covers Authorization / api_key / x-api-key without substring-matching benign
// diagnostics such as `tokenBudget` or `secretPrefix`. `code` is deliberately
// absent: Error.code carries essential values like ECONNRESET/EAI_AGAIN.
const SENSITIVE_ERR_KEYS = new Set([
  'authorization',
  'cookie',
  'setcookie',
  'stripesignature',
  'password',
  'newpassword',
  'currentpassword',
  'recoverycode',
  'recoverycodes',
  // Five-minute, single-use MFA challenge bearer returned by password auth
  // and presented on the TOTP/recovery exchange.
  'challengetoken',
  'apikey',
  'xapikey',
  'apisecret',
  'plaintext',
  'secret',
  'signingsecret',
  'webhooksecret',
  'totpsecret',
  'mfasecret',
  'clientsecret',
  'configblob',
  'privatekey',
  'byokanthropicapikey',
  'xbyokanthropicapikey',
  'guicontrolkey',
  'xdriftstackguicontrolkey',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'credential',
  'credentials',
]);
function isSensitiveErrKey(key: string): boolean {
  return SENSITIVE_ERR_KEYS.has(key.toLowerCase().replaceAll(/[^a-z0-9]/g, ''));
}
function redactErrValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_ERR_REDACT_DEPTH || seen.has(value)) return REDACTED_ERR_STRUCTURE;
  seen.add(value);
  if (Array.isArray(value)) {
    const redacted = value.map((v) => redactErrValue(v, depth + 1, seen));
    seen.delete(value);
    return redacted;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveErrKey(k) ? '[redacted]' : redactErrValue(v, depth + 1, seen);
  }
  seen.delete(value);
  return out;
}
export function redactErrSerializer(err: unknown): Record<string, unknown> {
  const base = pino.stdSerializers.err(err as Error) as Record<string, unknown>;
  return redactErrValue(base, 0, new WeakSet<object>()) as Record<string, unknown>;
}

/**
 * V-494 follow-up — pino `req` serializer. Fastify's built-in request log
 * records `req.url`, which for the SSE/EventSource path includes the bearer
 * token as `?ds_token=` (and the OAuth callback's single-use `?code=`).
 * Header + cookie redaction can't reach values embedded in the URL string,
 * so this sanitizes the logged URL. Exported so the wiring is directly
 * testable (a refactor that drops the serializer is caught by the test).
 * Mirrors Fastify 5's default req serializer shape.
 */
export function redactReqSerializer(req: {
  method?: string;
  url?: string;
  host?: string;
  ip?: string;
  socket?: { remotePort?: number };
}): {
  method?: string;
  url?: string;
  host?: string;
  remoteAddress?: string;
  remotePort?: number;
} {
  return {
    method: req.method,
    url: typeof req.url === 'string' ? redactUrlQueryTokens(req.url) : req.url,
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  };
}

// We re-export pino's Logger as our `Logger` type. Fastify's FastifyBaseLogger
// is structurally a subset of pino's Logger, so passing a pino instance to
// Fastify's `loggerInstance` works; we cast at the boundary in app.ts to
// satisfy Fastify's narrower expected type.
export type Logger = PinoLogger;

export function createLogger(config: Pick<Config, 'logLevel' | 'nodeEnv'>): Logger {
  const isDev = config.nodeEnv !== 'production';

  return pino({
    level: config.logLevel,
    base: { service: 'driftstack-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    // V-494 — defense-in-depth log redaction. Pino dot-paths cannot
    // wildcard-match every nested location, so we list the known
    // fields. New sensitive fields MUST be added here whenever a
    // request/response shape gains them. Mirrored in
    // `lib/sentry.ts::beforeSend` so Sentry captures don't carry
    // secrets even when pino is bypassed.
    redact: {
      paths: [
        // Auth headers
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        'req.headers["stripe-signature"]',
        // Arc 7 obs.2 — v2-#8 BYOK per-request header. Customers'
        // Anthropic keys arrive in this header on agent-session
        // message turns; MUST scrub even though the route never
        // logs req.headers explicitly (defense-in-depth: a future
        // refactor that adds a request-trace log would otherwise
        // leak the key).
        'req.headers["x-byok-anthropic-api-key"]',
        // gui_control_key per-session control header. The separate
        // simulator app presents the auto-minted per-session
        // gui_control_key in this header to drive the session-scoped
        // control endpoints (mode / takeover / handback / input-event)
        // without the account API key. Same defense-in-depth as the
        // BYOK header above — scrub it so no request-trace log can leak
        // the live control key.
        'req.headers["x-driftstack-gui-control-key"]',
        // Direct fields seen on objects logged inline
        'apiKey',
        'plaintext',
        'body.plaintext',
        'secret',
        'signingSecret',
        'webhookSecret',
        // Request-body fields on auth + MFA + password flows
        'body.password',
        'body.new_password',
        'body.current_password',
        'body.code',
        'body.recovery_code',
        'body.recovery_codes',
        'body.challenge_token',
        'body.challengeToken',
        'body.signing_secret',
        'body.secret',
        // Account-proxy VPN secrets (ARC A). The POST/PUT
        // /v1/account/me/proxies body carries the customer's VPN
        // credentials NESTED under the scheme block — the OpenVPN
        // config_blob embeds certs + private keys, the WireGuard
        // private_key is the tunnel key, and OpenVPN auth rides a
        // nested password (the top-level body.password path above
        // only reaches the socks5/http form). Path-based pino redaction
        // doesn't recurse, so each nested location is listed explicitly;
        // the bare keys (config_blob / private_key) are mirrored in
        // lib/sentry.ts so a captured request body can't leak there.
        'body.openvpn.config_blob',
        'body.openvpn.password',
        'body.wireguard.private_key',
        // Arc 7 obs.2 — v2-#8 BYOK PUT body field. The PUT
        // /v1/account/me/byok-anthropic-key route accepts the key
        // as { api_key: 'sk-ant-...' }. Same defense-in-depth as
        // the header above.
        'body.api_key',
        // Arc 7 obs.2 — v2-#8 sub-slice 8.4 gui_control_key.
        // Auto-minted per pair-mode session; surfaces in the
        // response payload as the plaintext (shown once). If a
        // future route adds the field on a request body too,
        // these glob the camelCase + snake_case variants.
        'gui_control_key',
        'guiControlKey',
        'body.gui_control_key',
        // Response-body fields surfaced on enrolment / mint paths
        'recovery_codes',
        'recoveryCodes',
        'challenge_token',
        'challengeToken',
        'totpSecret',
        'totp_secret',
        'mfaSecret',
        'client_secret',
        // OAuth token fields. The introspect/revoke request body carries
        // the bearer/refresh token as `{ token }` (routes/oauth.ts
        // IntrospectBody/RevokeBody); the token-endpoint response carries
        // `{ access_token, refresh_token }`. Same defense-in-depth as the
        // api_key fields above — scrub even though no current path logs
        // these, so a future request-trace log can't leak a live token.
        'body.token',
        'access_token',
        'refresh_token',
      ],
      censor: '[redacted]',
    },
    // V-494 follow-up — Fastify's built-in request log records `req.url`,
    // which for the SSE/EventSource path includes the bearer token as
    // `?ds_token=` (and the OAuth callback's single-use `?code=`). The
    // redactReqSerializer (above) sanitizes the logged URL; the Sentry side
    // is handled in lib/sentry.ts (event.request.url / query_string).
    serializers: {
      req: redactReqSerializer,
      // V-494 follow-up — scrub credential tokens embedded in a caught error's
      // message/stack before they reach the logs (free-text vector redact.paths
      // can't cover). See redactErrSerializer.
      err: redactErrSerializer,
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
    ...(isDev
      ? {
          // Pretty output in dev iff pino-pretty is installed; otherwise plain JSON.
          // We don't add the dep yet — JSON is fine for inspecting via jq.
        }
      : {}),
  });
}

export function createTestLogger(): Logger {
  return pino({ level: 'silent' });
}
