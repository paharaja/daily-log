// Two stacked SVG panels (systolic, diastolic) on a shared time axis.
// Dots = readings; orange line = 7-day average; labelled reference lines; optional US zones.
import { UK, US_ZONES } from './reference.js';
import { rolling7 } from './stats.js';

const NS = 'http://www.w3.org/2000/svg';
const DAY = 86400000;

function el(name, attrs = {}, parent) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

function niceTicks(lo, hi, step) {
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
  return out;
}

const fmtDay = (t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/London' });

export function renderChart(container, readings, { rangeDays = 30, showUS = false, tooltip } = {}) {
  container.replaceChildren();
  const now = Date.now();
  const lastT = readings.length ? Math.max(...readings.map((r) => Date.parse(r.measured_at_utc))) : now;
  const end = Math.max(now, lastT);
  const start = rangeDays ? end - rangeDays * DAY : (readings.length ? Math.min(...readings.map((r) => Date.parse(r.measured_at_utc))) - DAY / 2 : end - 30 * DAY);
  const shown = readings.filter((r) => Date.parse(r.measured_at_utc) >= start);
  if (!shown.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No readings in this period.';
    container.appendChild(p);
    return;
  }
  const roll = rolling7(readings).map((p) => ({ t: Date.parse(`${p.date}T12:00:00Z`), sys: p.sys, dia: p.dia, days: p.days, readings: p.readings }))
    .filter((p) => p.t >= start);

  const W = Math.max(320, container.clientWidth || 800);
  const H = 210;
  const m = { l: 40, r: 92, t: 26, b: 22 };
  const pw = W - m.l - m.r;
  const x = (t) => m.l + ((t - start) / (end - start)) * pw;

  const panels = [
    { key: 'systolic', rk: 'sys', title: 'Systolic (upper number), mmHg', lines: [{ v: UK.homeSys, label: '135 UK home' }, { v: UK.lowSys, label: '90 NHS low' }], lo: 85, hi: 175, us: 'sys' },
    { key: 'diastolic', rk: 'dia', title: 'Diastolic (lower number), mmHg', lines: [{ v: UK.homeDia, label: '85 UK home' }, { v: UK.lowDia, label: '60 NHS low' }], lo: 55, hi: 110, us: 'dia' },
  ];

  for (const p of panels) {
    const vals = shown.map((r) => r[p.key]);
    const lo = Math.min(p.lo, Math.floor((Math.min(...vals) - 5) / 10) * 10);
    const hi = Math.max(p.hi, Math.ceil((Math.max(...vals) + 5) / 10) * 10);
    const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': `${p.title} chart`, class: 'chart' });
    el('text', { x: m.l, y: 16, class: 'chart-title' }, svg).textContent = p.title;

    if (showUS) {
      for (const z of US_ZONES) {
        const [a, b] = z[p.us];
        const top = Math.min(hi, b);
        const bot = Math.max(lo, a);
        if (top <= bot) continue;
        el('rect', { x: m.l, width: pw, y: y(top), height: y(bot) - y(top), class: `zone zone-${z.name.replace(/\s/g, '').toLowerCase()}` }, svg);
        el('text', { x: W - m.r + 6, y: (y(top) + y(bot)) / 2 + 4, class: 'zone-label' }, svg).textContent = `US ${z.name}`;
      }
    }
    for (const v of niceTicks(lo, hi, 10)) {
      el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: 'grid' }, svg);
      el('text', { x: m.l - 6, y: y(v) + 4, class: 'tick', 'text-anchor': 'end' }, svg).textContent = v;
    }
    for (const ln of p.lines) {
      if (ln.v < lo || ln.v > hi) continue;
      el('line', { x1: m.l, x2: W - m.r, y1: y(ln.v), y2: y(ln.v), class: 'ref' }, svg);
      if (!showUS) el('text', { x: W - m.r + 6, y: y(ln.v) + 4, class: 'ref-label' }, svg).textContent = ln.label;
    }
    // x ticks
    const spanDays = (end - start) / DAY;
    const step = spanDays <= 10 ? 1 : spanDays <= 35 ? 7 : spanDays <= 120 ? 14 : 30;
    const first = new Date(start);
    first.setUTCHours(12, 0, 0, 0);
    for (let t = first.getTime(); t <= end; t += step * DAY) {
      el('text', { x: x(t), y: H - 6, class: 'tick', 'text-anchor': 'middle' }, svg).textContent = fmtDay(t);
    }
    // 7-day average line
    if (roll.length > 1) {
      const d = roll.map((q, i) => `${i ? 'L' : 'M'}${x(q.t).toFixed(1)},${y(q[p.rk]).toFixed(1)}`).join(' ');
      el('path', { d, class: 'avg-line' }, svg);
    }
    // Readings
    for (const r of shown) {
      const cx = x(Date.parse(r.measured_at_utc));
      const cy = y(r[p.key]);
      el('circle', { cx, cy, r: 4, class: 'dot' }, svg);
      const hit = el('circle', { cx, cy, r: 11, class: 'hit', tabindex: 0 }, svg);
      const label = `${r.local_date} ${r.local_time} — ${r.systolic}/${r.diastolic}${r.pulse != null ? `, pulse ${r.pulse}` : ''}${r.note ? ` — ${r.note}` : ''}`;
      el('title', {}, hit).textContent = label;
      if (tooltip) {
        const show = (ev) => tooltip(label, ev);
        hit.addEventListener('pointerenter', show);
        hit.addEventListener('focus', show);
        hit.addEventListener('pointerleave', () => tooltip(null));
        hit.addEventListener('blur', () => tooltip(null));
      }
    }
    container.appendChild(svg);
  }
  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.innerHTML = '<span><span class="key key-dot"></span>Reading</span><span><span class="key key-line"></span>7-day average</span><span><span class="key key-ref"></span>Reference line</span><span class="small muted">The 7-day average is drawn only where those 7 days hold at least 3 days and 4 readings.</span>';
  container.appendChild(legend);
}
