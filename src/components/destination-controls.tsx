'use client';

/**
 * Destination registration and approval controls (TRD §5, §13).
 *
 * Approving requires a written reference. Revoking asks for a reason and warns
 * that live links stop redirecting immediately, because they do.
 */

import {
  approveDestinationAction, createDestinationAction, rejectDestinationAction, revokeDestinationAction,
} from '@/server/actions';
import { ActionForm, Field, Select, SubmitButton, TextArea, TextInput } from './form';

export function DestinationForm({
  publishers,
}: {
  publishers: { value: string; label: string }[];
}) {
  return (
    <ActionForm action={createDestinationAction}>
      {(state) => (
        <>
          <div className="form-grid">
            <Field label="Label" name="label" hint="A name people will recognise in the link form.">
              <TextInput name="label" placeholder="Welcome promo landing" />
            </Field>

            <Field label="Type" name="type" required error={state.fields?.type}>
              <Select
                name="type"
                required
                defaultValue={state.values?.type ?? 'website'}
                options={[
                  { value: 'website', label: 'Website' },
                  { value: 'whatsapp', label: 'WhatsApp' },
                ]}
                error={state.fields?.type}
              />
            </Field>

            <Field
              label="URL"
              name="url"
              required
              wide
              error={state.fields?.url}
              hint="Must be https and on an allowlisted host. The URL cannot be edited later — register a new destination and move the link instead, so historical clicks keep their original target."
            >
              <TextInput
                name="url" type="url" required
                placeholder="https://www.betindia.bet/promo/welcome"
                defaultValue={state.values?.url ?? ''}
                error={state.fields?.url}
              />
            </Field>

            <Field
              label="Restrict to publisher"
              name="publisherId"
              hint="Optional. A publisher-scoped destination is only offered on that publisher's campaigns."
            >
              <Select name="publisherId" placeholder="Any publisher" options={publishers} />
            </Field>

            <Field label="Approval reference" name="approvalReference" hint="Can be added now or at approval time.">
              <TextInput name="approvalReference" />
            </Field>

            <Field label="Notes" name="approvalNotes" wide>
              <TextArea name="approvalNotes" />
            </Field>
          </div>

          <div className="row">
            <SubmitButton>Register destination</SubmitButton>
            <span className="small muted">Registered as pending. It cannot receive traffic until approved.</span>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function ApproveForm({ id }: { id: string }) {
  return (
    <ActionForm action={approveDestinationAction} className="stack stack--tight">
      {(state) => (
        <>
          <input type="hidden" name="id" value={id} />
          <Field
            label="Publisher approval reference"
            name={`approvalReference-${id}`}
            required
            error={state.fields?.approvalReference}
            hint="TRD §13 requires recorded approval evidence."
          >
            <input
              id={`approvalReference-${id}`}
              name="approvalReference"
              required
              placeholder="Email 12 Sep / IO-2291"
              aria-invalid={state.fields?.approvalReference ? 'true' : undefined}
            />
          </Field>
          <SubmitButton variant="primary" confirm="Approve this destination? Links may then send live traffic to it.">
            Approve
          </SubmitButton>
        </>
      )}
    </ActionForm>
  );
}

export function RejectForm({ id, mode }: { id: string; mode: 'reject' | 'revoke' }) {
  const revoking = mode === 'revoke';

  return (
    <ActionForm action={revoking ? revokeDestinationAction : rejectDestinationAction} className="stack stack--tight">
      {(state) => (
        <>
          <input type="hidden" name="id" value={id} />
          <Field
            label="Reason"
            name={`approvalNotes-${id}`}
            required
            error={state.fields?.approvalNotes}
          >
            <input
              id={`approvalNotes-${id}`}
              name="approvalNotes"
              required
              placeholder={revoking ? 'Publisher withdrew approval' : 'Not approved by publisher'}
              aria-invalid={state.fields?.approvalNotes ? 'true' : undefined}
            />
          </Field>
          <SubmitButton
            variant="danger"
            confirm={
              revoking
                ? 'Withdraw this approval? Every link pointing at it stops redirecting immediately.'
                : 'Reject this destination?'
            }
          >
            {revoking ? 'Withdraw approval' : 'Reject'}
          </SubmitButton>
        </>
      )}
    </ActionForm>
  );
}
