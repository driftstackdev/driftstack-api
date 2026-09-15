// Passive OS fingerprinting of a proxy's own TCP/IP stack.
//
// WHY THIS WORKS AT ALL. A SOCKS5 proxy does not forward packets — it opens its
// OWN TCP connection to the destination and relays the payload. So the SYN that
// reaches our observer was crafted by the PROXY HOST's kernel, not the
// customer's and not ours. Its IP/TCP header choices are therefore a property
// of the proxy machine, which is exactly what the operator wants to see: a
// "residential iPhone" proxy whose stack says Linux is not what it claims.
//
// ⛔ WHY IT CANNOT COME FROM THE EXISTING PROBE. The device-side probe opens a
// CONNECTED socket (`std::net::TcpStream`). By the time a connected socket
// exists the kernel has consumed the SYN-ACK, and the TTL, window, MSS and
// option layout are gone — none are exposed by any socket API. The inputs only
// exist in the raw SYN, so an observer that sees the packet is required. This
// module is the pure half: given a signature somebody else captured, say what
// stack it looks like. No I/O, no sockets, fully testable.
//
// The signature fields are p0f's: initial TTL, MSS, window size, window scale,
// the ORDER of TCP options, and the DF bit. Option ORDER matters more than the
// individual values — stacks differ in how they lay options out even when the
// numbers coincide.

/** One observed SYN, as captured from the wire. */
export interface TcpSynSignature {
  /** IP TTL as it arrived. Hops decrement it, so it is rounded UP to the
   *  nearest common initial value before use — see `initialTtl`. */
  ttl: number;
  /** TCP window size from the SYN (pre-scaling). */
  windowSize: number;
  /** Maximum segment size option, or null when absent. */
  mss: number | null;
  /** Window-scale shift, or null when the option is absent. */
  windowScale: number | null;
  /** TCP option kinds in wire order, e.g. [2,4,8,1,3] for MSS,SACKOK,TS,NOP,WS. */
  optionOrder: readonly number[];
  /** IP Don't-Fragment bit. */
  df: boolean;
}

export type FingerprintedOs = 'macos-or-ios' | 'windows' | 'linux' | 'bsd' | 'unknown';

export interface OsFingerprintResult {
  os: FingerprintedOs;
  /** How much the signature narrowed it. `unknown` always carries 'none'. */
  confidence: 'high' | 'medium' | 'low' | 'none';
  /** Human-readable reason, for the operator staring at a red cell. */
  reason: string;
}

/** Real internet paths are well under 30 hops; p0f uses the same reasoning.
 *  Beyond this the observed TTL no longer identifies which initial value it
 *  started from, and a guess would be worse than admitting we cannot tell. */
export const MAX_PLAUSIBLE_HOPS = 32;

/** Hops decrement TTL, so the observed value is below the sender's initial one.
 *  Stacks start at 64, 128 or 255; round up to the nearest that implies a
 *  plausible hop count. Returns null when none does — an observed TTL of 3
 *  would need 61 hops from 64, which is not a path, so it carries no
 *  information about the sender. */
export function initialTtl(observed: number): 64 | 128 | 255 | null {
  if (observed <= 0) return null;
  for (const start of [64, 128, 255] as const) {
    if (observed <= start && start - observed <= MAX_PLAUSIBLE_HOPS) return start;
  }
  return null;
}

const TS = 8; // timestamps
const WS = 3; // window scale
const SACK_OK = 4;

type Layout = 'darwin' | 'linux' | 'windows' | 'ws-sack-ts' | 'none';

/**
 * The stack family the TCP OPTION LAYOUT alone says, ignoring TTL.
 *
 *   Darwin   MSS,NOP,WS,NOP,NOP,TS,SACK,EOL  — window-scale BEFORE SACK, timestamps ON
 *   Windows  MSS,NOP,WS,NOP,NOP,SACK         — window-scale BEFORE SACK, timestamps OFF
 *   Linux    MSS,SACK,TS,NOP,WS              — SACK BEFORE window-scale
 *
 * Darwin and Windows share the WS-before-SACK order. What separates Darwin is
 * WHERE the timestamp sits: Darwin puts it BEFORE SACK-permitted.
 *
 * ⛔ "timestamps present" is NOT enough to say Darwin, and an adversarial review
 * caught that it was being used that way. FreeBSD 9+ (MSS,NOP,WS,SACK,TS, window
 * 65535, wscale 6 — p0f) and Windows with RFC 1323 timestamps enabled
 * (MSS,NOP,WS,SACK,TS) both carry timestamps AFTER SACK. Reading them as Darwin
 * put a green "matches the iOS device" on a FreeBSD/pfSense relay, and turned a
 * real timestamped Windows host into "unknown". That order is its own class,
 * `ws-sack-ts`: genuinely ambiguous between those two, and never Darwin.
 */
function layoutOf(sig: TcpSynSignature): Layout {
  const opts = sig.optionOrder;
  const idxWs = opts.indexOf(WS);
  const idxSack = opts.indexOf(SACK_OK);
  const idxTs = opts.indexOf(TS);
  if (idxWs === -1 || idxSack === -1) return 'none';
  if (idxSack < idxWs) return 'linux';
  if (idxTs === -1) return 'windows';
  return idxTs < idxSack ? 'darwin' : 'ws-sack-ts';
}

/** The layout family together with the numeric values that stack actually
 *  ships — enough to override a contradicting TTL, which layout alone is not. */
function corroborated(sig: TcpSynSignature, layout: Layout): boolean {
  if (layout === 'darwin') return sig.windowScale === 6 && sig.windowSize === 65535;
  if (layout === 'linux') return sig.windowScale === 7 && sig.optionOrder.includes(TS);
  if (layout === 'windows') return sig.windowScale === 8;
  return false;
}

const TTL_REWRITE_NOTE =
  'a TTL rewritten in the path — mobile carriers normalise TTL, and no middlebox reorders TCP options';

/**
 * Classify a captured SYN.
 *
 * Deliberately conservative: it returns `unknown` rather than guessing, because
 * this drives a red/green cell an operator will act on and a confident wrong
 * answer is worse than an honest blank.
 *
 * ⛔⛔ (V-219) TTL DOES NOT OUTRANK THE OPTION LAYOUT, and it used to. This read
 * TTL first ("64 vs 128 is a hard split") and, on 128, answered Windows without
 * looking at the options at all. TTL is the ONE field of a SYN that the path is
 * known to rewrite: mobile carriers normalise it (T-Mobile's network is the
 * well-known case, for tethering detection). The option layout is written by the
 * sending kernel and nothing between it and us reorders it.
 *
 * MEASURED 2026-09-15 on production, same control-plane dialer, same destination
 * IP, only the port differing. Three T-Mobile proxies each presented TWO stacks —
 * a Linux layout on 7791 and a Darwin layout on 443 — and BOTH arrived with TTL
 * 114–117 (initial 128). Two different kernels cannot both have originated TTL
 * 128; the path set it. This classifier called both of them Windows, which is the
 * "TmobileTX shows Win" the owner reported, while a Verizon proxy with the same
 * two layouts at TTL 53 (initial 64) was read correctly as Linux and Darwin.
 *
 * So: layout decides the family; TTL CORROBORATES. When they agree, confidence
 * is as before. When they disagree, a layout backed by that stack's own numeric
 * values wins at `medium` with the rewrite named in the reason; a bare layout
 * that TTL contradicts is not enough to override anything, and reads `unknown`.
 */
export function fingerprintOs(sig: TcpSynSignature): OsFingerprintResult {
  const ttl0 = initialTtl(sig.ttl);
  const layout = layoutOf(sig);
  const backed = corroborated(sig, layout);
  const hasTs = sig.optionOrder.includes(TS);

  // TTL 255 (BSD and a lot of network gear) keeps its old reading unless the
  // layout is unambiguous and backed — the same override rule as 128.
  if (ttl0 === null && layout === 'none') {
    return {
      os: 'unknown',
      confidence: 'none',
      reason: `TTL ${sig.ttl} matches no common initial value`,
    };
  }

  if (ttl0 === 64) {
    if (layout === 'darwin') {
      return {
        os: 'macos-or-ios',
        confidence: backed ? 'high' : 'medium',
        reason: backed
          ? 'TTL 64, window-scale before SACK-permitted, wscale 6 and window 65535 — Darwin (macOS/iOS)'
          : 'TTL 64 with window-scale ordered before SACK-permitted — Darwin option layout',
      };
    }
    if (layout === 'linux') {
      return {
        os: 'linux',
        confidence: backed ? 'high' : 'medium',
        reason: backed
          ? 'TTL 64, SACK-permitted before window-scale, wscale 7 with timestamps — Linux'
          : 'TTL 64 with SACK-permitted ordered before window-scale — Linux option layout',
      };
    }
    if (layout === 'windows' && backed) {
      return {
        os: 'windows',
        confidence: 'medium',
        reason: `Windows option layout (no timestamps, wscale 8) at TTL 64 — ${TTL_REWRITE_NOTE}`,
      };
    }
    if (layout === 'windows' || layout === 'ws-sack-ts') {
      // WS before SACK at TTL 64, but without Darwin's timestamp placement. This
      // used to be read as Darwin; it is not Darwin's layout (no timestamp, or a
      // timestamp after SACK — FreeBSD's). Nothing here names a family.
      return {
        os: 'unknown',
        confidence: 'none',
        reason:
          'initial TTL 64 with window-scale before SACK-permitted but not Darwin’s timestamp placement — FreeBSD and tuned stacks share it',
      };
    }
    return {
      os: 'unknown',
      confidence: 'none',
      reason:
        'initial TTL 64 (a unix family) but the option layout does not separate Darwin from Linux',
    };
  }

  if (ttl0 === 128) {
    if (layout === 'darwin' && backed) {
      return {
        os: 'macos-or-ios',
        confidence: 'medium',
        reason: `Darwin option layout, wscale 6 and window 65535, at TTL ${sig.ttl} (initial 128) — ${TTL_REWRITE_NOTE}`,
      };
    }
    if (layout === 'linux' && backed) {
      return {
        os: 'linux',
        confidence: 'medium',
        reason: `Linux option layout, wscale 7 with timestamps, at TTL ${sig.ttl} (initial 128) — ${TTL_REWRITE_NOTE}`,
      };
    }
    if (layout === 'darwin' || layout === 'linux') {
      // The layout contradicts TTL but nothing else backs it. Neither signal is
      // strong enough alone to name a family, so say so. (`ws-sack-ts` is NOT
      // here: at TTL 128 that is Windows with timestamps enabled, and it falls
      // through to the Windows reading below, exactly as before this change.)
      return {
        os: 'unknown',
        confidence: 'none',
        reason: `initial TTL 128 says Windows but the option layout says ${layout === 'darwin' ? 'Darwin' : 'Linux'}, and neither is corroborated`,
      };
    }
    return {
      os: 'windows',
      confidence: hasTs ? 'medium' : 'high',
      reason: hasTs
        ? 'initial TTL 128 (Windows default); timestamps present, which Windows usually omits'
        : 'initial TTL 128 with no TCP timestamps — Windows default stack',
    };
  }

  if (ttl0 === 255 && (layout === 'darwin' || layout === 'linux') && backed) {
    return {
      os: layout === 'darwin' ? 'macos-or-ios' : 'linux',
      confidence: 'medium',
      reason: `${layout === 'darwin' ? 'Darwin' : 'Linux'} option layout, corroborated, at TTL ${sig.ttl} (initial 255) — ${TTL_REWRITE_NOTE}`,
    };
  }

  if (ttl0 === null) {
    return {
      os: 'unknown',
      confidence: 'none',
      reason: `TTL ${sig.ttl} matches no common initial value`,
    };
  }

  // ⛔ The same rule as TTL 128, and it was missing: a layout that contradicts
  // TTL 255 without its own numeric values overrides nothing — but it also must
  // not fall through to "bsd". An iPhone behind a TTL-255 rewriter with tuned
  // window values read BSD, and a web-port reading turns BSD against an iOS claim
  // into a red "detectable mismatch". The honest answer is the one TTL 128 gives.
  if (layout === 'darwin' || layout === 'linux' || layout === 'windows') {
    return {
      os: 'unknown',
      confidence: 'none',
      reason: `initial TTL 255 but a ${layout === 'darwin' ? 'Darwin' : layout === 'linux' ? 'Linux' : 'Windows'} option layout, and neither is corroborated`,
    };
  }

  // TTL 255: classic BSD and a lot of network gear.
  return {
    os: 'bsd',
    confidence: 'low',
    reason: 'initial TTL 255 — BSD-family or an intermediate device',
  };
}

/** What the archetype claims the device is, reduced to the families the
 *  fingerprint can actually distinguish. */
export type ClaimedOs = 'ios' | 'macos' | 'other';

export type FingerprintVerdict = 'match' | 'mismatch' | 'unknown';

/**
 * Compare what the proxy's stack looks like against what the profile claims.
 *
 * `unknown` is a first-class outcome and must stay visually distinct from
 * `match`: "we could not tell" is not "this is fine". An operator who cannot
 * see the difference will read every blank as a pass.
 */
export function compareOsToClaim(
  observed: FingerprintedOs,
  claimed: ClaimedOs,
): FingerprintVerdict {
  if (observed === 'unknown') return 'unknown';
  // iOS and macOS share a kernel and are indistinguishable at this layer, so a
  // Darwin stack satisfies either claim. Claiming Darwin and presenting Linux
  // or Windows is the mismatch this exists to catch.
  if (claimed === 'ios' || claimed === 'macos') {
    return observed === 'macos-or-ios' ? 'match' : 'mismatch';
  }
  return 'unknown';
}
