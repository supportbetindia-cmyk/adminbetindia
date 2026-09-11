/**
 * CSV generation for exports (PRD §9, UI/UX §11).
 *
 * Every export is prefixed with a header block recording the filters, the
 * timezone, the attribution model and the metric definitions in force when it
 * ran. UI/UX §11 requires it, and without it a spreadsheet emailed onward is
 * a set of numbers with no way to tell what they counted.
 */

export type CsvValue = string | number | boolean | Date | null | undefined;

/**
 * Escapes a cell.
 *
 * Values starting with =, +, - or @ are prefixed with a single quote so a
 * spreadsheet treats them as text. Without it, an imported publisher name
 * beginning with "=" becomes a formula when the file is opened.
 */
function cell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();

  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export interface CsvColumn<T> {
  key: string;
  header: string;
  value: (row: T) => CsvValue;
}

export interface CsvMeta {
  title: string;
  generatedAt: Date;
  timezone: string;
  filters: Record<string, string | undefined>;
  definitions: { label: string; text: string }[];
  notes?: string[];
}

export function buildCsv<T>(rows: T[], columns: CsvColumn<T>[], meta: CsvMeta): string {
  const lines: string[] = [];

  lines.push(cell(`# ${meta.title}`));
  lines.push(cell(`# Generated: ${meta.generatedAt.toISOString()} (UTC)`));
  lines.push(cell(`# Display timezone: ${meta.timezone}`));

  const filters = Object.entries(meta.filters).filter(([, v]) => v !== undefined && v !== '');
  lines.push(cell(`# Filters: ${filters.length ? filters.map(([k, v]) => `${k}=${v}`).join('; ') : 'none'}`));

  for (const note of meta.notes ?? []) lines.push(cell(`# ${note}`));
  for (const def of meta.definitions) lines.push(cell(`# ${def.label}: ${def.text}`));
  lines.push('');

  lines.push(columns.map((c) => cell(c.header)).join(','));
  for (const row of rows) {
    lines.push(columns.map((c) => cell(c.value(row))).join(','));
  }

  return lines.join('\r\n');
}

export function csvFilename(prefix: string, from: string, to: string): string {
  return `${prefix}_${from}_to_${to}.csv`;
}
