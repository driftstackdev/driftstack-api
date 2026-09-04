// V-661 / V-550 — sub-processor RSS feed for trust-center subscribers.
//
// Customers + auditors who need to know when our sub-processor list
// changes (Article 28(2) notice cadence) can subscribe to this feed
// rather than re-checking the trust page. One <item> per
// SUB_PROCESSOR_CHANGELOG entry, newest first.
//
// Astro static-output endpoint: emits XML at build time, served by
// Cloudflare Pages at /trust/sub-processors/feed.xml.
import type { APIRoute } from 'astro';
import {
  SUB_PROCESSOR_CHANGELOG,
  type SubProcessorChangeLogEntry,
} from '../../../data/sub-processors.ts';

const SITE = 'https://driftstack.io';
const FEED_URL = `${SITE}/trust/sub-processors/feed.xml`;
const PAGE_URL = `${SITE}/trust/sub-processors`;

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case "'":
        return '&apos;';
      case '"':
        return '&quot;';
      default:
        return c;
    }
  });
}

function kindLabel(kind: SubProcessorChangeLogEntry['kind']): string {
  switch (kind) {
    case 'added':
      return 'Sub-processor added';
    case 'removed':
      return 'Sub-processor removed';
    case 'material_change':
      return 'Material change';
    case 'register_published':
      return 'Register published';
  }
}

function entryTitle(e: SubProcessorChangeLogEntry): string {
  if (e.kind === 'register_published') return kindLabel(e.kind);
  return `${kindLabel(e.kind)}: ${e.subject || '(no subject)'}`;
}

function entryGuid(e: SubProcessorChangeLogEntry): string {
  // Stable per-entry id — date + kind + subject is unique under the
  // current cadence (one change per day per sub-processor). RSS clients
  // dedupe on this.
  const slug = e.subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${FEED_URL}#${e.date}-${e.kind}${slug ? `-${slug}` : ''}`;
}

function rfc822Date(isoDate: string): string {
  // Inputs are YYYY-MM-DD; render at 00:00 UTC.
  const d = new Date(`${isoDate}T00:00:00Z`);
  return d.toUTCString();
}

export const GET: APIRoute = () => {
  const sorted = [...SUB_PROCESSOR_CHANGELOG].sort((a, b) => b.date.localeCompare(a.date));
  const latestDate = sorted[0]?.date ?? '2026-01-01';
  const items = sorted
    .map((e) => {
      const description = `<![CDATA[<p><strong>Effective ${escapeXml(e.effective_at)}</strong></p><p>${escapeXml(e.summary)}</p>]]>`;
      return `    <item>
      <title>${escapeXml(entryTitle(e))}</title>
      <link>${PAGE_URL}</link>
      <guid isPermaLink="false">${escapeXml(entryGuid(e))}</guid>
      <pubDate>${rfc822Date(e.date)}</pubDate>
      <category>${escapeXml(e.kind)}</category>
      <description>${description}</description>
    </item>`;
    })
    .join('\n');

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Driftstack sub-processor changes</title>
    <link>${PAGE_URL}</link>
    <atom:link href="${FEED_URL}" rel="self" type="application/rss+xml" />
    <description>Article 28(2) sub-processor amendment notices for Driftstack. One item per entry in SUB_PROCESSOR_CHANGELOG, newest first. Subscribe to be notified when the register changes.</description>
    <language>en-us</language>
    <lastBuildDate>${rfc822Date(latestDate)}</lastBuildDate>
${items}
  </channel>
</rss>
`;
  return new Response(body, {
    headers: {
      'content-type': 'application/rss+xml; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
};
