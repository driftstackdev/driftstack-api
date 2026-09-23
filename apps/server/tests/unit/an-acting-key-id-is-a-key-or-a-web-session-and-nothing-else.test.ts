// An acting key id is an API key's uuid or a web session's `wsk_<uuid>`, and
// nothing else — lib/acting-key-columns.ts, the one place every writer and
// reader of an actor column turns that id into its two columns and back.
//
// The failure it exists for: a signed-in browser acts as `wsk_<uuid>`, and every
// table that recorded the acting key held it in a `uuid` column, so the admin
// panel's audited writes answered 500 and the dashboard's activity rows vanished
// (migration 0138). The in-memory test repositories accepted ANY string, which is
// how a fixture id like `wsk_ws-owner` passed where production could not; they
// now call this same function, so its refusals are the database's.

import { describe, expect, it } from 'vitest';
import {
  actingKeyColumns,
  actingKeyIdFromColumns,
  optionalActingKeyColumns,
  publicActingKeyId,
  requiredActingKeyIdFromColumns,
} from '../../src/lib/acting-key-columns.js';

const KEY = '0f8b2c4e-1a2b-4c3d-8e9f-0123456789ab';
const SESSION = '7d1e9a30-5b6c-4d7e-9f80-a1b2c3d4e5f6';

describe('an acting key id is a key or a web session and nothing else', () => {
  it('CRITICAL a bare uuid is an API key; `wsk_<uuid>` is a web session; each lands in exactly one column', () => {
    expect(actingKeyColumns(KEY)).toEqual({ keyId: KEY, webSessionId: null });
    expect(actingKeyColumns(`wsk_${SESSION}`)).toEqual({ keyId: null, webSessionId: SESSION });
  });

  it('CRITICAL anything else throws before it can reach a uuid column — including the fixture shape that hid the bug, a published key id, and 36 dashes', () => {
    for (const bad of [
      'wsk_ws-owner',
      `key_${KEY}`,
      `wsk_${KEY}x`,
      `wsk_wsk_${SESSION}`,
      '-'.repeat(36),
      '',
      `${KEY} `,
      'admin-key',
    ]) {
      expect(() => actingKeyColumns(bad), JSON.stringify(bad)).toThrow(RangeError);
    }
  });

  it('a column that may record no actor takes null or undefined as "none", and still refuses a malformed id', () => {
    expect(optionalActingKeyColumns(null)).toEqual({ keyId: null, webSessionId: null });
    expect(optionalActingKeyColumns(undefined)).toEqual({ keyId: null, webSessionId: null });
    expect(() => optionalActingKeyColumns('wsk_ws-owner')).toThrow(RangeError);
  });

  it('CRITICAL reading the columns back gives the very string the auth context had, so no reader changes type', () => {
    for (const acting of [KEY, `wsk_${SESSION}`]) {
      const cols = actingKeyColumns(acting);
      expect(actingKeyIdFromColumns(cols.keyId, cols.webSessionId)).toBe(acting);
      expect(requiredActingKeyIdFromColumns(cols.keyId, cols.webSessionId)).toBe(acting);
    }
    expect(actingKeyIdFromColumns(null, null)).toBeNull();
  });

  it('a row naming both, or a row that must name one naming neither, is refused on read — the database refuses both', () => {
    expect(() => actingKeyIdFromColumns(KEY, SESSION)).toThrow(RangeError);
    expect(() => requiredActingKeyIdFromColumns(null, null)).toThrow(RangeError);
  });

  it('uppercase is accepted as Postgres accepts it, and normalised to the lowercase the column reads back', () => {
    expect(actingKeyColumns(KEY.toUpperCase())).toEqual({ keyId: KEY, webSessionId: null });
    expect(actingKeyColumns(`wsk_${SESSION.toUpperCase()}`)).toEqual({
      keyId: null,
      webSessionId: SESSION,
    });
  });

  it('CRITICAL a published response names a key `key_<uuid>` as it always has, and a web session `wsk_<uuid>` — never `key_wsk_…`, a key that does not exist', () => {
    expect(publicActingKeyId(KEY)).toBe(`key_${KEY}`);
    expect(publicActingKeyId(`wsk_${SESSION}`)).toBe(`wsk_${SESSION}`);
    expect(() => publicActingKeyId('wsk_ws-owner')).toThrow(RangeError);
  });
});
