'use client';

/**
 * Form primitives (UI/UX §15: FormField, ConfirmationDialog, ExportAction).
 *
 * The only client components in the admin UI. Everything else renders on the
 * server, which keeps authoritative numbers off the browser (§15: "do not
 * calculate authoritative financial metrics only in the browser").
 */

import { useActionState, useId, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { IDLE, type FormState } from '@/server/form-state';

type Action = (prev: FormState, data: FormData) => Promise<FormState>;

export function Field({
  label, name, children, hint, error, required, wide,
}: {
  label: string;
  name: string;
  children: ReactNode;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  wide?: boolean;
}) {
  const hintId = useId();
  return (
    <div className={`field${wide ? ' field--wide' : ''}`}>
      <label className="field__label" htmlFor={name}>
        {label}
        {required && <span className="field__req" aria-hidden>*</span>}
        {required && <span className="visually-hidden"> (required)</span>}
      </label>
      {children}
      {hint && <span className="field__hint" id={hintId}>{hint}</span>}
      {error && <span className="field__error" role="alert">{error}</span>}
    </div>
  );
}

export function TextInput({
  name, error, ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { name: string; error?: string }) {
  return <input id={name} name={name} aria-invalid={error ? 'true' : undefined} {...props} />;
}

export function TextArea({
  name, error, ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { name: string; error?: string }) {
  return <textarea id={name} name={name} aria-invalid={error ? 'true' : undefined} {...props} />;
}

export function Select({
  name, error, options, placeholder, ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & {
  name: string;
  error?: string;
  options: { value: string; label: string; disabled?: boolean }[];
  placeholder?: string;
}) {
  return (
    <select id={name} name={name} aria-invalid={error ? 'true' : undefined} {...props}>
      {placeholder && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>
      ))}
    </select>
  );
}

export function CheckLine({
  name, label, hint, defaultChecked,
}: { name: string; label: string; hint?: ReactNode; defaultChecked?: boolean }) {
  return (
    <label className="checkline" htmlFor={name}>
      <input type="checkbox" id={name} name={name} defaultChecked={defaultChecked} />
      <span className="checkline__text">
        {label}
        {hint && <span className="checkline__hint">{hint}</span>}
      </span>
    </label>
  );
}

export function SubmitButton({
  children, variant = 'primary', confirm,
}: { children: ReactNode; variant?: 'primary' | 'default' | 'danger'; confirm?: string }) {
  const { pending } = useFormStatus();
  const className =
    variant === 'primary' ? 'btn btn--primary' : variant === 'danger' ? 'btn btn--danger' : 'btn';

  return (
    <button
      type="submit"
      className={className}
      disabled={pending}
      // §14 requires a confirmation step on consequential actions. A native
      // confirm keeps it keyboard-accessible with no dialog state to manage.
      onClick={confirm ? (e) => { if (!window.confirm(confirm)) e.preventDefault(); } : undefined}
    >
      {pending ? 'Working…' : children}
    </button>
  );
}

/**
 * Wraps a Server Action, surfaces its result and exposes per-field errors to
 * the fields inside it.
 */
export function ActionForm({
  action, children, className = 'form', successTone = 'ok',
}: {
  action: Action;
  children: (state: FormState) => ReactNode;
  className?: string;
  successTone?: 'ok' | 'info';
}) {
  const [state, formAction] = useActionState(action, IDLE);

  return (
    <form action={formAction} className={className} noValidate>
      {state.message && (
        <div
          className={`notice notice--${state.ok ? successTone : 'danger'}`}
          role={state.ok ? 'status' : 'alert'}
        >
          <div>{state.message}</div>
        </div>
      )}
      {children(state)}
    </form>
  );
}

/** A one-button form for a status change or an approval. */
export function InlineAction({
  action, hidden, label, variant = 'default', confirm,
}: {
  action: Action;
  hidden: Record<string, string>;
  label: string;
  variant?: 'primary' | 'default' | 'danger';
  confirm?: string;
}) {
  const [state, formAction] = useActionState(action, IDLE);

  return (
    <form action={formAction} className="row">
      {Object.entries(hidden).map(([key, value]) => (
        <input key={key} type="hidden" name={key} value={value} />
      ))}
      <SubmitButton variant={variant} confirm={confirm}>{label}</SubmitButton>
      {state.message && (
        <span className={state.ok ? 'small muted' : 'field__error'} role="status">{state.message}</span>
      )}
    </form>
  );
}

/** Copies a smart link URL to the clipboard (UI/UX §7 "copy"). */
export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  return (
    <button
      type="button"
      className="btn btn--sm"
      onClick={async (e) => {
        const button = e.currentTarget;
        try {
          await navigator.clipboard.writeText(value);
          const original = button.textContent;
          button.textContent = 'Copied';
          setTimeout(() => { button.textContent = original; }, 1500);
        } catch {
          button.textContent = 'Copy failed';
        }
      }}
    >
      {label}
    </button>
  );
}
