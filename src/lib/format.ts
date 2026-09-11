/**
 * Display formatting.
 *
 * Project convention: UTC in the database, IST at display time. Every date the
 * UI renders goes through here, so a timestamp is never shown in whatever
 * timezone the viewer's machine happens to be set to.
 */

export const DISPLAY_TIMEZONE = process.env.DISPLAY_TIMEZONE ?? 'Asia/Kolkata';
export const DISPLAY_LOCALE = 'en-IN';

const dateTimeFormatter = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  timeZone: DISPLAY_TIMEZONE,
  year: 'numeric', month: 'short', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

const dateFormatter = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  timeZone: DISPLAY_TIMEZONE,
  year: 'numeric', month: 'short', day: '2-digit',
});

export function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${dateTimeFormatter.format(date)} IST`;
}

export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return dateFormatter.format(date);
}

/**
 * Renders a metric value.
 *
 * `null` becomes N/A, never 0 — UI/UX §4 is explicit that an unavailable
 * metric must not be displayed as zero.
 */
export function formatMetric(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'N/A';
  return new Intl.NumberFormat(DISPLAY_LOCALE).format(value);
}

export function formatMoney(
  value: number | string | null | undefined,
  currency = 'INR',
): string {
  if (value === null || value === undefined || value === '') return 'N/A';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 'N/A';
  return new Intl.NumberFormat(DISPLAY_LOCALE, {
    style: 'currency', currency, maximumFractionDigits: 2,
  }).format(n);
}

/** Percentages with a zero denominator are N/A, not 0% (PRD §10). */
export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
  return `${value.toFixed(digits)}%`;
}

export function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  return (numerator / denominator) * 100;
}

/**
 * Masks a phone number for display (UI/UX §8, §9).
 *
 * Keeps the country code and the last two digits, which is enough to match
 * against a support conversation without putting the number on screen.
 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '—';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6) return '••••';
  const lead = phone.startsWith('+') ? `+${digits.slice(0, 2)}` : digits.slice(0, 2);
  return `${lead} ••••• ${digits.slice(-2)}`;
}

/** Today and N days ago as YYYY-MM-DD, for default filter values. */
export function defaultDateRange(days = 30): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - (days - 1) * 86_400_000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

export function titleCase(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
