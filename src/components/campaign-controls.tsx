'use client';

/**
 * Status controls, creative entry and spend entry for a campaign.
 *
 * Activation and ending are confirmed before they run (UI/UX §14). Ending is
 * irreversible by design — services/campaigns.ts refuses to reopen.
 */

import { createCreativeAction, recordCostAction, setCampaignStatusAction } from '@/server/actions';
import { ActionForm, Field, InlineAction, Select, SubmitButton, TextInput } from './form';

export function CampaignStatusControls({ id, status }: { id: string; status: string }) {
  if (status === 'ended') {
    return <span className="muted small">This campaign has ended. Ended campaigns cannot be reopened.</span>;
  }

  return (
    <div className="row">
      {status !== 'active' && (
        <InlineAction
          action={setCampaignStatusAction}
          hidden={{ id, status: 'active' }}
          label="Activate"
          variant="primary"
        />
      )}
      {status === 'active' && (
        <InlineAction
          action={setCampaignStatusAction}
          hidden={{ id, status: 'paused' }}
          label="Pause"
          confirm="Pause this campaign? Its links will stop redirecting."
        />
      )}
      <InlineAction
        action={setCampaignStatusAction}
        hidden={{ id, status: 'ended' }}
        label="End campaign"
        variant="danger"
        confirm="End this campaign permanently? It cannot be reopened, and its links stop redirecting."
      />
    </div>
  );
}

export function CreativeForm({ campaignId }: { campaignId: string }) {
  return (
    <ActionForm action={createCreativeAction}>
      {(state) => (
        <>
          <input type="hidden" name="campaignId" value={campaignId} />
          <div className="form-grid">
            <Field label="Creative name" name="name" required error={state.fields?.name}>
              <TextInput name="name" required placeholder="Banner 300x250 v1" error={state.fields?.name} />
            </Field>
            <Field label="Format" name="format" hint="Dimensions or ad unit.">
              <TextInput name="format" placeholder="300x250" />
            </Field>
            <Field label="Placement ID" name="placementId">
              <TextInput name="placementId" />
            </Field>
            <Field label="Asset reference" name="assetReference" hint="Where the approved asset lives.">
              <TextInput name="assetReference" />
            </Field>
            <Field
              label="Approval status"
              name="approvalStatus"
              hint="Only approved creatives can be attached to a smart link."
            >
              <Select
                name="approvalStatus"
                defaultValue="pending"
                options={[
                  { value: 'pending', label: 'Pending publisher approval' },
                  { value: 'approved', label: 'Approved' },
                  { value: 'rejected', label: 'Rejected' },
                ]}
              />
            </Field>
            <Field label="Approval reference" name="approvalReference">
              <TextInput name="approvalReference" />
            </Field>
          </div>
          <div className="row"><SubmitButton>Add creative</SubmitButton></div>
        </>
      )}
    </ActionForm>
  );
}

export function CostForm({ campaignId, currency }: { campaignId: string; currency: string }) {
  return (
    <ActionForm action={recordCostAction}>
      {(state) => (
        <>
          <input type="hidden" name="campaignId" value={campaignId} />
          <div className="form-grid">
            <Field label="Date" name="costDate" required error={state.fields?.costDate}>
              <TextInput name="costDate" type="date" required error={state.fields?.costDate} />
            </Field>
            <Field label={`Amount (${currency})`} name="amount" required error={state.fields?.amount}>
              <TextInput name="amount" type="number" min="0" step="0.01" required error={state.fields?.amount} />
            </Field>
            <input type="hidden" name="currency" value={currency} />
            <Field
              label="Source"
              name="source"
              required
              error={state.fields?.source}
              hint="Where this figure came from. Re-entering the same date and source corrects the figure rather than adding to it."
            >
              <TextInput name="source" required placeholder="publisher_invoice" error={state.fields?.source} />
            </Field>
            <Field label="External reference" name="externalReference">
              <TextInput name="externalReference" placeholder="INV-2026-014" />
            </Field>
          </div>
          <div className="row">
            <SubmitButton>Record spend</SubmitButton>
            <span className="small muted">
              ROI and ROAS are not calculated. TRD §11 puts them behind approved accounting definitions.
            </span>
          </div>
        </>
      )}
    </ActionForm>
  );
}
