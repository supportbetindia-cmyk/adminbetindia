'use client';

/**
 * Smart link creation and lifecycle controls (UI/UX §7).
 *
 * Deletion is offered only for links with no click history.
 */

import { useState } from 'react';
import {
  changeDestinationAction, createSmartLinkAction, deleteSmartLinkAction, setSmartLinkStatusAction,
} from '@/server/actions';
import { ActionForm, CopyButton, Field, InlineAction, Select, SubmitButton, TextArea, TextInput } from './form';

export interface DestinationOption {
  value: string;
  label: string;
  url: string;
  type: string;
}

export function SmartLinkForm({
  campaigns, destinations, creatives, defaultCampaignId, baseUrl,
}: {
  campaigns: { value: string; label: string }[];
  destinations: DestinationOption[];
  creatives: { value: string; label: string }[];
  defaultCampaignId?: string;
  baseUrl: string;
}) {
  const [slug, setSlug] = useState('');
  const [destinationId, setDestinationId] = useState(destinations[0]?.value ?? '');
  const chosen = destinations.find((d) => d.value === destinationId);

  return (
    <ActionForm action={createSmartLinkAction}>
      {(state) => (
        <>
          <div className="form-grid">
            <Field label="Campaign" name="campaignId" required error={state.fields?.campaignId}>
              <Select
                name="campaignId"
                required
                placeholder="Select a campaign"
                defaultValue={state.values?.campaignId ?? defaultCampaignId ?? ''}
                options={campaigns}
                error={state.fields?.campaignId}
              />
            </Field>

            <Field
              label="Approved destination"
              name="destinationId"
              required
              error={state.fields?.destinationId}
              hint="Only approved destinations appear here."
            >
              <Select
                name="destinationId"
                required
                placeholder="Select a destination"
                value={destinationId}
                onChange={(e) => setDestinationId(e.target.value)}
                options={destinations}
                error={state.fields?.destinationId}
              />
            </Field>

            <Field
              label="Slug"
              name="slug"
              required
              error={state.fields?.slug}
              hint="Lowercase letters, numbers, hyphens and underscores. This appears in the public URL."
            >
              <TextInput
                name="slug"
                required
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="crex-ipl-sep01"
                error={state.fields?.slug}
              />
            </Field>

            <Field label="Creative" name="creativeId" hint="Optional. Only approved creatives on the selected campaign.">
              <Select name="creativeId" placeholder="No creative" options={creatives} />
            </Field>

            <Field
              label="Expires"
              name="expiresAt"
              error={state.fields?.expiresAt}
              hint="Leave blank so the link never expires — that is the usual choice. Set a date only for a campaign with a hard end, and remember to set the time too."
            >
              <TextInput name="expiresAt" type="datetime-local" error={state.fields?.expiresAt} />
            </Field>

            <Field label="Notes" name="notes" wide>
              <TextArea name="notes" />
            </Field>
          </div>

          <div className="notice notice--info">
            <div>
              <strong className="notice__title">Preview</strong>
              <div>
                Short URL: <code>{baseUrl}/c/{slug || '{slug}'}</code>
                {slug && <> <CopyButton value={`${baseUrl}/c/${slug}`} label="Copy" /></>}
              </div>
              <div style={{ marginTop: 6 }}>
                Redirects to: <code>{chosen?.url ?? '—'}</code>
              </div>
              {chosen?.type === 'whatsapp' && (
                <div className="small" style={{ marginTop: 6 }}>
                  The approved WhatsApp message is used exactly as configured. Track each banner by
                  assigning it a separate creative and smart link.
                </div>
              )}
            </div>
          </div>

          <div className="row">
            <SubmitButton>Create link</SubmitButton>
            <span className="small muted">Created as a draft. Activate it once you are ready for traffic.</span>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function SmartLinkStatusControls({ id, status, clickCount }: { id: string; status: string; clickCount: number }) {
  if (status === 'ended') {
    return (
      <div className="row">
        <span className="muted small">This link has ended. Ended links cannot be reopened.</span>
        {clickCount === 0 && (
          <InlineAction action={deleteSmartLinkAction} hidden={{ id }} label="Delete link" variant="danger" confirm="Delete this unused link permanently?" />
        )}
      </div>
    );
  }

  return (
    <div className="row">
      {status !== 'active' && (
        <InlineAction action={setSmartLinkStatusAction} hidden={{ id, status: 'active' }} label="Activate" variant="primary" />
      )}
      {status === 'active' && (
        <InlineAction
          action={setSmartLinkStatusAction}
          hidden={{ id, status: 'paused' }}
          label="Pause"
          confirm="Pause this link? Clicks will be refused until it is resumed."
        />
      )}
      <InlineAction
        action={setSmartLinkStatusAction}
        hidden={{ id, status: 'ended' }}
        label="End link"
        variant="danger"
        confirm="End this link permanently? It cannot be reopened. Its click history is preserved."
      />
      {clickCount === 0 && (
        <InlineAction action={deleteSmartLinkAction} hidden={{ id }} label="Delete link" variant="danger" confirm="Delete this unused link permanently?" />
      )}
    </div>
  );
}

export function ChangeDestinationForm({
  id, destinations, currentDestinationId,
}: {
  id: string;
  destinations: DestinationOption[];
  currentDestinationId: string | null;
}) {
  const options = destinations.filter((d) => d.value !== currentDestinationId);

  if (options.length === 0) {
    return <p className="muted small">No other approved destination is available to move to.</p>;
  }

  return (
    <ActionForm action={changeDestinationAction}>
      {(state) => (
        <>
          <input type="hidden" name="id" value={id} />
          <div className="form-grid">
            <Field label="New destination" name="destinationId" required error={state.fields?.destinationId}>
              <Select
                name="destinationId" required placeholder="Select a destination"
                options={options} error={state.fields?.destinationId}
              />
            </Field>
            <Field
              label="Publisher approval reference"
              name="approvalReference"
              required
              error={state.fields?.approvalReference}
              hint="A destination change may itself need publisher approval (PRD §11, TRD §13)."
            >
              <TextInput name="approvalReference" required error={state.fields?.approvalReference} />
            </Field>
          </div>
          <div className="row">
            <SubmitButton confirm="Move this link to a new destination? A new version is recorded; clicks already logged keep their original destination.">
              Change destination
            </SubmitButton>
            <span className="small muted">Creates a new version. Historical clicks are never rewritten.</span>
          </div>
        </>
      )}
    </ActionForm>
  );
}
