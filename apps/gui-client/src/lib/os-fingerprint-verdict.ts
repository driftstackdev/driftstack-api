// N-2 — the colour rule for a proxy's passive OS fingerprint.
//
// The control plane fingerprints the proxy's OWN TCP stack from the SYN it
// sends (TTL, window, MSS, option order — see apps/server/src/lib/
// tcp-os-fingerprint.ts). Every Driftstack device is an Apple device, so the
// claim the proxy has to match is Darwin: a proxy whose stack looks like
// iOS/macOS is coherent with the phone it fronts, and one that looks like
// Windows or Linux is the mismatch this exists to make visible — "if its
// mismatched, it should be red, and if MAC/IOS then green".
//
// ⛔ `unknown` and "never measured" are neither. Not measured must never render
// green: an operator who cannot tell a blank from a pass reads every blank as
// a pass. The chip carries a third, neutral tone for both.

/**
 * How long a measured stack reading stays current, in ms.
 *
 * ⛔ RE-EXPORTED HERE, from the import-free proxy-reading-windows, because TWO
 * surfaces age the same reading and they must age it by the same number: the
 * proxy grid's cached reading (proxy-probe-cache drops it past this) and the
 * cockpit's session readout (OsReadout labels it past this). A second literal in
 * the component would drift from this one silently, and the two surfaces would
 * then disagree about the same proxy on the same screen. The windows module has
 * no imports of its own, so this file still drags nothing in.
 *
 * ⛔ IT WAS THIRTY MINUTES, matching QUIC_VERDICT_TTL_MS, and that was the defect
 * the owner reported as "i see apple but not being green at proxies". Nothing
 * re-takes this reading more often than every six hours, so the window closed
 * five and a half hours before the next measurement could reopen it and a proxy
 * whose stack really is Darwin spent ~92% of its life muted. It is now derived:
 * W = the capability cadence + one sweep slot + margin. The reasoning that
 * justified expiring it AT ALL is untouched and still right — a residential exit
 * rotates to another machine entirely, and the reading is about the machine, not
 * the row — so the reading still leaves the present tense, just not before
 * anything could have re-taken it.
 */
export { MEASURED_READING_TTL_MS as OS_FINGERPRINT_TTL_MS } from './proxy-reading-windows';
import { OS_WORD } from './reading-badge-words';

export const FINGERPRINTED_OS = ['macos-or-ios', 'windows', 'linux', 'bsd', 'unknown'] as const;
export type FingerprintedOs = (typeof FINGERPRINTED_OS)[number];
export const FINGERPRINT_CONFIDENCE = ['high', 'medium', 'low', 'none'] as const;
export type FingerprintConfidence = (typeof FINGERPRINT_CONFIDENCE)[number];

export function isFingerprintedOs(v: unknown): v is FingerprintedOs {
  return typeof v === 'string' && (FINGERPRINTED_OS as readonly string[]).includes(v);
}
export function isFingerprintConfidence(v: unknown): v is FingerprintConfidence {
  return typeof v === 'string' && (FINGERPRINT_CONFIDENCE as readonly string[]).includes(v);
}

/**
 * (o) O3 — WHY a /test result carried no fingerprint. Mirrors the control plane's
 * `os_fingerprint_unavailable` byte for byte (packages/api-types/src/profiles.ts):
 *
 *   vpn_tunnel    an openvpn/wireguard row has no SOCKS5 stack to dial through,
 *                 so there is no SYN to read. NO retry can produce one.
 *   not_observed  the observer tunnel was refused / no SYN was recorded. A retry
 *                 can genuinely help, so this is the ONE cause that still says
 *                 "run Test".
 *   observer_off  this deployment runs no raw-socket observer. No retry helps.
 *
 * A CLOSED set: a value outside it (a newer server) must fall back to today's
 * neutral wording rather than render a cause the chip cannot state truthfully.
 */
export const OS_FINGERPRINT_UNAVAILABLE = ['vpn_tunnel', 'not_observed', 'observer_off'] as const;
export type OsFingerprintUnavailable = (typeof OS_FINGERPRINT_UNAVAILABLE)[number];
export function isOsFingerprintUnavailable(v: unknown): v is OsFingerprintUnavailable {
  return typeof v === 'string' && (OS_FINGERPRINT_UNAVAILABLE as readonly string[]).includes(v);
}

/**
 * Owner item 9 (2026-09-24) — the cause as the server PUBLISHES it since
 * 2026-09-21 (services/customer-safe-proxy-test-vocabulary.ts renames every
 * /test reply's cause into customer words), mapped back to the cause this chip
 * states. `isOsFingerprintUnavailable` alone admitted only the internal words,
 * so every published cause was DROPPED and the chip fell back to "OS not
 * measured yet. Run Test" — on a row a Test had just measured. The internal
 * words an older server sends still map to themselves; anything else is
 * undefined (today's neutral wording, never a cause this build cannot state).
 */
const PUBLISHED_OS_FINGERPRINT_UNAVAILABLE: Readonly<Record<string, OsFingerprintUnavailable>> = {
  not_available_for_vpn: 'vpn_tunnel',
  not_captured: 'not_observed',
  not_offered_here: 'observer_off',
};
export function cleanOsFingerprintUnavailable(v: unknown): OsFingerprintUnavailable | undefined {
  if (isOsFingerprintUnavailable(v)) return v;
  if (typeof v !== 'string') return undefined;
  return Object.prototype.hasOwnProperty.call(PUBLISHED_OS_FINGERPRINT_UNAVAILABLE, v)
    ? PUBLISHED_OS_FINGERPRINT_UNAVAILABLE[v]
    : undefined;
}

export interface OsFingerprint {
  os: FingerprintedOs;
  confidence: FingerprintConfidence;
  /** The classifier's one-line reason — shown in the tooltip so a red cell explains itself. */
  reason: string;
  /** (o) O3 — set ONLY on the placeholder minted by `unavailableOsFingerprint` for a
   *  result that carried no fingerprint and a machine-readable cause. `os`/`confidence`
   *  are then the honest fillers 'unknown'/'none', and THIS field is what the verdict
   *  branches on first — so the chip says why there is no value instead of "we looked
   *  and could not tell". Never set on a record the control plane actually measured,
   *  which is why it is the discriminator rather than `os === 'unknown'`. */
  unavailable?: OsFingerprintUnavailable;
  /** WHICH MACHINE'S stack this describes — `exit_ip` is the address the website
   *  will see, `proxy_host` is only the front door we dialled. The control plane
   *  has always sent it (`observed_via` on the wire); the client dropped it, and
   *  that omission is what let a reading of a provider's gateway be painted as a
   *  verdict about the exit. Absent on a placeholder or a legacy cached record. */
  observedVia?: 'proxy_host' | 'exit_ip';
  /**
   * (V-219) Whether this reading describes the path a WEBSITE gets: the host we
   * dialled, the host that emitted the SYN and the address the destination sees
   * are one machine, so nothing in between can route a site's port differently
   * from our observer's.
   *
   * ⛔ Absent means FALSE, and that is load-bearing. A legacy cached record, a
   * placeholder, an older server, or a tampered response all read `undefined` —
   * and every one of them must fail to assert rather than default into a
   * confident claim. Only an explicit `true` from a server that computed it
   * unlocks the match/mismatch arms.
   */
  singleHostVantage?: boolean;
  /**
   * (V-219) The control plane took this reading on port 443 at an IP literal —
   * the port a website connects on, with no CDN in front. Absent means FALSE,
   * for exactly the reasons `singleHostVantage` gives.
   */
  webPortVantage?: boolean;
  /**
   * (p) 2026-09-16 — WHEN the control plane took this reading (epoch ms), when
   * the holder knows. The probe cache has always carried it (`CachedOsFingerprint`
   * narrows it to required) and the chip never showed it, so a reading of any age
   * was rendered in bare present tense — and since the reading can now arrive from
   * the SERVER's stored copy, taken on another machine, "how old is this" stopped
   * being answerable from the screen at all.
   *
   * Optional because a record parsed straight off the wire has no date of its own:
   * a /test reply's reading was measured by that reply, and a cause or the
   * `measuring` sentinel is not a measurement. Absent simply means the hint says
   * nothing about age — never that the reading is current.
   */
  at?: number;
  /** (o) O4 — set ONLY on `OS_FINGERPRINT_MEASURING`, the sentinel a view passes while
   *  a test THIS client started is in flight. "Measuring" is a claim about work in
   *  progress: it may be rendered from a running probe and from nothing else, never
   *  from mere absence. Never parsed off the wire and never persisted. */
  measuring?: true;
}

export type OsVerdictTone = 'match' | 'mismatch' | 'unknown';

export interface OsVerdict {
  /** Set ONLY by `agedOsFingerprintVerdict`: this describes a reading that is no
   *  longer current. The tone beside it is then always the neutral one. */
  aged?: true;
  tone: OsVerdictTone;
  /** One glyph before the label: ✓ match, ✗ mismatch, — not measured, ? measured but
   *  undetermined, … a probe this client started is running right now (o) O4. */
  glyph: '✓' | '✗' | '—' | '?' | '…';
  /** Short chip text. */
  label: string;
  /** Tooltip. */
  hint: string;
}

/** The badge's word for each OS family — the ONE vocabulary's (lib/reading-
 *  badge-words): "Apple" for macOS-or-iOS on every surface. It was "iOS/macOS"
 *  here and "Apple" on the compact card, one reading in two words (gui-v0.1.72,
 *  owner item 9). */
const OS_LABEL: Record<Exclude<FingerprintedOs, 'unknown'>, string> = OS_WORD;
/** The same family in a SENTENCE (a hover): the badge's word, and for Apple the
 *  two systems it stands for — the reading cannot tell macOS from iOS. */
const OS_NAME: Record<Exclude<FingerprintedOs, 'unknown'>, string> = {
  ...OS_WORD,
  'macos-or-ios': `${OS_WORD['macos-or-ios']} (iOS or macOS)`,
};

/**
 * How sure the reading is, as a CLAUSE after the OS name: ", with high
 * confidence".
 *
 * ⛔ Never a second bracket (gui-v0.1.73 review). It was "(high confidence)"
 * straight after the name, and the Apple name carries its own "(iOS or macOS)",
 * so the card's details sheet — which prints these hints as visible text —
 * read "Your proxy presents as Apple (iOS or macOS) (high confidence) — …".
 * A reading that carries no confidence at all says so in words.
 */
function withConfidence(confidence: FingerprintConfidence): string {
  return `, with ${confidence === 'none' ? 'no' : confidence} confidence`;
}

/**
 * (o) O3 — the TRUE sentence for each reported cause. Each one names the cause and
 * offers advice that can actually produce a value; where none can, it says so instead
 * of inventing an action. ⛔ "Run Test" appears in exactly ONE member — `not_observed`,
 * the only cause a retry can clear. Pressing Test on a VPN tunnel, or on a deployment
 * with no observer, can never produce a fingerprint, and telling the customer to press
 * it is the dead-end loop this item exists to close.
 */
const UNAVAILABLE_HINT: Record<OsFingerprintUnavailable, string> = {
  vpn_tunnel:
    'OS not measured: the OS check is not available for VPN connections, so no test can produce one here.',
  not_observed:
    'OS not measured: the proxy refused the connection used for the reading. Run Test again.',
  observer_off:
    'OS not measured: the OS check is turned off, so running Test will not produce one.',
};

/** The one-line `reason` carried on the placeholder record, for any consumer that
 *  reads `reason` rather than the verdict's hint. Same fact, shorter. */
const UNAVAILABLE_REASON: Record<OsFingerprintUnavailable, string> = {
  vpn_tunnel: 'the OS check is not available for VPN connections',
  not_observed: 'the proxy refused the connection the check needs',
  observer_off: 'the OS check is turned off',
};

/**
 * (o) O3 — mint the placeholder a reported cause travels on. The parser calls this
 * when a reply carried `os_fingerprint_unavailable` and no `os_fingerprint`, so the
 * cause rides the SAME field every existing consumer already carries (the wire parse,
 * the outcome mapper, the cache entry, the chip) and reaches the verdict without a
 * parallel channel that could drift from it.
 *
 * `os: 'unknown'` + `confidence: 'none'` are not a guess dressed as a reading: they
 * say exactly what happened — no OS determined, zero confidence — and `unavailable`
 * is what stops the verdict rendering them as "measured but undetermined".
 */
export function unavailableOsFingerprint(cause: OsFingerprintUnavailable): OsFingerprint {
  return {
    os: 'unknown',
    confidence: 'none',
    reason: UNAVAILABLE_REASON[cause],
    unavailable: cause,
  };
}

/**
 * (o) 2026-09-11 — the cause a VPN row carries FROM ITS OWN SCHEME, for the states in
 * which no reply carries one: before the first Check, while one is in flight, and after
 * a tunnel that failed to come up (a failed/refused outcome drops every server-measured
 * field, the reported cause with it). `vpn_tunnel` is a property of the scheme — there
 * is no SOCKS5 stack behind a tunnel to dial and fingerprint — so a row of this scheme
 * can state it without asking, and the answer is the same one the control plane gives.
 *
 * ⛔ It is a FALLBACK, never an override: a view uses it only where the row has no
 * fingerprint of its own (`osFingerprint ?? …`), so a real reading always wins.
 */
export const VPN_TUNNEL_OS_FINGERPRINT: OsFingerprint = unavailableOsFingerprint('vpn_tunnel');

/** (o) O4 — the sentinel a view passes to the chip while a test IT started is in
 *  flight, and the ONLY input that renders the word "measuring". */
export const OS_FINGERPRINT_MEASURING: OsFingerprint = {
  os: 'unknown',
  confidence: 'none',
  reason: 'a test you started is still running',
  measuring: true,
};

/**
 * (p) 2026-09-16 — the age of a reading, in the app's plain words, for the hint
 * sentence below. "just now" under a minute, then whole minutes / hours / days.
 *
 * ⛔ Deliberately its own formatter and not `formatRelativeNarrow`: that one
 * writes a CHIP LABEL ("5 min ago", "3 mo ago") sized for a 178px tile, this
 * writes half a SENTENCE a customer reads in a tooltip, and it lives in this
 * import-free module for the reason the TTL above does — two surfaces age the same
 * reading and neither may drag the Tauri store in to do it.
 */
export function measuredAgo(ageMs: number): string {
  if (ageMs < 60_000) return 'just now';
  const plural = (n: number, unit: string): string =>
    `${n.toString()} ${unit}${n === 1 ? '' : 's'} ago`;
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return plural(hours, 'hour');
  return plural(Math.floor(hours / 24), 'day');
}

/**
 * (p) 2026-09-16 — WHERE the reading came from and HOW OLD it is, appended to the
 * hint of every verdict that describes a real measurement.
 *
 * The customer's question, once a reading can arrive from a machine they are not
 * sitting at, is "who says so and when": "Measured by Driftstack" is the same
 * plain phrasing the latency vantage uses (`vantageLabel`), and the age is what
 * stops a stored reading from reading as something taken just now. Plain words
 * only — no vantage names, no ports, no mention of a cache or a list.
 *
 * ⛔ A stamp in the FUTURE (clock skew between this Mac and the server) says
 * "just now" rather than a negative age: we cannot show it is old, so we claim
 * nothing about its age.
 */
function provenanceSentence(at: number, nowMs: number): string {
  return `Measured by Driftstack, ${measuredAgo(Math.max(0, nowMs - at))}.`;
}

/**
 * The hover sentence of ANY reading that has aged out of the present tense — the
 * OS chip's, and the QUIC / UDP chips', which import it from here so all of them
 * say one thing (this module is import-free, which is why it is the shared home).
 *
 * Says when the reading was taken and what happens next, and nothing about how:
 * "It will be rechecked automatically" only where that is TRUE — the caller asks
 * the automatic check's own planner whether it would ever check this row
 * (`isCapabilityRowCheckable`) — and the button that re-takes it otherwise. Never the present tense, never "just now":
 * a reading only gets here by being older than the thirty-minute window.
 */
export function agedReadingHint(
  atMs: number,
  nowMs: number,
  autoRecheck: boolean,
  /** The button THIS row has — a VPN row's is not called Test, and a sentence that
   *  names a button the row does not have sends the customer looking for it. */
  manualAction = 'Test',
): string {
  const when = measuredAgo(Math.max(0, nowMs - atMs));
  return `Last checked ${when}. ${
    autoRecheck ? 'It will be rechecked automatically.' : `Run ${manualAction} to check it again.`
  }`;
}

/**
 * The verdict of an AGED reading: what was found, stated as what WAS found.
 *
 * ⛔ THE TONE IS ALWAYS THE NEUTRAL ONE, whatever the reading said. Green and red
 * on this chip mean "matches / can be detected, NOW"; a reading from four hours
 * ago about an exit that may have rotated to another machine supports neither,
 * and an aged chip that kept its colour would be indistinguishable from a current
 * one at a glance — the exact thing the thirty-minute TTL exists to prevent. The
 * glyph and the label survive (that is the information), muted, and the hint
 * leads with the age before it repeats what the reading found.
 *
 * A cause, the in-flight sentinel and "never measured" are not readings and do
 * not age; they come back unchanged.
 */
export function agedOsFingerprintVerdict(
  fp: OsFingerprint,
  atMs: number,
  nowMs: number = Date.now(),
  // ⛔ False by default: a caller that does not know names the button rather than
  // promising a recheck that may never come.
  autoRecheck = false,
): OsVerdict {
  const v = osFingerprintVerdictUndated(fp);
  if (fp.measuring === true || fp.unavailable !== undefined) return v;
  return {
    ...v,
    aged: true,
    // ⛔ Owner item 9 (2026-09-24): "if it's a Apple, it should be green status".
    // An aged reading of Apple is still a reading of Apple, and it still matches
    // the device — so it keeps the green, in the aged chrome, with its age. Every
    // OTHER aged reading gives up its tone as before: a red "does not match" from
    // hours ago is a claim about now that the reading cannot support.
    tone: v.tone === 'match' ? 'match' : 'unknown',
    hint: `${agedReadingHint(atMs, nowMs, autoRecheck)} What it found then: ${v.hint}`,
  };
}

/**
 * Pure. `undefined` = never measured (no observer, or the proxy is not stored
 * on the account so the control plane never tested it).
 *
 * (p) — a reading that carries its date (`fp.at`: every cached record, and every
 * reading adopted from the account list) says so in its hint. The verdict itself
 * — tone, glyph, label — is untouched by age: the TTL that decides whether a
 * reading is shown AT ALL is applied by the cache derivation, once, for every
 * surface; a second age rule here could only disagree with it.
 */
export function osFingerprintVerdict(
  fp: OsFingerprint | undefined,
  /** Reference moment for the age sentence; injected by tests. */
  nowMs: number = Date.now(),
): OsVerdict {
  const v = osFingerprintVerdictUndated(fp);
  // A cause, the in-flight sentinel and "never measured" describe no measurement,
  // so there is nothing to date — and `at` is absent on all three anyway.
  if (fp?.at === undefined || fp.measuring === true || fp.unavailable !== undefined) return v;
  return { ...v, hint: `${v.hint} ${provenanceSentence(fp.at, nowMs)}` };
}

function osFingerprintVerdictUndated(fp: OsFingerprint | undefined): OsVerdict {
  // (o) O4 — "measuring…" asserts work IN PROGRESS. It is rendered from a probe this
  // client has actually started and from nothing else; absence below says "not
  // measured", which is the honest state of a proxy nobody has tested.
  if (fp?.measuring === true) {
    return {
      tone: 'unknown',
      glyph: '…',
      label: 'OS',
      hint: 'Checking this proxy’s operating system — your test is still running.',
    };
  }
  // (o) O3 — a cause the control plane REPORTED outranks the shape of the record it
  // rides on: the placeholder's `os` is 'unknown', but "we looked and could not tell"
  // is a different (and false) statement from "there was nothing here to look at".
  if (fp?.unavailable !== undefined) {
    return { tone: 'unknown', glyph: '—', label: 'OS', hint: UNAVAILABLE_HINT[fp.unavailable] };
  }
  if (fp === undefined) {
    return {
      tone: 'unknown',
      glyph: '—',
      label: 'OS',
      hint: 'OS not measured yet. Run Test on this proxy.',
    };
  }
  // ⛔⛔ Owner item 9 (2026-09-24), verbatim: "And if it's a Apple, it should be
  // green status, which we don't always have". A reading of Apple (macOS or iOS)
  // is the device's own family: it MATCHES the iPhone this product presents as,
  // so it reads green on every surface, whichever vantage took it. Until this
  // change two vantages withheld it as a neutral '?': a reading of the proxy's
  // entry point on the observer port ("? OS", which did not even name Apple),
  // and a reading through a multi-machine proxy ("? Apple") — which is also what
  // every reading stored before the vantage flags existed looks like. What those
  // vantages cannot rule out is still said, in the hint: a website may reach a
  // different machine. The RED arm is untouched — a mismatch is still asserted
  // only where the vantage supports it (below), so a withheld Windows reading
  // stays a neutral '?'. This is a deliberate asymmetry, decided by the owner;
  // the argument against it is the V-219 note further down and is kept there.
  if (fp.os === 'macos-or-ios') {
    const label = OS_LABEL['macos-or-ios'];
    const name = OS_NAME['macos-or-ios'];
    const websitePath = fp.singleHostVantage === true || fp.webPortVantage === true;
    const entryPointOnly = fp.observedVia === 'proxy_host' && fp.webPortVantage !== true;
    return {
      tone: 'match',
      glyph: '✓',
      label,
      hint: websitePath
        ? `Your proxy presents as ${name} to websites${withConfidence(fp.confidence)} — it matches the iOS device behind it.${vantageSentence(fp)}`
        : entryPointOnly
          ? `Your proxy presents as ${name}${withConfidence(fp.confidence)} — it matches the iOS device behind it. Only the proxy's entry point could be read, so some websites may reach a different machine.`
          : `Your proxy presents as ${name}${withConfidence(fp.confidence)} — it matches the iOS device behind it. It forwards through more than one machine, so some websites may reach a different one.`,
    };
  }
  // ⛔ MEASURED ON PROD 2026-09-14, and it is the owner's whole complaint: every
  // stored fingerprint was `windows` / `proxy_host` / medium — the same three
  // values on every row. Not a classifier bug. The SYN was recorded under the
  // address we DIALLED (the provider's front door), never under the exit, so the
  // chip was describing a shared gateway and painting a red "does not match the
  // iOS device it fronts" about a machine that is not necessarily what any
  // website sees. A provider that FORWARDS the connection out of the exit device
  // makes that badge simply wrong; an application-layer proxy makes it right,
  // and a SYN cannot tell the two apart.
  //
  // So a front-door reading states what was measured and claims nothing about
  // the exit. It is never the red tone: the one measured defect has to stay a
  // defect somebody can act on, and "your provider's gateway runs Windows" is
  // not one. `exit_ip` readings are untouched — there the claim is about the
  // address the site will see, which is what the verdict was always for.
  // ⛔⛔ (V-219) ON THE WEB PORT A FRONT-DOOR READING IS A VERDICT. The owner's
  // decision, 2026-09-15, after the measurement: we present as an iPhone, and a
  // Darwin stack on 443 — the port a website connects on, confirmed against an
  // independent browserleaks reading of the same proxy — is green. A review had
  // argued for naming without judging (a front-door hit on 443 shows the provider
  // routes by destination, so a CDN-named site may reach a different machine);
  // that caveat stays in the hint, and the verdict is what the web port measured.
  // Symmetric on purpose: the same vantage that supports green supports red.
  // Only the OBSERVER-port front door — the provider's gateway — stays neutral.
  if (fp.observedVia === 'proxy_host' && fp.webPortVantage !== true) {
    const looksLike =
      fp.os === 'unknown' ? 'could not be identified' : `looks like ${OS_NAME[fp.os]}`;
    return {
      tone: 'unknown',
      glyph: '?',
      label: 'OS',
      hint: `Only the proxy's entry point could be read, not the exit device — that entry point ${looksLike}. This does not say what websites see.`,
    };
  }
  if (fp.os === 'unknown') {
    return {
      tone: 'unknown',
      glyph: '?',
      label: 'OS',
      hint: 'OS could not be determined from this proxy.',
    };
  }
  const label = OS_LABEL[fp.os];
  const name = OS_NAME[fp.os];
  // ⛔⛔ (V-219) NEITHER ARM MAY ASSERT UNLESS THE VANTAGE SUPPORTS IT, and the
  // symmetry is the whole point.
  //
  // MEASURED by the owner 2026-09-14: browserleaks.com/ip loaded THROUGH their
  // residential proxy reads the arriving stack on 443 — a website's port — and
  // reports Mac/iOS. Our observer reads the same proxy on 7791 and reports Linux
  // at high confidence. The provider routes web traffic through the residential
  // device and odd ports through its own infrastructure, so a reading taken here
  // can describe a path no website ever touches.
  //
  // The tempting fix was to stop painting the red arm, because that is the one
  // that produced a complaint. That would have been a complaint-to-evidence fix,
  // not a claim-to-evidence one: the GREEN arm is minted from the identical SYN,
  // over the identical path, and asserts "matches the iOS device it fronts". If
  // this vantage cannot support "detectable mismatch" it cannot support "matches"
  // either — and of the two errors, the false green is far worse. A red chip is
  // an irritant somebody eventually reports; a green chip on a proxy that is
  // actually detectable costs a customer their account, and nobody ever files a
  // bug about a reassuring badge. Silencing only the red one would have left the
  // product able to falsely reassure and unable to falsely alarm, with no
  // instrument left that could contradict a wrong green.
  //
  // ⚠️ A KNOWN LIMIT ON THE ARM THIS GATE STILL TRUSTS, measured the same night
  // and written down rather than left as an unexamined premise.
  //
  // The single-host argument is about the PROXY side: one kernel, so nothing
  // there can route a website's port differently from our observer's. That
  // reasoning holds. What it silently assumed is that OUR two ports are
  // comparable — and they are not. `api.driftstack.dev` is behind Cloudflare, so
  // 443 to that name terminates at a CDN edge and is re-originated, while 7791
  // is not in Cloudflare's proxied port set and reaches the origin directly. The
  // two ports differ in topology before the customer's proxy is involved at all.
  //
  // So even a genuine single-host proxy is being read over a path a website does
  // not use. That is a second, independent cause of the same defect the owner
  // found from the outside, and it is ours rather than their provider's. It does
  // NOT make this arm wrong — it withholds in every case that needed withholding,
  // and a single-host proxy cannot itself be the source of a split — but the
  // trusted arm rests on an assumption this measurement weakened. Settling it
  // needs a vantage reachable on 443 with no CDN in front, which is an
  // infrastructure decision with a real cost, not a code change.
  //
  // ⛔ Do not strengthen this arm, or add a new asserting arm, until that vantage
  // exists. Getting it wrong does not fail visibly: it produces a confident,
  // stable reading of a CDN edge labelled as the customer's proxy.
  //
  // `singleHostVantage` is the one case where the reading IS about the path a
  // website gets: dialled host, SYN emitter and destination-visible address are
  // one machine, so there is no fabric in between to route 443 differently.
  // Everything else states what was measured and claims nothing.
  // ⛔ (V-219) THE VANTAGE THE COMMENT ABOVE ASKED FOR NOW EXISTS. The observer
  // records SYNs on 443 at the origin's IP literal, with no CDN in front, and on
  // 2026-09-15 a production diagnostic — same control-plane dialer, same
  // destination, only the port differing — showed four mobile proxies presenting
  // a Linux layout on the observer port and a Darwin layout on 443, the latter
  // agreeing with the owner's independent browserleaks reading. A reading taken
  // on the web port is about the path a website gets, by construction; that is
  // the condition this function was waiting for, not a relaxation of it.
  const websitePath = fp.singleHostVantage === true || fp.webPortVantage === true;
  if (!websitePath) {
    return {
      tone: 'unknown',
      glyph: '?',
      label,
      hint: `This proxy looks like ${name}${withConfidence(fp.confidence)}, but it forwards through more than one machine, so a website may reach a different one. Not a conclusion either way.`,
    };
  }
  // (An Apple reading returned green at the top of this function — owner item 9.)
  return {
    tone: 'mismatch',
    glyph: '✗',
    label,
    hint: `Your proxy presents as ${name} to websites${withConfidence(fp.confidence)} — an iOS device behind a ${name} proxy can be detected.${vantageSentence(fp)}`,
  };
}

/** Why a verdict may be asserted, in the customer's terms — whichever vantage
 *  unlocked it. */
function vantageSentence(fp: OsFingerprint): string {
  // Customer terms only: no ports, no vantage names, no third-party sites.
  // ⛔ G17 (prod-5) — when the reading is of the proxy's ENTRY POINT (`proxy_host`)
  // rather than the exit device, the caveat has to SAY so. It used to read "This
  // provider forwards from the device", which is the opposite of what an entry-point
  // reading is: the SYN came from the front door we dialled, not from the exit
  // device. The verdict still stands (V-219: a Darwin stack on the web port is
  // green), but a customer must not be told the device forwarded a reading that was
  // taken before the device. Same voice as the observer-port entry-point sentence.
  return fp.webPortVantage === true && fp.observedVia === 'proxy_host'
    ? " This was read at the proxy's entry point, so some sites may reach a different machine."
    : '';
}
