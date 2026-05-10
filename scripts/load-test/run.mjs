#!/usr/bin/env node
// V-495 — autocannon-based load-test harness.
//
// Usage:
//   node scripts/load-test/run.mjs --target=status [--env=staging|production]
//   node scripts/load-test/run.mjs --target=status --duration=60 --connections=50
//
// Profiles available out of the box:
//   - status      → GET /v1/status (public, no auth — safe for staging + prod)
//   - health      → GET /health    (public, no auth — safe for staging + prod)
//   - version     → GET /version   (public, no auth — safe for staging + prod)
//   - sessions    → POST /v1/sessions (auth required; STAGING ONLY by default)
//
// Methodology + safety: docs/load-test/methodology.md
//
// The harness emits a JSON summary to stdout; pipe to jq or save for
// trend-tracking. Default duration is short (30s) so accidental runs
// don't generate noise.

import autocannon from 'autocannon';

const TARGETS = {
  status: {
    method: 'GET',
    path: '/v1/status',
    requiresAuth: false,
    productionSafe: true,
  },
  health: {
    method: 'GET',
    path: '/health',
    requiresAuth: false,
    productionSafe: true,
  },
  version: {
    method: 'GET',
    path: '/version',
    requiresAuth: false,
    productionSafe: true,
  },
  sessions: {
    method: 'POST',
    path: '/v1/sessions',
    requiresAuth: true,
    productionSafe: false, // mutates state; staging only by default
    body: JSON.stringify({ label: 'load-test' }),
    headers: { 'content-type': 'application/json' },
  },
};

const ENVS = {
  staging: 'https://staging.driftstack.dev',
  production: 'https://api.driftstack.dev',
  local: 'http://localhost:7780',
};

function parseArgs() {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    const m = /^--([^=]+)=(.+)$/.exec(arg);
    if (m) args[m[1]] = m[2];
    else if (arg.startsWith('--')) args[arg.slice(2)] = 'true';
  }
  return args;
}

async function main() {
  const args = parseArgs();
  const targetName = args.target || 'status';
  const envName = args.env || 'staging';
  const duration = parseInt(args.duration || '30', 10);
  const connections = parseInt(args.connections || '10', 10);
  const pipelining = parseInt(args.pipelining || '1', 10);

  const target = TARGETS[targetName];
  if (!target) {
    console.error(`Unknown target "${targetName}". Available: ${Object.keys(TARGETS).join(', ')}`);
    process.exit(2);
  }

  const baseUrl = ENVS[envName];
  if (!baseUrl) {
    console.error(`Unknown env "${envName}". Available: ${Object.keys(ENVS).join(', ')}`);
    process.exit(2);
  }

  if (envName === 'production' && !target.productionSafe) {
    console.error(
      `Refusing to run target "${targetName}" against production. ` +
        `Mutating endpoints stay on staging unless --i-know-what-im-doing is set.`,
    );
    if (args['i-know-what-im-doing'] !== 'true') process.exit(3);
  }

  const headers = { ...(target.headers || {}) };
  if (target.requiresAuth) {
    const token = process.env.DRIFTSTACK_LOAD_TEST_API_KEY;
    if (!token) {
      console.error(
        `Target "${targetName}" requires auth. Export DRIFTSTACK_LOAD_TEST_API_KEY ` +
          `with a staging-account API key (NEVER use production keys).`,
      );
      process.exit(4);
    }
    headers.authorization = `Bearer ${token}`;
  }

  const url = baseUrl + target.path;
  console.error(
    `[load-test] target=${targetName} env=${envName} duration=${duration}s ` +
      `connections=${connections} pipelining=${pipelining}`,
  );
  console.error(`[load-test] ${target.method} ${url}`);

  const opts = {
    url,
    method: target.method,
    headers,
    duration,
    connections,
    pipelining,
  };
  if (target.body) opts.body = target.body;

  const result = await autocannon(opts);

  const summary = {
    target: targetName,
    env: envName,
    url,
    method: target.method,
    duration_seconds: duration,
    connections,
    pipelining,
    requests: {
      total: result.requests.total,
      per_sec_avg: result.requests.average,
      per_sec_p50: result.requests.p50 ?? null,
      per_sec_p99: result.requests.p99 ?? null,
    },
    latency_ms: {
      avg: result.latency.average,
      p50: result.latency.p50,
      p90: result.latency.p90,
      p99: result.latency.p99,
      max: result.latency.max,
    },
    throughput_bytes: {
      avg: result.throughput.average,
      total: result.throughput.total,
    },
    errors: result.errors,
    timeouts: result.timeouts,
    non_2xx: result.non2xx,
    started_at: result.start.toISOString(),
    finished_at: result.finish.toISOString(),
  };

  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');

  if (result.errors > 0 || result.non2xx > 0 || result.timeouts > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[load-test] failed:', err);
  process.exit(1);
});
