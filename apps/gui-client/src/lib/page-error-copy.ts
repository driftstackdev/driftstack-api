// Shared page-navigation error copy (W616). The harness/driver supplies the
// per-kind error envelope on a page_state{state:'errored'} frame (DNS/TLS/HTTP/
// timeout/net); both live surfaces — the in-app LiveSessionView poller AND the
// standalone SimulatorWindow data-channel/poll consumer — render the SAME
// customer-facing "what should I DO about it" copy from this single source so the
// two stay in lock-step (a frozen frame must never read as a silent successful
// load — audit). The error kinds mirror api-types PageStateErrorKindSchema.

/** The page-error envelope the harness/driver emits. `kind` is widened to string
 *  because the LiveKit data-channel frame is semi-trusted (and the page-state poll
 *  types it as an open string) — an unrecognized kind falls through to a generic
 *  line rather than throwing. */
export interface PageErrorInfo {
  kind?: string;
  http_status?: number;
  message?: string;
}

/** Friendly, action-oriented copy per page-error kind. Used by BOTH LiveSessionView
 *  and SimulatorWindow so the error treatment is identical across surfaces. */
export function pageErrorCopy(err: PageErrorInfo): string {
  switch (err.kind) {
    case 'dns':
      return "Couldn't find this site — check the address (DNS lookup failed).";
    case 'tls':
      return 'Secure connection failed — the site’s certificate could not be trusted.';
    case 'http': {
      // HTTP statuses are user-comprehensible, so keep the number — but lead with
      // plain "what happened" copy rather than a bare "HTTP 404".
      const s = err.http_status;
      if (s === 404) return "This page wasn't found (404).";
      if (s === 403) return 'Access to this page was denied (403).';
      if (s === 401) return 'This page requires you to sign in (401).';
      if (s === 429) return 'The site is rate-limiting requests — try again shortly (429).';
      if (typeof s === 'number' && s >= 500)
        return `The site is having problems right now (HTTP ${s}).`;
      return typeof s === 'number'
        ? `The site couldn't load this page (HTTP ${s}).`
        : "The site couldn't load this page.";
    }
    case 'timeout':
      return 'The site took too long to respond.';
    case 'net':
      return 'Network error while loading the page.';
    default:
      // Unrecognized / missing kind — a generic honest fallback (never read the
      // failure as a clean load). The raw harness `err.message` is deliberately
      // NOT surfaced here: it can be a cryptic transport code (e.g. -1004) that
      // must never reach the operator's face (founder). It still reaches the dev
      // logs via the caller's envelope logging.
      return "This page couldn't be loaded.";
  }
}
