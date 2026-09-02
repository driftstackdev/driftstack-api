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

/**
 * Classify a captured SYN.
 *
 * Deliberately conservative: it returns `unknown` rather than guessing, because
 * this drives a red/green cell an operator will act on and a confident wrong
 * answer is worse than an honest blank. The three families below are separated
 * by TTL first (64 vs 128 is a hard split) and then by option layout.
 */
export function fingerprintOs(sig: TcpSynSignature): OsFingerprintResult {
  const ttl0 = initialTtl(sig.ttl);
  if (ttl0 === null) {
    return {
      os: 'unknown',
      confidence: 'none',
      reason: `TTL ${sig.ttl} matches no common initial value`,
    };
  }

  const opts = sig.optionOrder;
  const hasTs = opts.includes(TS);
  const idxWs = opts.indexOf(WS);
  const idxSack = opts.indexOf(SACK_OK);

  // Windows: initial TTL 128 is close to definitive — no mainstream unix uses
  // it. Modern Windows also omits timestamps by default, which separates it
  // from the rare unix configured to 128.
  if (ttl0 === 128) {
    return {
      os: 'windows',
      confidence: hasTs ? 'medium' : 'high',
      reason: hasTs
        ? 'initial TTL 128 (Windows default); timestamps present, which Windows usually omits'
        : 'initial TTL 128 with no TCP timestamps — Windows default stack',
    };
  }

  if (ttl0 === 64) {
    // Darwin (macOS/iOS) vs Linux, both TTL 64. The option LAYOUT separates
    // them: Darwin emits window-scale before SACK-permitted, Linux emits
    // SACK-permitted before window-scale. Window scale value corroborates
    // (Darwin 6, Linux 7) but is not relied on alone — it is tunable.
    const darwinOrder = idxWs !== -1 && idxSack !== -1 && idxWs < idxSack;
    const linuxOrder = idxWs !== -1 && idxSack !== -1 && idxSack < idxWs;

    if (darwinOrder) {
      const corroborated = sig.windowScale === 6 && sig.windowSize === 65535;
      return {
        os: 'macos-or-ios',
        confidence: corroborated ? 'high' : 'medium',
        reason: corroborated
          ? 'TTL 64, window-scale before SACK-permitted, wscale 6 and window 65535 — Darwin (macOS/iOS)'
          : 'TTL 64 with window-scale ordered before SACK-permitted — Darwin option layout',
      };
    }
    if (linuxOrder) {
      const corroborated = sig.windowScale === 7 && hasTs;
      return {
        os: 'linux',
        confidence: corroborated ? 'high' : 'medium',
        reason: corroborated
          ? 'TTL 64, SACK-permitted before window-scale, wscale 7 with timestamps — Linux'
          : 'TTL 64 with SACK-permitted ordered before window-scale — Linux option layout',
      };
    }
    // TTL 64 with no usable option ordering. A BSD without both options, or a
    // stack that stripped them. Say TTL narrowed it and stop.
    return {
      os: 'unknown',
      confidence: 'none',
      reason:
        'initial TTL 64 (a unix family) but the option layout does not separate Darwin from Linux',
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
