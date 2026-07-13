import * as Sentry from '@sentry/astro';

Sentry.init({
  dsn: import.meta.env.PUBLIC_SENTRY_DSN_DASHBOARD,
  environment: import.meta.env.PUBLIC_SENTRY_ENVIRONMENT ?? 'production',
  tracesSampleRate: 0.05,
});
