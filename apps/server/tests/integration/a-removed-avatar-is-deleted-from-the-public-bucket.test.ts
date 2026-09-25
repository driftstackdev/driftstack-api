// Security sweep E-23 (2026-09-24). Avatars live on the PUBLIC bucket at a key
// derived from the account id (avatars/<account_id>.<ext>). DELETE
// /v1/account/me/avatar only cleared the account's pointer — the comment called
// the object "intentionally left in place" for a sweeper that never existed — so
// an image the customer removed stayed publicly readable. Replacing a PNG with a
// JPEG left the PNG behind the same way, since the key carries the extension.
//
// Removal now deletes every avatar object the account can have; replacement
// deletes the ones the new upload did not overwrite. (Account purge is the
// sweeper's arm: a-terminated-accounts-avatar-leaves-the-public-bucket.)
//
// In-memory fixtures: the public bucket is the test app's R2 fake, whose store
// is inspected directly.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const ONE_BY_ONE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';

const auth = (fixture: TestAppFixture): { authorization: string } => ({
  authorization: `Bearer ${fixture.plaintext}`,
});

async function upload(contentType: string): Promise<number> {
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/account/me/avatar',
    headers: { ...auth(fx), 'content-type': 'application/json' },
    payload: { content_type: contentType, data_base64: ONE_BY_ONE_PNG_BASE64 },
  });
  return res.statusCode;
}

/** Every public-bucket key that belongs to this account's avatar. */
function avatarObjects(): string[] {
  return [...fx.r2PublicStore.objects.keys()]
    .filter((k) => k.startsWith(`avatars/${fx.accountId}.`))
    .sort();
}

describe('a removed avatar is deleted from the public bucket', () => {
  it('POSITIVE CONTROL an upload stores exactly one public object — or every "is gone" below would pass on a store that never held anything', async () => {
    fx = await buildTestApp();
    expect(await upload('image/png')).toBe(200);
    expect(avatarObjects()).toEqual([`avatars/${fx.accountId}.png`]);
  });

  it('CRITICAL DELETE removes the public object, not only the pointer', async () => {
    fx = await buildTestApp();
    expect(await upload('image/png')).toBe(200);

    const del = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/account/me/avatar',
      headers: auth(fx),
    });

    expect(del.statusCode).toBe(204);
    expect(avatarObjects(), 'the removed image is still publicly readable').toEqual([]);
    const me = await fx.app.inject({ method: 'GET', url: '/v1/account/me', headers: auth(fx) });
    expect(me.json<{ avatar_url: string | null }>().avatar_url).toBeNull();
  });

  it('CRITICAL replacing an avatar with another format deletes the old object', async () => {
    fx = await buildTestApp();
    expect(await upload('image/png')).toBe(200);
    expect(await upload('image/jpeg')).toBe(200);

    expect(avatarObjects(), 'the replaced PNG is still publicly readable').toEqual([
      `avatars/${fx.accountId}.jpg`,
    ]);
  });

  it('re-uploading the same format keeps the new object (the cleanup never deletes what it just wrote)', async () => {
    fx = await buildTestApp();
    expect(await upload('image/png')).toBe(200);
    expect(await upload('image/png')).toBe(200);
    expect(avatarObjects()).toEqual([`avatars/${fx.accountId}.png`]);
  });

  it('DELETE also removes objects a replacement left behind before this fix', async () => {
    fx = await buildTestApp();
    expect(await upload('image/jpeg')).toBe(200);
    // An orphan from the old behaviour: same account, another extension.
    fx.r2PublicStore.objects.set(`avatars/${fx.accountId}.webp`, { body: Buffer.from('old') });

    const del = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/account/me/avatar',
      headers: auth(fx),
    });

    expect(del.statusCode).toBe(204);
    expect(avatarObjects()).toEqual([]);
  });

  it('CRITICAL when the bucket refuses the delete, the request fails and the avatar stays referenced, so a retry can finish it — never a 204 that leaves the image public', async () => {
    fx = await buildTestApp();
    expect(await upload('image/png')).toBe(200);
    const store = fx.r2PublicStore.objects;
    const realDelete = store.delete.bind(store);
    store.delete = () => {
      throw new Error('bucket unavailable');
    };

    const failed = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/account/me/avatar',
      headers: auth(fx),
    });

    expect(failed.statusCode).toBe(503);
    const me = await fx.app.inject({ method: 'GET', url: '/v1/account/me', headers: auth(fx) });
    expect(me.json<{ avatar_source: string }>().avatar_source).toBe('user');

    store.delete = realDelete;
    const retried = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/account/me/avatar',
      headers: auth(fx),
    });
    expect(retried.statusCode).toBe(204);
    expect(avatarObjects()).toEqual([]);
  });

  it("another account's avatar is untouched", async () => {
    fx = await buildTestApp();
    const other = 'avatars/00000000-0000-4000-8000-000000000000.png';
    fx.r2PublicStore.objects.set(other, { body: Buffer.from('someone else') });
    expect(await upload('image/png')).toBe(200);

    await fx.app.inject({ method: 'DELETE', url: '/v1/account/me/avatar', headers: auth(fx) });

    expect(fx.r2PublicStore.objects.has(other)).toBe(true);
  });
});
