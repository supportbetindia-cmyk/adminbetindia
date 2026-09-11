'use client';

/**
 * ExportAction (UI/UX §11, §15).
 *
 * Posts the current filters to the export endpoint and downloads the result.
 * The file it produces carries the filters, timezone, metric definitions and
 * attribution model in a header block, so a spreadsheet passed on to someone
 * else still says what it counted.
 */

import { useState } from 'react';

export function ExportAction({
  report, filter, label = 'Export CSV',
}: {
  report: 'clicks' | 'publishers';
  filter: Record<string, string | undefined>;
  label?: string;
}) {
  const [state, setState] = useState<'idle' | 'working' | 'error'>('idle');

  async function download() {
    setState('working');
    try {
      const response = await fetch('/api/v1/reports/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ report, filter }),
      });

      if (!response.ok) {
        setState('error');
        return;
      }

      const blob = await response.blob();
      const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1]
        ?? `${report}.csv`;

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      URL.revokeObjectURL(url);
      setState('idle');
    } catch {
      setState('error');
    }
  }

  return (
    <>
      <button type="button" className="btn" onClick={download} disabled={state === 'working'}>
        {state === 'working' ? 'Preparing…' : label}
      </button>
      {state === 'error' && (
        <span className="field__error" role="alert">Export failed. Your role may not permit exports.</span>
      )}
    </>
  );
}
