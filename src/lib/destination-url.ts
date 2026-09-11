/**
 * Destination URL handling.
 *
 * TRD §5 is explicit: use an allowlisted HTTPS destination registry, prevent
 * open redirects, and reject arbitrary user-supplied destination URLs. The
 * destination therefore comes only from the `destinations` table — never from
 * a query parameter, header, or anything else the caller controls.
 *
 * "Preserve approved tracking parameters only" (TRD §5) is read strictly here:
 * we do not forward the publisher's inbound query string to the destination.
 * Inbound parameters are captured on the click record instead. Forwarding them
 * blind would leak publisher macros and any stray personal data into the
 * destination URL, which Backend Schema §8 forbids.
 */

export type DestinationKind = 'website' | 'whatsapp';

export class UnsafeDestinationError extends Error {}

/** Hosts a destination is permitted to point at. Defence in depth behind the registry. */
function allowedHosts(): string[] {
  const raw = process.env.DESTINATION_HOST_ALLOWLIST ?? '';
  const configured = raw.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (configured.length > 0) return configured;
  return ['betindia.bet', 'www.betindia.bet', 'wa.me', 'api.whatsapp.com'];
}

function hostAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return allowedHosts().some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/**
 * Validates a stored destination before it is ever used in a Location header.
 * Runs on every redirect, not just at save time — a row could have been changed
 * by a path that bypassed validation.
 */
export function assertSafeDestination(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeDestinationError(`Destination is not a valid URL: ${url}`);
  }

  if (parsed.protocol !== 'https:') {
    throw new UnsafeDestinationError(`Destination must use https, got ${parsed.protocol}`);
  }

  if (parsed.username || parsed.password) {
    throw new UnsafeDestinationError('Destination must not contain credentials');
  }

  if (!hostAllowed(parsed.hostname)) {
    throw new UnsafeDestinationError(`Destination host is not allowlisted: ${parsed.hostname}`);
  }

  return parsed;
}

export interface BuildRedirectInput {
  destinationUrl: string;
  kind: DestinationKind;
  clickId: string;
  /**
   * Campaign reference injected into a WhatsApp prefilled message.
   *
   * UNVERIFIED MECHANISM. PRD §7 and TRD §8 require that this be tested against
   * real Interakt payloads before it is relied on: the code may not survive
   * into the inbound webhook, and the user can delete the prefilled text before
   * sending. Until that test passes, treat WhatsApp attribution as campaign
   * level at best.
   */
  campaignReference?: string | null;
  /** Query parameter carrying the click ID to our own website. */
  clickParam?: string;
}

export function buildRedirectUrl(input: BuildRedirectInput): string {
  const url = assertSafeDestination(input.destinationUrl);
  const clickParam = input.clickParam ?? process.env.CLICK_QUERY_PARAM ?? 'bi_click';

  if (input.kind === 'website') {
    // Our own domain, so attaching the click ID is first-party and necessary
    // for the website SDK to associate the landing session (TRD §7).
    url.searchParams.set(clickParam, input.clickId);
    return url.toString();
  }

  // WhatsApp: the only carrier available is the prefilled message body.
  if (input.campaignReference) {
    const existing = url.searchParams.get('text') ?? '';
    const reference = `[${input.campaignReference}]`;
    if (!existing.includes(reference)) {
      url.searchParams.set('text', existing ? `${existing} ${reference}` : reference);
    }
  }
  return url.toString();
}
