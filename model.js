// Reading schema, validation, events and the causal fold.
// Pure module: no DOM, no storage — imported by the app and by node tests.

export const TZ = 'Europe/London';

export const GUARDS = { sysMin: 70, sysMax: 250, diaMin: 40, diaMax: 150, pulseMin: 30, pulseMax: 220 };

const pad = (n) => String(n).padStart(2, '0');

// Local civil parts of a UTC instant in Europe/London.
export function localParts(date, tz = TZ) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  const m = /GMT(?:([+-])(\d{2}):(\d{2}))?/.exec(p.timeZoneName || 'GMT');
  const offset = m && m[1] ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  return { local_date: `${p.year}-${p.month}-${p.day}`, local_time: `${p.hour}:${p.minute}`, offset_minutes: offset };
}

// Resolve a civil date/time in Europe/London to UTC.
// Returns { status: 'ok' | 'ambiguous' | 'nonexistent', candidates: [{utc, offset_minutes}] }.
export function fromLocal(local_date, local_time, tz = TZ) {
  const [y, mo, d] = local_date.split('-').map(Number);
  const [h, mi] = local_time.split(':').map(Number);
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const candidates = [];
  for (const off of [0, 60, -60, 120]) {
    const utc = new Date(naive - off * 60000);
    const lp = localParts(utc, tz);
    if (lp.local_date === local_date && lp.local_time === `${pad(h)}:${pad(mi)}` && lp.offset_minutes === off) {
      candidates.push({ utc: utc.toISOString(), offset_minutes: off });
    }
  }
  if (candidates.length === 0) return { status: 'nonexistent', candidates };
  candidates.sort((a, b) => a.utc.localeCompare(b.utc));
  return { status: candidates.length > 1 ? 'ambiguous' : 'ok', candidates };
}

// Validation: errors block saving; warnings need a confirmation tap and never discard.
export function validate(p) {
  const errors = [];
  const warnings = [];
  const isInt = (v) => Number.isInteger(v);
  if (!isInt(p.systolic)) errors.push('Systolic must be a whole number.');
  if (!isInt(p.diastolic)) errors.push('Diastolic must be a whole number.');
  if (p.pulse != null && !isInt(p.pulse)) errors.push('Pulse must be a whole number or left blank.');
  if (isInt(p.systolic) && isInt(p.diastolic) && p.diastolic >= p.systolic) {
    errors.push('Diastolic (lower number) must be below systolic (upper number).');
  }
  if (errors.length) return { errors, warnings };
  const g = GUARDS;
  if (p.systolic < g.sysMin || p.systolic > g.sysMax) warnings.push(`Systolic ${p.systolic} is outside the app's check range ${g.sysMin}–${g.sysMax} (an app guard, not a medical threshold).`);
  if (p.diastolic < g.diaMin || p.diastolic > g.diaMax) warnings.push(`Diastolic ${p.diastolic} is outside the app's check range ${g.diaMin}–${g.diaMax} (an app guard, not a medical threshold).`);
  if (p.pulse != null && (p.pulse < g.pulseMin || p.pulse > g.pulseMax)) warnings.push(`Pulse ${p.pulse} is outside the app's check range ${g.pulseMin}–${g.pulseMax} (an app guard, not a medical threshold).`);
  return { errors, warnings };
}

// randomUUID only exists on secure origins; the phone reaches the PC over plain http on the LAN.
export function uuid() {
  const c = globalThis.crypto;
  if (c.randomUUID && globalThis.isSecureContext !== false) return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Build an event. recorded_at is display-only and clamped past the parents' values.
export function makeEvent({ op, reading_id, parents = [], payload = null, device_id, now = Date.now(), parentEvents = [] }) {
  const floor = parentEvents.reduce((m, e) => Math.max(m, Date.parse(e.recorded_at) + 1), 0);
  return {
    eid: uuid(), op, reading_id, parents: [...parents],
    recorded_at: new Date(Math.max(now, floor)).toISOString(),
    device_id, payload,
  };
}

// Deterministic id for imported rows, so the same file imported twice is the same reading.
export function importReadingId(source, sourceRow) {
  return `${source}#${sourceRow}`;
}

const samePayload = (a, b) => JSON.stringify(a?.payload ?? null) === JSON.stringify(b?.payload ?? null) && a.op === b.op;

// Causal fold. An event supersedes the events named in its parents. A reading's current
// state is its event(s) that nothing supersedes. Two different heads = a conflict to show.
// Returns Map reading_id -> { reading_id, head, deleted, conflict: [heads] | null, history: [events] }.
export function fold(events) {
  const byEid = new Map();
  for (const e of events) if (!byEid.has(e.eid)) byEid.set(e.eid, e);
  const groups = new Map();
  for (const e of byEid.values()) {
    if (!groups.has(e.reading_id)) groups.set(e.reading_id, []);
    groups.get(e.reading_id).push(e);
  }
  const out = new Map();
  for (const [rid, evs] of groups) {
    const superseded = new Set(evs.flatMap((e) => e.parents || []));
    let heads = evs.filter((e) => !superseded.has(e.eid));
    // Identical heads (e.g. the same CSV imported on two devices) are one state, not a conflict.
    const distinct = [];
    for (const h of heads.sort(byRecorded)) if (!distinct.some((d) => samePayload(d, h))) distinct.push(h);
    heads = distinct;
    const head = heads[heads.length - 1];
    out.set(rid, {
      reading_id: rid,
      head,
      deleted: heads.length === 1 && head.op === 'delete',
      conflict: heads.length > 1 ? heads : null,
      history: evs.sort(byRecorded),
    });
  }
  return out;
}

function byRecorded(a, b) {
  return a.recorded_at === b.recorded_at ? a.eid.localeCompare(b.eid) : a.recorded_at.localeCompare(b.recorded_at);
}

// Current, non-deleted readings as flat objects for stats and display.
export function currentReadings(folded) {
  const list = [];
  for (const r of folded.values()) {
    if (r.deleted || !r.head || r.head.op === 'delete') continue;
    list.push({ id: r.reading_id, ...r.head.payload, _eid: r.head.eid, _conflict: !!r.conflict });
  }
  return list.sort((a, b) => a.measured_at_utc.localeCompare(b.measured_at_utc));
}

// Payload for a new reading taken now.
export function newPayload({ systolic, diastolic, pulse = null, now = new Date(), source = 'manual', ...rest }) {
  const lp = localParts(now);
  return {
    systolic, diastolic, pulse,
    measured_at_utc: now.toISOString(), ...lp, tz: TZ, source,
    context: 'home', ...rest,
  };
}
