// The TOTP parameters published to customers are the ones the server computes
// with — including the one that is derived rather than stated.
//
// `api/mfa.md` publishes an "Algorithm details" table: SHA-1, a 30-second
// period, 6 digits, "±1 window (90s total)" of drift tolerance, `Driftstack` as
// the issuer, and 10 recovery codes per enrollment. These are interop
// parameters. An authenticator app configured from them either produces the
// same six digits the server expects or it does not, and a customer whose codes
// are rejected has no way to tell a wrong period from a wrong secret.
//
// Five tests reference this page and none imports a TOTP constant, so the table
// is pinned as text and compared to nothing — the same shape found on the rate
// limit table, the retry schedule, and the tier caps on six pages.
//
// The drift figure is the interesting one and the reason this is worth writing
// rather than eyeballing. "90s total" is not a constant anywhere; it is
// `(2 * TOTP_DRIFT_WINDOWS + 1) * TOTP_PERIOD_SECONDS`. Changing the period to
// 60 while leaving the window count alone leaves every stated number on the
// page individually defensible and the total silently wrong, which is exactly
// the kind of drift a text pin cannot see and a reader cannot catch.
//
// `TOTP_PERIOD_SECONDS`, `TOTP_DIGITS` and `TOTP_DRIFT_WINDOWS` are exported and
// imported here. The hash algorithm, the issuer and the recovery-code count are
// module-private, so they are read out of the source — the same approach the
// backoff guard takes for the worker's private table. Reading them is what makes
// the comparison real; restating them here would just be a second copy to drift.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TOTP_DIGITS, TOTP_DRIFT_WINDOWS, TOTP_PERIOD_SECONDS } from '../../src/lib/mfa-totp.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO, 'apps/docs/src/pages/api/mfa.md');
const SOURCE = resolve(REPO, 'apps/server/src/lib/mfa-totp.ts');

/** `| Field | Value |` rows of the published algorithm table. */
function publishedTable(): Map<string, string> {
  const md = readFileSync(DOC, 'utf8');
  const start = md.indexOf('## Algorithm details');
  const out = new Map<string, string>();
  if (start < 0) return out;
  for (const line of md.slice(start).split('\n')) {
    const m = /^\|\s*([A-Za-z][A-Za-z -]+?)\s*\|\s*(.+?)\s*\|\s*$/.exec(line);
    if (m === null) continue;
    if (m[1] === 'Field' || /^-+$/.test(m[2] ?? '')) continue;
    out.set(m[1]!, m[2]!);
  }
  return out;
}

/** Module-private constants, read from source because they are not exported. */
function privateConstants(): { algorithm: string; issuer: string; recoveryCount: number } {
  const src = readFileSync(SOURCE, 'utf8');
  const algorithm = /createHmac\(\s*'([a-z0-9]+)'/.exec(src)?.[1] ?? '';
  const issuer = /const issuer = '([^']+)'/.exec(src)?.[1] ?? '';
  const recoveryCount = Number(/const RECOVERY_COUNT = (\d+);/.exec(src)?.[1] ?? NaN);
  return { algorithm, issuer, recoveryCount };
}

describe('the published TOTP parameters match the code', () => {
  it('CRITICAL the table and the private constants were both read. Every comparison below reports disagreement, and a value read as an empty string disagrees with nothing useful — an unparsed table would report the algorithm verified having read none of it.', () => {
    const table = publishedTable();
    const priv = privateConstants();

    expect(table.size, 'rows parsed from the published algorithm table').toBeGreaterThanOrEqual(6);
    for (const field of ['Algorithm', 'Period', 'Digits', 'Drift tolerance', 'Issuer']) {
      expect(table.has(field), `the table still publishes "${field}"`).toBe(true);
    }
    expect(priv.algorithm, 'hash algorithm recovered from source').not.toBe('');
    expect(priv.issuer, 'issuer recovered from source').not.toBe('');
    expect(priv.recoveryCount, 'recovery-code count recovered from source').toBeGreaterThan(0);
  });

  it('CRITICAL algorithm, period and digits are what the server computes with. An authenticator configured from this table either produces the six digits the server expects or it does not, and the customer sees only "invalid code".', () => {
    const table = publishedTable();
    const priv = privateConstants();

    // The page writes SHA-1; the code passes 'sha1' to createHmac.
    expect(
      (table.get('Algorithm') ?? '').toLowerCase().replace(/-/g, ''),
      'published hash algorithm',
    ).toBe(priv.algorithm.toLowerCase());
    expect(Number(/(\d+)/.exec(table.get('Period') ?? '')?.[1]), 'published period seconds').toBe(
      TOTP_PERIOD_SECONDS,
    );
    expect(Number(table.get('Digits')), 'published digit count').toBe(TOTP_DIGITS);
  });

  it('CRITICAL the drift tolerance and its stated total agree with the code. "90s total" is derived — (2 * windows + 1) * period — so changing the period alone leaves every individual number defensible and the total wrong, which is precisely what a text pin cannot see.', () => {
    const published = publishedTable().get('Drift tolerance') ?? '';
    const windows = Number(/±\s*(\d+)\s*window/.exec(published)?.[1]);
    const total = Number(/(\d+)\s*s\b/.exec(published)?.[1]);

    expect(windows, 'window count parsed from the page').toBe(TOTP_DRIFT_WINDOWS);
    expect(total, 'total tolerance seconds parsed from the page').toBe(
      (2 * TOTP_DRIFT_WINDOWS + 1) * TOTP_PERIOD_SECONDS,
    );
  });

  it('CRITICAL the issuer and recovery-code count match. The issuer is what an authenticator app displays, so a mismatch labels the entry with a name the customer does not recognise; the count is what they are told to store before losing access to the device.', () => {
    const table = publishedTable();
    const priv = privateConstants();

    expect((table.get('Issuer') ?? '').replace(/`/g, '').trim(), 'published issuer string').toBe(
      priv.issuer,
    );
    expect(
      Number(/(\d+)/.exec(table.get('Recovery code count') ?? '')?.[1]),
      'published recovery-code count',
    ).toBe(priv.recoveryCount);
  });
});
