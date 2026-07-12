// Conservative defense-in-depth for model/customer type intents. Secret values
// are never inspected; only the CSS selector's standard field metadata is used.
// False positives merely disable typo correction and suppress input logging,
// while a false negative can expose a password/OTP/card value to ordinary input
// telemetry. Explicit `sensitive:true` remains the primary signal.

const SENSITIVE_AUTOCOMPLETE_RE =
  /autocomplete\s*=\s*["']?(?:current-password|new-password|one-time-code|cc-number|cc-csc)(?:["'\]\s]|$)/i;
const PASSWORD_TYPE_RE = /type\s*=\s*["']?password(?:["'\]\s]|$)/i;
const SENSITIVE_TOKEN_RE =
  /(?:^|[#.[\]_\-\s"'=:])(?:password|passwd|passcode|one[-_ ]?time[-_ ]?code|otp|totp|mfa|2fa|pin|cvv|cvc|cc[-_ ]?(?:number|csc)|card[-_ ]?(?:number|security)|api[-_ ]?key|secret)(?=$|[#.[\]_\-\s"'=:])/i;

export function selectorImpliesSensitiveInput(selector: string): boolean {
  const normalized = selector.normalize('NFKC');
  return (
    PASSWORD_TYPE_RE.test(normalized) ||
    SENSITIVE_AUTOCOMPLETE_RE.test(normalized) ||
    SENSITIVE_TOKEN_RE.test(normalized)
  );
}
