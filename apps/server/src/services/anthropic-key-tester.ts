// Live, no-inference validation for a customer-supplied Anthropic API key.
// Anthropic documents GET /v1/models as the authenticated model-discovery
// endpoint. Requesting one row proves the credential reaches the provider
// without spending inference tokens or selecting a billable model.

const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models?limit=1';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 30_000;

export type AnthropicKeyTestOutcome = 'invalid' | 'quota_exceeded' | 'unknown';
export type AnthropicKeyTestResult =
  | { ok: true }
  | { ok: false; outcome: AnthropicKeyTestOutcome; reason: string };

export interface AnthropicKeyTesterOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const INVALID_REASON =
  'Anthropic rejected this API key as invalid or unauthorized. Check or rotate it and try again.';
const RATE_LIMIT_REASON =
  'Anthropic rate-limited the connection test. Wait a moment and try again.';
const SERVICE_REASON =
  'Anthropic could not complete the connection test right now. Wait a moment and try again.';
const TIMEOUT_REASON = 'The Anthropic connection test timed out. Check your network and try again.';
const NETWORK_REASON =
  'Could not reach Anthropic to test this key. Check your network and try again.';

/**
 * Build the route's key tester. Every failure reason is fixed customer-safe
 * copy: upstream response bodies, native transport errors, and the plaintext
 * key never enter the result. Response bodies are cancelled because the HTTP
 * status alone is the authentication verdict.
 */
export function makeAnthropicKeyTester(
  options: AnthropicKeyTesterOptions = {},
): (apiKey: string) => Promise<AnthropicKeyTestResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));

  return async (apiKey: string): Promise<AnthropicKeyTestResult> => {
    if (apiKey.length === 0) {
      return { ok: false, outcome: 'invalid', reason: INVALID_REASON };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(ANTHROPIC_MODELS_URL, {
        method: 'GET',
        headers: {
          'anthropic-version': ANTHROPIC_VERSION,
          'x-api-key': apiKey,
        },
        signal: controller.signal,
      });
      // Do not read or reflect an upstream body. Cancelling promptly also keeps
      // an attacker-controlled/oversized error response out of process memory.
      void response.body?.cancel().catch(() => undefined);

      if (response.ok) return { ok: true };
      if (response.status === 401 || response.status === 403) {
        return { ok: false, outcome: 'invalid', reason: INVALID_REASON };
      }
      if (response.status === 429) {
        return { ok: false, outcome: 'quota_exceeded', reason: RATE_LIMIT_REASON };
      }
      return { ok: false, outcome: 'unknown', reason: SERVICE_REASON };
    } catch {
      return {
        ok: false,
        outcome: 'unknown',
        reason: controller.signal.aborted ? TIMEOUT_REASON : NETWORK_REASON,
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

export const testAnthropicKey = makeAnthropicKeyTester();
