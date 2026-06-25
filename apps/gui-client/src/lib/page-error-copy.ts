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
    case 'http':
      return `The site returned HTTP ${err.http_status ?? 'error'}.`;
    case 'timeout':
      return 'The site took too long to respond.';
    case 'net':
      return 'Network error while loading the page.';
    default:
      // Unrecognized / missing kind — prefer the harness message if present, else
      // a generic honest fallback (never read the failure as a clean load).
      return typeof err.message === 'string' && err.message.length > 0
        ? err.message
        : "This page couldn't be loaded.";
  }
}
