import { describe, expect, it } from 'vitest';
import { MockDriver } from '../../src/drivers/mock.js';
import { DriverError } from '../../src/lib/errors.js';

const fastDriver = (): MockDriver =>
  new MockDriver({ fastForwardLatency: true, navigateLatencyMs: 0, interactLatencyMs: 0 });

describe('MockDriver — session lifecycle', () => {
  it('createSession returns a deterministic, monotonically increasing id', async () => {
    const driver = fastDriver();
    const a = await driver.createSession({
      archetype: 'iphone16pro_ios18_7_safari26_4',
      purpose: 'production_customer' as const,
    });
    const b = await driver.createSession({
      archetype: 'iphone16pro_ios18_7_safari26_4',
      purpose: 'production_customer' as const,
    });
    expect(a.driverSessionId).toMatch(/^mock_ses_\d{8}$/);
    expect(b.driverSessionId).toMatch(/^mock_ses_\d{8}$/);
    expect(b.driverSessionId > a.driverSessionId).toBe(true);
  });

  it('destroy is idempotent', async () => {
    const driver = fastDriver();
    const { driverSessionId } = await driver.createSession({
      archetype: 'x',
      purpose: 'production_customer' as const,
    });
    await expect(driver.destroy(driverSessionId)).resolves.toBeUndefined();
    await expect(driver.destroy(driverSessionId)).resolves.toBeUndefined();
    await expect(driver.destroy('mock_ses_99999999')).resolves.toBeUndefined();
  });

  it('operations on a destroyed session throw DriverError', async () => {
    const driver = fastDriver();
    const { driverSessionId } = await driver.createSession({
      archetype: 'x',
      purpose: 'production_customer' as const,
    });
    await driver.destroy(driverSessionId);

    await expect(
      driver.navigate(driverSessionId, {
        url: 'https://example.com',
        timeoutMs: 5000,
        waitUntil: 'load',
      }),
    ).rejects.toBeInstanceOf(DriverError);
    await expect(driver.getState(driverSessionId)).rejects.toBeInstanceOf(DriverError);
  });
});

describe('MockDriver — login result truth', () => {
  it('returns the complete submitted branch with bounded duration and no credential echo', async () => {
    const driver = fastDriver();
    const { driverSessionId } = await driver.createSession({
      archetype: 'x',
      purpose: 'production_customer' as const,
    });
    const result = await driver.login(driverSessionId, {
      username: 'user@example.com',
      password: 'do-not-echo',
    });
    // `durationMs` is a MEASURED elapsed time, so pinning it to exactly 0 was a
    // wall-clock assumption: it held on an idle machine and intermittently read
    // 1ms when this file ran beside the rest of the suite. Assert the contract
    // instead — every other field exactly, and the duration as a real integer
    // inside the published 0..600,000ms budget.
    const { durationMs, ...loginShape } = result;
    expect(loginShape).toEqual({
      submitted: true,
      credentialsTruncated: false,
      loggedIn: true,
      postLoginUrl: 'https://example.com/account',
    });
    expect(Number.isInteger(durationMs)).toBe(true);
    expect(durationMs).toBeGreaterThanOrEqual(0);
    expect(durationMs).toBeLessThanOrEqual(600_000);
    expect(JSON.stringify(result)).not.toContain('user@example.com');
    expect(JSON.stringify(result)).not.toContain('do-not-echo');
  });
});

describe('MockDriver — search result truth', () => {
  it('returns the normal non-truncated branch without echoing the query', async () => {
    const driver = fastDriver();
    const { driverSessionId } = await driver.createSession({
      archetype: 'x',
      purpose: 'production_customer' as const,
    });
    const result = await driver.search(driverSessionId, {
      query: 'do-not-echo',
      submit: true,
      waitForResultsSelector: '#results',
    });
    const { durationMs, ...searchShape } = result;
    expect(searchShape).toEqual({
      submitted: true,
      queryTruncated: false,
      resultsVisible: true,
    });
    expect(Number.isInteger(durationMs)).toBe(true);
    expect(durationMs).toBeGreaterThanOrEqual(0);
    expect(durationMs).toBeLessThanOrEqual(600_000);
    expect(JSON.stringify(result)).not.toContain('do-not-echo');
  });
});

describe('MockDriver — navigate', () => {
  it('happy-path 200 with finalUrl matching url', async () => {
    const driver = fastDriver();
    const { driverSessionId } = await driver.createSession({
      archetype: 'x',
      purpose: 'production_customer' as const,
    });
    const r = await driver.navigate(driverSessionId, {
      url: 'https://example.com/path',
      timeoutMs: 5000,
      waitUntil: 'load',
    });
    expect(r.status).toBe(200);
    expect(r.finalUrl).toBe('https://example.com/path');
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('updates the session state so getState reflects the new url', async () => {
    const driver = fastDriver();
    const { driverSessionId } = await driver.createSession({
      archetype: 'x',
      purpose: 'production_customer' as const,
    });
    await driver.navigate(driverSessionId, {
      url: 'https://example.com',
      timeoutMs: 5000,
      waitUntil: 'load',
    });
    const state = await driver.getState(driverSessionId);
    expect(state.url).toBe('https://example.com');
    expect(state.title).toContain('example.com');
  });

  it('rejects malformed URLs with DriverError', async () => {
    const driver = fastDriver();
    const { driverSessionId } = await driver.createSession({
      archetype: 'x',
      purpose: 'production_customer' as const,
    });
    await expect(
      driver.navigate(driverSessionId, {
        url: 'not a url',
        timeoutMs: 5000,
        waitUntil: 'load',
      }),
    ).rejects.toBeInstanceOf(DriverError);
  });

  it('error.driftstack-mock.test triggers DriverError', async () => {
    const driver = fastDriver();
    const { driverSessionId } = await driver.createSession({
      archetype: 'x',
      purpose: 'production_customer' as const,
    });
    await expect(
      driver.navigate(driverSessionId, {
        url: 'https://error.driftstack-mock.test',
        timeoutMs: 5000,
        waitUntil: 'load',
      }),
    ).rejects.toBeInstanceOf(DriverError);
  });

  it('http500.driftstack-mock.test returns status 500 (no throw)', async () => {
    const driver = fastDriver();
    const { driverSessionId } = await driver.createSession({
      archetype: 'x',
      purpose: 'production_customer' as const,
    });
    const r = await driver.navigate(driverSessionId, {
      url: 'https://http500.driftstack-mock.test',
      timeoutMs: 5000,
      waitUntil: 'load',
    });
    expect(r.status).toBe(500);
  });
});

describe('MockDriver — interact', () => {
  it('happy-path tap returns durationMs', async () => {
    const driver = fastDriver();
    const { driverSessionId } = await driver.createSession({
      archetype: 'x',
      purpose: 'production_customer' as const,
    });
    const r = await driver.interact(driverSessionId, {
      action: { kind: 'tap', selector: '#button' },
      timeoutMs: 1000,
    });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('selector #nonexistent triggers DriverError', async () => {
    const driver = fastDriver();
    const { driverSessionId } = await driver.createSession({
      archetype: 'x',
      purpose: 'production_customer' as const,
    });
    await expect(
      driver.interact(driverSessionId, {
        action: { kind: 'tap', selector: '#nonexistent' },
        timeoutMs: 1000,
      }),
    ).rejects.toBeInstanceOf(DriverError);
  });

  it('press action (no selector) succeeds', async () => {
    const driver = fastDriver();
    const { driverSessionId } = await driver.createSession({
      archetype: 'x',
      purpose: 'production_customer' as const,
    });
    const r = await driver.interact(driverSessionId, {
      action: { kind: 'press', key: 'Enter' },
      timeoutMs: 1000,
    });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('MockDriver — wait', () => {
  it('time-based wait sleeps for the requested duration', async () => {
    // Don't fast-forward here — we want to verify wait actually waits.
    const driver = new MockDriver({
      fastForwardLatency: false,
      navigateLatencyMs: 0,
      interactLatencyMs: 0,
    });
    const { driverSessionId } = await driver.createSession({
      archetype: 'x',
      purpose: 'production_customer' as const,
    });
    const start = Date.now();
    const r = await driver.wait(driverSessionId, {
      condition: { kind: 'time', ms: 50 },
      timeoutMs: 1000,
    });
    const elapsed = Date.now() - start;
    expect(r.satisfied).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(45); // small margin for timer skew
  });

  it('selector that never appears returns satisfied=false after timeout', async () => {
    const driver = fastDriver();
    const { driverSessionId } = await driver.createSession({
      archetype: 'x',
      purpose: 'production_customer' as const,
    });
    const r = await driver.wait(driverSessionId, {
      condition: { kind: 'selector', selector: '#nonexistent' },
      timeoutMs: 100,
    });
    expect(r.satisfied).toBe(false);
  });
});

describe('MockDriver — capture', () => {
  it('screenshot returns base64-encoded PNG bytes', async () => {
    const driver = fastDriver();
    const { driverSessionId } = await driver.createSession({
      archetype: 'x',
      purpose: 'production_customer' as const,
    });
    const r = await driver.capture(driverSessionId, { kind: 'screenshot', fullPage: false });
    expect(r.kind).toBe('screenshot');
    expect(r.encoding).toBe('base64');
    expect(r.data.length).toBeGreaterThan(0);
    // PNG header in base64 starts with "iVBORw0KGgo"
    expect(r.data.startsWith('iVBORw0KGgo')).toBe(true);
  });

  it('dom_snapshot returns utf8 HTML', async () => {
    const driver = fastDriver();
    const { driverSessionId } = await driver.createSession({
      archetype: 'x',
      purpose: 'production_customer' as const,
    });
    const r = await driver.capture(driverSessionId, { kind: 'dom_snapshot', fullPage: true });
    expect(r.kind).toBe('dom_snapshot');
    expect(r.encoding).toBe('utf8');
    expect(r.data).toContain('<html');
  });

  it('pdf returns base64-encoded bytes', async () => {
    const driver = fastDriver();
    const { driverSessionId } = await driver.createSession({
      archetype: 'x',
      purpose: 'production_customer' as const,
    });
    const r = await driver.capture(driverSessionId, { kind: 'pdf', fullPage: false });
    expect(r.kind).toBe('pdf');
    expect(r.encoding).toBe('base64');
  });
});

describe('MockDriver — getState', () => {
  it('fresh session has null url and title', async () => {
    const driver = fastDriver();
    const { driverSessionId } = await driver.createSession({
      archetype: 'x',
      purpose: 'production_customer' as const,
    });
    const state = await driver.getState(driverSessionId);
    expect(state.url).toBeNull();
    expect(state.title).toBeNull();
    expect(state.cookies).toEqual([]);
    expect(state.localStorage).toEqual({});
  });
});

describe('MockDriver — determinism', () => {
  it('two drivers with the same op sequence return matching state', async () => {
    const a = fastDriver();
    const b = fastDriver();
    const sa = await a.createSession({
      archetype: 'iphone16pro_ios18_7_safari26_4',
      purpose: 'production_customer' as const,
    });
    const sb = await b.createSession({
      archetype: 'iphone16pro_ios18_7_safari26_4',
      purpose: 'production_customer' as const,
    });
    expect(sa.driverSessionId).toBe(sb.driverSessionId); // first id is identical

    const ra = await a.navigate(sa.driverSessionId, {
      url: 'https://example.com',
      timeoutMs: 5000,
      waitUntil: 'load',
    });
    const rb = await b.navigate(sb.driverSessionId, {
      url: 'https://example.com',
      timeoutMs: 5000,
      waitUntil: 'load',
    });
    expect(ra.url).toBe(rb.url);
    expect(ra.finalUrl).toBe(rb.finalUrl);
    expect(ra.status).toBe(rb.status);
  });
});
