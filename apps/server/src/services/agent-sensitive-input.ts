// Conservative defense-in-depth for model/customer type intents. Secret values
// are never inspected; only the CSS selector's standard field metadata is used.
// False positives merely disable typo correction and suppress input logging,
// while a false negative can expose a password/OTP/card value to ordinary input
// telemetry. Explicit `sensitive:true` remains the primary signal.
//
// The token boundary is ANY non-alphanumeric, not a list of delimiters. The list
// form omitted every CSS combinator, so `#password>input`, `#password,#email`,
// `#password+label`, `#password~span` and `:is(#password)` all read as ordinary
// input: the token was present and the character after it merely was not on the
// list. `_` and `-` must stay boundaries — `#login_passwd` has to match — which
// is why this is a negated class rather than `\b`. Alphanumeric on either side
// still blocks a substring hit, so `#spin` and `#pinboard` remain negative.

const SENSITIVE_AUTOCOMPLETE_RE =
  /autocomplete\s*=\s*["']?(?:current-password|new-password|one-time-code|cc-number|cc-csc)(?:["'\]\s]|$)/i;
const PASSWORD_TYPE_RE = /type\s*=\s*["']?password(?:["'\]\s]|$)/i;
const SENSITIVE_TOKEN_RE =
  /(?:^|[^A-Za-z0-9])(?:password|passwd|passcode|one[-_ ]?time[-_ ]?code|otp|totp|mfa|2fa|pin|cvv|cvc|cc[-_ ]?(?:number|csc)|card[-_ ]?(?:number|security)|api[-_ ]?key|secret)(?=$|[^A-Za-z0-9])/i;

export function selectorImpliesSensitiveInput(selector: string): boolean {
  const normalized = selector.normalize('NFKC');
  return (
    PASSWORD_TYPE_RE.test(normalized) ||
    SENSITIVE_AUTOCOMPLETE_RE.test(normalized) ||
    SENSITIVE_TOKEN_RE.test(normalized)
  );
}
