/**
 * Shared shape for Server Action results.
 *
 * UI/UX §6: "Show validation inline and preserve form data after errors." A
 * ServiceError already carries per-field messages, so the same error a REST
 * caller receives as JSON becomes the inline messages on the form.
 */

import { ServiceError } from '@/lib/errors';

export interface FormState {
  ok: boolean;
  message?: string;
  fields?: Record<string, string>;
  /** Echoed back so the form can repopulate without a client-side store. */
  values?: Record<string, string>;
}

export const IDLE: FormState = { ok: false };

export function formValues(data: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of data.entries()) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/**
 * Runs a mutation and converts any failure into a FormState.
 *
 * Unexpected errors are logged server-side and reported generically — an
 * internal message must not reach the browser (TRD §14).
 */
export async function runAction(
  data: FormData,
  fn: () => Promise<void | FormState>,
): Promise<FormState> {
  try {
    const result = await fn();
    return result ?? { ok: true };
  } catch (err) {
    if (err instanceof ServiceError) {
      return {
        ok: false,
        message: err.message,
        fields: Object.keys(err.fields).length ? err.fields : undefined,
        values: formValues(data),
      };
    }
    // A redirect() inside an action throws by design; let it through.
    if (isRedirectError(err)) throw err;
    console.error('[action] unhandled error:', err);
    return { ok: false, message: 'Something went wrong. Try again.', values: formValues(data) };
  }
}

function isRedirectError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'digest' in err &&
    typeof (err as { digest: unknown }).digest === 'string' &&
    (err as { digest: string }).digest.startsWith('NEXT_REDIRECT')
  );
}

/** FormData → plain object, with checkboxes and multi-selects handled. */
export function toPayload(
  data: FormData,
  options: { booleans?: string[]; arrays?: string[]; numbers?: string[] } = {},
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  for (const [key, value] of data.entries()) {
    if (typeof value !== 'string') continue;
    if (options.arrays?.includes(key)) {
      (payload[key] as string[] | undefined) ??= [];
      (payload[key] as string[]).push(value);
      continue;
    }
    payload[key] = value;
  }

  // An unchecked checkbox sends nothing at all, which must read as false
  // rather than "unchanged" — otherwise a permission can never be withdrawn.
  for (const key of options.booleans ?? []) {
    payload[key] = data.get(key) === 'on' || data.get(key) === 'true';
  }
  for (const key of options.arrays ?? []) {
    payload[key] ??= [];
  }
  for (const key of options.numbers ?? []) {
    if (typeof payload[key] === 'string' && payload[key] !== '') payload[key] = Number(payload[key]);
  }

  return payload;
}
