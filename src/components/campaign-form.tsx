'use client';

/**
 * Campaign create / edit form (UI/UX §6).
 *
 * Creation always produces a Draft. Activation is a separate action on the
 * detail page, because it has preconditions a form field cannot express.
 */

import { createCampaignAction, updateCampaignAction } from '@/server/actions';
import { ActionForm, Field, Select, SubmitButton, TextArea, TextInput } from './form';

export interface CampaignFormValues {
  id?: string;
  publisherId?: string;
  name?: string;
  placement?: string | null;
  startsAt?: Date | string | null;
  endsAt?: Date | string | null;
  timezone?: string;
  currency?: string;
  budgetAmount?: string | null;
  attributionWindowDays?: number;
  approvalReference?: string | null;
  notes?: string | null;
}

/** `datetime-local` needs YYYY-MM-DDTHH:mm with no timezone suffix. */
function toLocalInput(value: Date | string | null | undefined): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 16);
}

export function CampaignForm({
  campaign, publishers,
}: {
  campaign?: CampaignFormValues;
  publishers: { value: string; label: string; disabled?: boolean }[];
}) {
  const editing = Boolean(campaign?.id);

  return (
    <ActionForm action={editing ? updateCampaignAction : createCampaignAction}>
      {(state) => {
        const v = (key: keyof CampaignFormValues) =>
          state.values?.[key as string] ?? (campaign?.[key] as string | undefined) ?? '';

        return (
          <>
            {editing && <input type="hidden" name="id" value={campaign!.id} />}

            <div className="form-grid">
              {!editing && (
                <Field
                  label="Publisher"
                  name="publisherId"
                  required
                  error={state.fields?.publisherId}
                  hint="A campaign belongs to exactly one publisher and cannot be moved later."
                >
                  <Select
                    name="publisherId"
                    required
                    placeholder="Select a publisher"
                    defaultValue={v('publisherId')}
                    options={publishers}
                    error={state.fields?.publisherId}
                  />
                </Field>
              )}

              <Field label="Campaign name" name="name" required error={state.fields?.name}>
                <TextInput name="name" required defaultValue={v('name')} error={state.fields?.name} />
              </Field>

              <Field label="Placement / inventory" name="placement" hint="Where the banner runs on their property.">
                <TextInput name="placement" defaultValue={v('placement')} />
              </Field>

              <Field label="Start" name="startsAt" error={state.fields?.startsAt} hint="Stored in UTC, displayed in IST.">
                <TextInput
                  name="startsAt" type="datetime-local"
                  defaultValue={state.values?.startsAt ?? toLocalInput(campaign?.startsAt)}
                  error={state.fields?.startsAt}
                />
              </Field>

              <Field label="End" name="endsAt" error={state.fields?.endsAt} hint="Cannot be before the start.">
                <TextInput
                  name="endsAt" type="datetime-local"
                  defaultValue={state.values?.endsAt ?? toLocalInput(campaign?.endsAt)}
                  error={state.fields?.endsAt}
                />
              </Field>

              <Field label="Currency" name="currency" error={state.fields?.currency}>
                <TextInput name="currency" maxLength={3} defaultValue={v('currency') || 'INR'} error={state.fields?.currency} />
              </Field>

              <Field
                label="Planned budget"
                name="budgetAmount"
                error={state.fields?.budgetAmount}
                hint="Planned only. Actual spend is recorded separately and the two are never added together."
              >
                <TextInput name="budgetAmount" type="number" min="0" step="0.01" defaultValue={v('budgetAmount')} error={state.fields?.budgetAmount} />
              </Field>

              <Field
                label="Attribution window (days)"
                name="attributionWindowDays"
                error={state.fields?.attributionWindowDays}
                hint="TRD §10 proposes 30 days, subject to business approval. Not yet approved."
              >
                <TextInput
                  name="attributionWindowDays" type="number" min="1" max="90"
                  defaultValue={state.values?.attributionWindowDays ?? String(campaign?.attributionWindowDays ?? 30)}
                  error={state.fields?.attributionWindowDays}
                />
              </Field>

              <Field label="Approval reference" name="approvalReference" hint="Publisher approval reference for this campaign.">
                <TextInput name="approvalReference" defaultValue={v('approvalReference')} />
              </Field>

              <Field label="Notes" name="notes" wide>
                <TextArea name="notes" defaultValue={v('notes')} />
              </Field>
            </div>

            <div className="row">
              <SubmitButton>{editing ? 'Save changes' : 'Create as draft'}</SubmitButton>
              {!editing && (
                <span className="small muted">
                  New campaigns start in Draft. Activation requires an approved destination.
                </span>
              )}
            </div>
          </>
        );
      }}
    </ActionForm>
  );
}
