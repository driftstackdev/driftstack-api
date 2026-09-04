#!/usr/bin/env node
// Smoke test for Postmark go-live (V-665 / V-486). Sends one message
// per requested template against the env-configured Postmark server
// and reports per-template success/fail.
//
// Usage:
//   node scripts/smoke-postmark.mjs \
//     --to qa+postmark@driftstack.dev \
//     --templates signup-verification,password-reset,signup-welcome
//
// Requires the same three env vars as the live API:
//   POSTMARK_API_TOKEN
//   POSTMARK_FROM
//   POSTMARK_REPLY_TO
//
// Exits non-zero on any send failure so CI can gate on it.

import process from 'node:process';

const args = parseArgs(process.argv.slice(2));
if (!args.to) {
  console.error('error: --to <email> is required');
  process.exit(2);
}

const templates = (args.templates ?? 'signup-verification,password-reset,signup-welcome')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const token = process.env.POSTMARK_API_TOKEN;
const from = process.env.POSTMARK_FROM;
const replyTo = process.env.POSTMARK_REPLY_TO;
if (!token || !from || !replyTo) {
  console.error('error: POSTMARK_API_TOKEN / POSTMARK_FROM / POSTMARK_REPLY_TO must be set');
  process.exit(2);
}

const FIXTURES = {
  'signup-verification': {
    subject: '[smoke] Verify your Driftstack account',
    textBody:
      'This is a smoke test of the signup-verification template.\nLink: https://app.driftstack.io/verify-email?token=SMOKE\nExpires: ' +
      new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
  },
  'password-reset': {
    subject: '[smoke] Reset your Driftstack password',
    textBody:
      'This is a smoke test of the password-reset template.\nLink: https://app.driftstack.io/reset-password?token=SMOKE\nExpires: ' +
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  },
  'signup-welcome': {
    subject: '[smoke] Welcome to Driftstack',
    textBody:
      'This is a smoke test of the signup-welcome template.\nDashboard: https://app.driftstack.io/',
  },
};

const results = [];
for (const name of templates) {
  const fixture = FIXTURES[name];
  if (!fixture) {
    console.error(`error: unknown template "${name}". Known: ${Object.keys(FIXTURES).join(', ')}`);
    process.exit(2);
  }
  const startedAt = Date.now();
  try {
    const res = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Postmark-Server-Token': token,
      },
      body: JSON.stringify({
        From: from,
        To: args.to,
        Subject: fixture.subject,
        TextBody: fixture.textBody,
        ReplyTo: replyTo,
        MessageStream: 'outbound',
      }),
    });
    const body = await res.json().catch(() => ({}));
    const ms = Date.now() - startedAt;
    if (!res.ok) {
      results.push({
        template: name,
        ok: false,
        status: res.status,
        ms,
        code: body.ErrorCode ?? null,
        message: body.Message ?? `HTTP ${res.status}`,
      });
      continue;
    }
    results.push({
      template: name,
      ok: true,
      status: res.status,
      ms,
      messageId: body.MessageID ?? null,
    });
  } catch (err) {
    const ms = Date.now() - startedAt;
    results.push({
      template: name,
      ok: false,
      status: 0,
      ms,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

let anyFail = false;
for (const r of results) {
  const tag = r.ok ? 'OK' : 'FAIL';
  const extra = r.ok
    ? `msgId=${r.messageId ?? '-'}`
    : `code=${r.code ?? '-'} msg=${(r.message ?? '').slice(0, 120)}`;
  console.log(`${tag} ${r.template} status=${r.status} ${r.ms}ms ${extra}`);
  if (!r.ok) anyFail = true;
}

process.exit(anyFail ? 1 : 0);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith('--')) {
        out[k] = v;
        i++;
      } else {
        out[k] = true;
      }
    }
  }
  return out;
}
