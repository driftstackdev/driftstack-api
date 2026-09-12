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
    // OpenVPN's own config parser strips a leading `--` from every directive
    // (bypass_doubledash in options.c, applied to config-file lines when the token
    // is >= 3 chars), so `--plugin`/`--script-security`/`--up` are honored exactly
    // like their bare forms. Match the same normalization or the refusal is a
    // one-character bypass (a `--plugin` line loads a native module as root on the
    // shared egress host — the P0 root-RCE class this guard exists to stop).
    let keyword = (tokens[0] ?? '').toLowerCase();
    if (keyword.length >= 3 && keyword.startsWith('--')) keyword = keyword.slice(2);
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

/**
 * OpenVPN cert/key directives whose material must be INLINE (an
 * `<directive>…</directive>` block), because the userspace-egress node renders
 * the config into an isolated directory holding only `client.ovpn` + `auth.txt`:
 * a bare file argument (`ca ca.crt`) names a path that cannot exist there.
 * Matched on the first whitespace token, case-insensitively.
 */
export const OPENVPN_INLINE_REQUIRED_DIRECTIVES: ReadonlySet<string> = new Set([
  'ca',
  'cert',
  'key',
  'tls-auth',
  'tls-crypt',
]);

/**
 * Lines that reference an EXTERNAL cert/key file the server cannot provide — a
 * `ca`/`cert`/`key`/`tls-auth`/`tls-crypt` directive with a file argument and NO
 * corresponding inline `<directive>` block anywhere in the blob. Such a config
 * stores and dispatches fine, then dies late inside openvpn with a generic
 * "Options error" that names neither the field nor the cause; caught here it
 * fails at upload naming the directive, so the customer knows to paste the
 * inline / "unified" .ovpn their provider offers.
 *
 * ⭐ CROSS-SOURCE PIN with the node-side reject (A3 `8a03a3929`,
 * VPNProxyConfigParser.openvpnExternalFileReference). Upload-reject (here) and
 * parse-reject (node) enforce the same rule on the four points below, with ONE
 * measured exception named after them — ⛔ "by construction" is what this comment
 * used to claim, and it was false; two implementations in two languages agree
 * until they drift, and a differential is the only thing that knows:
 *   - REJECT: first token is one of the five AND the line has a file argument
 *     (≥2 tokens), when NO `<directive>` opening tag exists anywhere in the blob.
 *   - ACCEPT: an inline `<ca>`…`</ca>` block — inline WINS even if a stray
 *     `ca ca.crt` line is also present (openvpn uses the block; the line is inert).
 *   - ACCEPT: a comment (`#`/`;`) or a bare directive with no argument.
 *
 * ⛔⛔ SEPARATORS: SPACE AND TAB, and ONLY those — `token_separators: [" ", "\t"]`
 * in the shared contract (openvpn-file-reference-fixtures.json), which is what
 * openvpn's own config lexer does and what the node parser does
 * (`whereSeparator: { $0 == " " || $0 == "\t" }`, VPNProxyConfig.swift).
 *
 * This function used to split on `/\s+/`, i.e. on every Unicode space as well —
 * a FOURTH divergence in this pair, found 2026-09-12 by reading the two sources
 * against the contract rather than against each other. `ca\u00A0ca.crt` (a
 * non-breaking space, which a copy-paste out of a provider's web page produces)
 * was REFUSED here and ACCEPTED by the node, so "both ends enforce the same
 * rule" — the sentence the dispatch-time refusal's safety argument rests on —
 * was false, and the drift was invisible: the contract suite's rule-parameter arm
 * compared the FIXTURE's declared separators against a literal `[' ', '\t']` and
 * never against this code, so it read green either way. The arm now derives its
 * cases from `token_separators` and asserts the NEGATIVE too (a whitespace char
 * outside the declared set is NOT a separator here), which is what would have
 * caught it.
 *
 * Direction of this correction: slightly MORE permissive. A line openvpn cannot
 * tokenise is an unrecognised option that fails LOUDLY at startup — a different
 * failure class from the SILENT file-not-found this guard exists to catch, and
 * the one the Swift side already documents as deliberately out of scope.
 *
 * ⚠️ `findUnsupportedOpenvpnLines` above still splits on `/\s+/` ON PURPOSE: it is
 * the SECURITY guard (script-executing directives), it has no cross-source
 * contract declaring its tokenizer, and for it over-refusal is the safe
 * direction. Do not "make them consistent".
 *   - DO NOT require `<ca>` unconditionally: the rule is "no UNRESOLVABLE file
 *     reference", not "must contain <ca>". A config with no cert material at all
 *     is a genuine error openvpn names better than a blanket requirement, and
 *     rejecting valid provider configs is the expensive direction.
 *
 * ⛔ CRLF: most .ovpn files are Windows-authored. Split on \r\n / \r / \n and
 * trim each line — the node shipped a CRLF-blind split that let every Windows
 * config bypass this check silently (worse than no check: it reads clean).
 *
 * Pure, dependency-free and total (never throws): safe to run on every paste.
 */
export function findUnresolvableOpenvpnFileReferences(
  configBlob: string,
): OpenvpnUnsupportedLine[] {
  const lines = configBlob.split(/\r\n|\r|\n/);
  // First pass: which directives carry an inline `<directive>` block anywhere?
  // Inline WINS, so a directive with a block is never flagged below. CASE-SENSITIVE
  // (no toLowerCase): OpenVPN matches inline tags against its case-sensitive option
  // table, so `<CA>` is NOT the `ca` block — treating it as one would ACCEPT a config
  // the node still can't resolve (the miss A3's cross-language diff caught). Matches
  // the node parser (8a03a3929).
  const inlineBlocks = new Set<string>();
  for (const raw of lines) {
    const text = raw.trim();
    for (const dir of OPENVPN_INLINE_REQUIRED_DIRECTIVES) {
      // `</ca>` does not match `<ca>` (char after `<` is `/`), so a closing tag
      // is never mistaken for an opening one.
      if (text.startsWith(`<${dir}>`)) inlineBlocks.add(dir);
    }
  }
  // Second pass: a file-referencing directive with no inline block is unresolvable.
  const hits: OpenvpnUnsupportedLine[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const text = (lines[i] ?? '').trim();
    if (text === '' || text.startsWith('#') || text.startsWith(';')) continue;
    // Space and tab only — see the ⛔⛔ note above. NOT `/\s+/`.
    const tokens = text.split(/[ \t]+/);
    // CASE-SENSITIVE keyword, matching the node parser (8a03a3929) and OpenVPN's
    // own option table (streq against lowercase names — assumed from behaviour, not
    // read from options.c this session): `CA ca.crt` is an unrecognised option that
    // fails LOUD at openvpn startup, a DIFFERENT class from the SILENT file-not-found
    // this guard exists to catch, so we deliberately only guard the lowercase form.
    // `--` is still stripped (>=3 chars) so `--ca ca.crt` cannot bypass; a bare `--`
    // (len 2, not stripped) normalises to nothing and is inert.
    let keyword = tokens[0] ?? '';
    if (keyword.length >= 3 && keyword.startsWith('--')) keyword = keyword.slice(2);
    if (!OPENVPN_INLINE_REQUIRED_DIRECTIVES.has(keyword)) continue;
    if (tokens.length < 2) continue; // bare directive, no file argument — not a reference
    if (inlineBlocks.has(keyword)) continue; // inline block present → openvpn uses it
    hits.push({
      line: i + 1,
      directive: keyword,
      text,
      reason:
        `\`${keyword} ${tokens[1] ?? ''}\` points to a file the server cannot provide — ` +
        `a session renders only client.ovpn + auth.txt. Paste the inline ` +
        `<${keyword}>…</${keyword}> block (the "inline" or "unified" .ovpn your provider offers).`,
    });
  }
  return hits;
}
