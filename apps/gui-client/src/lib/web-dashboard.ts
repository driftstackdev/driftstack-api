// The web dashboard — the one place some account changes can be made.
//
// The desktop app's own sign-in ("Sign in with browser") mints a key the server
// refuses, BY DESIGN, for the changes that could take an account over: inviting
// or removing a teammate, and saving, testing or clearing the Anthropic key
// (server `middleware/device-key-deny.ts`). Those changes are made in the web
// dashboard, so the app names it and links to it instead of offering a control
// that cannot work. Billing already lives there (`BillingMovedView`).

/** The web dashboard's origin. A fixed address, as `BillingMovedView` uses. */
export const WEB_DASHBOARD_URL = 'https://app.driftstack.io';

/** The address as the customer reads it in copy and link text. */
export const WEB_DASHBOARD_HOST = 'app.driftstack.io';

/** Where team changes are made. */
export const WEB_DASHBOARD_TEAM_URL = `${WEB_DASHBOARD_URL}/team/`;

/** Where the Anthropic key is saved, tested and cleared. */
export const WEB_DASHBOARD_SETTINGS_URL = `${WEB_DASHBOARD_URL}/settings/`;
