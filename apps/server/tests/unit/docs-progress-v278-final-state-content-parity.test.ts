// W572.A — drift guard for /docs/progress/v278-final-state.md.
// V-278 final-state checkpoint 2026-05-09 HEAD 632a5f2. Drift here
// either re-jiggers the 6/6 HTTP-200 Rule-L empirical posture,
// drops the Let's-Encrypt-vs-Cloudflare-Origin-CA pivot context,
// or unsets the V-278.K/L/J-2 + F-001/F-003 deferred-item posture.
//
//   • V-278. LIVE checkpoint. HEAD 632a5f2.
//   • TLS: Cloudflare Full (strict), TLS 1.3.
//   • 6/6 URLs HTTP 200 (Rule L empirical proof).
//   • Origin TLS: Let's Encrypt DNS-01 (pivot from Cloudflare Origin
//     CA because /v4/certificates requires legacy Origin CA Key).
//   • Sub-processor map matches DPA Annex 3.
//   • 6 deferred items + 7 founder-blocked items.
//   • V-278 slice index: A→A-2→B→C→D→E→F→G→H→I→J→M→post.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/progress/v278-final-state.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W572.A /docs/progress/v278-final-state.md content parity', () => {
  const body = read(LIB);

  it('Header + V-278-checkpoint 2026-05-09 + HEAD-632a5f2 + Cloudflare-Full-strict-TLS-1.3 + 6-URL HTTP-200 table framing pinned', () => {
    expect(body).toMatch(/^# V-278 final state — control plane v1\.0 LIVE$/m);
    expect(body).toMatch(/\*\*Checkpoint date:\*\* 2026-05-09/);
    expect(body).toMatch(/\*\*HEAD at checkpoint:\*\* `632a5f2`/);
    expect(body).toMatch(
      /\*\*TLS posture:\*\* Cloudflare Full \(strict\), TLS 1\.3 customer-edge ↔ Cloudflare ↔ origin/,
    );
    expect(body).toMatch(/## Live URLs \(6\/6 HTTP 200, Rule L empirical proof\)/);
    expect(body).toMatch(
      /\| https:\/\/driftstack\.io\/\s+\| 200\s+\| Cloudflare Pages → driftstack-marketing\s+\|/,
    );
    expect(body).toMatch(
      /\| https:\/\/www\.driftstack\.io\/\s+\| 200\s+\| Cloudflare Pages → driftstack-marketing\s+\|/,
    );
    expect(body).toMatch(
      /\| https:\/\/docs\.driftstack\.io\/\s+\| 200\s+\| Cloudflare Pages → driftstack-docs\s+\|/,
    );
    expect(body).toMatch(
      /\| https:\/\/app\.driftstack\.io\/\s+\| 200\s+\| Cloudflare Pages → driftstack-customer-dashboard\s+\|/,
    );
    expect(body).toMatch(
      /\| https:\/\/api\.driftstack\.dev\/health\s+\| 200\s+\| Hetzner production \(128\.140\.37\.74\) — Fastify \+ nginx \+ Node 22 \|/,
    );
    expect(body).toMatch(
      /\| https:\/\/staging\.driftstack\.dev\/health \| 200\s+\| Hetzner staging \(116\.203\.22\.197\) — Fastify \+ nginx \+ Node 22\s+\|/,
    );
  });

  it("Origin TLS Let's-Encrypt DNS-01 + certbot + handshake-evidence + V-278.M-pivot framing pinned", () => {
    expect(body).toMatch(/## Origin TLS/);
    expect(body).toMatch(/\*\*Mechanism:\*\* Let's Encrypt via DNS-01 challenge\./);
    expect(body).toMatch(
      /- \*\*Tooling:\*\* `python3-certbot-dns-cloudflare` \(Ubuntu 24\.04 system/,
    );
    expect(body).toMatch(/package\)\./);
    expect(body).toMatch(/- \*\*Auth:\*\* the agent's Cloudflare API token \(`Zone:DNS:Edit`\)/);
    expect(body).toMatch(/via `\/etc\/letsencrypt\/cf-dns-creds\.ini`\./);
    expect(body).toMatch(
      /- prod: `\/etc\/letsencrypt\/live\/api\.driftstack\.dev\/\{fullchain,privkey\}\.pem`/,
    );
    expect(body).toMatch(
      /- staging: `\/etc\/letsencrypt\/live\/staging\.driftstack\.dev\/\{fullchain,privkey\}\.pem`/,
    );
    expect(body).toMatch(/\(SAN: `staging\.driftstack\.dev` \+ `api\.staging\.driftstack\.dev`\)/);
    expect(body).toMatch(/- \*\*Renewal:\*\* certbot's systemd timer auto-renews every ~60 days\./);
    expect(body).toMatch(/Both certs expire 2026-08-07; first auto-renewal lands ~July\./);
    expect(body).toMatch(/- \*\*TLS handshake captured \(Rule L empirical\):\*\*/);
    expect(body).toMatch(/TLSv1\.3 \/ AEAD-CHACHA20-POLY1305-SHA256/);
    expect(body).toMatch(/subject: CN=api\.driftstack\.dev/);
    expect(body).toMatch(/issuer:\s+C=US; O=Let's Encrypt; CN=E8/);
    expect(body).toMatch(/HTTP\/2 200/);
    expect(body).toMatch(/### Spec deviation from V-278\.M direction/);
    expect(body).toMatch(/The founder direction asked for Cloudflare Origin Certificates via/);
    expect(body).toMatch(/`POST \/v4\/certificates`\. That endpoint requires the legacy/);
    expect(body).toMatch(/"Origin CA Key" credential \(separate from API tokens; viewable at/);
    expect(body).toMatch(/dash\.cloudflare\.com → My Profile → API Tokens → API Keys →/);
    expect(body).toMatch(/"Origin CA Key" → View\)\./);
    expect(body).toMatch(/Even with `Account:SSL and Certificates:Edit`/);
    expect(body).toMatch(/on the `cfut_` token, `\/v4\/certificates` returns/);
    expect(body).toMatch(/`code 1016 User is not authorized`\. Pivoted to Let's Encrypt;/);
    expect(body).toMatch(/functionally equivalent posture \(publicly-trusted CA, auto-renewed\),/);
    expect(body).toMatch(/just a different CA\./);
  });

  it('Sub-processor map + deferred-items + founder-blocked + V-278 slice-index + commit-trail framing pinned', () => {
    expect(body).toMatch(/## Sub-processor map \(live; matches DPA Annex 3\)/);
    expect(body).toMatch(
      /- \*\*Hetzner Cloud\*\* \(Nuremberg NBG1\) — VM compute\. Production CPX32 \+/,
    );
    expect(body).toMatch(/staging CPX22\./);
    expect(body).toMatch(/- \*\*Neon\*\* \(Frankfurt eu-central-1\) — managed Postgres 17\./);
    expect(body).toMatch(/- \*\*Upstash\*\* \(eu-central\) — managed Redis 7\./);
    expect(body).toMatch(
      /- \*\*Cloudflare\*\* \(global, EU-jurisdiction R2\) — DNS \+ CDN \+ Pages \+/,
    );
    expect(body).toMatch(/Workers \+ R2, which IS wired into the API and holds customer data:/);
    // V-826 SENTINEL — a sub-processor register that under-declares a
    // processor holding customer data is the one direction that matters.
    expect(body, 'R2 is wired and holds customer data').not.toMatch(
      /R2 not yet wired into the API/,
    );
    expect(body).toMatch(/- \*\*Postmark\*\* \(US\) — transactional email; sender domain/);
    expect(body).toMatch(/`driftstack\.io` DKIM-verified\. Server "driftstack-transactional",/);
    expect(body).toMatch(/DeliveryType=Live\./);
    expect(body).toMatch(/- \*\*Sentry\*\* \(DE \/ EU region\) — error tracking\./);
    expect(body).toMatch(/- \*\*Stripe\*\* \(US, EU subsidiary for SCA\) — payment processing\./);
    expect(body).toMatch(/TEST-mode keys live; live keys swap in via SSH-write post-BV-KvK/);
    expect(body).toMatch(/closure \(~2026-05-21\)\./);
    expect(body).toMatch(
      /- \*\*Let's Encrypt\*\* \(CA used for origin TLS\) — added as a sub-processor/,
    );
    expect(body).toMatch(/in this slice; needs DPA Annex 3 update on next legal sweep/);
    expect(body).toMatch(/\(informational, no customer data flows through them\)\./);
    expect(body).toMatch(/## Deferred items \(post-checkpoint pickup\)/);
    expect(body).toMatch(
      /\| V-278\.J-2 \| Per-service Sentry projects \(driftstack-dashboard \+ driftstack-marketing\) via org auth token API\./,
    );
    expect(body).toMatch(
      /\| V-278\.K\s+\| Split shared Neon database into separate prod \+ staging Neon projects \(separate ep-host\)\./,
    );
    expect(body).toMatch(
      /\| V-278\.L\s+\| Split shared Upstash database into separate prod \+ staging Upstash databases \(separate URLs\)\./,
    );

    // V-870 — the rows above are a point-in-time record and stay verbatim; two
    // of them have since expired and the banner says which. Only the DURABLE
    // half of that banner is pinned: the checkpoint framing cannot go stale,
    // whereas pinning the expiry list would freeze a claim that dies as each
    // item is resolved — the V-865 mistake V-794 caught.
    expect(body, 'the document identifies itself as a checkpoint').toMatch(
      /⚠ V-870 — this is a CHECKPOINT, and parts of it have expired\./,
    );
    expect(body, 'and says why its tables are not edited to match today').toMatch(
      /a\s*\n?>?\s*point-in-time record that gets edited to match today stops being a record/,
    );
    expect(body).toMatch(
      /\| F-003\s+\| OAuth \(Google \/ GitHub\) signup \+ signin flow\. Tier-1; ~6h after founder unblock\./,
    );
    expect(body).toMatch(
      /\| Origin CA \| Switch from Let's Encrypt → Cloudflare Origin CA when founder shares the Origin CA Key\./,
    );
    expect(body).toMatch(
      /\| R2 wiring \| Wire R2 access keys into api `R2_\*` env vars to enable avatar upload \+ V-295c2 status snapshot\./,
    );
    expect(body).toMatch(/## Founder-blocked items/);
    expect(body).toMatch(/\| F-001 mobile UI \| Need device \+ URL \+ screenshot to reproduce;/);
    expect(body).toMatch(
      /\| F-003 OAuth\s+\| Founder registers OAuth apps at Google Cloud Console \+ GitHub Developer Settings;/,
    );
    expect(body).toMatch(
      /\| NowPayments\s+\| Crypto rail re-evaluation per ADR-002 — no provider chosen yet; not on critical-launch path\./,
    );
    expect(body).toMatch(
      /\| LiveKit\s+\| V-306-V-308 GUI client streaming; Agent 1 territory \+ LiveKit account provisioning\./,
    );
    expect(body).toMatch(
      /\| V-413 Tier-3\s+\| Audit IP\/UA leak in account-audit payloads — pending founder verdict on scrub strategy\./,
    );
    expect(body).toMatch(
      /\| BV KvK closure\s+\| ~2026-05-21; gates Stripe live-mode keys \+ commercial activation\. Test-mode wired today\./,
    );
    expect(body).toMatch(
      /\| Origin CA Key\s+\| Optional — only needed if founder wants Cloudflare Origin CA over Let's Encrypt for the origin leg\./,
    );
    expect(body).toMatch(/## V-278 slice index/);
    expect(body).toMatch(
      /\| V-278\.A\s+\| bootstrap\.sh \+ nginx vhosts \+ systemd unit \+ \.env templates committed\./,
    );
    expect(body).toMatch(
      /\| V-278\.A-2\s+\| Bootstrap executed via SSH on both Hetzner servers; Node 22 \+ nginx \+ UFW \+ fail2ban active\./,
    );
    expect(body).toMatch(
      /\| V-278\.B\s+\| Production API deployed; listening 127\.0\.0\.1:7780; \/health 200\./,
    );
    expect(body).toMatch(
      /\| V-278\.G\s+\| 38 Drizzle migrations applied to Neon \(33 public-schema tables\); fixed in-place migration 0028 broken table reference\./,
    );
    expect(body).toMatch(
      /\| V-278\.H\s+\| 6 DNS records live \(api\/app\/docs\/staging\/www\/apex CNAME-flattened\)\./,
    );
    expect(body).toMatch(
      /\| V-278\.I\s+\| 6\/6 public URLs HTTP 200 \(after Cloudflare SSL\/TLS Flexible flip\)\./,
    );
    expect(body).toMatch(
      /\| V-278\.J\s+\| Sentry DSN wired \(production driftstack-api project; Sentry initialized in boot logs\)\./,
    );
    expect(body).toMatch(
      /\| V-278\.M\s+\| Full \(strict\) TLS upgrade with Let's Encrypt origin certs \(DNS-01\)\./,
    );
    expect(body).toMatch(/## Commit trail \(this session, in order\)/);
    expect(body).toMatch(/85aee83\s+V-468: docs\/sdk\/installation — fold V-455 closure additions/);
    expect(body).toMatch(/9ed4cba\s+V-278\.B\/F production-deploy fixups \(live verified\)/);
    expect(body).toMatch(
      /b3fe4eb\s+V-278\.M: Full \(strict\) TLS upgrade — Let's Encrypt DNS-01 origin certs/,
    );
    expect(body).toMatch(/632a5f2\s+F-001\/F-002\/F-003: founder feedback inbox post-V-278\.M/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
