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
 *  where in the country the exit sits. US/CA/AU/RU/BR/MX/ID/KZ/CD all span
 *  several; a Torrance exit resolving to America/New_York is expected behaviour
 *  of this table, and the reason tier (1) exists.
 *
 *  ⭐ COVERAGE (2026-09-09): originally 65 curated countries, which left ~19% of
 *  live sessions falling through to the harness archetype (Europe/Istanbul)
 *  because their KNOWN exit country had no entry — measured by A3 across 78
 *  geo-resolving sessions. That is a free timezone-vs-IP mismatch, one of the
 *  cheapest fingerprint tells there is (Intl.DateTimeFormat().resolvedOptions()
 *  .timeZone needs no permission and every detector cross-checks it). Expanded
 *  to full ISO-3166-1 so any country Cloudflare CAN classify yields its real
 *  primary zone instead of null.
 *
 *  ⛔ Real IANA zones ONLY — never Etc/GMT±N. A fixed-offset zone is technically
 *  a valid value and is NEVER what a real browser reports, so it is uniquely
 *  identifying: worse than the null it would replace. If you extend this, add
 *  the country's actual representative zone (America/Guayaquil, Asia/Qatar), not
 *  an offset.
 *
 *  This is NOT "geo is done". It makes the zone coherent at COUNTRY granularity,
 *  which is the comparison most detectors make; it does NOT give the exact city
 *  zone inside a multi-zone country. The precise per-IP fix is tier (1) —
 *  enabling Cloudflare's "Add visitor location headers" Managed Transform — and
 *  it is complementary, not superseded by this table. A country Cloudflare
 *  cannot classify (XX / Tor) still resolves to null here, by design. */
export const COUNTRY_PRIMARY_TIMEZONE: Readonly<Record<string, string>> = {
  AD: 'Europe/Andorra',
  AE: 'Asia/Dubai',
  AF: 'Asia/Kabul',
  AG: 'America/Antigua',
  AI: 'America/Anguilla',
  AL: 'Europe/Tirane',
  AM: 'Asia/Yerevan',
  AO: 'Africa/Luanda',
  AR: 'America/Argentina/Buenos_Aires',
  AS: 'Pacific/Pago_Pago',
  AT: 'Europe/Vienna',
  AU: 'Australia/Sydney',
  AW: 'America/Aruba',
  AX: 'Europe/Mariehamn',
  AZ: 'Asia/Baku',
  BA: 'Europe/Sarajevo',
  BB: 'America/Barbados',
  BD: 'Asia/Dhaka',
  BE: 'Europe/Brussels',
  BF: 'Africa/Ouagadougou',
  BG: 'Europe/Sofia',
  BH: 'Asia/Bahrain',
  BI: 'Africa/Bujumbura',
  BJ: 'Africa/Porto-Novo',
  BL: 'America/St_Barthelemy',
  BM: 'Atlantic/Bermuda',
  BN: 'Asia/Brunei',
  BO: 'America/La_Paz',
  BQ: 'America/Kralendijk',
  BR: 'America/Sao_Paulo',
  BS: 'America/Nassau',
  BT: 'Asia/Thimphu',
  BW: 'Africa/Gaborone',
  BY: 'Europe/Minsk',
  BZ: 'America/Belize',
  CA: 'America/Toronto',
  CD: 'Africa/Kinshasa',
  CF: 'Africa/Bangui',
  CG: 'Africa/Brazzaville',
  CH: 'Europe/Zurich',
  CI: 'Africa/Abidjan',
  CK: 'Pacific/Rarotonga',
  CL: 'America/Santiago',
  CM: 'Africa/Douala',
  CN: 'Asia/Shanghai',
  CO: 'America/Bogota',
  CR: 'America/Costa_Rica',
  CU: 'America/Havana',
  CV: 'Atlantic/Cape_Verde',
  CW: 'America/Curacao',
  CY: 'Asia/Nicosia',
  CZ: 'Europe/Prague',
  DE: 'Europe/Berlin',
  DJ: 'Africa/Djibouti',
  DK: 'Europe/Copenhagen',
  DM: 'America/Dominica',
  DO: 'America/Santo_Domingo',
  DZ: 'Africa/Algiers',
  EC: 'America/Guayaquil',
  EE: 'Europe/Tallinn',
  EG: 'Africa/Cairo',
  EH: 'Africa/El_Aaiun',
  ER: 'Africa/Asmara',
  ES: 'Europe/Madrid',
  ET: 'Africa/Addis_Ababa',
  FI: 'Europe/Helsinki',
  FJ: 'Pacific/Fiji',
  FK: 'Atlantic/Stanley',
  FM: 'Pacific/Pohnpei',
  FO: 'Atlantic/Faroe',
  FR: 'Europe/Paris',
  GA: 'Africa/Libreville',
  GB: 'Europe/London',
  GD: 'America/Grenada',
  GE: 'Asia/Tbilisi',
  GF: 'America/Cayenne',
  GG: 'Europe/Guernsey',
  GH: 'Africa/Accra',
  GI: 'Europe/Gibraltar',
  GL: 'America/Nuuk',
  GM: 'Africa/Banjul',
  GN: 'Africa/Conakry',
  GP: 'America/Guadeloupe',
  GQ: 'Africa/Malabo',
  GR: 'Europe/Athens',
  GT: 'America/Guatemala',
  GU: 'Pacific/Guam',
  GW: 'Africa/Bissau',
  GY: 'America/Guyana',
  HK: 'Asia/Hong_Kong',
  HN: 'America/Tegucigalpa',
  HR: 'Europe/Zagreb',
  HT: 'America/Port-au-Prince',
  HU: 'Europe/Budapest',
  ID: 'Asia/Jakarta',
  IE: 'Europe/Dublin',
  IL: 'Asia/Jerusalem',
  IM: 'Europe/Isle_of_Man',
  IN: 'Asia/Kolkata',
  IQ: 'Asia/Baghdad',
  IR: 'Asia/Tehran',
  IS: 'Atlantic/Reykjavik',
  IT: 'Europe/Rome',
  JE: 'Europe/Jersey',
  JM: 'America/Jamaica',
  JO: 'Asia/Amman',
  JP: 'Asia/Tokyo',
  KE: 'Africa/Nairobi',
  KG: 'Asia/Bishkek',
  KH: 'Asia/Phnom_Penh',
  KI: 'Pacific/Tarawa',
  KM: 'Indian/Comoro',
  KN: 'America/St_Kitts',
  KP: 'Asia/Pyongyang',
  KR: 'Asia/Seoul',
  KW: 'Asia/Kuwait',
  KY: 'America/Cayman',
  KZ: 'Asia/Almaty',
  LA: 'Asia/Vientiane',
  LB: 'Asia/Beirut',
  LC: 'America/St_Lucia',
  LI: 'Europe/Vaduz',
  LK: 'Asia/Colombo',
  LR: 'Africa/Monrovia',
  LS: 'Africa/Maseru',
  LT: 'Europe/Vilnius',
  LU: 'Europe/Luxembourg',
  LV: 'Europe/Riga',
  LY: 'Africa/Tripoli',
  MA: 'Africa/Casablanca',
  MC: 'Europe/Monaco',
  MD: 'Europe/Chisinau',
  ME: 'Europe/Podgorica',
  MF: 'America/Marigot',
  MG: 'Indian/Antananarivo',
  MH: 'Pacific/Majuro',
  MK: 'Europe/Skopje',
  ML: 'Africa/Bamako',
  MM: 'Asia/Yangon',
  MN: 'Asia/Ulaanbaatar',
  MO: 'Asia/Macau',
  MP: 'Pacific/Saipan',
  MQ: 'America/Martinique',
  MR: 'Africa/Nouakchott',
  MT: 'Europe/Malta',
  MU: 'Indian/Mauritius',
  MV: 'Indian/Maldives',
  MW: 'Africa/Blantyre',
  MX: 'America/Mexico_City',
  MY: 'Asia/Kuala_Lumpur',
  MZ: 'Africa/Maputo',
  NA: 'Africa/Windhoek',
  NC: 'Pacific/Noumea',
  NE: 'Africa/Niamey',
  NG: 'Africa/Lagos',
  NI: 'America/Managua',
  NL: 'Europe/Amsterdam',
  NO: 'Europe/Oslo',
  NP: 'Asia/Kathmandu',
  NR: 'Pacific/Nauru',
  NU: 'Pacific/Niue',
  NZ: 'Pacific/Auckland',
  OM: 'Asia/Muscat',
  PA: 'America/Panama',
  PE: 'America/Lima',
  PF: 'Pacific/Tahiti',
  PG: 'Pacific/Port_Moresby',
  PH: 'Asia/Manila',
  PK: 'Asia/Karachi',
  PL: 'Europe/Warsaw',
  PM: 'America/Miquelon',
  PR: 'America/Puerto_Rico',
  PS: 'Asia/Hebron',
  PT: 'Europe/Lisbon',
  PW: 'Pacific/Palau',
  PY: 'America/Asuncion',
  QA: 'Asia/Qatar',
  RE: 'Indian/Reunion',
  RO: 'Europe/Bucharest',
  RS: 'Europe/Belgrade',
  RU: 'Europe/Moscow',
  RW: 'Africa/Kigali',
  SA: 'Asia/Riyadh',
  SB: 'Pacific/Guadalcanal',
  SC: 'Indian/Mahe',
  SD: 'Africa/Khartoum',
  SE: 'Europe/Stockholm',
  SG: 'Asia/Singapore',
  SI: 'Europe/Ljubljana',
  SK: 'Europe/Bratislava',
  SL: 'Africa/Freetown',
  SM: 'Europe/San_Marino',
  SN: 'Africa/Dakar',
  SO: 'Africa/Mogadishu',
  SR: 'America/Paramaribo',
  SS: 'Africa/Juba',
  SV: 'America/El_Salvador',
  SX: 'America/Lower_Princes',
  SY: 'Asia/Damascus',
  SZ: 'Africa/Mbabane',
  TC: 'America/Grand_Turk',
  TD: 'Africa/Ndjamena',
  TG: 'Africa/Lome',
  TH: 'Asia/Bangkok',
  TJ: 'Asia/Dushanbe',
  TL: 'Asia/Dili',
  TM: 'Asia/Ashgabat',
  TN: 'Africa/Tunis',
  TO: 'Pacific/Tongatapu',
  TR: 'Europe/Istanbul',
  TT: 'America/Port_of_Spain',
  TV: 'Pacific/Funafuti',
  TW: 'Asia/Taipei',
  TZ: 'Africa/Dar_es_Salaam',
  UA: 'Europe/Kyiv',
  UG: 'Africa/Kampala',
  US: 'America/New_York',
  UY: 'America/Montevideo',
  UZ: 'Asia/Tashkent',
  VA: 'Europe/Vatican',
  VC: 'America/St_Vincent',
  VE: 'America/Caracas',
  VG: 'America/Tortola',
  VI: 'America/St_Thomas',
  VN: 'Asia/Ho_Chi_Minh',
  VU: 'Pacific/Efate',
  WS: 'Pacific/Apia',
  YE: 'Asia/Aden',
  YT: 'Indian/Mayotte',
  ZA: 'Africa/Johannesburg',
  ZM: 'Africa/Lusaka',
  ZW: 'Africa/Harare',
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
