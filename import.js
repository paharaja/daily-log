// CSV import and export. Pure module.
import { fromLocal, importReadingId, TZ } from './model.js';

// Parse the simple CSV used by the paper-log transcription: date,time,systolic,diastolic[,pulse][,note]
export function parseCSV(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '');
  if (!lines.length) return { rows: [], errors: ['Empty file'] };
  const header = splitLine(lines[0]).map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const need = ['date', 'time', 'systolic', 'diastolic'];
  const missing = need.filter((n) => col(n) < 0);
  if (missing.length) return { rows: [], errors: [`Missing column(s): ${missing.join(', ')}`] };
  const rows = [];
  const errors = [];
  lines.slice(1).forEach((line, i) => {
    const f = splitLine(line);
    const rowNo = i + 1;
    const get = (n) => (col(n) >= 0 ? (f[col(n)] ?? '').trim() : '');
    const row = {
      source_row: rowNo,
      date: get('date'), time: get('time'),
      systolic: Number(get('systolic')), diastolic: Number(get('diastolic')),
      pulse: get('pulse') === '' ? null : Number(get('pulse')),
      note: get('note'),
    };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !/^\d{2}:\d{2}$/.test(row.time)) errors.push(`Row ${rowNo}: bad date/time "${row.date} ${row.time}"`);
    else if (!Number.isInteger(row.systolic) || !Number.isInteger(row.diastolic)) errors.push(`Row ${rowNo}: bad numbers`);
    else rows.push(row);
  });
  return { rows, errors };
}

function splitLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

// Turn parsed rows into { reading_id, payload, warning } with stable ids per source row.
export function rowsToPayloads(rows, source) {
  return rows.map((row) => {
    const res = fromLocal(row.date, row.time);
    let warning = null;
    let cand = res.candidates[0];
    if (res.status === 'nonexistent') {
      warning = `Row ${row.source_row}: ${row.date} ${row.time} does not exist in UK time (clocks went forward).`;
      cand = { utc: new Date(`${row.date}T${row.time}:00Z`).toISOString(), offset_minutes: 0 };
    } else if (res.status === 'ambiguous') {
      warning = `Row ${row.source_row}: ${row.date} ${row.time} happened twice (clocks went back); the first was used.`;
    }
    const payload = {
      systolic: row.systolic, diastolic: row.diastolic, pulse: row.pulse,
      measured_at_utc: cand.utc, local_date: row.date, local_time: row.time,
      offset_minutes: cand.offset_minutes, tz: TZ,
      source, source_row: row.source_row, verified: false, context: 'home',
    };
    if (row.note) payload.note = row.note;
    return { reading_id: importReadingId(source, row.source_row), payload, warning };
  });
}

const esc = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCSV(readings) {
  const cols = ['local_date', 'local_time', 'systolic', 'diastolic', 'pulse', 'context', 'pair_id', 'protocol', 'tags', 'note', 'source', 'verified', 'measured_at_utc'];
  const lines = [cols.join(',')];
  for (const r of readings) {
    lines.push(cols.map((c) => esc(Array.isArray(r[c]) ? r[c].join(';') : r[c])).join(','));
  }
  return lines.join('\n') + '\n';
}
