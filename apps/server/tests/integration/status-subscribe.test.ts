// V-295c3 — status-page email-subscription routes integration tests.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const headers = { 'content-type': 'application/json' };

function getConfirmTokenFromLastEmail(fixture: TestAppFixture): string {
  const last = fixture.emailSends[fixture.emailSends.length - 1];
  if (!last) throw new Error('no email sent');
  const link = last.vars.confirmLink as string;
  const url = new URL(link);
  const token = url.searchParams.get('token');
  if (!token) throw new Error(`confirmLink has no token: ${link}`);
  return token;
}

function getUnsubscribeTokenFromLastEmail(fixture: TestAppFixture): string {
  const last = fixture.emailSends[fixture.emailSends.length - 1];
  if (!last) throw new Error('no email sent');
  const link = last.vars.unsubscribeLink as string;
  const url = new URL(link);
  const token = url.searchParams.get('token');
  if (!token) throw new Error(`unsubscribeLink has no token: ${link}`);
  return token;
}

describe('POST /v1/status/subscribe', () => {
  it('202 accepts subscription + sends confirmation email', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/status/subscribe',
      headers,
      payload: { email: 'user@example.test' },
    });
    expect(res.statusCode).toBe(202);
    expect(fx.emailSends).toHaveLength(1);
    expect(fx.emailSends[0]!.template).toBe('status-subscription-confirmation');
    expect(fx.emailSends[0]!.to).toBe('user@example.test');

    const rows = fx.statusSubscribersRepo.getAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email).toBe('user@example.test');
    expect(rows[0]!.confirmTokenHash).not.toBeNull();
    expect(rows[0]!.confirmedAt).toBeNull();
  });

  it('400 on malformed email', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/status/subscribe',
      headers,
      payload: { email: 'not-an-email' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('re-subscribe resets confirmation state for the same email', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/status/subscribe',
      headers,
      payload: { email: 'user@example.test' },
    });
    const firstToken = getConfirmTokenFromLastEmail(fx);

    await fx.app.inject({
      method: 'POST',
      url: '/v1/status/subscribe',
      headers,
      payload: { email: 'user@example.test' },
    });
    const secondToken = getConfirmTokenFromLastEmail(fx);

    expect(secondToken).not.toBe(firstToken);
    expect(fx.statusSubscribersRepo.getAll()).toHaveLength(1); // same row, fresh token
  });

  it('lowercases + trims the email before storage', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/status/subscribe',
      headers,
      payload: { email: '  USER@EXAMPLE.TEST  ' },
    });
    expect(fx.statusSubscribersRepo.getAll()[0]!.email).toBe('user@example.test');
  });
});

describe('GET /v1/status/subscribe/confirm', () => {
  it('200 marks confirmed + sends welcome email with unsubscribe link', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/status/subscribe',
      headers,
      payload: { email: 'user@example.test' },
    });
    const token = getConfirmTokenFromLastEmail(fx);

    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/status/subscribe/confirm?token=${encodeURIComponent(token)}`,
    });
    expect(res.statusCode).toBe(200);

    const row = fx.statusSubscribersRepo.getAll()[0]!;
    expect(row.confirmedAt).not.toBeNull();
    expect(row.confirmTokenHash).toBeNull();
    expect(row.unsubscribeTokenHash).not.toBeNull();

    const welcome = fx.emailSends[fx.emailSends.length - 1]!;
    expect(welcome.template).toBe('status-subscription-welcome');
    expect(welcome.vars.unsubscribeLink).toMatch(/\/subscribe\/unsubscribe\?token=/);
  });

  it('404 on unknown / used token', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/status/subscribe/confirm?token=${'a'.repeat(40)}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('400 on missing token', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/status/subscribe/confirm',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/status/subscribe/unsubscribe', () => {
  it('200 marks unsubscribed + listConfirmed excludes the row', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/status/subscribe',
      headers,
      payload: { email: 'user@example.test' },
    });
    const confirmToken = getConfirmTokenFromLastEmail(fx);
    await fx.app.inject({
      method: 'GET',
      url: `/v1/status/subscribe/confirm?token=${encodeURIComponent(confirmToken)}`,
    });
    const unsubToken = getUnsubscribeTokenFromLastEmail(fx);

    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/status/subscribe/unsubscribe?token=${encodeURIComponent(unsubToken)}`,
    });
    expect(res.statusCode).toBe(200);

    const row = fx.statusSubscribersRepo.getAll()[0]!;
    expect(row.unsubscribedAt).not.toBeNull();
    // Confirmed-and-still-subscribed view excludes this row.
    const confirmed = await fx.statusSubscribersRepo.listConfirmed();
    expect(confirmed).toHaveLength(0);
  });

  it('404 on unknown token', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/status/subscribe/unsubscribe?token=${'b'.repeat(40)}`,
    });
    expect(res.statusCode).toBe(404);
  });
});
