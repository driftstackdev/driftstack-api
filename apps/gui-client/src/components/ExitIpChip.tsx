// ExitIpChip (T-26, owner #12) — the live exit identity of a running session,
// shown in the simulator cockpit next to the proxy/egress label.
//
// The values ride the session's `capabilityReport` (exit_ip / exit_country /
// exit_timezone / webrtc_candidate_ips), which the control plane already
// projects onto the session body — this component READS them off the report the
// simulator already holds; it never fetches. The fields are INERT until the
// harness (A3) emits them, so the chip degrades gracefully: absent exit_ip
// renders a muted "measuring…" state, never a crash and never a false verdict.
//
// Leak tell: a WebRTC candidate IP that differs from the exit IP means the
// device's RTC stack would expose an address the proxy exit does not — a real
// deanonymization risk — so that line is marked in the error token. When every
// candidate matches the exit IP (or none is present), no warning is shown.

import { type JSX } from 'react';
import type { AgentSessionCapabilityReport } from '../lib/agent-session-control';

/** The WebRTC candidate IPs that differ from the exit IP — the leak set. Empty
 *  when the report has no exit IP, no candidates, or every candidate matches the
 *  exit (the coherent, no-leak case). Pure so the rule is unit-testable. */
export function webrtcLeakIps(report: AgentSessionCapabilityReport | null): string[] {
  const exitIp = report?.exit_ip;
  if (exitIp === undefined) return [];
  return (report?.webrtc_candidate_ips ?? []).filter((ip) => ip !== exitIp);
}

export function ExitIpChip({
  report,
}: {
  report: AgentSessionCapabilityReport | null;
}): JSX.Element {
  const exitIp = report?.exit_ip;
  // Absent exit IP = not observed yet (the live state until A3 emits). Show a
  // muted measuring line rather than nothing or an error.
  if (exitIp === undefined) {
    return (
      <div
        data-component="sim-exit-ip-chip"
        data-state="measuring"
        className="mt-1 text-[10px] leading-snug text-white/40"
      >
        Exit IP: measuring…
      </div>
    );
  }

  const candidates = report?.webrtc_candidate_ips ?? [];
  const leaks = webrtcLeakIps(report);
  const hasLeak = leaks.length > 0;

  return (
    <div
      data-component="sim-exit-ip-chip"
      data-state="observed"
      className="mt-1 text-[10px] leading-snug text-white/70"
    >
      <div className="truncate">
        <span className="text-white/45">Exit IP </span>
        <span className="font-mono">{exitIp}</span>
        {report?.exit_country !== undefined ? ` · ${report.exit_country}` : ''}
        {report?.exit_timezone !== undefined ? ` · ${report.exit_timezone}` : ''}
      </div>
      {candidates.length > 0 && (
        <div
          data-component="sim-webrtc-candidates"
          data-leak={hasLeak ? 'true' : 'false'}
          className={`truncate ${hasLeak ? 'text-status-error' : 'text-white/50'}`}
        >
          {hasLeak ? '⚠ ' : ''}WebRTC: <span className="font-mono">{candidates.join(', ')}</span>
        </div>
      )}
    </div>
  );
}
