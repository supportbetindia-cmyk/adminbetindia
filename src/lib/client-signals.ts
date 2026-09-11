/**
 * Device, OS and bot signals derived from the request.
 *
 * PRD §5: bot and fraud signals are *recorded*, never used to silently alter
 * raw click counts. Filtering happens at report time from these columns, so
 * the raw event table always reconciles with what actually hit the endpoint.
 *
 * Deliberately dependency-free and regex-based: this runs on the redirect hot
 * path, where the p95 budget is 300 ms end to end (TRD §15).
 */

export type DeviceType = 'mobile' | 'tablet' | 'desktop' | 'unknown';

export interface ClientSignals {
  deviceType: DeviceType;
  os: string | null;
  botScore: number;
  botFlags: string[];
  isFiltered: boolean;
}

/**
 * Link-preview fetchers. These hit the URL whenever someone shares or forwards
 * the link — in WhatsApp, in a Facebook post, in Slack. They are not people and
 * would otherwise inflate click counts, which matters a great deal for a
 * campaign whose destination *is* WhatsApp.
 */
const PREVIEW_FETCHERS = [
  /facebookexternalhit/i,
  /facebookcatalog/i,
  /WhatsApp/i,
  /TelegramBot/i,
  /Twitterbot/i,
  /Slackbot/i,
  /LinkedInBot/i,
  /Discordbot/i,
  /SkypeUriPreview/i,
  /redditbot/i,
  /Google-InspectionTool/i,
];

const GENERIC_BOTS = [
  /\bbot\b/i,
  /spider/i,
  /crawler/i,
  /crawling/i,
  /scrapy/i,
  /curl\//i,
  /wget/i,
  /python-requests/i,
  /python-urllib/i,
  /go-http-client/i,
  /java\//i,
  /okhttp/i,
  /axios\//i,
  /node-fetch/i,
  /headlesschrome/i,
  /phantomjs/i,
  /puppeteer/i,
  /playwright/i,
  /lighthouse/i,
  /monitoring/i,
  /uptime/i,
  /pingdom/i,
  /ahrefs/i,
  /semrush/i,
];

export interface SignalInput {
  userAgent: string | null;
  /** Values of Purpose / X-Purpose / Sec-Purpose, if present. */
  purposeHeaders: (string | null)[];
  method: string;
}

export function deriveClientSignals(input: SignalInput): ClientSignals {
  const ua = input.userAgent ?? '';
  const flags: string[] = [];
  let score = 0;

  // ── device and OS ────────────────────────────────────────────
  let os: string | null = null;
  if (/android/i.test(ua)) os = 'Android';
  else if (/iphone|ipad|ipod/i.test(ua)) os = 'iOS';
  else if (/windows nt/i.test(ua)) os = 'Windows';
  else if (/mac os x/i.test(ua)) os = 'macOS';
  else if (/cros/i.test(ua)) os = 'ChromeOS';
  else if (/linux/i.test(ua)) os = 'Linux';

  let deviceType: DeviceType = 'unknown';
  if (/ipad|tablet|playbook|silk|(android(?!.*mobile))/i.test(ua)) deviceType = 'tablet';
  else if (/mobi|iphone|ipod|android.*mobile|windows phone/i.test(ua)) deviceType = 'mobile';
  else if (ua) deviceType = 'desktop';

  // ── bot and non-human signals ────────────────────────────────
  if (!ua.trim()) {
    flags.push('missing_user_agent');
    score = Math.max(score, 0.9);
  }

  if (PREVIEW_FETCHERS.some((re) => re.test(ua))) {
    flags.push('link_preview_fetcher');
    score = Math.max(score, 0.95);
  }

  if (GENERIC_BOTS.some((re) => re.test(ua))) {
    flags.push('known_bot_agent');
    score = Math.max(score, 0.9);
  }

  // Browser prefetch: the user has not chosen to go anywhere yet.
  const purpose = input.purposeHeaders.filter(Boolean).join(' ').toLowerCase();
  if (purpose.includes('prefetch') || purpose.includes('preview') || purpose.includes('prerender')) {
    flags.push('prefetch');
    score = Math.max(score, 0.8);
  }

  // HEAD is never a human clicking a banner.
  if (input.method.toUpperCase() === 'HEAD') {
    flags.push('head_request');
    score = Math.max(score, 0.85);
  }

  return {
    deviceType,
    os,
    botScore: score,
    botFlags: flags,
    // A convenience flag for reporting. The row is still written either way.
    isFiltered: score >= 0.8,
  };
}

/**
 * First client IP from proxy headers. Trust only the leftmost entry of
 * x-forwarded-for when the app sits behind a known proxy; behind an untrusted
 * network this header is spoofable and is treated as a weak signal only.
 */
export function clientIpFrom(headers: Headers): string | null {
  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return headers.get('x-real-ip') ?? headers.get('cf-connecting-ip') ?? null;
}
