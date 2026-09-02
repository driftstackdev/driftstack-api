// Deriving a session's timezone from where its traffic actually exits.
//
// ⛔ WHY THIS EXISTS. The exit-identity probe read the timezone from
// Cloudflare's `cf-timezone` edge header. That header is NOT added on our plan
// unless the "Add visitor location headers" Managed Transform is enabled, so
// `exitIdentity.timezone` was not "best-effort, occasionally null" — it was
// ALWAYS null. Measured 2026-09-02: a real session through a working US proxy
// cached `country=US, timezone=null`, and `GET /v1/egress/echo` returned
// `{"country":"NL","region":null,"city":null,"timezone":null}`. One cause
// explains all three nulls: country rides `cf-ipcountry`, which every plan
// gets; region/city/timezone ride the Managed-Transform headers, which we do
// not currently have.
//
// The harness consumes the CP's exit timezone and falls back to the archetype
// when it is null — and the launch archetype ships `Europe/Istanbul`. So every
// production session rendered Turkey time regardless of where it egressed,
// which is the customer's "timezone mismatch on proxies".
//
// ⭐ THE ORDER HERE IS DELIBERATE, most precise first:
//   1. the edge's own timezone, when the Managed Transform is on — per-IP exact;
//   2. otherwise the country's representative zone — imprecise inside
//      multi-zone countries, but the same COUNTRY as the exit, which is the
//      comparison a detector actually makes;
//   3. otherwise null, which leaves the harness's archetype fallback exactly as
//      it is today. Never a guess dressed as a measurement.
//
// (2) is a real improvement over (3) even when it picks the wrong US zone: a US
// exit reporting America/New_York is coherent at country granularity, whereas a
// US exit reporting Europe/Istanbul is a free tell. It is NOT a substitute for
// (1) — enabling the Managed Transform is the actual fix and costs one toggle.

/** Representative IANA zone per ISO-3166-1 alpha-2 country.
 *
 *  ⚠️ For multi-zone countries this is the most populous zone, NOT a claim about
 *  where in the country the exit sits. US/CA/AU/RU/BR/MX/ID all span several;
 *  a Torrance exit resolving to America/New_York is expected behaviour of this
 *  table, and the reason tier (1) exists. Countries absent here resolve to null
 *  rather than to a neighbour's zone. */
const COUNTRY_PRIMARY_TIMEZONE: Readonly<Record<string, string>> = {
  AE: 'Asia/Dubai',
  AR: 'America/Argentina/Buenos_Aires',
  AT: 'Europe/Vienna',
  AU: 'Australia/Sydney',
  BD: 'Asia/Dhaka',
  BE: 'Europe/Brussels',
  BG: 'Europe/Sofia',
  BR: 'America/Sao_Paulo',
  CA: 'America/Toronto',
  CH: 'Europe/Zurich',
  CL: 'America/Santiago',
  CN: 'Asia/Shanghai',
  CO: 'America/Bogota',
  CZ: 'Europe/Prague',
  DE: 'Europe/Berlin',
  DK: 'Europe/Copenhagen',
  EE: 'Europe/Tallinn',
  EG: 'Africa/Cairo',
  ES: 'Europe/Madrid',
  FI: 'Europe/Helsinki',
  FR: 'Europe/Paris',
  GB: 'Europe/London',
  GR: 'Europe/Athens',
  HK: 'Asia/Hong_Kong',
  HR: 'Europe/Zagreb',
  HU: 'Europe/Budapest',
  ID: 'Asia/Jakarta',
  IE: 'Europe/Dublin',
  IL: 'Asia/Jerusalem',
  IN: 'Asia/Kolkata',
  IS: 'Atlantic/Reykjavik',
  IT: 'Europe/Rome',
  JP: 'Asia/Tokyo',
  KE: 'Africa/Nairobi',
  KR: 'Asia/Seoul',
  LT: 'Europe/Vilnius',
  LU: 'Europe/Luxembourg',
  LV: 'Europe/Riga',
  MA: 'Africa/Casablanca',
  MX: 'America/Mexico_City',
  MY: 'Asia/Kuala_Lumpur',
  NG: 'Africa/Lagos',
  NL: 'Europe/Amsterdam',
  NO: 'Europe/Oslo',
  NZ: 'Pacific/Auckland',
  PE: 'America/Lima',
  PH: 'Asia/Manila',
  PK: 'Asia/Karachi',
  PL: 'Europe/Warsaw',
  PT: 'Europe/Lisbon',
  RO: 'Europe/Bucharest',
  RS: 'Europe/Belgrade',
  RU: 'Europe/Moscow',
  SA: 'Asia/Riyadh',
  SE: 'Europe/Stockholm',
  SG: 'Asia/Singapore',
  SI: 'Europe/Ljubljana',
  SK: 'Europe/Bratislava',
  TH: 'Asia/Bangkok',
  TR: 'Europe/Istanbul',
  TW: 'Asia/Taipei',
  UA: 'Europe/Kyiv',
  US: 'America/New_York',
  VN: 'Asia/Ho_Chi_Minh',
  ZA: 'Africa/Johannesburg',
};

/** True when `tz` is a zone this runtime actually knows.
 *
 *  Validated against Intl rather than a regex: a syntactically plausible but
 *  non-existent zone (`America/Atlantis`) would pass a shape check and then
 *  throw or silently misbehave downstream. The harness also validates, but a
 *  value should not leave here unless it is real. */
export function isValidIanaTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the timezone to send with a session's exit identity.
 *
 * @param edgeTimezone the edge's per-IP timezone (`cf-timezone`), when present
 * @param country      ISO-3166-1 alpha-2 from `cf-ipcountry`, when present
 * @returns an IANA zone, or null when neither source can answer — null means
 *          "unknown", and callers must not substitute anything for it.
 */
export function resolveExitTimezone(
  edgeTimezone: string | null | undefined,
  country: string | null | undefined,
): string | null {
  // 1. Per-IP, exact. Still validated: an upstream that starts sending a
  //    malformed value must not become the thing we ship worldwide.
  if (typeof edgeTimezone === 'string' && edgeTimezone.length > 0) {
    if (isValidIanaTimeZone(edgeTimezone)) return edgeTimezone;
  }
  // 2. Country granularity. Imprecise inside big countries, coherent at the
  //    granularity a detector compares.
  if (typeof country === 'string' && country.length === 2) {
    const zone = COUNTRY_PRIMARY_TIMEZONE[country.toUpperCase()];
    if (zone !== undefined) return zone;
  }
  // 3. Unknown. NOT a default — the caller keeps its own fallback and the
  //    absence stays visible.
  return null;
}
