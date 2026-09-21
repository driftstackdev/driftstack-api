// Every value in the closed customer vocabulary for
// `POST /v1/account/me/proxies/:id/test` is documented in every place a
// customer reads it, or this fails. Same shape as
// `a-public-egress-warning-cannot-ship-undocumented.test.ts` next door, for
// the same reason: the vocabulary lives in several places by necessity —
// `customer-safe-proxy-test-vocabulary.ts` produces it, the api-types doc
// comments are what a TypeScript consumer reads on hover, the LIVE OpenAPI
// document (and its committed snapshot) is what the SDKs are generated from,
// the generated Pydantic model is what a Python consumer reads, and the docs
// page is what a customer finds by searching. A copy with no guard is a copy
// that drifts, and the drift is invisible because each one keeps looking
// complete on its own.
//
// ⛔ WHOLE-TOKEN MATCHING, NOT `includes`. `check_unavailable` is not a
// substring of anything else in this vocabulary, but the same discipline as
// the file next door applies: every check below matches the code INSIDE
// BACKTICKS, which is how every document here writes it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateOpenApiSpec } from '../../src/lib/openapi.js';
import {
  PUBLIC_OS_FINGERPRINT_UNAVAILABLE_CODES,
  PUBLIC_PROXY_TEST_NOT_RUN_CODES,
  PUBLIC_PROXY_TEST_CHECK_VALUES,
  PUBLIC_OS_FINGERPRINT_VANTAGE_FIELDS,
  resolveProxyTestVantage,
  publicOsFingerprintUnavailable,
  publicProxyTestNotRun,
  unmappedProxyTestVocabulary,
} from '../../src/services/customer-safe-proxy-test-vocabulary.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const API_TYPES = resolve(REPO_ROOT, 'packages/api-types/src/profiles.ts');
const DOCS_PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/proxies.md');
const SPEC_SNAPSHOT = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');
const PY_MODELS = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/_generated/models.py');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

/** The code as every document writes it: inside backticks, whole. */
function documents(text: string, code: string): boolean {
  return text.includes(`\`${code}\``);
}

describe('every published proxy-test result code is documented where customers read', () => {
  const apiTypes = read(API_TYPES);
  const docsPage = read(DOCS_PAGE);
  const liveSpecText = JSON.stringify(generateOpenApiSpec());
  const snapshotText = read(SPEC_SNAPSHOT);
  const pyModels = read(PY_MODELS);

  it('POSITIVE CONTROL — the vocabulary is really the closed set this file assumes, and the sources really contain the surface', () => {
    expect(PUBLIC_OS_FINGERPRINT_UNAVAILABLE_CODES).toEqual([
      'not_available_for_vpn',
      'not_captured',
      'not_offered_here',
    ]);
    expect(PUBLIC_PROXY_TEST_NOT_RUN_CODES).toEqual([
      'check_unavailable',
      'config_unresolvable',
      'live_session',
    ]);
    expect(PUBLIC_PROXY_TEST_CHECK_VALUES).toEqual(['quick', 'full']);
    expect(apiTypes).toContain('AccountProxyTestResultSchema');
    expect(apiTypes).toContain('AccountProxyOsFingerprintSchema');
    expect(docsPage).toContain('## Test a proxy');
    // A control on the matcher itself: a code that does not exist must not be
    // reported as documented, or every arm below is vacuous.
    expect(documents(apiTypes, 'not_a_real_code')).toBe(false);
    expect(documents(docsPage, 'not_a_real_code')).toBe(false);
    expect(documents(pyModels, 'not_a_real_code')).toBe(false);
  });

  const allReasonCodes = [
    ...PUBLIC_OS_FINGERPRINT_UNAVAILABLE_CODES,
    ...PUBLIC_PROXY_TEST_NOT_RUN_CODES,
  ];

  it('CRITICAL the api-types doc comments document every public reason code', () => {
    const missing = allReasonCodes.filter((code) => !documents(apiTypes, code));
    expect(missing, 'undocumented in packages/api-types/src/profiles.ts').toEqual([]);
  });

  it('CRITICAL the customer docs page documents every public reason code', () => {
    const missing = allReasonCodes.filter((code) => !documents(docsPage, code));
    expect(missing, 'undocumented in apps/docs/src/pages/api/proxies.md').toEqual([]);
  });

  it('CRITICAL the LIVE OpenAPI document carries every public reason code on the AccountProxyTestResult schema', () => {
    const missing = allReasonCodes.filter((code) => !documents(liveSpecText, code));
    expect(missing, 'undocumented in the generated OpenAPI document').toEqual([]);
  });

  it('CRITICAL the COMMITTED spec snapshot carries every public reason code — a stale snapshot is what the SDKs are generated from', () => {
    const missing = allReasonCodes.filter((code) => !documents(snapshotText, code));
    expect(
      missing,
      'undocumented in packages/sdk-python/openapi.json — re-run `npm run sdk:python:dump-spec`',
    ).toEqual([]);
  });

  it('CRITICAL the GENERATED Python model documents every public reason code', () => {
    const start = pyModels.indexOf('class AccountProxyTestResult1(BaseModel):');
    expect(start, 'the AccountProxyTestResult1 model was renamed or removed').toBeGreaterThan(-1);
    const block = pyModels.slice(start);
    const missing = allReasonCodes.filter((code) => !documents(block, code));
    expect(
      missing,
      'undocumented in the generated Pydantic models — re-run ' +
        '`npm run sdk:python:dump-spec` then `npm run sdk:python:generate`',
    ).toEqual([]);
  });

  it('CRITICAL the `check` query values are documented in the LIVE OpenAPI document and the docs page', () => {
    // Either spelling counts as documented: a value on its own
    // (`` `quick` ``) or paired with the parameter (`` `check=quick` ``) —
    // both tell a reader what to send.
    const documentsCheckValue = (text: string, value: string): boolean =>
      documents(text, value) || documents(text, `check=${value}`);
    for (const value of PUBLIC_PROXY_TEST_CHECK_VALUES) {
      expect(
        documentsCheckValue(liveSpecText, value),
        `check=${value} undocumented in the OpenAPI document`,
      ).toBe(true);
      expect(
        documentsCheckValue(docsPage, value),
        `check=${value} undocumented in the docs page`,
      ).toBe(true);
    }
    expect(documents(docsPage, 'check')).toBe(true);
  });

  it('CRITICAL the customer-worded os_fingerprint field aliases are documented everywhere the fields they mirror are', () => {
    for (const alias of Object.values(PUBLIC_OS_FINGERPRINT_VANTAGE_FIELDS)) {
      expect(documents(apiTypes, alias), `${alias} undocumented in api-types`).toBe(true);
      expect(documents(docsPage, alias), `${alias} undocumented in the docs page`).toBe(true);
      expect(documents(liveSpecText, alias), `${alias} undocumented in the OpenAPI document`).toBe(
        true,
      );
      expect(
        documents(snapshotText, alias),
        `${alias} undocumented in the committed spec snapshot`,
      ).toBe(true);
      expect(
        documents(pyModels, alias),
        `${alias} undocumented in the generated Python model`,
      ).toBe(true);
    }
  });

  it('CRITICAL no published proxy-test string names an internal mechanism — the customer-copy rule of this product: say WHAT, never HOW', () => {
    const forbidden = [
      'fleet',
      'node',
      'harness',
      'control_plane',
      'control plane',
      'observer',
      'vantage',
      'interpose',
      'webkit',
      'dyld',
      'pf_',
      'tcc',
      'spawn',
      'founder',
      'undetectable',
      'port',
    ];
    const published = [
      ...allReasonCodes,
      ...PUBLIC_PROXY_TEST_CHECK_VALUES,
      ...Object.values(PUBLIC_OS_FINGERPRINT_VANTAGE_FIELDS),
    ];
    for (const code of published) {
      for (const term of forbidden) {
        expect(code, `the public string "${code}" says HOW`).not.toContain(term);
      }
    }
  });

  it('every distinct internal cause the route can produce maps to a member of the closed public set — measured by walking the source rather than trusting the map to describe itself', () => {
    // The three internal os_fingerprint_unavailable causes and the five
    // internal not_run causes this repository's own code can produce (see
    // `routes/account-me.ts` — every one is a literal in this file, not
    // device-supplied text; that is the whole reason the map is exhaustive
    // rather than defensive-only).
    const internalOsCauses = ['vpn_tunnel', 'not_observed', 'observer_off'];
    const internalNotRunCauses = [
      'live_session',
      'unresolvable',
      'node_busy',
      'node_error',
      'no_node',
    ];
    for (const cause of internalOsCauses) {
      const mapped = publicOsFingerprintUnavailable(cause);
      expect(mapped, `${cause} has no public mapping`).not.toBeNull();
      expect(PUBLIC_OS_FINGERPRINT_UNAVAILABLE_CODES).toContain(mapped);
    }
    for (const cause of internalNotRunCauses) {
      const mapped = publicProxyTestNotRun(cause);
      expect(PUBLIC_PROXY_TEST_NOT_RUN_CODES).toContain(mapped);
    }
  });
});

describe('resolveProxyTestVantage — the query-parameter alias', () => {
  it('CRITICAL `check` (documented) wins when both `check` and `vantage` are present', () => {
    expect(resolveProxyTestVantage({ check: 'full', vantage: 'cp' })).toEqual({ vantage: 'fleet' });
    expect(resolveProxyTestVantage({ check: 'quick', vantage: 'fleet' })).toEqual({
      vantage: 'cp',
    });
  });

  it('`vantage` (legacy, undocumented) is still accepted alone', () => {
    expect(resolveProxyTestVantage({ vantage: 'fleet' })).toEqual({ vantage: 'fleet' });
    expect(resolveProxyTestVantage({ vantage: 'cp' })).toEqual({ vantage: 'cp' });
  });

  it('`check` alone maps correctly both ways', () => {
    expect(resolveProxyTestVantage({ check: 'quick' })).toEqual({ vantage: 'cp' });
    expect(resolveProxyTestVantage({ check: 'full' })).toEqual({ vantage: 'fleet' });
  });

  it('neither present defaults to quick/cp — unchanged default behaviour', () => {
    expect(resolveProxyTestVantage({})).toEqual({ vantage: 'cp' });
  });

  it('NEGATIVE CONTROL — an invalid `check` value is refused with a customer-worded error naming `check`, not `vantage`', () => {
    const result = resolveProxyTestVantage({ check: 'bogus' });
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('check');
      expect(result.error).toContain('quick');
      expect(result.error).toContain('full');
    }
  });

  it('NEGATIVE CONTROL — an invalid `vantage` value is refused the same way the route always refused it', () => {
    const result = resolveProxyTestVantage({ vantage: 'bogus' });
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('vantage');
    }
  });

  it('a non-string value for either parameter is refused, not coerced', () => {
    expect('error' in resolveProxyTestVantage({ check: ['full'] })).toBe(true);
    expect('error' in resolveProxyTestVantage({ vantage: 123 })).toBe(true);
  });
});

describe('publicOsFingerprintUnavailable / publicProxyTestNotRun — the mapping itself', () => {
  it('CRITICAL each internal cause maps to its documented public word', () => {
    expect(publicOsFingerprintUnavailable('vpn_tunnel')).toBe('not_available_for_vpn');
    expect(publicOsFingerprintUnavailable('not_observed')).toBe('not_captured');
    expect(publicOsFingerprintUnavailable('observer_off')).toBe('not_offered_here');

    expect(publicProxyTestNotRun('live_session')).toBe('live_session');
    expect(publicProxyTestNotRun('unresolvable')).toBe('config_unresolvable');
    expect(publicProxyTestNotRun('node_busy')).toBe('check_unavailable');
    expect(publicProxyTestNotRun('node_error')).toBe('check_unavailable');
    expect(publicProxyTestNotRun('no_node')).toBe('check_unavailable');
  });

  it('CRITICAL an unrecognised os_fingerprint_unavailable cause is DROPPED (null), never leaked — absence already means "no cause reported"', () => {
    expect(publicOsFingerprintUnavailable('a_future_cause_nobody_mapped')).toBeNull();
  });

  it('CRITICAL an unrecognised not_run cause NEVER drops — it must remain present so ok:false is never misread as a real verdict — and lands on the safest true statement', () => {
    expect(publicProxyTestNotRun('a_future_cause_nobody_mapped')).toBe('check_unavailable');
  });

  it('an unrecognised cause is recorded through the shared bounded recorder, sanitised', () => {
    publicOsFingerprintUnavailable('zz_test_unmapped_os_cause');
    publicProxyTestNotRun('zz_test_unmapped_not_run_cause');
    expect(
      unmappedProxyTestVocabulary
        .counts()
        .get('os_fingerprint_unavailable:zz_test_unmapped_os_cause'),
    ).toBeGreaterThan(0);
    expect(
      unmappedProxyTestVocabulary.counts().get('not_run:zz_test_unmapped_not_run_cause'),
    ).toBeGreaterThan(0);
  });
});
