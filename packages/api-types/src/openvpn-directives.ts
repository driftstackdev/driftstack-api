// OpenVPN directives the API refuses inside a customer `config_blob`, and the
// line-level finder both ends of the wire use to name them.
//
// The set is the rejection list the control plane enforces at ingress
// (apps/server/src/lib/webhook-target-guard.ts): every directive here invokes
// an external program once `script-security` is >=2 — the class the P0
// root-RCE (A3 118722821) exploited, when a customer blob carrying
// `up /path/script` ran as root on the userspace egress host. The box now
// forces `--script-security 1` (user scripts disabled), but the CP REJECTS a
// config carrying any of these so a weaponized blob is never stored or
// dispatched — defense-in-depth, not the sole line of defense.
//
// Why it lives in @driftstack/api-types (ledger T-20): commercial provider
// .ovpn files routinely carry `up /etc/openvpn/update-resolv-conf` and
// `script-security 2`, so the refusal is something an ordinary customer hits,
// not only an attacker. The server needs the offending LINE to name in its
// 400; the desktop client needs the same finder to warn before submitting and
// to offer "remove the unsupported lines". Two hand-kept copies of the list
// would drift — the client accepting what the server refuses, or refusing what
// it accepts — so there is one list and one tokenizer here, and the server's
// enforcement is built on top of it rather than beside it.
//
// Pure, dependency-free and total (never throws): safe to run on every paste.

/**
 * OpenVPN config directives that invoke an external program when
 * script-security is >=2. Lower-cased; matched on the directive keyword at
 * line start (first whitespace-delimited token, case-insensitively).
 */
export const DANGEROUS_OPENVPN_DIRECTIVES: ReadonlySet<string> = new Set([
  'up',
  'down',
  'route-up',
  'route-pre-down',
  'ipchange',
  'tls-verify',
  'learn-address',
  'client-connect',
  'client-disconnect',
  'auth-user-pass-verify',
  'up-restart',
  // Derived from the shipped OpenVPN man page (2.7) rather than recalled: every
  // directive whose own text says it runs a command. These three were absent.
  //
  // `client-crresponse cmd` — "Executed when the client sends a text based
  // challenge response"; OpenVPN writes the response to a temp file and passes
  // the filename to cmd. Same class as the eleven above.
  'client-crresponse',
  // `dns-updown` — runs a command to apply DNS settings ("use force as cmd to
  // run the default command"). Same class.
  'dns-updown',
  // `plugin` loads a SHARED MODULE and hooks it into OpenVPN's callbacks, which
  // is arbitrary native code rather than a script. Included because a customer
  // config blob has no legitimate reason to load one.
  //
  // Stated honestly: the box forces `--script-security 1`, and that is what
  // neuters the script directives above. Whether it also gates plugin LOADING
  // could not be verified here — this machine's man page carries only a single
  // passing mention of `--script-security` and no levels section. So treat the
  // box mitigation as unconfirmed for this entry specifically, which is the
  // reason to reject it at ingress rather than rely on the host.
  'plugin',
]);

/** One line of an OpenVPN config the API will refuse. */
export interface OpenvpnUnsupportedLine {
  /** 1-based line number in the blob as pasted (CRLF and LF each count one line). */
  line: number;
  /** The directive keyword, lower-cased (`up`, `script-security`, …). */
  directive: string;
  /** The offending line, trimmed, exactly as the customer wrote it. */
  text: string;
  /** Why it is refused; names the `script-security` level when that is the cause. */
  reason: string;
}

/**
 * Every line of an OpenVPN `config_blob` the API refuses, in file order:
 * a script-executing directive (up/down/route-up/…) or `script-security`
 * raised to 2+ (the switch that lets those directives run programs; 0/1 are
 * safe — 1 permits only built-ins and the box floors there regardless).
 *
 * Comment (`#`/`;`) and blank lines are skipped. The keyword is the first
 * whitespace-delimited token of the trimmed line, matched case-insensitively.
 * Nothing else about the line is interpreted — `up-north.example.com` after a
 * `remote` keyword is a hostname, not a directive.
 */
export function findUnsupportedOpenvpnLines(configBlob: string): OpenvpnUnsupportedLine[] {
  const hits: OpenvpnUnsupportedLine[] = [];
  const lines = configBlob.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const text = (lines[i] ?? '').trim();
    if (text === '' || text.startsWith('#') || text.startsWith(';')) continue;
    const tokens = text.split(/\s+/);
    const keyword = (tokens[0] ?? '').toLowerCase();
    if (DANGEROUS_OPENVPN_DIRECTIVES.has(keyword)) {
      hits.push({
        line: i + 1,
        directive: keyword,
        text,
        reason:
          keyword === 'plugin'
            ? '`plugin` loads a native module into OpenVPN'
            : `\`${keyword}\` runs an external program`,
      });
      continue;
    }
    if (keyword === 'script-security') {
      const level = Number(tokens[1]);
      if (Number.isFinite(level) && level >= 2) {
        hits.push({
          line: i + 1,
          directive: keyword,
          text,
          reason: `\`script-security ${tokens[1] ?? ''}\` allows the config to run external programs (level 2 or higher)`,
        });
      }
    }
  }
  return hits;
}

/**
 * The same blob with every line `findUnsupportedOpenvpnLines` reports taken
 * out — except `script-security`, which is lowered to `script-security 1`
 * (deleting it would also work, since 1 is OpenVPN's default, but keeping the
 * line shows the customer what changed). Every other byte, including the
 * customer's line endings and indentation, is preserved, so the result diffs
 * cleanly against the paste.
 *
 * `removed` is exactly what the finder reported; a `script-security` entry in
 * it means that line was lowered rather than deleted. Running the finder on
 * `config` afterwards yields nothing — the strip is idempotent.
 */
export function stripUnsupportedOpenvpnLines(configBlob: string): {
  config: string;
  removed: OpenvpnUnsupportedLine[];
} {
  const removed = findUnsupportedOpenvpnLines(configBlob);
  if (removed.length === 0) return { config: configBlob, removed };
  const byLine = new Map(removed.map((hit) => [hit.line, hit] as const));
  // Split with the separator CAPTURED so each line keeps the ending it came
  // with; even indices are lines, odd indices the `\n` / `\r\n` after them.
  // Numbering matches the finder's `split(/\r?\n/)` exactly.
  const parts = configBlob.split(/(\r?\n)/);
  let config = '';
  let lineNo = 0;
  for (let i = 0; i < parts.length; i += 2) {
    lineNo += 1;
    const text = parts[i] ?? '';
    const ending = parts[i + 1] ?? '';
    const hit = byLine.get(lineNo);
    if (hit === undefined) {
      config += text + ending;
    } else if (hit.directive === 'script-security') {
      const indent = text.slice(0, text.length - text.trimStart().length);
      config += `${indent}script-security 1${ending}`;
    }
    // Any other hit: the line and its ending are dropped.
  }
  return { config, removed };
}
