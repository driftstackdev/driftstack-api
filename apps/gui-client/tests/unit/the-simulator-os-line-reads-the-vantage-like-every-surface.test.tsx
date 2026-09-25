// Owner item 9 — the Simulator's OS line against the other surfaces, now that
// the session's `capability_report.os_fingerprint` carries HOW the reading was
// taken (`observed_via`, `single_host_vantage`, `web_port_vantage`, and their
// customer names `direct_reading` / `website_like_reading`).
//
// Before, the report carried no vantage, so the Simulator could only paint
// Apple green and leave every other OS neutral. Now it reads the same verdict
// the Proxies grid's OS chip reads, from the same fields: Apple green from any
// vantage; a different OS red ONLY from a vantage that describes the path a
// website sees; neutral otherwise. Each case below renders both surfaces and
// holds them to the same tone.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { AgentSessionCapabilityReport } from '../../src/lib/agent-session-control';
import { getAgentSession } from '../../src/lib/agent-session-control';
import { capabilityReportsEqual } from '../../src/lib/capability-report-equal';
import type { OsFingerprint } from '../../src/lib/os-fingerprint-verdict';
import { ProxyOsChip } from '../../src/components/ProxyCapabilities';
import { OsReadout } from '../../src/components/OsReadout';

afterEach(cleanup);

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const AT = '2026-09-24T11:50:00.000Z';

type WireFp = NonNullable<AgentSessionCapabilityReport['os_fingerprint']>;

const CASES: ReadonlyArray<{ name: string; wire: WireFp; tone: 'match' | 'mismatch' | 'unknown' }> =
  [
    {
      name: 'Apple, from the web port',
      wire: {
        os: 'macos-or-ios',
        confidence: 'high',
        at: AT,
        observed_via: 'proxy_host',
        web_port_vantage: true,
      },
      tone: 'match',
    },
    {
      name: 'Apple, from a multi-machine proxy (no vantage flag)',
      wire: { os: 'macos-or-ios', confidence: 'medium', at: AT, observed_via: 'exit_ip' },
      tone: 'match',
    },
    {
      name: 'Windows, from a single-host proxy — the path a website sees',
      wire: {
        os: 'windows',
        confidence: 'high',
        at: AT,
        observed_via: 'exit_ip',
        single_host_vantage: true,
      },
      tone: 'mismatch',
    },
    {
      name: 'Windows, from the web port',
      wire: {
        os: 'windows',
        confidence: 'high',
        at: AT,
        observed_via: 'proxy_host',
        web_port_vantage: true,
      },
      tone: 'mismatch',
    },
    {
      name: 'Windows, from a multi-machine proxy — cannot speak for a website’s path',
      wire: { os: 'windows', confidence: 'high', at: AT, observed_via: 'exit_ip' },
      tone: 'unknown',
    },
    {
      name: 'Windows, only the entry point on the observer port',
      wire: { os: 'windows', confidence: 'high', at: AT, observed_via: 'proxy_host' },
      tone: 'unknown',
    },
  ];

/** The same reading as the grid holds it. */
function asGridFingerprint(w: WireFp): OsFingerprint {
  return {
    os: w.os as OsFingerprint['os'],
    confidence: w.confidence as OsFingerprint['confidence'],
    reason: '',
    ...(w.observed_via !== undefined ? { observedVia: w.observed_via } : {}),
    ...(w.single_host_vantage === true ? { singleHostVantage: true } : {}),
    ...(w.web_port_vantage === true ? { webPortVantage: true } : {}),
    at: Date.parse(w.at ?? AT),
  };
}

function simLine(fp: WireFp): HTMLElement {
  const { container } = render(
    <OsReadout
      report={{
        manual_input_available: true,
        streaming_state: 'live',
        egress_state: 'live',
        os_fingerprint: fp,
      }}
      nowMs={NOW}
    />,
  );
  return container.querySelector('[data-component="sim-os-readout"]') as HTMLElement;
}

describe('the Simulator OS line reads the vantage exactly as the Proxies grid does', () => {
  for (const c of CASES) {
    it(`${c.name}: ${c.tone}`, () => {
      const grid = render(
        <ProxyOsChip fingerprint={asGridFingerprint(c.wire)} nowMs={NOW} />,
      ).container.querySelector('[data-component="proxy-os-fingerprint"]') as HTMLElement;
      expect(grid.getAttribute('data-os-tone'), 'grid').toBe(c.tone);
      cleanup();
      const sim = simLine(c.wire);
      expect(sim.getAttribute('data-os-tone'), 'simulator').toBe(c.tone);
      if (c.tone === 'match') {
        expect(sim.className).toContain('text-status-ready');
        expect(sim.textContent).toMatch(/^OS: ✓ iOS\/macOS/);
      } else if (c.tone === 'mismatch') {
        expect(sim.className).toContain('text-status-error');
        expect(sim.textContent).toMatch(/^OS: ✗ Windows/);
      } else {
        expect(sim.className).not.toContain('text-status-error');
        expect(sim.className).not.toContain('text-status-ready');
      }
    });
  }

  it('the customer names of the two flags count the same as the flags', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            mode: 'manual',
            status: 'active',
            capability_report: {
              manual_input_available: true,
              streaming_state: 'live',
              egress_state: 'live',
              // Only the customer names — a server that sends just these.
              os_fingerprint: { os: 'windows', confidence: 'high', at: AT, direct_reading: true },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    try {
      const s = await getAgentSession('agt_x', {
        controlKey: `gck_${'a'.repeat(32)}`,
        baseUrl: 'https://api.example.test',
      });
      const fp = s.capabilityReport?.os_fingerprint;
      expect(fp?.single_host_vantage).toBe(true);
      expect(simLine(fp as WireFp).getAttribute('data-os-tone')).toBe('mismatch');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('the fields reach the Simulator, and a change to them is a change', () => {
  it('the session read keeps the vantage fields the server sends', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            mode: 'manual',
            status: 'active',
            capability_report: {
              manual_input_available: true,
              streaming_state: 'live',
              egress_state: 'live',
              os_fingerprint: {
                os: 'windows',
                confidence: 'high',
                at: AT,
                observed_via: 'exit_ip',
                single_host_vantage: true,
                web_port_vantage: false,
                direct_reading: true,
                website_like_reading: false,
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    try {
      const s = await getAgentSession('agt_x', {
        controlKey: `gck_${'a'.repeat(32)}`,
        baseUrl: 'https://api.example.test',
      });
      expect(s.capabilityReport?.os_fingerprint).toMatchObject({
        os: 'windows',
        observed_via: 'exit_ip',
        single_host_vantage: true,
        web_port_vantage: false,
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('a reading that changes only its vantage is a new report', () => {
    const base: AgentSessionCapabilityReport = {
      manual_input_available: true,
      streaming_state: 'live',
      egress_state: 'live',
    };
    expect(
      capabilityReportsEqual(
        { ...base, os_fingerprint: { os: 'windows', confidence: 'high', at: AT } },
        {
          ...base,
          os_fingerprint: { os: 'windows', confidence: 'high', at: AT, single_host_vantage: true },
        },
      ),
    ).toBe(false);
  });
});
