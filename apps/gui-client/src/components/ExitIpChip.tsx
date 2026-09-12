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

/** Compress/normalize an IPv6 literal to its canonical form: expand `::`,
 *  collapse per-group leading zeros, lowercase hex, and re-collapse the longest
 *  zero run to `::`. Also folds an IPv4-mapped tail (`::ffff:1.2.3.4`) into two
 *  hex groups so it compares to its hex spelling. Returns null when `s` is not a
 *  parseable IPv6 literal, so the caller can fall back to the raw string.
 *  Minimal and self-contained — the CSP/bundle forbids pulling a new dep. */
function canonicalIpv6(s: string): string | null {
  if (!s.includes(':')) return null;

  // Fold a trailing dotted-quad (IPv4-mapped) into two hex groups.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(tail)) {
    const [a, b, c, d] = tail.split('.').map((o) => Number(o));
    if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
    if (a > 255 || b > 255 || c > 255 || d > 255) return null;
    const hi = ((a << 8) | b).toString(16);
    const lo = ((c << 8) | d).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null; // more than one `::` is invalid

  const parse = (part: string): string[] | null => {
    if (part === '') return [];
    const groups = part.split(':');
    for (const g of groups) if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    return groups;
  };

  const head = parse(halves[0] ?? '');
  const rear = parse(halves.length === 2 ? (halves[1] ?? '') : '');
  if (head === null || rear === null) return null;

  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - (head.length + rear.length);
    if (missing < 1) return null; // `::` must stand for at least one zero group
    groups = [...head, ...Array<string>(missing).fill('0'), ...rear];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const nums = groups.map((g) => g.replace(/^0+(?=.)/, ''));

  // Longest run of "0" groups (length >= 2) collapses to `::`.
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < 8; i++) {
    if (nums[i] === '0') {
      if (curStart === -1) curStart = i;
      curLen += 1;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }
  if (bestLen < 2) return nums.join(':');

  const before = nums.slice(0, bestStart);
  const after = nums.slice(bestStart + bestLen);
  return `${before.join(':')}::${after.join(':')}`;
}

/** Canonicalize an IP string so textually-different spellings of the SAME
 *  address compare equal — otherwise a coherent exit is cried as a WebRTC leak.
 *  Lowercases; drops a trailing dot; strips an embedded port for IPv4
 *  (`a.b.c.d:p` → `a.b.c.d`) and bracketed IPv6 (`[::1]:p` → `::1`); and fully
 *  compresses an IPv6 literal. A value we cannot parse normalizes to itself
 *  (lowercased), so a genuinely different string still differs and still flags.
 *  Pure. */
export function normalizeIp(value: string): string {
  let s = value.trim().toLowerCase();
  if (s.endsWith('.')) s = s.slice(0, -1);

  // Bracketed IPv6 with optional port: [2001:db8::1]:443 → 2001:db8::1
  const bracket = /^\[([0-9a-f:.]+)\](?::\d+)?$/.exec(s);
  if (bracket) {
    const inner = bracket[1] ?? s;
    return canonicalIpv6(inner) ?? inner;
  }

  // IPv4 with an embedded port: 1.2.3.4:8080 → 1.2.3.4
  const ipv4Port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(s);
  if (ipv4Port) return ipv4Port[1] ?? s;

  // Bare IPv4: already canonical (equal spellings are equal).
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(s)) return s;

  // IPv6 literal (may already carry `::`).
  return canonicalIpv6(s) ?? s;
}

/** The WebRTC candidate IPs that differ from the exit IP — the leak set. Empty
 *  when the report has no exit IP, no candidates, or every candidate matches the
 *  exit (the coherent, no-leak case). Compares CANONICALIZED addresses so two
 *  equal-but-textually-different spellings (IPv6 case/compression, a trailing
 *  dot, an embedded :port) are not cried as a leak. Pure so the rule is
 *  unit-testable. */
export function webrtcLeakIps(report: AgentSessionCapabilityReport | null): string[] {
  const exitIp = report?.exit_ip;
  if (exitIp === undefined) return [];
  const exitCanon = normalizeIp(exitIp);
  return (report?.webrtc_candidate_ips ?? []).filter((ip) => normalizeIp(ip) !== exitCanon);
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
        className="mt-1 text-[10px] leading-snug text-white/50"
      >
        Exit IP: measuring…
      </div>
    );
  }

  const candidates = report?.webrtc_candidate_ips ?? [];
  const leaks = webrtcLeakIps(report);
  const hasLeak = leaks.length > 0;
  // Both lines truncate at the drawer's width, so each carries `title` = the
  // full text it renders (the drawer's pattern for every clipped line). The
  // strings are built ONCE and rendered from the same values so the tooltip can
  // never drift from the visible text.
  const geo = `${report?.exit_country !== undefined ? ` · ${report.exit_country}` : ''}${
    report?.exit_timezone !== undefined ? ` · ${report.exit_timezone}` : ''
  }`;
  const exitLine = `Exit IP ${exitIp}${geo}`;
  const webrtcLine = `${hasLeak ? '⚠ ' : ''}WebRTC: ${candidates.join(', ')}`;

  return (
    <div
      data-component="sim-exit-ip-chip"
      data-state="observed"
      className="mt-1 text-[10px] leading-snug text-white/70"
    >
      <div className="truncate" title={exitLine}>
        <span className="text-white/50">Exit IP </span>
        <span className="font-mono">{exitIp}</span>
        {geo}
      </div>
      {candidates.length > 0 && (
        <div
          data-component="sim-webrtc-candidates"
          data-leak={hasLeak ? 'true' : 'false'}
          title={webrtcLine}
          className={`truncate ${hasLeak ? 'text-status-error' : 'text-white/50'}`}
        >
          {hasLeak ? '⚠ ' : ''}WebRTC: <span className="font-mono">{candidates.join(', ')}</span>
        </div>
      )}
    </div>
  );
}
