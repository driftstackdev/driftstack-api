// Increment-2 — unit tests for the harness control-plane wire codec
// (serializeIntentDispatch / parseIntentResult + encode/decodeWireData).
// Pins the A3-confirmed base64-JSON `Data` codec + camelCase envelopes, and
// the round-trip with the (b) mapper output.

import { describe, expect, it } from 'vitest';
import {
  encodeWireData,
  decodeWireData,
  serializeIntentDispatch,
  serializeSessionAssign,
  serializeSessionEnd,
  serializePauseSession,
  serializeResumeSession,
  serializeCookiesRequest,
  serializeSetCookies,
  serializeNavigateHistory,
  serializeUploadFile,
  serializeListDownloads,
  serializeFetchDownload,
  parseIntentResult,
  HarnessWireCodecError,
} from '../../src/services/harness-control-codec.js';
import {
  IntentDispatchSchema,
  IntentResultEnvelopeSchema,
  SessionAssignSchema,
  SessionEndSchema,
} from '../../src/schemas/harness-control-protocol.js';
import { agentIntentToDispatch } from '../../src/services/agent-intent-to-dispatch.js';

describe('encode/decodeWireData — base64 JSON round-trip', () => {
  it('encodes to base64 of the UTF-8 JSON', () => {
    const enc = encodeWireData({ url: 'https://example.com' });
    expect(enc).toBe(Buffer.from('{"url":"https://example.com"}', 'utf8').toString('base64'));
    expect(Buffer.from(enc, 'base64').toString('utf8')).toBe('{"url":"https://example.com"}');
  });

  it('round-trips arbitrary JSON values (object / empty / nested / unicode)', () => {
    for (const v of [{ a: 1 }, {}, { n: { deep: [1, 'x', true] } }, { s: 'héllo·世界' }]) {
      expect(decodeWireData(encodeWireData(v))).toEqual(v);
    }
  });

  it('decodeWireData throws HarnessWireCodecError on non-JSON base64', () => {
    const notJson = Buffer.from('not json at all', 'utf8').toString('base64');
    expect(() => decodeWireData(notJson)).toThrow(HarnessWireCodecError);
  });

  // V-1382 — the arm above feeds VALID base64 whose bytes are not JSON, which is why the
  // decoder's base64 branch showed as never executed: it could not execute. `Buffer.from(x,
  // 'base64')` throws for no input at all, so the try/catch that used to wrap the decode was
  // dead, and the doc comment promising a "malformed base64" refusal described something the
  // function never did. These two pin what it does instead.
  it('CRITICAL malformed base64 is NOT rejected as base64 — Node drops the characters outside the alphabet and the leftover bytes are what fails, so the caller is told the payload was not JSON. Pinned because the previous doc comment claimed the opposite, and a wire field that reads as validated when it is not is worse than one nobody claimed for.', () => {
    // Node's own behaviour, asserted rather than assumed: no input makes this throw.
    for (const garbage of ['not-base64!!', '$$$$', 'A', '====']) {
      expect(() => Buffer.from(garbage, 'base64')).not.toThrow();
    }

    expect(() => decodeWireData('not-base64!!')).toThrow(HarnessWireCodecError);
    expect(() => decodeWireData('not-base64!!')).toThrow(/did not contain valid JSON/);
    expect(
      () => decodeWireData('not-base64!!'),
      'no base64-specific refusal exists on this path',
    ).not.toThrow(/is not valid base64/);
  });

  it('CRITICAL a string outside the base64 alphabet that happens to decode to valid JSON is ACCEPTED. This is the cost of the permissive decode, stated rather than discovered later: `{"a":1}` survives characters Node simply drops, so the wire field has more than one accepted spelling.', () => {
    const canonical = encodeWireData({ a: 1 });
    const respelled = `${canonical}!!`; // `!` is outside the alphabet and is dropped
    expect(respelled).not.toBe(canonical);
    expect(decodeWireData(respelled), 'the dropped characters change nothing').toEqual({ a: 1 });
  });
});

describe('serializeIntentDispatch', () => {
  it('builds a schema-valid IntentDispatch with base64-encoded params', () => {
    const d = serializeIntentDispatch({
      sessionId: 'ses_x',
      intentId: 'int_1',
      intentName: 'navigate',
      params: { url: 'https://example.com' },
    });
    expect(IntentDispatchSchema.safeParse(d).success).toBe(true);
    expect(typeof d.inputParams).toBe('string');
    expect(d.sessionId).toBe('ses_x');
    expect(d.intentName).toBe('navigate');
    // inputParams decodes back to the original params.
    expect(decodeWireData(d.inputParams)).toEqual({ url: 'https://example.com' });
  });

  it('encodes no-param intents as base64 of {}', () => {
    const d = serializeIntentDispatch({
      sessionId: 'ses_x',
      intentId: 'int_2',
      intentName: 'screenshot',
      params: {},
    });
    expect(decodeWireData(d.inputParams)).toEqual({});
  });

  it('rejects params that fail the per-intent harness contract (caught here, not at the harness)', () => {
    expect(() =>
      serializeIntentDispatch({
        sessionId: 'ses_x',
        intentId: 'int_3',
        intentName: 'navigate',
        params: {}, // navigate requires url
      }),
    ).toThrow(HarnessWireCodecError);
  });

  it('composes with the (b) mapper: AgentIntent → dispatch → wire envelope', () => {
    const mapped = agentIntentToDispatch({
      kind: 'interact',
      action: 'type',
      selector: '#email',
      value: 'a@b.com',
    });
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) throw new Error('narrow');
    const d = serializeIntentDispatch({
      sessionId: 'ses_x',
      intentId: 'int_4',
      intentName: mapped.intentName,
      params: mapped.params,
    });
    expect(d.intentName).toBe('send_keys');
    expect(decodeWireData(d.inputParams)).toEqual({
      strategy: 'css selector',
      value: '#email',
      text: 'a@b.com',
    });
  });
});

describe('parseIntentResult', () => {
  it('decodes a success frame with base64 outputData', () => {
    const frame = {
      type: 'intentResult' as const,
      sessionId: 'ses_x',
      intentId: 'int_1',
      success: true,
      durationMs: 42,
      outputData: encodeWireData({ url: 'https://example.com' }),
    };
    expect(IntentResultEnvelopeSchema.safeParse(frame).success).toBe(true);
    const r = parseIntentResult(frame, 'navigate');
    expect(r.success).toBe(true);
    expect(r.durationMs).toBe(42);
    expect(r.outputData).toEqual({ url: 'https://example.com' });
    expect(r.errorCode).toBeUndefined();
  });

  it('decodes only the two exact login terminals and preserves producer duration', () => {
    const submitted = parseIntentResult(
      {
        type: 'intentResult',
        sessionId: 'ses_x',
        intentId: 'int_login_submitted',
        success: true,
        durationMs: 600_000,
        outputData: encodeWireData({
          submitted: true,
          credentials_truncated: false,
          logged_in: false,
          post_login_url: 'https://example.com/login?error=1',
        }),
      },
      'login',
    );
    expect(submitted).toMatchObject({
      success: true,
      durationMs: 600_000,
      outputData: {
        submitted: true,
        credentials_truncated: false,
        logged_in: false,
      },
    });

    const truncated = parseIntentResult(
      {
        type: 'intentResult',
        sessionId: 'ses_x',
        intentId: 'int_login_truncated',
        success: true,
        durationMs: 1,
        outputData: encodeWireData({
          submitted: false,
          credentials_truncated: true,
          logged_in: false,
        }),
      },
      'login',
    );
    expect(truncated.outputData).toEqual({
      submitted: false,
      credentials_truncated: true,
      logged_in: false,
    });

    for (const invalid of [
      { submitted: false, credentials_truncated: true, logged_in: true },
      {
        submitted: false,
        credentials_truncated: true,
        logged_in: false,
        post_login_url: 'https://example.com/account',
      },
      { submitted: true, credentials_truncated: false, logged_in: true, password: 'secret' },
    ]) {
      expect(() =>
        parseIntentResult(
          {
            type: 'intentResult',
            sessionId: 'ses_x',
            intentId: 'int_login_bad',
            success: true,
            durationMs: 1,
            outputData: encodeWireData(invalid),
          },
          'login',
        ),
      ).toThrow(HarnessWireCodecError);
    }
  });

  it('decodes only the exact fill_form complete and safe-truncation terminals', () => {
    for (const outputData of [
      { fields_filled: 1, submitted: false, truncated: false },
      { fields_filled: 50, submitted: true, truncated: false },
      { fields_filled: 0, submitted: false, truncated: true, truncated_fields: [0] },
      { fields_filled: 49, submitted: false, truncated: true, truncated_fields: [49] },
    ]) {
      expect(
        parseIntentResult(
          {
            type: 'intentResult',
            sessionId: 'ses_x',
            intentId: 'int_fill',
            success: true,
            durationMs: 1,
            outputData: encodeWireData(outputData),
          },
          'fill_form',
        ).outputData,
      ).toEqual(outputData);
    }
    for (const outputData of [
      { fields_filled: 0, submitted: false, truncated: false },
      { fields_filled: 1, submitted: true, truncated: true, truncated_fields: [1] },
      { fields_filled: 1, submitted: false, truncated: true, truncated_fields: [0] },
      { fields_filled: 1, submitted: false, truncated: true, truncated_fields: [1, 2] },
    ]) {
      expect(() =>
        parseIntentResult(
          {
            type: 'intentResult',
            sessionId: 'ses_x',
            intentId: 'int_fill_bad',
            success: true,
            durationMs: 1,
            outputData: encodeWireData(outputData),
          },
          'fill_form',
        ),
      ).toThrow(HarnessWireCodecError);
    }
  });

  it('decodes only the exact search normal and zero-submit truncation terminals', () => {
    for (const outputData of [
      { submitted: true, query_truncated: false, results_visible: false },
      { submitted: false, query_truncated: false },
      { submitted: false, query_truncated: true },
    ]) {
      expect(
        parseIntentResult(
          {
            type: 'intentResult',
            sessionId: 'ses_x',
            intentId: 'int_search',
            success: true,
            durationMs: 600_000,
            outputData: encodeWireData(outputData),
          },
          'search',
        ).outputData,
      ).toEqual(outputData);
    }
    for (const outputData of [
      { submitted: true, query_truncated: true },
      { submitted: false, query_truncated: true, results_visible: false },
      { submitted: false, query_truncated: false, query: 'must-never-return' },
    ]) {
      expect(() =>
        parseIntentResult(
          {
            type: 'intentResult',
            sessionId: 'ses_x',
            intentId: 'int_search_bad',
            success: true,
            durationMs: 1,
            outputData: encodeWireData(outputData),
          },
          'search',
        ),
      ).toThrow(HarnessWireCodecError);
    }
  });

  it('decodes a failure frame (no outputData, errorCode + errorMessage preserved)', () => {
    const r = parseIntentResult(
      {
        type: 'intentResult',
        sessionId: 'ses_x',
        intentId: 'int_2',
        success: false,
        durationMs: 0,
        errorCode: 'intent_missing_parameter',
        errorMessage: 'url is required',
      },
      'navigate',
    );
    expect(r.success).toBe(false);
    expect(r.outputData).toBeUndefined();
    expect(r.errorCode).toBe('intent_missing_parameter');
    expect(r.errorMessage).toBe('url is required');
  });

  it('strictly decodes the producer deadline code without output payload', () => {
    const r = parseIntentResult(
      {
        type: 'intentResult',
        sessionId: 'ses_x',
        intentId: 'int_deadline',
        success: false,
        durationMs: 300_000,
        errorCode: 'intent_deadline_exceeded',
        errorMessage: 'session terminated after whole-intent wall deadline',
      },
      'scroll',
    );
    expect(r).toMatchObject({
      success: false,
      errorCode: 'intent_deadline_exceeded',
    });
    expect(r.outputData).toBeUndefined();
  });

  it('strictly decodes an unconfirmed deadline cleanup as a distinct correlated failure', () => {
    const r = parseIntentResult(
      {
        type: 'intentResult',
        sessionId: 'ses_x',
        intentId: 'int_deadline_unconfirmed',
        success: false,
        durationMs: 300_000,
        errorCode: 'intent_deadline_cleanup_unconfirmed',
        errorMessage: 'browser exit unconfirmed; session fenced',
      },
      'fill_form',
    );
    expect(r).toMatchObject({
      success: false,
      errorCode: 'intent_deadline_cleanup_unconfirmed',
    });
    expect(r.outputData).toBeUndefined();
  });

  it('throws on a frame that is not a valid IntentResultEnvelope (unknown errorCode)', () => {
    expect(() =>
      parseIntentResult(
        {
          type: 'intentResult',
          sessionId: 'ses_x',
          intentId: 'int_3',
          success: false,
          durationMs: 0,
          errorCode: 'totally_made_up',
        },
        'navigate',
      ),
    ).toThrow();
  });

  it('throws HarnessWireCodecError when outputData is malformed base64/JSON', () => {
    expect(() =>
      parseIntentResult(
        {
          type: 'intentResult',
          sessionId: 'ses_x',
          intentId: 'int_4',
          success: true,
          durationMs: 1,
          outputData: Buffer.from('nope', 'utf8').toString('base64'),
        },
        'navigate',
      ),
    ).toThrow(HarnessWireCodecError);
  });

  it('round-trips serialize → (transport) → IntentResult shape', () => {
    // A dispatched navigate, then the harness echoes a result for it.
    const d = serializeIntentDispatch({
      sessionId: 'ses_x',
      intentId: 'int_5',
      intentName: 'navigate',
      params: { url: 'https://x' },
    });
    const r = parseIntentResult(
      {
        type: 'intentResult',
        sessionId: d.sessionId,
        intentId: d.intentId,
        success: true,
        durationMs: 10,
        outputData: encodeWireData({ url: 'https://x' }),
      },
      d.intentName,
    );
    expect(r.intentId).toBe('int_5');
    expect(r.outputData).toEqual({ url: 'https://x' });
  });

  it('rejects a valid result for a different intent than the correlated dispatch', () => {
    expect(() =>
      parseIntentResult(
        {
          type: 'intentResult',
          sessionId: 'ses_x',
          intentId: 'int_cross',
          success: true,
          durationMs: 1,
          outputData: encodeWireData({ pressed: 'Enter' }),
        },
        'navigate',
      ),
    ).toThrow(HarnessWireCodecError);
  });
});

describe('serializeSessionAssign (EG-API-1.6; A3 W136 shape)', () => {
  const base = {
    sessionId: 'ses_1',
    archetype: 'iphone17_ios18_7_safari26_4',
    behaviorProfile: 'regular',
    transportMode: 'h2-and-h3' as const,
    idleTimeoutSeconds: 300,
    maxDurationSeconds: 3600,
  };

  it('emits the required envelope; validates against SessionAssignSchema', () => {
    const a = serializeSessionAssign(base);
    expect(SessionAssignSchema.safeParse(a).success).toBe(true);
    expect(a.type).toBe('sessionAssign');
    expect(a.transportMode).toBe('h2-and-h3');
    expect(a.idleTimeoutSeconds).toBe(300);
    expect(a.inlineProxyConfig).toBeUndefined();
    expect(a.livekit).toBeUndefined();
  });

  it('A3 W138 — minimal assign: transportMode + timeouts omitted (→ harness defaults), only the required fields emitted', () => {
    const a = serializeSessionAssign({
      sessionId: 'ses_1',
      archetype: 'iphone17_ios18_7_safari26_4',
      behaviorProfile: 'regular',
    });
    expect(SessionAssignSchema.safeParse(a).success).toBe(true);
    expect(a.transportMode).toBeUndefined();
    expect(a.idleTimeoutSeconds).toBeUndefined();
    expect(a.maxDurationSeconds).toBeUndefined();
    // The wire object carries exactly the 4 required keys (no explicit-null fields).
    expect(Object.keys(a).sort()).toEqual(['archetype', 'behaviorProfile', 'sessionId', 'type']);
  });

  it('inlineProxyConfig (SocksProxyConfig) → base64 of utf8 JSON (A3 W136 = Data codec, NOT nested object)', () => {
    const proxy = {
      host: 'proxy.example.com',
      port: 1080,
      username: 'u',
      password: 'p',
      udp_associate: true,
      require_remote_dns: false,
    };
    const a = serializeSessionAssign({ ...base, inlineProxyConfig: proxy });
    expect(typeof a.inlineProxyConfig).toBe('string');
    // It's base64-of-utf8-JSON: decode → JSON → the original config (round-trip,
    // key-order-agnostic). Proves the Data-codec encoding without pinning key order.
    const decodedJson = Buffer.from(a.inlineProxyConfig as string, 'base64').toString('utf8');
    expect(JSON.parse(decodedJson)).toEqual(proxy);
    expect(decodeWireData(a.inlineProxyConfig as string)).toEqual(proxy);
  });

  it('inlineProxyConfig carries the wire-ONLY udp_capable (A3 W2756 proxy pre-detection) — the extended wire schema keeps it; the plain SocksProxyConfig schema would strip it', () => {
    const proxy = {
      host: 'proxy.example.com',
      port: 1080,
      udp_associate: true,
      // The verified per-proxy capability — server-built, harness maps it to
      // DRIFTSTACK_PROXY_UDP_CAPABLE. It must survive the wire encoding.
      udp_capable: true,
      require_remote_dns: false,
    };
    const a = serializeSessionAssign({ ...base, inlineProxyConfig: proxy });
    expect(decodeWireData(a.inlineProxyConfig as string)).toEqual(proxy);
  });

  it('inlineProxyConfig (VPN) → base64 of the FLAT wire (A3 W2163: type + sibling fields, NOT nested)', () => {
    const wg = {
      type: 'wireguard' as const,
      private_key: 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=',
      peer_public_key: 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=',
      endpoint: 'vpn.example.com:51820',
      allowed_ips: '0.0.0.0/0',
      address: '10.7.0.2/32',
    };
    const a = serializeSessionAssign({ ...base, inlineProxyConfig: wg });
    // FLAT: the decoded object has `type` + the WG fields as DIRECT siblings —
    // never nested under a `wireguard` key (a nested payload fails A3's guard).
    expect(decodeWireData(a.inlineProxyConfig as string)).toEqual(wg);

    const ovpn = {
      type: 'openvpn' as const,
      config_blob: 'client\nremote h 1194\n',
      username: 'u',
    };
    const b = serializeSessionAssign({ ...base, inlineProxyConfig: ovpn });
    expect(decodeWireData(b.inlineProxyConfig as string)).toEqual(ovpn);
  });

  // V-1383 — `inlineProxyConfig` splits on `type`: openvpn|wireguard go through
  // `InlineVpnProxyWireSchema`, anything else through `SocksProxyConfigWireSchema`. Both
  // branches refuse a config that fails their contract, and coverage showed only the socks
  // refusal executing — the two happy paths above are covered, but a malformed VPN config
  // had never been handed to the serializer.
  //
  // The refusal is what stops a half-formed VPN config being base64'd onto a
  // `sessionAssign` frame. The box side validates too, but a frame that fails there fails
  // AFTER the session has been assigned, which is a much worse place to find out.
  it('CRITICAL a VPN config that fails the wire contract is refused HERE, before it is encoded onto the frame. Its socks sibling one branch down is covered and this one was not, so the asymmetry was the gap: the happy paths prove the flat wire shape, not that a bad config is stopped.', () => {
    // The parameter type forbids these shapes, and the runtime can still deliver them: an
    // inline proxy config is decrypted out of the database at dispatch time, so what reaches
    // this function is only as well-formed as the row. That is the whole reason the contract
    // check exists, so the arm supplies what the type will not vouch for.
    type InlineProxyArg = NonNullable<
      Parameters<typeof serializeSessionAssign>[0]['inlineProxyConfig']
    >;
    const fromStorage = (value: unknown): InlineProxyArg => value as InlineProxyArg;

    // Valid but for one required field — `private_key` removed. Everything else is the
    // shape the passing arm above uses, so only the contract check can answer.
    const brokenWireGuard = {
      type: 'wireguard' as const,
      peer_public_key: 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=',
      endpoint: 'vpn.example.com:51820',
      allowed_ips: '0.0.0.0/0',
      address: '10.7.0.2/32',
    };
    expect(() =>
      serializeSessionAssign({ ...base, inlineProxyConfig: fromStorage(brokenWireGuard) }),
    ).toThrow(HarnessWireCodecError);
    expect(() =>
      serializeSessionAssign({ ...base, inlineProxyConfig: fromStorage(brokenWireGuard) }),
    ).toThrow(/InlineVpnProxyWire contract before assign/);

    const brokenOpenVpn = { type: 'openvpn' as const, username: 'u' }; // no config_blob
    expect(() =>
      serializeSessionAssign({ ...base, inlineProxyConfig: fromStorage(brokenOpenVpn) }),
    ).toThrow(/InlineVpnProxyWire contract before assign/);

    // Control: the same wireguard config WITH the field serializes, so the refusal is the
    // missing key rather than anything else about the fixture.
    expect(() =>
      serializeSessionAssign({
        ...base,
        inlineProxyConfig: fromStorage({
          ...brokenWireGuard,
          private_key: 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=',
        }),
      }),
    ).not.toThrow();
  });

  it('profile-backed (A3 W417): camelCase in → snake_case wire; omits absent blob fields', () => {
    // inline (≤256KB) shape
    const inline = serializeSessionAssign({
      ...base,
      profile: { profileId: 'p1', dek: 'ZGVr', sealedBlob: 'YmxvYg==' },
    });
    expect(SessionAssignSchema.safeParse(inline).success).toBe(true);
    expect(inline.profile).toEqual({ profile_id: 'p1', dek: 'ZGVr', sealed_blob: 'YmxvYg==' });
    // large shape (presigned GET + PUT, no inline blob)
    const large = serializeSessionAssign({
      ...base,
      profile: {
        profileId: 'p1',
        dek: 'ZGVr',
        sealedBlobUrl: 'https://r2/get',
        sealedBlobPutUrl: 'https://r2/put',
      },
    });
    expect(large.profile).toEqual({
      profile_id: 'p1',
      dek: 'ZGVr',
      sealed_blob_url: 'https://r2/get',
      sealed_blob_put_url: 'https://r2/put',
    });
    // fresh profile (no prior state) → only the two required keys
    const fresh = serializeSessionAssign({ ...base, profile: { profileId: 'p1', dek: 'ZGVr' } });
    expect(fresh.profile).toEqual({ profile_id: 'p1', dek: 'ZGVr' });
    // absent → omitted (stateless path unchanged)
    expect(serializeSessionAssign(base).profile).toBeUndefined();
  });

  it('throws HarnessWireCodecError on a malformed SocksProxyConfig (bad port)', () => {
    expect(() =>
      serializeSessionAssign({
        ...base,
        inlineProxyConfig: {
          host: 'h',
          port: 70000,
          udp_associate: true,
          require_remote_dns: false,
        },
      }),
    ).toThrow(HarnessWireCodecError);
  });

  it('maps camelCase livekit → snake_case wire object (the lone snake_case exception)', () => {
    const a = serializeSessionAssign({
      ...base,
      livekit: { room: 'r1', token: 'tk', wsUrl: 'wss://lk', expiresAt: '2026-06-05T20:00:00Z' },
    });
    expect(a.livekit).toEqual({
      room: 'r1',
      token: 'tk',
      ws_url: 'wss://lk',
      expires_at: '2026-06-05T20:00:00Z',
    });
  });

  it('initialUrl is http(s)-only — a file:/javascript: initialUrl throws (chokepoint guard, A3 W135)', () => {
    expect(serializeSessionAssign({ ...base, initialUrl: 'https://ok.example' }).initialUrl).toBe(
      'https://ok.example',
    );
    for (const initialUrl of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x']) {
      expect(() => serializeSessionAssign({ ...base, initialUrl })).toThrow();
    }
  });

  it('geolocation override — emits latitude/longitude (+ optional accuracy); absent → omitted', () => {
    // accuracy present → all three ride the wire
    const withAcc = serializeSessionAssign({
      ...base,
      geolocation: { latitude: 48.8566, longitude: 2.3522, accuracy: 20 },
    });
    expect(withAcc.geolocation).toEqual({ latitude: 48.8566, longitude: 2.3522, accuracy: 20 });
    // accuracy omitted → the harness applies its own default (35.0), so the field
    // is dropped entirely rather than sent as null/undefined.
    const noAcc = serializeSessionAssign({
      ...base,
      geolocation: { latitude: -33.8688, longitude: 151.2093 },
    });
    expect(noAcc.geolocation).toEqual({ latitude: -33.8688, longitude: 151.2093 });
    // absent → omitted (harness keeps its proxy-exit auto-derive default)
    expect(serializeSessionAssign(base).geolocation).toBeUndefined();
  });

  it('geolocation out-of-range latitude/longitude throws (wire schema bounds)', () => {
    expect(() =>
      serializeSessionAssign({ ...base, geolocation: { latitude: 91, longitude: 0 } }),
    ).toThrow();
    expect(() =>
      serializeSessionAssign({ ...base, geolocation: { latitude: 0, longitude: 181 } }),
    ).toThrow();
  });

  it('exit_identity (#128 new-tab panel) — camelCase in → snake_case wire; null geo passthrough; absent → omitted', () => {
    const full = serializeSessionAssign({
      ...base,
      exitIdentity: {
        ip: '203.0.113.7',
        country: 'NL',
        region: 'North Holland',
        city: 'Amsterdam',
        timezone: 'Europe/Amsterdam',
        quicOk: true,
        probedAt: '2026-07-06T10:00:00.000Z',
      },
    });
    expect(full.exit_identity).toEqual({
      ip: '203.0.113.7',
      country: 'NL',
      region: 'North Holland',
      city: 'Amsterdam',
      timezone: 'Europe/Amsterdam',
      quic_ok: true,
      probed_at: '2026-07-06T10:00:00.000Z',
    });
    // Unresolved best-effort geo rides as null (present, NOT omitted) so the box
    // decoder always sees the key — distinct from the whole block being absent.
    const nullGeo = serializeSessionAssign({
      ...base,
      exitIdentity: {
        ip: '198.51.100.4',
        country: 'XX',
        region: null,
        city: null,
        timezone: null,
        quicOk: false,
        probedAt: '2026-07-06T10:00:00.000Z',
      },
    });
    expect(nullGeo.exit_identity).toEqual({
      ip: '198.51.100.4',
      country: 'XX',
      region: null,
      city: null,
      timezone: null,
      quic_ok: false,
      probed_at: '2026-07-06T10:00:00.000Z',
    });
    // absent → omitted (box keeps today's no-local-panel behaviour)
    expect(serializeSessionAssign(base).exit_identity).toBeUndefined();
  });

  it('exit_identity country must be exactly ISO-3166 alpha-2 (2 chars) — wire schema bound', () => {
    expect(() =>
      serializeSessionAssign({
        ...base,
        exitIdentity: {
          ip: '1.2.3.4',
          country: 'NLD',
          region: null,
          city: null,
          timezone: null,
          quicOk: true,
          probedAt: '2026-07-06T10:00:00.000Z',
        },
      }),
    ).toThrow();
  });
});

describe('serializeSessionEnd (ControlInbound teardown)', () => {
  it('builds the trivial {type,sessionId} envelope; validates against SessionEndSchema', () => {
    const e = serializeSessionEnd('agt_123');
    expect(SessionEndSchema.safeParse(e).success).toBe(true);
    expect(e).toEqual({ type: 'sessionEnd', sessionId: 'agt_123' });
  });

  it('rejects an empty sessionId (would be a malformed teardown)', () => {
    expect(() => serializeSessionEnd('')).toThrow();
  });
});

describe('serializePauseSession / serializeResumeSession (W393 challenge-handling)', () => {
  it('serializePauseSession builds the {type,sessionId} envelope', () => {
    expect(serializePauseSession('agt_1')).toEqual({ type: 'pauseSession', sessionId: 'agt_1' });
  });

  it('serializeResumeSession includes challengeId when given, omits it when absent', () => {
    expect(serializeResumeSession({ sessionId: 'agt_1', challengeId: 'chl_9' })).toEqual({
      type: 'resumeSession',
      sessionId: 'agt_1',
      challengeId: 'chl_9',
    });
    expect(serializeResumeSession({ sessionId: 'agt_1' })).toEqual({
      type: 'resumeSession',
      sessionId: 'agt_1',
    });
  });

  it('rejects an empty sessionId (malformed control frame)', () => {
    expect(() => serializePauseSession('')).toThrow();
    expect(() => serializeResumeSession({ sessionId: '' })).toThrow();
  });
});

// The six control serializers that no test named, pinned field-by-field.
//
// Each builds a wire envelope and re-validates it through its zod schema, which
// is why a wrong `type` literal cannot survive. What zod cannot see is two
// same-typed fields swapped: `requestId` and `sessionId` are both strings, so a
// swap produces a perfectly valid envelope that names the wrong session.
//
// Measured before writing this: swapping those two fields inside EACH of the six
// serializers in turn passed all 80 tests across this file and
// fleet-control-registry. Six for six, nothing noticed.
//
// It fails in exactly the place CI cannot see. These envelopes go to a fleet node
// over WSS: a swapped `sessionId` names a session the harness cannot find, and a
// swapped `requestId` breaks the correlation the harness echoes back on the reply
// — so the caller waits for a reply keyed to an id it never sent. The
// file-control pair carries customer file bytes to and from the session's jail.
//
// Every argument below is deliberately distinct and non-interchangeable, because
// a fixture that reuses one id for both fields cannot detect the swap it exists
// to catch.
describe('harness control serializers — envelope field mapping', () => {
  const requestId = 'req-11111111-1111-4111-8111-111111111111';
  const sessionId = 'ses-22222222-2222-4222-8222-222222222222';

  it('CRITICAL serializeCookiesRequest maps requestId and sessionId to their own fields', () => {
    expect(serializeCookiesRequest({ requestId, sessionId })).toEqual({
      type: 'cookiesRequest',
      requestId,
      sessionId,
    });
  });

  it('CRITICAL serializeSetCookies carries the jar unchanged alongside the right ids', () => {
    const cookies = [
      {
        name: 'sid',
        value: 'abc',
        domain: 'example.com',
        path: '/',
        secure: true,
        httpOnly: true,
        // Capitalised, per CookieSchema's enum — the WebKit spelling, not the
        // lowercase form the Set-Cookie header uses.
        sameSite: 'Lax' as const,
      },
    ];
    const wire = serializeSetCookies({ requestId, sessionId, cookies });
    expect(wire.type).toBe('setCookies');
    expect(wire.requestId).toBe(requestId);
    expect(wire.sessionId).toBe(sessionId);
    expect(wire.cookies).toEqual(cookies);
  });

  it('CRITICAL serializeNavigateHistory keeps direction and the ids distinct', () => {
    expect(serializeNavigateHistory({ requestId, sessionId, direction: 'back' })).toEqual({
      type: 'navigateHistory',
      requestId,
      sessionId,
      direction: 'back',
    });
  });

  it('CRITICAL serializeUploadFile maps every field of a customer file upload — name, mime and bytes each to their own slot', () => {
    expect(
      serializeUploadFile({
        requestId,
        sessionId,
        name: 'invoice.pdf',
        mime: 'application/pdf',
        dataB64: 'JVBERi0=',
      }),
    ).toEqual({
      type: 'uploadFile',
      requestId,
      sessionId,
      name: 'invoice.pdf',
      mime: 'application/pdf',
      dataB64: 'JVBERi0=',
    });
  });

  it('CRITICAL serializeListDownloads maps requestId and sessionId to their own fields', () => {
    expect(serializeListDownloads({ requestId, sessionId })).toEqual({
      type: 'listDownloads',
      requestId,
      sessionId,
    });
  });

  it('CRITICAL serializeFetchDownload keeps the basename out of the id fields', () => {
    expect(serializeFetchDownload({ requestId, sessionId, name: 'report.csv' })).toEqual({
      type: 'fetchDownload',
      requestId,
      sessionId,
      name: 'report.csv',
    });
  });
});
