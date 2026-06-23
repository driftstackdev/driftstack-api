// #48 item 2 — "Copy diagnostics" for the simulator session-info panel.
// The session-info overlay already SHOWS the live transport/latency/loss
// figures; the founder repeatedly reports streaming/latency issues and needs to
// convey the exact numbers (a support request / bug report). This builds a
// plain-text, paste-ready snapshot of everything the overlay shows.
//
// Pure (no clipboard / no React) so it's unit-tested without a running GUI —
// the same convention as computeFlingPath / mapVideoToContentCss.

export interface SessionDiagnosticsInput {
  sessionId: string;
  profileName: string;
  deviceName: string;
  /** wsHost(info.ws_url), or null when not connected. */
  link: string | null;
  /** proxyLabel — '' when no egress proxy is configured. */
  egress: string;
  fps: number | null;
  /** App-level DataChannel ping RTT (preferred). */
  latencyMs: number | null;
  /** Media/candidate-pair RTT (fallback when the ping isn't echoed). */
  linkRttMs: number | null;
  transport: string | null;
  relayed: boolean | null;
  decodeFps: number | null;
  packetLossPct: number | null;
  jitterMs: number | null;
  freezeCount: number | null;
  build: string;
}

/**
 * Format a session diagnostics snapshot as paste-ready plain text. Mirrors the
 * fields + fallbacks of the on-screen session-info overlay: omit a line when its
 * value is absent (null / '') rather than printing a confusing "null", and use
 * the same app-ping-then-media-RTT latency fallback the overlay renders.
 */
export function formatSessionDiagnostics(d: SessionDiagnosticsInput): string {
  const lines: string[] = ['Driftstack session diagnostics'];
  if (d.sessionId !== '') lines.push(`session: ${d.sessionId}`);
  if (d.profileName !== '') lines.push(`profile: ${d.profileName}`);
  lines.push(`device: ${d.deviceName}`);
  lines.push(`link: ${d.link ?? 'not connected'}`);
  if (d.egress !== '') lines.push(`egress: ${d.egress}`);
  if (d.fps !== null) lines.push(`fps: ${d.fps}`);

  const latency =
    d.latencyMs !== null
      ? `${d.latencyMs} ms`
      : d.linkRttMs !== null
        ? `${d.linkRttMs} ms (link)`
        : 'measuring…';
  lines.push(`latency: ${latency}`);

  if (d.transport !== null) {
    lines.push(`transport: ${d.transport}${d.relayed === true ? ' · relay' : ' · direct'}`);
  }

  const media: string[] = [];
  if (d.decodeFps !== null) media.push(`decode ${d.decodeFps} fps`);
  if (d.packetLossPct !== null) media.push(`loss ${d.packetLossPct}%`);
  if (d.jitterMs !== null) media.push(`jitter ${d.jitterMs}ms`);
  if (d.freezeCount !== null) media.push(`freezes ${d.freezeCount}`);
  if (media.length > 0) lines.push(media.join(' · '));

  lines.push(`build: ${d.build}`);
  return lines.join('\n');
}
