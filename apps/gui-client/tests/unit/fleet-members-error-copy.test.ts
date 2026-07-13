import { afterEach, describe, expect, it, vi } from 'vitest';
import { pingFleetMember, type FleetMember } from '../../src/lib/fleet-members';

const member: FleetMember = {
  id: 'fleet_1',
  label: 'Mac mini',
  baseUrl: 'https://fleet.example.test',
  notes: null,
  createdAt: '2026-07-13T12:00:00.000Z',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fleet member ping error copy', () => {
  it('turns native network diagnostics into actionable copy', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('fetch failed: getaddrinfo ENOTFOUND private.host')),
    );

    await expect(pingFleetMember(member)).resolves.toMatchObject({
      ok: false,
      error: 'Check your connection and try again.',
    });
  });
});
