// Descriptive statistics for small, irregular home BP data. Pure module.
// Every result carries n. No tests of significance, no forecasts, no stage labels.

export const r1 = (x) => (x == null || Number.isNaN(x) ? null : Math.round(x * 10) / 10);
const sum = (a) => a.reduce((s, x) => s + x, 0);
export const mean = (a) => (a.length ? sum(a) / a.length : null);

export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function sd(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(sum(a.map((x) => (x - m) ** 2)) / (a.length - 1));
}

function describe(values) {
  const s = [...values].sort((x, y) => x - y);
  return {
    mean: mean(s), median: quantile(s, 0.5), q1: quantile(s, 0.25), q3: quantile(s, 0.75),
    sd: sd(s), min: s.length ? s[0] : null, max: s.length ? s[s.length - 1] : null,
  };
}

export const BINS = [
  { key: 'night', label: 'Night 00:00–04:59', from: 0, to: 5 },
  { key: 'morning', label: 'Morning 05:00–11:59', from: 5, to: 12 },
  { key: 'afternoon', label: 'Afternoon 12:00–17:59', from: 12, to: 18 },
  { key: 'evening', label: 'Evening 18:00–23:59', from: 18, to: 24 },
];

export function binOf(local_time) {
  const h = Number(local_time.slice(0, 2));
  return BINS.find((b) => h >= b.from && h < b.to).key;
}

export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function weekday(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// A sitting = one reading, or all readings sharing a pair_id. Averaged so a repeat check
// after a high reading does not double-weight that sitting.
export function sittings(readings) {
  const map = new Map();
  for (const r of readings) {
    const key = r.pair_id ? `p:${r.pair_id}` : `r:${r.id}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return [...map.values()].map((rs) => ({
    local_date: rs[0].local_date,
    local_time: rs.map((r) => r.local_time).sort()[0],
    systolic: mean(rs.map((r) => r.systolic)),
    diastolic: mean(rs.map((r) => r.diastolic)),
    n: rs.length,
  }));
}

export function dailyMeans(readings) {
  const byDay = new Map();
  for (const s of sittings(readings)) {
    if (!byDay.has(s.local_date)) byDay.set(s.local_date, []);
    byDay.get(s.local_date).push(s);
  }
  const counts = new Map();
  for (const r of readings) counts.set(r.local_date, (counts.get(r.local_date) || 0) + 1);
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, ss]) => ({
    date, systolic: mean(ss.map((s) => s.systolic)), diastolic: mean(ss.map((s) => s.diastolic)),
    sittings: ss.length, readings: counts.get(date),
  }));
}

export function summary(readings) {
  const days = dailyMeans(readings);
  return {
    n: readings.length,
    days: days.length,
    firstDate: days[0]?.date ?? null,
    lastDate: days.at(-1)?.date ?? null,
    perDay: days.length ? { min: Math.min(...days.map((d) => d.readings)), max: Math.max(...days.map((d) => d.readings)) } : null,
    sys: describe(readings.map((r) => r.systolic)),
    dia: describe(readings.map((r) => r.diastolic)),
    dayWeighted: { sys: mean(days.map((d) => d.systolic)), dia: mean(days.map((d) => d.diastolic)) },
  };
}

export function shares(readings, home = { sys: 135, dia: 85 }) {
  const homeReadings = readings.filter((r) => r.context !== 'clinic');
  return {
    n: homeReadings.length,
    aboveHome: homeReadings.filter((r) => r.systolic >= home.sys || r.diastolic >= home.dia).length,
    dia90: homeReadings.filter((r) => r.diastolic >= 90).length,
    normalUS: homeReadings.filter((r) => r.systolic < 120 && r.diastolic < 80).length,
    veryHigh: readings.filter((r) => r.systolic >= 180 || r.diastolic >= 120).length,
  };
}

export function bins(readings) {
  return BINS.map((b) => {
    const rs = readings.filter((r) => binOf(r.local_time) === b.key);
    return {
      key: b.key, label: b.label, n: rs.length, small: rs.length < 10,
      sys: mean(rs.map((r) => r.systolic)), dia: mean(rs.map((r) => r.diastolic)),
    };
  });
}

export function excludeFirstDay(readings) {
  const days = dailyMeans(readings);
  if (!days.length) return null;
  const rest = readings.filter((r) => r.local_date !== days[0].date);
  return { excluded: days[0].date, n: rest.length, sys: mean(rest.map((r) => r.systolic)), dia: mean(rest.map((r) => r.diastolic)) };
}

// Rolling 7-calendar-day mean of daily means; drawn only where the window has >=3 days and >=4 readings.
export function rolling7(readings) {
  const days = dailyMeans(readings);
  const out = [];
  for (const d of days) {
    const from = addDays(d.date, -6);
    const win = days.filter((x) => x.date >= from && x.date <= d.date);
    const nReadings = sum(win.map((x) => x.readings));
    if (win.length >= 3 && nReadings >= 4) {
      out.push({ date: d.date, sys: mean(win.map((x) => x.systolic)), dia: mean(win.map((x) => x.diastolic)), days: win.length, readings: nReadings });
    }
  }
  return out;
}

function windowStats(readings, from, to) {
  const rs = readings.filter((r) => r.local_date >= from && r.local_date <= to);
  const days = dailyMeans(rs);
  const ds = [...days.map((d) => d.systolic)].sort((a, b) => a - b);
  const dd = [...days.map((d) => d.diastolic)].sort((a, b) => a - b);
  const binCounts = Object.fromEntries(BINS.map((b) => [b.key, rs.filter((r) => binOf(r.local_time) === b.key).length]));
  return {
    from, to, readings: rs.length, days: days.length,
    sys: mean(ds), dia: mean(dd),
    sysIqr: ds.length ? [quantile(ds, 0.25), quantile(ds, 0.75)] : null,
    diaIqr: dd.length ? [quantile(dd, 0.25), quantile(dd, 0.75)] : null,
    binCounts,
  };
}

// "Last 7 days vs previous 7 days" — two sets of numbers, no verdict.
export function compare7(readings, endDate) {
  return {
    last: windowStats(readings, addDays(endDate, -6), endDate),
    previous: windowStats(readings, addDays(endDate, -13), addDays(endDate, -7)),
  };
}

export function morningMinusEvening(readings) {
  const byDay = new Map();
  for (const r of readings) {
    const b = binOf(r.local_time);
    if (b !== 'morning' && b !== 'evening') continue;
    if (!byDay.has(r.local_date)) byDay.set(r.local_date, { morning: [], evening: [] });
    byDay.get(r.local_date)[b].push(r);
  }
  const diffs = [];
  for (const v of byDay.values()) {
    if (v.morning.length && v.evening.length) {
      diffs.push({
        sys: mean(v.morning.map((r) => r.systolic)) - mean(v.evening.map((r) => r.systolic)),
        dia: mean(v.morning.map((r) => r.diastolic)) - mean(v.evening.map((r) => r.diastolic)),
      });
    }
  }
  return { days: diffs.length, sys: mean(diffs.map((d) => d.sys)), dia: mean(diffs.map((d) => d.dia)) };
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Hidden until every weekday has >=4 observed dates.
export function weekdayMeans(readings, minDates = 4) {
  const days = dailyMeans(readings);
  const groups = WEEKDAYS.map((name, i) => ({ name, days: days.filter((d) => weekday(d.date) === i) }));
  const ready = groups.every((g) => g.days.length >= minDates);
  return {
    ready,
    minDates,
    groups: groups.map((g) => ({ name: g.name, dates: g.days.length, sys: ready ? mean(g.days.map((d) => d.systolic)) : null, dia: ready ? mean(g.days.map((d) => d.diastolic)) : null })),
  };
}

export function pulseStats(readings, min = 7) {
  const p = readings.map((r) => r.pulse).filter((x) => Number.isInteger(x));
  return { n: p.length, shown: p.length >= min, mean: p.length >= min ? mean(p) : null };
}

// NICE CKS home-monitoring week, applied to readings marked protocol: true.
// Day 1 discarded; every remaining protocol reading averaged equally. No stage is named.
export function homeWeek(readings) {
  const rs = readings.filter((r) => r.protocol).sort((a, b) => a.measured_at_utc.localeCompare(b.measured_at_utc));
  if (!rs.length) return null;
  const dates = [...new Set(rs.map((r) => r.local_date))].sort();
  const kept = rs.filter((r) => r.local_date !== dates[0]);
  // A sitting is a pair_id group (or a lone reading). Conformant = >=2 readings, first two >=60 s apart.
  const sittingMap = new Map();
  for (const r of rs) {
    const key = r.pair_id || r.id;
    if (!sittingMap.has(key)) sittingMap.set(key, []);
    sittingMap.get(key).push(r);
  }
  const sittingList = [...sittingMap.values()].map((s) => {
    const t = s.map((r) => Date.parse(r.measured_at_utc)).sort((a, b) => a - b);
    return { date: s[0].local_date, bin: binOf(s[0].local_time), n: s.length, ok: s.length >= 2 && t[1] - t[0] >= 60000 };
  });
  const perDay = dates.map((date) => {
    const ss = sittingList.filter((s) => s.date === date);
    return {
      date,
      morning: ss.some((s) => s.bin === 'morning' && s.ok),
      evening: ss.some((s) => (s.bin === 'evening' || s.bin === 'afternoon') && s.ok),
    };
  });
  const checks = [
    { label: 'At least 4 days recorded (ideally 7)', ok: dates.length >= 4, detail: `${dates.length} day(s)` },
    { label: 'Every sitting has two readings at least 1 minute apart', ok: sittingList.every((s) => s.ok), detail: `${sittingList.filter((s) => !s.ok).length} sitting(s) short` },
    { label: 'Morning and evening sittings every day', ok: perDay.every((d) => d.morning && d.evening), detail: `${perDay.filter((d) => !(d.morning && d.evening)).length} day(s) missing one` },
  ];
  return {
    daysTotal: dates.length,
    discarded: dates[0],
    n: kept.length,
    sys: mean(kept.map((r) => r.systolic)),
    dia: mean(kept.map((r) => r.diastolic)),
    checks,
    perDay,
  };
}
