// OpenVPN directives the API refuses inside a customer `config_blob`, and the
// line-level finder both ends of the wire use to name them.
//
// The set is the rejection list the control plane enforces at ingress
// (apps/server/src/lib/webhook-target-guard.ts): every directive here invokes
// an external program once `script-security` is >=2 — the class the P0
// root-RCE (118722821) exploited, when a customer blob carrying
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
  // ⛔⛔ V-217 (2026-09-14) — SIX directives that load or run external code and
  // were NOT in this set. Found by an adversarial sweep of `openvpn --help` and
  // `man 8 openvpn` for the SHIPPED 2.7.0 binary, not recalled. The first three
  // are the serious ones: they `dlopen` a shared object, whose constructor runs
  // on load, and that happens at ANY `--script-security` level — MEASURED at
  // level 0 and at the default 1, so the box forcing `--script-security 1` does
  // NOT neuter this class the way it neuters the script hooks above.
  //
  // `--providers l` — "A list l of OpenSSL providers to load."
  'providers',
  // `--pkcs11-providers provider ...` — "PKCS#11 provider to load."
  'pkcs11-providers',
  // `--engine [name]` — loads an OpenSSL engine, i.e. a shared object.
  'engine',
  // `--tls-crypt-v2-verify cmd` — "Run command cmd to verify the metadata of
  // the client-supplied tls-crypt-v2 client key". A script hook like the eleven
  // at the top; it was simply missed.
  'tls-crypt-v2-verify',
  // `--iproute cmd` — "Set alternate command to execute instead of default
  // iproute2 command". Linux-only, so it is absent from a macOS `--help` and
  // present on the egress node, which is the one that matters. Verified in the
  // shipped man page.
  'iproute',
  // `--config file` — "Read configuration options from file." A clean-looking
  // blob that references a second file is a screen bypass by construction: we
  // would validate the file we were given and openvpn would run the union. The
  // session renders only client.ovpn + auth.txt anyway, so no legitimate
  // customer config can resolve one. ⭐ Measured on the egress node against
  // the shipped 2.7.0: `config /etc/passwd` makes openvpn PARSE /etc/passwd as
  // configuration (it errors at /etc/passwd:11), so the directive reads an
  // arbitrary file on our host and interprets it. Not theoretical.
  'config',
  // PROCESS CONTROL — matched to the node's own screen (same day) so the two
  // halves refuse the same set. None of these execute a customer program, which
  // is why they are grouped apart from the six above, but none has any business
  // in a customer's tunnel config either: they change what the openvpn PROCESS
  // is, where it runs, and who can drive it. Refusing them at ingress costs a
  // legitimate config nothing.
  //
  // `--cd dir` changes the process working directory, which silently re-points
  // every relative path in the file; `--chroot dir` moves its filesystem root;
  // `--daemon` detaches it from the supervision that is supposed to reap it.
  'cd',
  'chroot',
  'daemon',
  // The `management` family opens a control channel into the running openvpn —
  // a socket that can be driven to change its behaviour, and on some builds to
  // supply credentials or hold/release the tunnel. A customer config that stands
  // one up is asking for a second driver of our process.
  'management',
  'management-client',
  'management-query-passwords',
  'management-query-proxy',
  'management-query-remote',
  'management-external-key',
  'management-external-cert',
  'management-client-auth',
  'management-client-user',
  'management-client-group',
  'management-hold',
  'management-signal',
  'management-forget-disconnect',
  'management-up-down',
  'management-log-cache',
]);

/** One line of an OpenVPN config the API will refuse. */
/**
 * Directives the egress host's OpenVPN does NOT recognise, so a config carrying
 * one is rejected at BRING-UP with `Options error: Unrecognized option or
 * missing or extra parameter(s)` — after it passed every check here, was stored,
 * and the customer pressed Launch. What they see is "the session didn't start".
 *
 * ⛔ MEASURED, NOT RECALLED, against the same OpenVPN the egress runs
 * (2.7.0, 2026-09-14): each candidate was written as a one-line config and fed
 * to `openvpn --config`, and only the ones that answered "Unrecognized option"
 * are here. That mattered — three directives handed to me as members of this
 * class (`ns-cert-type`, `max-routes`, `comp-noadapt`) are ACCEPTED by 2.7.0,
 * and refusing them would have broken configs that work. `comp-lzo` and
 * `cipher` only warn, so they are not here either.
 *
 * Two reasons a directive lands in this set, and the customer is told which:
 *   • REMOVED from OpenVPN itself — version-dependent, platform-independent.
 *   • WINDOWS-ONLY — the egress host is Linux and never builds them. Sourced
 *     from the shipped man page ("uses Windows Filtering Platform", "Ask
 *     Windows to release the TAP adapter lease", …), not from the platform this
 *     was measured on, so the claim does not rest on the measuring machine.
 *
 * ⚠️ This set is version-bound. Re-measure it when the egress OpenVPN moves: a
 * directive restored upstream would be refused here for a reason that stopped
 * being true, which is the failure mode with no symptom.
 */
export const OPENVPN_UNRECOGNISED_DIRECTIVES: ReadonlyMap<string, string> = new Map([
  // Removed from OpenVPN. Each measured as a hard `Options error` on 2.7.0.
  ['keysize', 'removed from OpenVPN — the cipher now fixes its own key size'],
  ['tls-remote', 'removed from OpenVPN — use verify-x509-name instead'],
  ['no-iv', 'removed from OpenVPN — the cipher modes it applied to are gone'],
  ['key-method', 'removed from OpenVPN — only the current key method remains'],
  ['ifconfig-pool-linear', 'removed from OpenVPN — use topology subnet instead'],
  ['ncp-disable', 'removed from OpenVPN — cipher negotiation can no longer be turned off'],
  ['inetd', 'removed from OpenVPN'],
  ['remote-ip-hint', 'removed from OpenVPN'],
  ['management-client-pf', 'removed from OpenVPN'],
  // Windows-only, per the shipped man page. The egress host is Linux.
  ['block-outside-dns', 'Windows-only — it uses the Windows Filtering Platform'],
  ['register-dns', 'Windows-only — it runs ipconfig'],
  ['ip-win32', 'Windows-only'],
  ['win-sys', 'Windows-only — it names the Windows system directory'],
  ['win-sys_path', 'Windows-only — it names the Windows system directory'],
  ['dhcp-release', 'Windows-only — it releases a Windows TAP adapter lease'],
]);

export interface OpenvpnUnsupportedLine {
  /** 1-based line number in the blob as pasted (LF, CRLF and bare CR each count one line). */
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
/**
 * OpenVPN's config lexer strips surrounding quotes from a token, so `"up"`,
 * `'up'` and `up` are one directive. Match that, or the refusal is a
 * one-character bypass. Applied repeatedly because `"--up"` nests the two forms.
 */
function stripEnclosingQuotes(token: string): string {
  let out = token;
  while (
    out.length >= 2 &&
    ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'")))
  ) {
    out = out.slice(1, -1);
  }
  return out;
}

/**
 * The inline blocks an OpenVPN config may carry. Everything between `<ca>` and
 * `</ca>` is PEM/key DATA, not directives — openvpn never reads a directive
 * there, and neither may we.
 *
 * ⛔ V-217: without this the finder flagged a `script-security`-looking line
 * sitting inside a `<ca>` block, and the rewriters then OVERWROTE those bytes,
 * corrupting the customer's certificate. A mangled `<ca>` is a tunnel that can
 * never come up, produced by the very code meant to make the config work.
 */
const OPENVPN_INLINE_BLOCK_TAGS: ReadonlySet<string> = new Set([
  'ca',
  'cert',
  'key',
  'dh',
  'extra-certs',
  'pkcs12',
  'crl-verify',
  'secret',
  'tls-auth',
  'tls-crypt',
  'tls-crypt-v2',
  'peer-fingerprint',
  // Credential blocks: openvpn reads exactly a username line and a password line
  // from these and never interprets either as a directive, so skipping them
  // hides nothing — and scanning them would refuse a customer whose PASSWORD
  // happens to begin with a directive word, with no way for them to fix it.
  'auth-user-pass',
  'http-proxy-user-pass',
  // ⛔ `<connection>` is deliberately ABSENT. Unlike the blocks above it holds
  // real directives (remote/proto/port/http-proxy), openvpn parses them, and so
  // must we — skipping it would turn it into a hiding place for exactly what
  // this finder exists to catch.
]);

export function findUnsupportedOpenvpnLines(configBlob: string): OpenvpnUnsupportedLine[] {
  const hits: OpenvpnUnsupportedLine[] = [];
  // ⛔ LINE ENDINGS: \r\n / \r / \n — the same three `findUnresolvableOpenvpnFileReferences`
  // splits on below. This was `/\r?\n/` (CR-BLIND) until 2026-09-12, which made the
  // SECURITY guard read a classic-Mac-ended .ovpn as ONE line whose first token is
  // `client`: zero hits, every time. Measured against the running code, a stored blob of
  // `client\rdev tun\r…\rscript-security 2\rup /etc/openvpn/update-resolv-conf\r`
  // passed `OpenVpnProxyConfigSchema` (JavaScript's `m` flag counts a bare \r as a line
  // terminator, so the `client`/`remote` refines DID see the lines), passed this finder
  // with 0 hits, stored, and `stripUnsupportedOpenvpnLines` healed nothing — so
  // `script-security 2` and the `up` line crossed the wire intact. One blob validated as
  // MULTI-LINE for shape and SINGLE-LINE for security is exactly what the file-reference
  // finder's own note calls "worse than no check: it reads clean".
  //
  // What kept that from being an RCE was openvpn itself, not this guard: 2.7.0 answers a
  // CR-only file `Options error: Unrecognized option … :1: client` while the LF and CRLF
  // twins both honour the `up` line (measured). That is a HOST behaviour, and this
  // module's premise (see the header) is that the CP refuses independently of it. What
  // the customer got instead was the owner's 2026-09-12 report: a session that never
  // starts, with nothing on the control-plane side to read.
  const lines = configBlob.split(/\r\n|\r|\n/);
  // V-217 — the inline-block cursor. Non-null while we are inside a PEM/credential
  // block, holding the tag we are waiting to close. See OPENVPN_INLINE_BLOCK_TAGS.
  let openBlock: string | null = null;
  let openBlockLine = 0;
  let openBlockText = '';
  for (let i = 0; i < lines.length; i += 1) {
    const text = (lines[i] ?? '').trim();
    if (openBlock !== null) {
      if (text.toLowerCase() === `</${openBlock}>`) openBlock = null;
      // Everything else inside the block is certificate/key/credential DATA.
      // Never matched, never reported, so never rewritten.
      continue;
    }
    if (text === '' || text.startsWith('#') || text.startsWith(';')) continue;
    const blockOpen = /^<([a-z0-9-]+)>$/i.exec(text);
    if (blockOpen !== null && OPENVPN_INLINE_BLOCK_TAGS.has(blockOpen[1]?.toLowerCase() ?? '')) {
      openBlock = blockOpen[1]?.toLowerCase() ?? null;
      openBlockLine = i + 1;
      openBlockText = text;
      continue;
    }
    const tokens = text.split(/\s+/);
    // OpenVPN's own config parser strips a leading `--` from every directive
    // (bypass_doubledash in options.c, applied to config-file lines when the token
    // is >= 3 chars), so `--plugin`/`--script-security`/`--up` are honored exactly
    // like their bare forms. Match the same normalization or the refusal is a
    // one-character bypass (a `--plugin` line loads a native module as root on the
    // shared egress host — the P0 root-RCE class this guard exists to stop).
    let keyword = (tokens[0] ?? '').toLowerCase();
    // ⛔⛔ V-217 (2026-09-14) — QUOTES, the exact same one-character bypass as the
    // `--` case below, and it was open. OpenVPN's config lexer strips surrounding
    // single or double quotes from every token, so `"up" /x.sh` IS `--up /x.sh`.
    // This finder matched the raw token, so the keyword read as `"up"`, missed the
    // set, and the line passed with ZERO hits. MEASURED against the shipped 2.7.0:
    // `"up" /missing.sh` and `up /missing.sh` produce byte-identical
    // `Options error: --up script fails with '/missing.sh'`, which is openvpn
    // telling us it resolved the quoted token to the directive.
    //
    // It also defeated the script-security lowering in the same stroke: a quoted
    // `"script-security" 2` was not reported, so nothing lowered it, and the
    // raised level survived next to a live hook.
    //
    // Strip BEFORE the `--` test, because `"--up"` is legal too.
    keyword = stripEnclosingQuotes(keyword);
    if (keyword.length >= 3 && keyword.startsWith('--')) keyword = keyword.slice(2);
    keyword = stripEnclosingQuotes(keyword);
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
    // ⛔ NOT A SECURITY REFUSAL — a directive the egress OpenVPN cannot parse.
    // Everything above this line refuses a config for what it would DO; this
    // refuses one for what it cannot do at all. Before it existed, such a config
    // passed every check, was stored, and failed at Launch with `Options error`
    // that reached the customer as "the session didn't start" — the owner's own
    // report, root-caused on the egress node 2026-09-14. Refusing it at entry is
    // the difference between a fixable message and a mystery.
    const unrecognised = OPENVPN_UNRECOGNISED_DIRECTIVES.get(keyword);
    if (unrecognised !== undefined) {
      hits.push({
        line: i + 1,
        directive: keyword,
        text,
        reason: `\`${keyword}\` is ${unrecognised}, so OpenVPN refuses the whole config when the session starts`,
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
  // V-217 — an inline block that never closes. OpenVPN refuses the whole config
  // for this ("ERROR: Endtag </ca> missing", measured against 2.7.0), so it is
  // not a way to smuggle a live directive past the skip above — nothing in such
  // a file ever runs. It is reported for the other reason this module reports
  // unparseable directives: without it the customer's only signal is a session
  // that will not start, with nothing on the control-plane side to read.
  if (openBlock !== null) {
    hits.push({
      line: openBlockLine,
      directive: openBlock,
      text: openBlockText,
      reason: `\`<${openBlock}>\` is never closed with \`</${openBlock}>\`, so OpenVPN refuses the whole config when the session starts`,
    });
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
/*
 * Lower `script-security 2|3` to 1, and touch NOTHING else.
 *
 * ⛔ This exists because the control plane REFUSED a config for a directive that
 * cannot, by itself, run anything — and that refusal was the owner's "can't open
 * OpenVPN profiles". Measured 2026-09-14: every profile their provider
 * issues carries `script-security 2` at line 46, so every upload was a 400 and
 * the workaround was hand-editing each download. Removing the line by hand and
 * re-posting through the real API produced a working session in about a second
 * through their own endpoint.
 *
 * Why accepting it is safe, and why this is NOT the wholesale strip:
 *   • `script-security` PERMITS scripts; it executes nothing on its own.
 *   • Every directive that DOES execute something — up, down, route-up,
 *     tls-verify, plugin and the rest of DANGEROUS_OPENVPN_DIRECTIVES — stays
 *     refused, loudly, naming its line. So there is nothing left for a raised
 *     level to permit.
 *   • The harness strips the directive again before writing the config, and
 *     forces `--script-security 1` on the openvpn process itself.
 * Three independent reasons a script cannot run; the refusal was the only thing
 * the customer could see, and it protected nothing.
 *
 * ⛔⛔ READ THIS BEFORE TRUSTING THE SECOND BULLET. When this function was first
 * written that bullet was FALSE, and an adversarial review measured it false the
 * same day: the refusal set was missing six code-loading directives, and a
 * one-character quoting trick (`"up" /x.sh`) walked past the whole finder. Both
 * are fixed above, and BOTH WERE ALREADY REACHABLE WITHOUT THIS FUNCTION — the
 * wholesale `script-security 2` refusal had been masking them by rejecting
 * provider configs outright. The lesson is not about this function: it is that
 * the second bullet is a claim about a DENYLIST over a program with hundreds of
 * options, and a denylist is the weak half of this design. Anything that widens
 * what we accept must re-measure that bullet against the shipped binary rather
 * than cite this comment. The structural fix — an allowlist of known-safe
 * directives — is written up as a follow-up, not done here.
 *
 * ⚠️ Do NOT widen this to the script directives. Silently deleting a line that
 * would have run the customer's program changes what their config DOES without
 * telling them; refusing it and naming the line is the honest answer there.
 */
/**
 * Lowers a `script-security 2` or `3` line to `1` and changes nothing else.
 *
 * Many providers ship profiles with `script-security 2`, which only PERMITS
 * scripts — it runs nothing by itself. Every directive that does run
 * something stays refused by name, so lowering this one line makes such a
 * profile usable without making it do anything new.
 *
 * Run it on a config the API refused for this reason and offer the customer
 * the result. It never removes a script directive: a line that would have
 * run their program is refused and named, not deleted behind their back.
 */
export function lowerOpenvpnScriptSecurity(configBlob: string): {
  config: string;
  lowered: boolean;
} {
  const hits = findUnsupportedOpenvpnLines(configBlob).filter(
    (h) => h.directive === 'script-security',
  );
  if (hits.length === 0) return { config: configBlob, lowered: false };
  const byLine = new Map(hits.map((h) => [h.line, h] as const));
  // Same capture-the-separator walk the stripper uses, for the same reason: the
  // finder's line numbers and this rewrite must agree exactly, or it edits a
  // line the finder never reported.
  const parts = configBlob.split(/(\r\n|\r|\n)/);
  let config = '';
  let lineNo = 0;
  for (let i = 0; i < parts.length; i += 2) {
    lineNo += 1;
    const text = parts[i] ?? '';
    const ending = parts[i + 1] ?? '';
    if (!byLine.has(lineNo)) {
      config += `${text}${ending}`;
      continue;
    }
    const indent = /^\s*/.exec(text)?.[0] ?? '';
    config += `${indent}script-security 1${ending}`;
  }
  return { config, lowered: true };
}

export function stripUnsupportedOpenvpnLines(configBlob: string): {
  config: string;
  removed: OpenvpnUnsupportedLine[];
} {
  const removed = findUnsupportedOpenvpnLines(configBlob);
  if (removed.length === 0) return { config: configBlob, removed };
  const byLine = new Map(removed.map((hit) => [hit.line, hit] as const));
  // Split with the separator CAPTURED so each line keeps the ending it came
  // with; even indices are lines, odd indices the `\r\n` / `\r` / `\n` after
  // them. The alternation is ORDERED so a `\r\n` is consumed whole instead of
  // as two endings. Numbering matches the finder's split above exactly, and the
  // two MUST move together: a stripper numbering lines differently from the
  // finder rewrites a line the finder never reported.
  const parts = configBlob.split(/(\r\n|\r|\n)/);
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
    } else if (OPENVPN_INLINE_BLOCK_TAGS.has(hit.directive)) {
      // ⛔ V-217 — the UNTERMINATED-BLOCK hit is a refusal this stripper must NOT
      // "fix". Deleting the `<ca>` line that opened the block would leave the PEM
      // body as bare config lines and hand the customer a config missing its CA:
      // a worse file than the one they pasted, produced by the repair path. The
      // finder reports it so the refusal message can name it; nothing auto-fixes
      // it, because the only real fix is the closing tag the customer must add.
      config += text + ending;
    }
    // Any other hit: the line and its ending are dropped.
  }
  return { config, removed };
}

/**
 * The OpenVPN cert and key directives whose material must be INLINE — inside
 * an `<directive>…</directive>` block — because a session runs your config on
 * its own, with no access to files from the machine you uploaded from. A bare
 * `ca ca.crt` names a path that will not exist there.
 *
 * Matched on the first whitespace-separated token, case-insensitively.
 */
export const OPENVPN_INLINE_REQUIRED_DIRECTIVES: ReadonlySet<string> = new Set([
  'ca',
  'cert',
  'key',
  'tls-auth',
  'tls-crypt',
]);

/*
 * Lines that reference an EXTERNAL cert/key file the server cannot provide — a
 * `ca`/`cert`/`key`/`tls-auth`/`tls-crypt` directive with a file argument and NO
 * corresponding inline `<directive>` block anywhere in the blob. Such a config
 * stores and dispatches fine, then dies late inside openvpn with a generic
 * "Options error" that names neither the field nor the cause; caught here it
 * fails at upload naming the directive, so the customer knows to paste the
 * inline / "unified" .ovpn their provider offers.
 *
 * ⭐ CROSS-SOURCE PIN with the node-side reject (harness `8a03a3929`,
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
 * ⚠️ `findUnsupportedOpenvpnLines` above still splits TOKENS on `/\s+/` ON PURPOSE: it
 * is the SECURITY guard (script-executing directives), it has no cross-source
 * contract declaring its tokenizer, and for it over-refusal is the safe
 * direction. Do not "make them consistent".
 *
 * ⛔ That licence is about the TOKEN separator and NOTHING else. Both functions split
 * LINES on the same three endings (`\r\n|\r|\n`) and must keep doing so. The security
 * finder was CR-blind until 2026-09-12 — the UNSAFE direction, and invisible, because a
 * CR-only blob simply reported nothing. Changing either line split alone re-opens it.
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
/**
 * Finds the lines of an OpenVPN config that point at a certificate or key
 * FILE which will not exist when the session runs — a `ca`, `cert`, `key`,
 * `tls-auth` or `tls-crypt` directive with a filename argument and no
 * matching inline `<directive>` block anywhere in the file.
 *
 * Such a config saves and starts and then fails late with an "Options error"
 * that names neither the field nor the cause. Checking it up front lets you
 * tell the customer which line to fix: most providers offer an inline, or
 * "unified", `.ovpn` that has the material embedded.
 *
 * An inline block always wins, even when a stray `ca ca.crt` line is also
 * present. Comment lines and bare directives with no argument are ignored,
 * and Windows line endings are handled.
 *
 * Pure, dependency-free and total — it never throws, so it is safe to run on
 * every paste.
 */
export function findUnresolvableOpenvpnFileReferences(
  configBlob: string,
): OpenvpnUnsupportedLine[] {
  const lines = configBlob.split(/\r\n|\r|\n/);
  // First pass: which directives carry an inline `<directive>` block anywhere?
  // Inline WINS, so a directive with a block is never flagged below. CASE-SENSITIVE
  // (no toLowerCase): OpenVPN matches inline tags against its case-sensitive option
  // table, so `<CA>` is NOT the `ca` block — treating it as one would ACCEPT a config
  // the node still can't resolve (the miss the harness's cross-language diff caught). Matches
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
    // verified against options.c): `CA ca.crt` is an unrecognised option that
    // fails LOUD at openvpn startup, a DIFFERENT class from the SILENT file-not-found
    // this guard exists to catch, so we deliberately only guard the lowercase form.
    // `--` is still stripped (>=3 chars) so `--ca ca.crt` cannot bypass; a bare `--`
    // (len 2, not stripped) normalises to nothing and is inert.
    let keyword = tokens[0] ?? '';
    // V-217 — quotes, same as the security finder above. OpenVPN's lexer strips
    // them, so `"ca" ca.crt` is `--ca ca.crt`. This finder is not a security
    // boundary (it catches a config that CANNOT launch, not one that would run
    // something), but the two must read a line the same way or the pair disagrees
    // about what a directive is — and that disagreement is how the quoted-`up`
    // bypass survived in the first place.
    keyword = stripEnclosingQuotes(keyword);
    if (keyword.length >= 3 && keyword.startsWith('--')) keyword = keyword.slice(2);
    keyword = stripEnclosingQuotes(keyword);
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

/**
 * The directives that declare which END of the tunnel a config is. `client` is
 * the one the control plane requires (`OpenVpnProxyConfigSchema` in egress.ts:
 * "This OpenVPN file must be a client configuration: it needs a `client` line.")
 * and `tls-client` is its long half — `client` is shorthand for `tls-client`
 * plus `pull`.
 *
 * A config carrying EITHER already says it is a client, so this module leaves it
 * alone. That is deliberate and it has a known cost: a `tls-client`-only config
 * is still refused by the server, because the server matches the literal `client`
 * line. Adding `client` on top of `tls-client` would also add `pull`, which
 * changes what the tunnel does with the routes and DNS the peer pushes — a
 * behaviour change this helper has no business making silently.
 */
const OPENVPN_CLIENT_ROLE_DIRECTIVES: ReadonlySet<string> = new Set(['client', 'tls-client']);

/**
 * Directives that mark a config as the SERVER end. `server <net> <mask>` is the
 * shorthand that expands to `mode server` + `tls-server` + a pool; `tls-server`
 * is the bare role; `mode server` is what a hand-written server config says.
 *
 * Any of them means the file is not a client config that forgot to say so, and
 * adding `client` to it would produce a config that contradicts itself. The
 * helper refuses rather than guesses — a wrong rewrite of a customer's file is
 * worse than the refusal they already have, which at least names its reason.
 */
const OPENVPN_SERVER_ROLE_DIRECTIVES: ReadonlySet<string> = new Set(['tls-server', 'server']);

/**
 * The STATIC-KEY marker — the THIRD mutually exclusive OpenVPN mode, and the one
 * this helper used not to know about.
 *
 * `--secret` is point-to-point shared-key mode: no TLS, no roles, both ends hold
 * the same key. OpenVPN refuses to start when it is combined with `--tls-client`
 * ("specify only one of --tls-server, --tls-client, or --secret"), and `client`
 * IS `tls-client` + `pull`. So a legacy static-key profile — no role line, a real
 * `remote`, an inline `<secret>` block — is NOT a client config that forgot to say
 * so, even though it looks exactly like one to a check that only knows the server
 * role words.
 *
 * ⛔ Nothing downstream catches this. `OpenVpnProxyConfigSchema` checks only that
 * `client` and `remote` are present, so the repaired blob is stored, the editor
 * flips to its ✓ endpoint line, Save is enabled — and the failure moves to session
 * launch, where nothing names it. That is the "a wrong rewrite of a customer's
 * file is worse than the refusal they already have" case, so a static key stops
 * the offer the same way a server role does.
 *
 * Both spellings count: a bare `secret static.key` directive, and the inline
 * `<secret>`…`</secret>` block. The tag is in OPENVPN_INLINE_BLOCK_TAGS, so the
 * flag must be set on the block-OPEN line — the body after it is key DATA that
 * the scan skips without reading.
 */
const OPENVPN_STATIC_KEY_DIRECTIVES: ReadonlySet<string> = new Set(['secret']);

/** A config's role/endpoint facts, read in ONE pass over the pasted bytes. */
interface OpenvpnRoleScan {
  /** A `client` or `tls-client` line, in any spelling openvpn's lexer accepts. */
  declaresClient: boolean;
  /** A `tls-server` / `server` / `mode server` line — this is the other end. */
  declaresServer: boolean;
  /** A `secret` directive or a `<secret>` block — static-key mode, not a TLS client. */
  declaresStaticKey: boolean;
  /** A bare lowercase `remote <arg>` line, i.e. one the SERVER's own regex sees. */
  hasRemote: boolean;
  /** 1-based line of the first real directive; 0 when the file has none. */
  firstDirectiveLine: number;
}

/**
 * Strip a trailing `# …` / `; …` comment. OpenVPN's parser breaks a line at an
 * unquoted `#` or `;`, and the server's own `client` regex tolerates one
 * (`^[ \t]*client[ \t]*(?:[#;].*)?$`), so `client  # provider note` is a
 * `client` line and must read as one here too.
 *
 * ⚠️ NOT applied by `findUnsupportedOpenvpnLines` above, which only skips lines
 * that START with a comment marker. That asymmetry is on purpose: over-reading a
 * line is the safe direction for a SECURITY finder and the unsafe direction
 * here, where reading a line as absent causes a rewrite.
 */
function stripOpenvpnInlineComment(line: string): string {
  const at = line.search(/[#;]/);
  return (at === -1 ? line : line.slice(0, at)).trim();
}

function scanOpenvpnRole(configBlob: string): OpenvpnRoleScan {
  const lines = configBlob.split(/\r\n|\r|\n/);
  const scan: OpenvpnRoleScan = {
    declaresClient: false,
    declaresServer: false,
    declaresStaticKey: false,
    hasRemote: false,
    firstDirectiveLine: 0,
  };
  let openBlock: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = (lines[i] ?? '').trim();
    if (openBlock !== null) {
      // Inside `<ca>`…`</ca>` and friends every byte is certificate/key/credential
      // DATA. Reading a directive there would be as wrong as the rewrite it feeds.
      if (raw.toLowerCase() === `</${openBlock}>`) openBlock = null;
      continue;
    }
    if (raw === '' || raw.startsWith('#') || raw.startsWith(';')) continue;
    const blockOpen = /^<([a-z0-9-]+)>$/i.exec(raw);
    if (blockOpen !== null && OPENVPN_INLINE_BLOCK_TAGS.has(blockOpen[1]?.toLowerCase() ?? '')) {
      const tag = blockOpen[1]?.toLowerCase() ?? null;
      // The OPEN line is the last chance to read this block: everything below it,
      // up to the closing tag, is key/certificate DATA the loop above skips. An
      // inline `<secret>` block is how a static-key profile carries its key, and
      // it is the mode marker — see OPENVPN_STATIC_KEY_DIRECTIVES.
      if (tag !== null && OPENVPN_STATIC_KEY_DIRECTIVES.has(tag)) scan.declaresStaticKey = true;
      openBlock = tag;
      if (scan.firstDirectiveLine === 0) scan.firstDirectiveLine = i + 1;
      continue;
    }
    if (scan.firstDirectiveLine === 0) scan.firstDirectiveLine = i + 1;
    const text = stripOpenvpnInlineComment(raw);
    if (text === '') continue;
    const tokens = text.split(/\s+/);
    // ROLE keywords are read the way the finders above read a directive — quotes
    // stripped, a leading `--` stripped, lower-cased — so `"client"`, `--client`
    // and `CLIENT` all count as "already declares a role" and this helper leaves
    // the file alone. Over-detecting here only ever means NOT rewriting, which is
    // the safe direction for a function that edits a customer's config.
    let keyword = stripEnclosingQuotes(tokens[0] ?? '');
    if (keyword.length >= 3 && keyword.startsWith('--')) keyword = keyword.slice(2);
    keyword = stripEnclosingQuotes(keyword).toLowerCase();
    if (OPENVPN_CLIENT_ROLE_DIRECTIVES.has(keyword)) scan.declaresClient = true;
    if (OPENVPN_SERVER_ROLE_DIRECTIVES.has(keyword)) scan.declaresServer = true;
    if (OPENVPN_STATIC_KEY_DIRECTIVES.has(keyword)) scan.declaresStaticKey = true;
    if (keyword === 'mode' && (tokens[1] ?? '').toLowerCase() === 'server') {
      scan.declaresServer = true;
    }
    // `remote` is read STRICTLY — the raw lowercase token with an argument, which
    // is exactly what the control plane's own `/^[ \t]*remote\s+\S+/m` accepts.
    // The point is not to detect the customer's intent loosely: it is that adding
    // `client` must leave a config the server ACCEPTS. A `--remote` spelling is
    // refused by that regex, so "fixing" it would hand back a config that is
    // refused for a different reason, which reads as the fix not working.
    if (tokens[0] === 'remote' && tokens[1] !== undefined) scan.hasRemote = true;
  }
  return scan;
}

/** The `client` line this module can add for the customer, and where it goes. */
export interface OpenvpnClientDirectiveFix {
  /** 1-based line the `client` directive is inserted BEFORE (the first directive). */
  line: number;
  /** The blob with a `client` line at the top of the directive section. */
  config: string;
}

/*
 * A config that never says it is a client, plus the same config with the missing
 * `client` line added — or null when adding one would be a guess.
 *
 * ⛔ WHY THIS IS SAFE, AND ONLY HERE. `client` is documented shorthand for
 * `tls-client` + `pull`. On a config that already carries a `remote` line and
 * declares no server role, both halves are what the file already means: it dials
 * out to a peer, so it is the TLS client, and pulling the peer's pushed routes is
 * what every provider profile does. Nothing else about the file changes. It is
 * the same one-line edit a customer makes by hand, and it is what OpenVPN 2.7
 * requires — it refuses such a profile itself, so this is not a Driftstack-only
 * rule being papered over.
 *
 * Returns null — offer nothing, leave the bytes alone — when:
 *   • the config already declares `client` or `tls-client` (see the set above);
 *   • it declares `tls-server`, `server` or `mode server` — that is the other end
 *     of a tunnel, not a client profile missing a line;
 *   • it carries a static key (`secret <file>`, or an inline `<secret>` block) —
 *     that is the third OpenVPN mode, and OpenVPN refuses `--secret` together with
 *     the `--tls-client` half of `client`, so the rewrite would produce a config
 *     that stores fine and then cannot launch;
 *   • it has no bare `remote <host>` line, so there is no evidence it dials out
 *     and the control plane would refuse it for the missing `remote` anyway;
 *   • it has no directive section at all (empty, or nothing but comments).
 *
 * Comment lines, inline comments and `<ca>`/`<cert>`/`<key>`/`<tls-auth>` blocks
 * are not directives and are never read as one.
 *
 * Pure, dependency-free and total (never throws): safe to run on every paste.
 */
/**
 * Adds the missing `client` line to an OpenVPN config that dials out but
 * never says which end of the tunnel it is, and returns the corrected text —
 * or null when adding the line would be a guess.
 *
 * `client` is shorthand for `tls-client` plus `pull`, both of which such a
 * file already means, so this is the same one-line edit a customer makes by
 * hand. OpenVPN 2.7 refuses a profile without it, so the fix is not specific
 * to this API.
 *
 * Returns null — offer nothing, change nothing — when the config already
 * says `client` or `tls-client`, when it is the server end, when it uses a
 * static key, when it has no `remote` line to dial, or when it has no
 * directives at all.
 *
 * Pure, dependency-free and total — it never throws, so it is safe to run on
 * every paste.
 */
export function addMissingOpenvpnClientDirective(
  configBlob: string,
): OpenvpnClientDirectiveFix | null {
  const scan = scanOpenvpnRole(configBlob);
  if (scan.declaresClient || scan.declaresServer || scan.declaresStaticKey) return null;
  if (!scan.hasRemote || scan.firstDirectiveLine === 0) return null;
  // Same capture-the-separator walk the strippers use, so the customer's own line
  // endings and indentation survive and the result diffs cleanly against the paste.
  const parts = configBlob.split(/(\r\n|\r|\n)/);
  // A file whose last line has no terminator still needs one after the inserted
  // directive, or `client` and the line below it fuse into one unreadable token.
  const fileEnding = /\r\n|\r|\n/.exec(configBlob)?.[0] ?? '\n';
  let config = '';
  let lineNo = 0;
  for (let i = 0; i < parts.length; i += 2) {
    lineNo += 1;
    const text = parts[i] ?? '';
    const ending = parts[i + 1] ?? '';
    if (lineNo === scan.firstDirectiveLine) {
      config += `client${ending === '' ? fileEnding : ending}`;
    }
    config += `${text}${ending}`;
  }
  return { line: scan.firstDirectiveLine, config };
}
