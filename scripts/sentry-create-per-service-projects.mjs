#!/usr/bin/env node
// V-469 follow-up — create per-service Sentry projects + capture DSNs.
//
// Idempotent: if a project already exists, the script captures its
// existing DSN rather than failing.
//
// Usage:
//   SENTRY_AUTH_TOKEN=<token> node scripts/sentry-create-per-service-projects.mjs
//
// Defaults assume org/team/region match the existing driftstack-gui
// project. Override via env if needed.

import process from 'node:process';

const TOKEN = process.env.SENTRY_AUTH_TOKEN;
if (!TOKEN) {
  console.error('error: SENTRY_AUTH_TOKEN is required');
  process.exit(2);
}

const ORG = process.env.SENTRY_ORG_SLUG ?? 'driftstack';
const TEAM = process.env.SENTRY_TEAM_SLUG ?? 'driftstack';
const REGION_BASE = process.env.SENTRY_REGION_URL ?? 'https://de.sentry.io';

const PROJECTS = [
  { slug: 'driftstack-dashboard', name: 'driftstack-dashboard', platform: 'javascript-nextjs' },
  { slug: 'driftstack-marketing', name: 'driftstack-marketing', platform: 'javascript-nextjs' },
];

async function sentry(method, path, body) {
  const res = await fetch(`${REGION_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    json = { _raw: text };
  }
  return { status: res.status, ok: res.ok, body: json };
}

async function ensureProject({ slug, name, platform }) {
  // Check first.
  const probe = await sentry('GET', `/api/0/projects/${ORG}/${slug}/`);
  if (probe.ok) {
    return { slug, status: 'exists', project: probe.body };
  }
  if (probe.status !== 404) {
    return { slug, status: 'probe-error', code: probe.status, body: probe.body };
  }
  // Create.
  const create = await sentry('POST', `/api/0/teams/${ORG}/${TEAM}/projects/`, {
    name,
    slug,
    platform,
  });
  if (!create.ok) {
    return { slug, status: 'create-error', code: create.status, body: create.body };
  }
  return { slug, status: 'created', project: create.body };
}

async function fetchDsn(slug) {
  const res = await sentry('GET', `/api/0/projects/${ORG}/${slug}/keys/`);
  if (!res.ok) return { slug, ok: false, error: res.body };
  const keys = Array.isArray(res.body) ? res.body : [];
  // First active key — Sentry creates one by default on project creation.
  const active = keys.find((k) => k.isActive) ?? keys[0];
  return {
    slug,
    ok: true,
    dsn: active?.dsn?.public ?? null,
    keyName: active?.name ?? null,
    keyId: active?.id ?? null,
  };
}

const results = [];
for (const p of PROJECTS) {
  const ensured = await ensureProject(p);
  if (ensured.status === 'created' || ensured.status === 'exists') {
    const key = await fetchDsn(p.slug);
    results.push({ ...ensured, ...key });
  } else {
    results.push(ensured);
  }
}

console.log(JSON.stringify({ org: ORG, team: TEAM, region: REGION_BASE, results }, null, 2));

const anyFail = results.some(
  (r) => r.status === 'probe-error' || r.status === 'create-error' || r.ok === false,
);
process.exit(anyFail ? 1 : 0);
