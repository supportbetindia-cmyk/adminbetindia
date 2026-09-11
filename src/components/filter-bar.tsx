/**
 * FilterBar (UI/UX §4, §15).
 *
 * A plain GET form: filters live in the URL, so a filtered view is
 * shareable, bookmarkable and reproducible in an export. §14 requires filters
 * to update all dependent metrics consistently — with the filter state in the
 * URL and every figure computed server-side from it, they cannot disagree.
 */

import Link from 'next/link';

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterBarProps {
  action: string;
  from: string;
  to: string;
  publishers?: FilterOption[];
  campaigns?: FilterOption[];
  creatives?: FilterOption[];
  selected: {
    publisherId?: string;
    campaignId?: string;
    creativeId?: string;
    destinationType?: string;
    device?: string;
    includeFiltered?: boolean;
  };
  /** Extra controls, e.g. an export button. */
  children?: React.ReactNode;
}

export function FilterBar({
  action, from, to, publishers, campaigns, creatives, selected, children,
}: FilterBarProps) {
  return (
    <form className="filterbar" method="get" action={action}>
      <div className="field">
        <label className="field__label" htmlFor="from">From</label>
        <input type="date" id="from" name="from" defaultValue={from} />
      </div>

      <div className="field">
        <label className="field__label" htmlFor="to">To</label>
        <input type="date" id="to" name="to" defaultValue={to} />
      </div>

      {publishers && (
        <div className="field">
          <label className="field__label" htmlFor="publisherId">Publisher</label>
          <select id="publisherId" name="publisherId" defaultValue={selected.publisherId ?? ''}>
            <option value="">All publishers</option>
            {publishers.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </div>
      )}

      {campaigns && (
        <div className="field">
          <label className="field__label" htmlFor="campaignId">Campaign</label>
          <select id="campaignId" name="campaignId" defaultValue={selected.campaignId ?? ''}>
            <option value="">All campaigns</option>
            {campaigns.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </div>
      )}

      {creatives && creatives.length > 0 && (
        <div className="field">
          <label className="field__label" htmlFor="creativeId">Creative</label>
          <select id="creativeId" name="creativeId" defaultValue={selected.creativeId ?? ''}>
            <option value="">All creatives</option>
            {creatives.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </div>
      )}

      <div className="field">
        <label className="field__label" htmlFor="destinationType">Destination</label>
        <select id="destinationType" name="destinationType" defaultValue={selected.destinationType ?? ''}>
          <option value="">Website and WhatsApp</option>
          <option value="website">Website</option>
          <option value="whatsapp">WhatsApp</option>
        </select>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="device">Device</label>
        <select id="device" name="device" defaultValue={selected.device ?? ''}>
          <option value="">All devices</option>
          <option value="mobile">Mobile</option>
          <option value="tablet">Tablet</option>
          <option value="desktop">Desktop</option>
          <option value="unknown">Unknown</option>
        </select>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="includeFiltered">Bot traffic</label>
        <select id="includeFiltered" name="includeFiltered" defaultValue={selected.includeFiltered ? 'true' : ''}>
          <option value="">Excluded from counts</option>
          <option value="true">Included in counts</option>
        </select>
      </div>

      <div className="filterbar__spacer" />

      <button type="submit" className="btn btn--primary">Apply</button>
      <Link href={action} className="btn">Reset</Link>
      {children}
    </form>
  );
}
