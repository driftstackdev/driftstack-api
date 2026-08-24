// Every credential this system mints is scrubbed from free text, wherever in
// that text it appears.
//
// `lib/logger.ts` runs `redactText` over every string in a serialized error
// precisely because key-based redaction cannot reach a credential embedded in a
// message: "`redact.paths` (key-based on the LOG object) can't reach a credential
// embedded inside that free text". That is the job. It was only doing part of it.
//
// The patterns recognised a credential by its POSITION — after `bearer`, as a
// named query parameter, inside URL userinfo — and a bare literal matched none
// of them. `Invalid API key: ds_live_…` from an upstream, or a request body
// echoed into an error message, went to the log in full. Measured before the
// fix: six of ten realistic shapes leaked, including both environments of this
// system's own API key, the per-session GUI control key, and webhook signing
// secrets.
//
// The fix recognises credentials by PREFIX as well as position, from an
// ALLOWLIST. That distinction is the whole design. This system mints a great
// many prefixed identifiers — `acc_`, `prof_`, `ses_`, `mem_`, `inc_`, `agt_`,
// `key_` — and every one of them is a PUBLIC id that belongs in a log. A generic
// `word_<random>` rule would scrub the identifiers people debug with, which is
// how a redactor gets switched off. Only values that are secret by construction
// are listed, and the prefix survives redaction so a log still says which kind
// of credential was removed.
//
// Both directions are tested here, because a redactor that scrubs too much fails
// differently and just as badly as one that scrubs too little.
//
// NOT COVERED, and stated rather than left to be found: `generateAuthToken`
// emits bare base64url with no prefix. Nothing distinguishes it from any other
// random string, so no pattern can catch it without eating ordinary prose. The
// tokens it mints are single-use and short-lived, which is the mitigation, not
// the absence of a pattern.

import { describe, expect, it } from 'vitest';
import { redactText } from '../../src/lib/redact-url.js';

/** Bodies use the same lowercase base32 alphabet the minters use. */
const BODY = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * Every credential shape the system mints, keyed by the function that mints it.
 *
 * A prefix added to the redactor without an entry here is untested; one removed
 * from the redactor fails here rather than silently going quiet.
 */
const MINTED_SECRETS: { name: string; sample: string; minter: string }[] = [
  { name: 'live API key', sample: `ds_live_${BODY}`, minter: 'lib/api-keys.ts generateApiKey' },
  { name: 'test API key', sample: `ds_test_${BODY}`, minter: 'lib/api-keys.ts generateApiKey' },
  {
    name: 'GUI control key',
    sample: `gck_${BODY}`,
    minter: 'lib/gui-control-key-encryption.ts generateGuiControlKey',
  },
  {
    name: 'webhook signing secret',
    sample: `whsec_${BODY}`,
    minter: 'lib/webhook-signing.ts generateWebhookSecret',
  },
  // V-1452 — both reached the log in CLEAR until this commit. The prefix
  // allowlist was hand-written and these were never added; the derived guard
  // that exists to catch exactly that missed them too, because it recognised a
  // secret only as `base32Encode(randomBytes(...))` and only inside a `function`
  // declaration, while OAuth mints `randomBytes(32).toString('base64url')`
  // inside class methods.
  //
  // Their bodies are base64url, so the sample carries `-` and `_` deliberately:
  // the general prefix pattern's `[A-Za-z0-9]` body class stops at the first of
  // either, which would redact a prefix and leave the rest of the credential
  // readable. That is why these have their own pattern.
  {
    name: 'OAuth client secret',
    sample: 'oas_kQ7v-N2xR8mB_4tL9wZ1cY6dF3hJ5nP0sA',
    minter: 'services/oauth.ts registerClient + rotateClientSecret',
  },
  {
    name: 'OAuth access token',
    sample: 'oat_pM3k-X7bV2nQ_9wL5tR8yD1cF4hJ6sZ0aG',
    minter: 'services/oauth.ts exchangeCode (returned as access_token)',
  },
];

/** Third-party secrets that arrive in upstream error text rather than minted. */
const FOREIGN_SECRETS = [
  { name: 'Stripe secret key', sample: 'sk_live_51ABCdefGHIjklMNOpqrSTUvwx' },
  { name: 'Stripe restricted key', sample: 'rk_live_51ABCdefGHIjklMNOpqrSTUvwx' },
];

/** Public identifiers that MUST survive redaction — logs are debugged with these. */
const PUBLIC_IDS = [
  'acc_9c8b7a6d-5e4f-3210-abcd-ef0123456789',
  'prof_9c8b7a6d-5e4f-3210-abcd-ef0123456789',
  'ses_9c8b7a6d-5e4f-3210-abcd-ef0123456789',
  'mem_9c8b7a6d-5e4f-3210-abcd-ef0123456789',
  'inc_9c8b7a6d-5e4f-3210-abcd-ef0123456789',
];

describe('redactText scrubs every minted credential shape', () => {
  it('CRITICAL a minted credential is scrubbed wherever it sits in the text. Position-based patterns miss the bare literal, which is the shape an upstream error message actually carries — and the reason redactText exists at all is to reach credentials that key-based redaction cannot.', () => {
    const leaks: string[] = [];
    for (const { name, sample, minter } of MINTED_SECRETS) {
      const contexts = [
        sample,
        `Invalid API key: ${sample}`,
        `{"plaintext":"${sample}"}`,
        `upstream said <${sample}> was rejected`,
      ];
      for (const context of contexts) {
        const out = redactText(context);
        if (out.includes(BODY) || out.includes(sample)) {
          leaks.push(`${name} (${minter}) survives in: ${context.slice(0, 60)}`);
        }
      }
    }
    expect(leaks.sort(), 'minted credential(s) that reach a log in full:').toEqual([]);
  });

  it('CRITICAL third-party secrets are scrubbed too. A Stripe key arrives in the text of an upstream error rather than through any of our own code paths, so position-based patterns never see it.', () => {
    const leaks = FOREIGN_SECRETS.filter(({ sample }) =>
      redactText(`stripe error: ${sample} is invalid`).includes(sample),
    ).map(({ name }) => name);
    expect(leaks.sort(), 'third-party secret(s) that reach a log in full:').toEqual([]);
  });

  it('CRITICAL public identifiers survive redaction. Scrubbing too much fails as badly as scrubbing too little: these are the ids a person debugs with, and a redactor that eats them is one that gets switched off.', () => {
    const eaten = PUBLIC_IDS.filter((id) => !redactText(`session ${id} closed`).includes(id));
    expect(eaten.sort(), 'public identifier(s) wrongly redacted:').toEqual([]);
  });

  it('CRITICAL the positional patterns still work and still win. A bearer credential must be replaced whole rather than prefix-first — reversed, the prefix pattern rewrites the body and the bearer pattern then stops at the bracket, leaving a doubled marker that reads as a bug.', () => {
    expect(redactText(`authorization: Bearer ds_live_${BODY}`)).toBe(
      'authorization: Bearer [redacted]',
    );
    expect(redactText(`https://api.driftstack.dev/v1/x?api_key=ds_live_${BODY}`)).toBe(
      'https://api.driftstack.dev/v1/x?api_key=[redacted]',
    );
    expect(redactText('postgres://user:supersecret@host:5432/db')).toBe(
      'postgres://[redacted]@host:5432/db',
    );
  });

  it('CRITICAL redaction keeps the prefix. A log saying a credential was removed is useful; one saying only [redacted] cannot tell an API key from a webhook secret, and the kind is what a responder needs first.', () => {
    expect(redactText(`ds_live_${BODY}`)).toBe('ds_live_[redacted]');
    expect(redactText(`gck_${BODY}`)).toBe('gck_[redacted]');
    expect(redactText(`whsec_${BODY}`)).toBe('whsec_[redacted]');
  });
});
