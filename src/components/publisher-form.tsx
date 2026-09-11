'use client';

/**
 * Publisher create / edit form (UI/UX §5).
 *
 * Every permission is an explicit, recorded decision. Unchecked means "not
 * approved", never "unknown but probably fine" — PRD §11.
 */

import { createPublisherAction, updatePublisherAction } from '@/server/actions';
import { ActionForm, CheckLine, Field, Select, SubmitButton, TextArea, TextInput } from './form';

export interface PublisherFormValues {
  id?: string;
  name?: string;
  status?: string;
  externalReference?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  permittedDestinationTypes?: string[];
  trackingMacros?: string[];
  trackingUrlApproved?: boolean;
  scriptsAllowed?: boolean;
  postbacksAllowed?: boolean;
  destinationChangePolicy?: string | null;
  approvalEvidence?: string | null;
  reportingAccessNotes?: string | null;
  eligibility?: string;
  notes?: string | null;
}

export function PublisherForm({ publisher }: { publisher?: PublisherFormValues }) {
  const editing = Boolean(publisher?.id);

  return (
    <ActionForm action={editing ? updatePublisherAction : createPublisherAction}>
      {(state) => {
        const v = (key: keyof PublisherFormValues) =>
          state.values?.[key as string] ?? (publisher?.[key] as string | undefined) ?? '';

        return (
          <>
            {editing && <input type="hidden" name="id" value={publisher!.id} />}

            <div className="form-grid">
              <Field label="Publisher name" name="name" required error={state.fields?.name}>
                <TextInput name="name" required defaultValue={v('name')} error={state.fields?.name} />
              </Field>

              <Field label="Status" name="status">
                <Select
                  name="status"
                  defaultValue={v('status') || 'active'}
                  options={[
                    { value: 'active', label: 'Active' },
                    { value: 'paused', label: 'Paused' },
                    { value: 'archived', label: 'Archived' },
                  ]}
                />
              </Field>

              <Field
                label="Eligibility"
                name="eligibility"
                hint="TRD §13: mark ineligible if the campaign category or destination is prohibited on this inventory."
              >
                <Select
                  name="eligibility"
                  defaultValue={v('eligibility') || 'unconfirmed'}
                  options={[
                    { value: 'unconfirmed', label: 'Unconfirmed — cannot run yet' },
                    { value: 'eligible', label: 'Eligible' },
                    { value: 'ineligible', label: 'Ineligible' },
                  ]}
                />
              </Field>

              <Field label="External reference" name="externalReference" hint="Their account or IO number.">
                <TextInput name="externalReference" defaultValue={v('externalReference')} />
              </Field>

              <Field label="Contact name" name="contactName">
                <TextInput name="contactName" defaultValue={v('contactName')} />
              </Field>

              <Field label="Contact email" name="contactEmail" error={state.fields?.contactEmail}>
                <TextInput name="contactEmail" type="email" defaultValue={v('contactEmail')} error={state.fields?.contactEmail} />
              </Field>
            </div>

            <fieldset style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-card)', padding: 'var(--s5)' }}>
              <legend style={{ padding: '0 8px', fontWeight: 600, fontSize: 14 }}>
                Written approvals (PRD §11, TRD §13)
              </legend>

              <div className="stack">
                <CheckLine
                  name="trackingUrlApproved"
                  label="This publisher has approved our tracking URL in writing"
                  hint="Without this, no campaign on this publisher can be activated."
                  defaultChecked={publisher?.trackingUrlApproved}
                />

                <div className="field">
                  <span className="field__label">Approved destination types</span>
                  <span className="field__hint">
                    Leave both unchecked if nothing has been approved. Empty never means &ldquo;all&rdquo;.
                  </span>
                  <label className="checkline" htmlFor="dest-website">
                    <input
                      type="checkbox" id="dest-website" name="permittedDestinationTypes" value="website"
                      defaultChecked={publisher?.permittedDestinationTypes?.includes('website')}
                    />
                    <span className="checkline__text">Website</span>
                  </label>
                  <label className="checkline" htmlFor="dest-whatsapp">
                    <input
                      type="checkbox" id="dest-whatsapp" name="permittedDestinationTypes" value="whatsapp"
                      defaultChecked={publisher?.permittedDestinationTypes?.includes('whatsapp')}
                    />
                    <span className="checkline__text">WhatsApp</span>
                  </label>
                </div>

                <Field
                  label="Supported click macros"
                  name="trackingMacros"
                  hint="Comma separated parameter names they will send, e.g. pcid, subid. Only these are read from an inbound click."
                  error={state.fields?.trackingMacros}
                >
                  <TextInput
                    name="trackingMacros"
                    defaultValue={state.values?.trackingMacros ?? publisher?.trackingMacros?.join(', ') ?? ''}
                    placeholder="pcid, subid"
                  />
                </Field>

                <CheckLine
                  name="scriptsAllowed"
                  label="Third-party scripts, pixels or tags are permitted"
                  defaultChecked={publisher?.scriptsAllowed}
                />
                <CheckLine
                  name="postbacksAllowed"
                  label="Conversion postbacks to this publisher are permitted"
                  hint="Postbacks must use approved fields only and minimise personal data (TRD §13)."
                  defaultChecked={publisher?.postbacksAllowed}
                />

                <Field
                  label="Destination-change rules"
                  name="destinationChangePolicy"
                  hint="What this publisher requires before a live destination may change."
                  wide
                >
                  <TextArea name="destinationChangePolicy" defaultValue={v('destinationChangePolicy')} />
                </Field>

                <Field
                  label="Approval evidence"
                  name="approvalEvidence"
                  hint="Email reference, contract clause or ticket number backing the approvals above."
                  wide
                >
                  <TextArea name="approvalEvidence" defaultValue={v('approvalEvidence')} />
                </Field>

                <Field label="Reporting access" name="reportingAccessNotes" hint="How their impressions and spend are obtained." wide>
                  <TextArea name="reportingAccessNotes" defaultValue={v('reportingAccessNotes')} />
                </Field>
              </div>
            </fieldset>

            <Field label="Notes" name="notes" wide>
              <TextArea name="notes" defaultValue={v('notes')} />
            </Field>

            <div className="row">
              <SubmitButton>{editing ? 'Save changes' : 'Create publisher'}</SubmitButton>
            </div>
          </>
        );
      }}
    </ActionForm>
  );
}
