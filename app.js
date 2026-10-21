import { fold, currentReadings, makeEvent, validate, fromLocal, localParts, newPayload, uuid } from './model.js';
import * as S from './stats.js';
import { chips, isVeryHigh, BANNER_TEXT, SOURCES, CKS_TEXT, UK } from './reference.js';
import { parseCSV, rowsToPayloads, toCSV } from './import.js';
import { renderChart } from './chart.js';
import { idbStore } from './store.js';
import { sync } from './sync.js';
import { dropboxClient } from './dropbox.js';
import { DROPBOX_APP_KEY } from './config.js';

// ---------- setup ----------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const f1 = (x) => (x == null ? '—' : S.r1(x).toFixed(1));
const f0 = (x) => (x == null ? '—' : String(Math.round(x)));

const store = idbStore();
const dbx = dropboxClient({ appKey: DROPBOX_APP_KEY, store });
let DEVICE = null;

const TAGS = ['coffee', 'alcohol', 'exercise', 'stress', 'poor sleep', 'tired', 'medication'];
// This code is public: it must never contain readings or figures derived from them.
const PAPER_SOURCE = 'paper-scan-2026-10-21';

const state = { events: [], folded: new Map(), readings: [], view: 'log', range: 30, pair: null, pending: 0, connected: false, lastSync: null, syncError: null };

// ---------- storage & sync ----------
// Every change is saved on this device first (one transaction with its outbox entry),
// then copied to Dropbox in the background.
async function refreshLocal() {
  state.events = await store.allEvents();
  state.pending = (await store.outboxEids()).length;
  state.connected = !!(await dbx.tokens());
  state.lastSync = await store.getMeta('lastSync');
  recompute();
}

function recompute() {
  state.folded = fold(state.events);
  state.readings = currentReadings(state.folded);
  renderStatus();
  render();
}

function renderStatus() {
  const n = `${state.readings.length} readings`;
  const when = state.lastSync ? new Date(state.lastSync).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : null;
  const waiting = state.pending ? ` · ${state.pending} change(s) waiting to copy to Dropbox` : '';
  let text;
  let warn = false;
  if (!DROPBOX_APP_KEY) { text = `${n} · saved on this device only (Dropbox not set up yet)`; warn = true; }
  else if (!state.connected) { text = `${n} · saved on this device only — connect Dropbox to back up and sync`; warn = true; }
  else if (state.syncError) { text = `${n}${waiting} · last Dropbox copy ${when || 'never'} — ${state.syncError}`; warn = !!state.pending; }
  else text = `${n}${waiting}${when ? ` · in Dropbox, synced ${when}` : ''}`;
  setStatus(text, warn);
  $('connect-btn').hidden = !DROPBOX_APP_KEY || state.connected;
}

let syncing = false;
let syncAgain = false;
async function doSync() {
  if (!DROPBOX_APP_KEY || !(await dbx.tokens())) { await refreshLocal(); return; }
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  try {
    await sync({ store, dbx, deviceId: DEVICE });
    await store.setMeta('lastSync', Date.now());
    state.syncError = null;
  } catch (e) {
    state.syncError = e.auth ? 'Dropbox needs connecting again' : navigator.onLine === false ? 'offline; will retry' : 'could not reach Dropbox; will retry';
    console.warn('sync failed', e);
  } finally {
    syncing = false;
    await refreshLocal();
    if (syncAgain) { syncAgain = false; doSync(); }
  }
}

async function save(events) {
  await store.putEvents(events, { pending: true });
  await refreshLocal();
  doSync();
  return true;
}

async function init() {
  await store.open();
  DEVICE = await store.getMeta('deviceId');
  if (!DEVICE) { DEVICE = uuid(); await store.setMeta('deviceId', DEVICE); }
  try {
    if (await dbx.handleRedirect()) {
      const t = await dbx.tokens();
      const prev = await store.getMeta('account');
      if (prev && t.account && prev !== t.account) {
        await dbx.disconnect();
        alert('That is a different Dropbox account from the one this device used before. Disconnected to keep the two apart.');
      } else {
        await store.setMeta('account', t.account);
        toast('Connected to Dropbox.');
      }
    }
  } catch (e) { toast(e.message); }
  await refreshLocal();
  doSync();
  if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
}

setInterval(() => { if (!document.hidden) doSync(); }, 120000);
window.addEventListener('online', doSync);

// ---------- UI helpers ----------
function setStatus(text, warn = false) { const s = $('status'); s.textContent = text; s.className = `status${warn ? ' warn' : ''}`; }
let toastTimer;
function toast(text) { const t = $('toast'); t.textContent = text; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 5000); }
function tooltip(text, ev) {
  const t = $('tooltip');
  if (!text) { t.hidden = true; return; }
  t.textContent = text;
  t.hidden = false;
  const r = ev.target.getBoundingClientRect();
  t.style.left = `${Math.min(window.innerWidth - 290, Math.max(8, r.left))}px`;
  t.style.top = `${Math.max(8, r.top - 44)}px`;
}
const chipHtml = (r) => chips(r).map((c) => `<span class="chip ${c.kind}">${esc(c.text)}</span>`).join(' ');

const VIEWS = ['log', 'history', 'charts', 'insights', 'report', 'data', 'about'];
function showView(v) {
  if (!VIEWS.includes(v)) v = 'log';
  state.view = v;
  document.querySelectorAll('nav button').forEach((b) => {
    if (b.dataset.view === v) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  document.querySelectorAll('main > section').forEach((s) => { s.hidden = s.id !== `view-${v}`; });
  if ((location.hash.slice(1) || 'log') !== v) history.pushState(null, '', v === 'log' ? location.pathname : `#${v}`);
  render();
}

function render() {
  if (state.view === 'history') renderHistory();
  if (state.view === 'charts') renderChart($('chart'), state.readings, { rangeDays: state.range, showUS: $('show-us').checked, tooltip });
  if (state.view === 'insights') renderInsights();
  if (state.view === 'report') renderReport();
  if (state.view === 'about') renderAbout();
}

// ---------- Log ----------
function setupLog() {
  const box = $('tag-chips');
  for (const t of TAGS) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip-toggle'; b.textContent = t; b.dataset.tag = t; b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'));
    box.appendChild(b);
  }
  $('protocol').checked = localStorage.getItem('bp.protocol') === '1';
  $('protocol').addEventListener('change', () => localStorage.setItem('bp.protocol', $('protocol').checked ? '1' : '0'));
  const order = ['sys', 'dia', 'pulse'];
  order.forEach((id, i) => {
    $(id).addEventListener('input', () => {
      const v = $(id).value.replace(/\D/g, '');
      $(id).value = v;
      if (i < 2 && (v.length === 3 || (v.length === 2 && v[0] >= '3'))) $(order[i + 1]).focus();
    });
  });
  $('change-time').addEventListener('click', () => {
    const lp = localParts(new Date());
    $('log-date').value = lp.local_date; $('log-time').value = lp.local_time;
    $('time-fields').hidden = false; $('time-now').hidden = true; $('change-time').hidden = true;
  });
  $('log-form').addEventListener('submit', (e) => { e.preventDefault(); saveReading(); });
}

function num(id) { const v = $(id).value.trim(); return v === '' ? null : Number(v); }

function resolveTime(date, time) {
  const res = fromLocal(date, time);
  if (res.status === 'nonexistent') { alert(`${date} ${time} did not exist in UK time (the clocks went forward). Please pick another time.`); return null; }
  let c = res.candidates[0];
  if (res.status === 'ambiguous') {
    c = confirm(`${time} happened twice on ${date} (the clocks went back).\nOK = the first one (BST)\nCancel = the second one (GMT)`) ? res.candidates[0] : res.candidates[1];
  }
  return { measured_at_utc: c.utc, local_date: date, local_time: time, offset_minutes: c.offset_minutes };
}

async function saveReading() {
  const base = { systolic: num('sys'), diastolic: num('dia'), pulse: num('pulse') };
  const v = validate(base);
  if (v.errors.length) { alert(v.errors.join('\n')); return; }
  if (v.warnings.length && !confirm(`${v.warnings.join('\n')}\n\nSave anyway?`)) return;
  let payload = newPayload({ ...base, context: $('context').value });
  if (!$('time-fields').hidden) {
    const t = resolveTime($('log-date').value, $('log-time').value);
    if (!t) return;
    payload = { ...payload, ...t };
  }
  const tags = [...document.querySelectorAll('#tag-chips [aria-pressed="true"]')].map((b) => b.dataset.tag);
  if (tags.length) payload.tags = tags;
  const note = $('note').value.trim();
  if (note) payload.note = note;
  if ($('protocol').checked) payload.protocol = true;
  const pairing = state.pair && Date.now() < state.pair.until;
  payload.pair_id = pairing ? state.pair.id : uuid();
  payload.pair_seq = pairing ? state.pair.seq : 1;
  const ev = makeEvent({ op: 'create', reading_id: uuid(), payload, device_id: DEVICE });
  const ok = await save([ev]);
  if (!ok) { recompute(); return; }
  // The pair button links the NEXT reading only; after that, pairing ends until pressed again.
  const savedPair = { id: payload.pair_id, seq: payload.pair_seq + 1, until: Date.now() + 5 * 60000, at: Date.now() };
  state.pair = null;
  resetForm();
  recompute();
  showResult(payload, savedPair, pairing);
}

function resetForm() {
  for (const id of ['sys', 'dia', 'pulse', 'note']) $(id).value = '';
  document.querySelectorAll('#tag-chips [aria-pressed="true"]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
  $('time-fields').hidden = true; $('time-now').hidden = false; $('change-time').hidden = false;
}

let countdown;
function showResult(p, savedPair, wasPaired) {
  const r = { ...p };
  const box = $('log-result');
  box.innerHTML = `<div class="card result">
    <div class="big">${r.systolic}/${r.diastolic}${r.pulse != null ? ` <span class="muted small">pulse ${r.pulse}</span>` : ''}</div>
    <div class="muted small">Saved ${esc(r.local_date)} ${esc(r.local_time)}${wasPaired ? ' · second reading of the pair' : ''}</div>
    <div class="chips">${chipHtml(r)}</div>
    ${isVeryHigh(r) ? `<div class="banner"><strong>Reading in the very-high range</strong>${esc(BANNER_TEXT)} <span class="small muted">Source: ${esc(SOURCES.cks.title)}.</span></div>` : ''}
    <div class="row"><button type="button" id="second-btn" class="secondary">${wasPaired ? 'Take another reading in this sitting' : 'Take a second reading (pair)'}</button></div>
  </div>`;
  $('second-btn').addEventListener('click', () => {
    state.pair = savedPair;
    $('log-title').textContent = 'Second reading (paired)';
    $('pair-info').hidden = false;
    clearInterval(countdown);
    const tick = () => {
      const left = Math.ceil((savedPair.at + 60000 - Date.now()) / 1000);
      $('pair-info').textContent = left > 0 ? `Wait ${left} s — NICE's method takes the second reading at least 1 minute after the first.` : 'Ready — take the second reading now.';
      if (left <= 0) clearInterval(countdown);
    };
    tick(); countdown = setInterval(tick, 1000);
    $('sys').focus();
  });
  if (!state.pair) { $('log-title').textContent = 'New reading'; $('pair-info').hidden = true; clearInterval(countdown); }
}

// ---------- History & editing ----------
function renderHistory() {
  const only = $('only-unchecked').checked;
  const list = state.readings.filter((r) => !only || (r.source !== 'manual' && r.verified === false)).slice().reverse();
  const unchecked = state.readings.filter((r) => r.source !== 'manual' && r.verified === false).length;
  let html = `<p class="small muted">${state.readings.length} readings${unchecked ? ` · ${unchecked} imported not yet checked` : ''}. Tap a reading to edit or delete it.</p>`;
  let day = '';
  for (const r of list) {
    if (r.local_date !== day) { day = r.local_date; html += `<div class="day">${esc(new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }))}</div>`; }
    const badges = [
      r._conflict ? '<span class="badge">edited on two devices — choose</span>' : '',
      r.source && r.source !== 'manual' ? `<span class="badge">${r.verified ? 'imported, checked' : 'imported, not checked'}</span>` : '',
      r.context === 'clinic' ? '<span class="badge">clinic</span>' : '',
      r.protocol ? '<span class="badge">home week</span>' : '',
      ...(r.tags || []).map((t) => `<span class="badge">${esc(t)}</span>`),
    ].join(' ');
    html += `<button type="button" class="reading" data-id="${esc(r.id)}">
      <span class="time">${esc(r.local_time)}</span>
      <span class="vals">${r.systolic}/${r.diastolic}${r.pulse != null ? ` <span class="muted small">♥ ${r.pulse}</span>` : ''}</span>
      <span></span>
      <span class="meta">${chipHtml(r)} ${badges}${r.note ? ` <span class="small muted">${esc(r.note)}</span>` : ''}</span>
    </button>`;
  }
  $('history-list').innerHTML = html || '<p class="muted">No readings yet.</p>';
  $('history-list').querySelectorAll('.reading').forEach((b) => b.addEventListener('click', () => openEdit(b.dataset.id)));
}

let editing = null;
function openEdit(id) {
  const rec = state.folded.get(id);
  if (!rec) return;
  editing = rec;
  const p = rec.head.payload;
  $('e-sys').value = p.systolic; $('e-dia').value = p.diastolic; $('e-pulse').value = p.pulse ?? '';
  $('e-date').value = p.local_date; $('e-time').value = p.local_time;
  $('e-context').value = p.context || 'home';
  $('e-protocol').checked = !!p.protocol;
  $('e-tags').value = (p.tags || []).join(', ');
  $('e-note').value = p.note || '';
  const imported = p.source && p.source !== 'manual';
  $('e-verified-row').hidden = !imported;
  $('e-verified').checked = !!p.verified;
  $('e-source').textContent = imported ? `Imported from ${p.source}${p.source_row ? `, row ${p.source_row}` : ''}.` : '';
  const c = $('edit-conflict');
  c.innerHTML = '';
  if (rec.conflict) {
    c.innerHTML = '<p class="banner small"><strong>This reading was edited on two devices.</strong>Choose which version to keep:</p>' +
      rec.conflict.map((h, i) => `<button type="button" class="secondary" data-i="${i}">Keep ${h.op === 'delete' ? 'deleted' : `${h.payload.systolic}/${h.payload.diastolic} at ${esc(h.payload.local_time)}`}</button>`).join(' ');
    c.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => resolveConflict(rec, rec.conflict[Number(b.dataset.i)])));
  }
  $('edit-dialog').showModal();
}

function heads(rec) { return rec.conflict ? rec.conflict : [rec.head]; }

async function resolveConflict(rec, chosen) {
  const hs = heads(rec);
  const ev = chosen.op === 'delete'
    ? makeEvent({ op: 'delete', reading_id: rec.reading_id, parents: hs.map((h) => h.eid), parentEvents: hs, device_id: DEVICE })
    : makeEvent({ op: 'resolve', reading_id: rec.reading_id, parents: hs.map((h) => h.eid), parentEvents: hs, payload: chosen.payload, device_id: DEVICE });
  $('edit-dialog').close();
  await save([ev]);
  recompute();
}

async function saveEdit() {
  const rec = editing;
  const old = rec.head.payload;
  const base = { systolic: Number($('e-sys').value), diastolic: Number($('e-dia').value), pulse: $('e-pulse').value.trim() === '' ? null : Number($('e-pulse').value) };
  const v = validate(base);
  if (v.errors.length) { alert(v.errors.join('\n')); return; }
  if (v.warnings.length && !confirm(`${v.warnings.join('\n')}\n\nSave anyway?`)) return;
  let payload = { ...old, ...base, context: $('e-context').value };
  if ($('e-date').value !== old.local_date || $('e-time').value !== old.local_time) {
    const t = resolveTime($('e-date').value, $('e-time').value);
    if (!t) return;
    payload = { ...payload, ...t };
  }
  const tags = $('e-tags').value.split(',').map((s) => s.trim()).filter(Boolean);
  if (tags.length) payload.tags = tags; else delete payload.tags;
  const note = $('e-note').value.trim();
  if (note) payload.note = note; else delete payload.note;
  if ($('e-protocol').checked) payload.protocol = true; else delete payload.protocol;
  if (!$('e-verified-row').hidden) payload.verified = $('e-verified').checked;
  const hs = heads(rec);
  const ev = makeEvent({ op: rec.conflict ? 'resolve' : 'update', reading_id: rec.reading_id, parents: hs.map((h) => h.eid), parentEvents: hs, payload, device_id: DEVICE });
  $('edit-dialog').close();
  await save([ev]);
  recompute();
}

async function deleteEdit() {
  if (!confirm('Delete this reading? (It stays in the history file and can be recovered.)')) return;
  const hs = heads(editing);
  const ev = makeEvent({ op: 'delete', reading_id: editing.reading_id, parents: hs.map((h) => h.eid), parentEvents: hs, device_id: DEVICE });
  $('edit-dialog').close();
  await save([ev]);
  recompute();
}

// ---------- Insights ----------
function todayLocal() { return localParts(new Date()).local_date; }

function insightsHtml(rs, { full = true } = {}) {
  if (!rs.length) return '<div class="card"><p class="muted">No readings yet.</p></div>';
  const s = S.summary(rs);
  const sh = S.shares(rs);
  const bins = S.bins(rs);
  let h = `<div class="card"><h2>Summary</h2>
  <p class="small muted">${s.n} readings over ${s.days} day(s), ${esc(s.firstDate)} to ${esc(s.lastDate)}.</p>
  <table><tr><th></th><th>Systolic</th><th>Diastolic</th></tr>
  <tr><td>Average (every reading counts equally)</td><td>${f1(s.sys.mean)}</td><td>${f1(s.dia.mean)}</td></tr>
  <tr><td>Average (every day counts equally)</td><td>${f1(s.dayWeighted.sys)}</td><td>${f1(s.dayWeighted.dia)}</td></tr>
  <tr><td>Median</td><td>${f0(s.sys.median)}</td><td>${f0(s.dia.median)}</td></tr>
  <tr><td>Middle half of readings (IQR)</td><td>${f0(s.sys.q1)}–${f0(s.sys.q3)}</td><td>${f0(s.dia.q1)}–${f0(s.dia.q3)}</td></tr>
  <tr><td>Spread (SD)</td><td>${f1(s.sys.sd)}</td><td>${f1(s.dia.sd)}</td></tr>
  <tr><td>Lowest – highest</td><td>${s.sys.min}–${s.sys.max}</td><td>${s.dia.min}–${s.dia.max}</td></tr></table>
  <h3>Against the UK home threshold (NHS: 135/85)</h3>
  <p>${sh.aboveHome} of ${sh.n} home readings were at or above 135/85 on at least one number. ${sh.dia90} of ${sh.n} had a lower number of 90 or more (descriptive only — not an NHS cut-off). ${sh.normalUS} of ${sh.n} were in the US "normal" range (under 120 and under 80).${sh.veryHigh ? ` ${sh.veryHigh} reading(s) were 180/120 or above.` : ''}</p></div>`;

  h += `<div class="card"><h2>Time of day</h2><table><tr><th>Period</th><th>Readings</th><th>Average</th></tr>${bins.map((b) => `<tr><td>${esc(b.label)}</td><td>${b.n}</td><td>${b.n ? `${f1(b.sys)}/${f1(b.dia)}${b.small ? ' <span class="muted small">small sample</span>' : ''}` : '—'}</td></tr>`).join('')}</table>`;
  const me = S.morningMinusEvening(rs);
  h += `<p class="small">${me.days ? `On the ${me.days} day(s) with both a morning and an evening reading, mornings averaged ${me.sys >= 0 ? '+' : ''}${f1(me.sys)}/${me.dia >= 0 ? '+' : ''}${f1(me.dia)} compared with evenings.` : 'No days yet with both a morning and an evening reading.'}</p></div>`;

  if (full) {
    const c = S.compare7(rs, todayLocal());
    const row = (label, w) => `<tr><td>${label}<br><span class="small muted">${esc(w.from)} to ${esc(w.to)}</span></td><td>${w.readings} readings, ${w.days} days</td><td>${w.days ? `${f1(w.sys)}/${f1(w.dia)}` : '—'}</td><td>${w.sysIqr ? `${f0(w.sysIqr[0])}–${f0(w.sysIqr[1])} / ${f0(w.diaIqr[0])}–${f0(w.diaIqr[1])}` : '—'}</td><td class="small">${Object.entries(w.binCounts).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ') || '—'}</td></tr>`;
    h += `<div class="card"><h2>Last 7 days vs the 7 before</h2><p class="small muted">Averages of daily averages. Different mixes of morning and evening readings can move these on their own.</p>
    <table><tr><th>Window</th><th>Data</th><th>Average</th><th>Middle half of days</th><th>Readings by time</th></tr>${row('Last 7 days', c.last)}${row('Previous 7 days', c.previous)}</table></div>`;
    const wk = S.weekdayMeans(rs);
    h += `<div class="card"><h2>Day of the week</h2>${wk.ready
      ? `<table><tr><th>Day</th><th>Dates</th><th>Average</th></tr>${wk.groups.map((g) => `<tr><td>${g.name}</td><td>${g.dates}</td><td>${f1(g.sys)}/${f1(g.dia)}</td></tr>`).join('')}</table>`
      : `<p class="small muted">Shown once every weekday has at least ${wk.minDates} dates. So far: ${wk.groups.map((g) => `${g.name} ${g.dates}`).join(', ')}.</p>`}</div>`;
    const ps = S.pulseStats(rs);
    h += `<div class="card"><h2>Pulse</h2><p class="small">${ps.shown ? `Average pulse ${f0(ps.mean)} bpm over ${ps.n} readings.` : `Shown after 7 readings with a pulse (so far ${ps.n}).`}</p></div>`;
    h += homeWeekHtml(rs);
    const paper = rs.filter((r) => r.source === PAPER_SOURCE);
    if (paper.length) {
      const ex = S.excludeFirstDay(paper);
      h += `<div class="card"><h2>Imported paper log</h2><p class="small">${paper.length} single readings at irregular times — not the NICE home-monitoring method. Average excluding the first day: ${f1(ex.sys)}/${f1(ex.dia)} (${ex.n} readings), shown for description only.</p></div>`;
    }
  }
  return h;
}

function homeWeekHtml(rs) {
  const w = S.homeWeek(rs);
  if (!w) {
    return `<div class="card"><h2>Home-monitoring week (NICE method)</h2><p class="small">${esc(CKS_TEXT.protocol)}</p><p class="small muted">To run one: tick "Home-monitoring week" on the Log screen, and each morning and evening take a reading, then press "Take a second reading" and take another a minute later.</p></div>`;
  }
  const clinic = rs.filter((r) => r.context === 'clinic').slice(-1)[0];
  return `<div class="card"><h2>Home-monitoring week (NICE method)</h2>
    <p class="big">${f1(w.sys)}/${f1(w.dia)}</p>
    <p class="small muted">Average of ${w.n} readings over ${w.daysTotal - 1} day(s), after discarding the first day (${esc(w.discarded)}).</p>
    <table>${w.checks.map((c) => `<tr><td class="${c.ok ? 'check-ok' : 'check-fail'}">${esc(c.label)}</td><td class="small muted">${esc(c.detail)}</td></tr>`).join('')}</table>
    <h3>NICE reference (CKS)</h3>
    <p class="small">${esc(CKS_TEXT.stage1)}<br>${esc(CKS_TEXT.stage2)}</p>
    <p class="small">${clinic ? `Most recent clinic reading on file: ${clinic.systolic}/${clinic.diastolic} on ${esc(clinic.local_date)}.` : 'No clinic reading on file. NICE’s stages need a clinic reading as well as the home average, so no stage is shown.'}</p>
    <p class="small muted">Source: ${esc(SOURCES.cks.title)}, ${esc(SOURCES.cks.reviewed)}.</p></div>`;
}

function renderInsights() { $('insights').innerHTML = insightsHtml(state.readings); }

// ---------- Report ----------
function renderReport() {
  const days = Number($('report-range').value);
  const from = days ? S.addDays(todayLocal(), -(days - 1)) : '0000-00-00';
  const rs = state.readings.filter((r) => r.local_date >= from);
  const el = $('report');
  el.innerHTML = `<h2>Home blood pressure — ${days ? `last ${days} days` : 'all readings'}</h2>
    <p class="small muted">Printed ${esc(todayLocal())}. Home readings unless marked clinic.</p>
    <div id="report-chart"></div>${insightsHtml(rs, { full: false })}
    <div class="card"><h2>Readings</h2><table><tr><th>Date</th><th>Time</th><th>BP</th><th>Pulse</th><th>Note</th></tr>${rs.map((r) => `<tr><td>${esc(r.local_date)}</td><td>${esc(r.local_time)}</td><td>${r.systolic}/${r.diastolic}${r.context === 'clinic' ? ' (clinic)' : ''}</td><td>${r.pulse ?? ''}</td><td>${esc(r.note || '')}</td></tr>`).join('')}</table></div>
    <p class="small muted">Reference: ${esc(SOURCES.nhsHigh.title)} — ${esc(SOURCES.nhsHigh.quote)}.</p>`;
  renderChart($('report-chart'), rs, { rangeDays: days, showUS: false });
}

// ---------- Import / export ----------
let preview = null;
function setupData() {
  $('csv-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    const { rows, errors } = parseCSV(text);
    const source = /_scan_2026-10-21/i.test(file.name) ? PAPER_SOURCE : `file-import:${file.name}`;
    const items = rowsToPayloads(rows, source);
    const existing = items.filter((i) => state.folded.has(i.reading_id)).length;
    preview = { items, source };
    const warnings = items.map((i) => i.warning).filter(Boolean);
    $('import-preview').innerHTML = `<p><strong>${rows.length}</strong> rows read from ${esc(file.name)}${existing ? ` — ${existing} already imported and will be skipped` : ''}.</p>
      ${errors.length ? `<p class="small">Problems: ${errors.map(esc).join('; ')}</p>` : ''}
      ${warnings.length ? `<p class="small">${warnings.map(esc).join('<br>')}</p>` : ''}
      <table><tr><th>#</th><th>Date</th><th>Time</th><th>BP</th><th>Pulse</th><th>Note</th></tr>${rows.map((r) => `<tr><td>${r.source_row}</td><td>${esc(r.date)}</td><td>${esc(r.time)}</td><td>${r.systolic}/${r.diastolic}</td><td>${r.pulse ?? ''}</td><td>${esc(r.note)}</td></tr>`).join('')}</table>
      <button type="button" id="do-import" class="primary">Import ${rows.length - existing} reading(s)</button>`;
    $('do-import').addEventListener('click', doImport);
  });
  $('export-btn').addEventListener('click', () => {
    const blob = new Blob([toCSV(state.readings)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `blood-pressure-${todayLocal()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
}

async function doImport() {
  const evs = preview.items.filter((i) => !state.folded.has(i.reading_id))
    .map((i) => makeEvent({ op: 'create', reading_id: i.reading_id, payload: i.payload, device_id: DEVICE }));
  if (!evs.length) { toast('Nothing new to import.'); return; }
  await save(evs);
  $('import-preview').innerHTML = `<p>Imported ${evs.length} reading(s). Check each one against the paper in History → "Only imported readings not yet checked".</p>`;
  recompute();
}


// ---------- About ----------
function renderAbout() {
  const src = Object.values(SOURCES).map((s) => `<li><a href="${esc(s.url)}" rel="noreferrer">${esc(s.title)}</a> — ${esc(s.reviewed)}. ${s.quote ? `“${esc(s.quote)}”` : ''}</li>`).join('');
  $('about').innerHTML = `<h2>About</h2>
    <p class="small">Every reading is saved on this device first, then copied to your Dropbox, into the app's own folder (<code>Dropbox/Apps/…</code>). The app can see nothing else in your Dropbox. Each device writes its own file, and every change is kept, so edits and deletions can be undone.</p>
    <p class="small">Dropbox: ${state.connected ? 'connected' : 'not connected'}${state.lastSync ? ` · last synced ${esc(new Date(state.lastSync).toLocaleString('en-GB'))}` : ''}${state.pending ? ` · ${state.pending} change(s) waiting` : ''}.</p>
    <div class="row">${state.connected ? '<button type="button" id="check-btn" class="secondary">Check Dropbox connection</button> <button type="button" id="disconnect-btn" class="danger">Disconnect Dropbox on this device</button>' : (DROPBOX_APP_KEY ? '<button type="button" id="about-connect" class="secondary">Connect Dropbox</button>' : '')}</div>
    <p id="check-result" class="small">${esc(state.checkResult || '')}</p>
    <p class="small muted">Lost phone? On another device, open Dropbox → Settings → Connected apps and remove this app; that cuts off every device's access at once.</p>
    <h3>Phone home screen</h3><p class="small">In Chrome, open the menu (⋮) and choose “Add to Home screen”.</p>
    <h3>Reference sources</h3><ul class="small">${src}</ul>
    <p class="small">${esc(CKS_TEXT.stage3)}</p>
    <p class="small muted">The app states figures and published thresholds only; it does not diagnose.</p>`;
  $('disconnect-btn')?.addEventListener('click', async () => {
    if (state.pending && !confirm(`${state.pending} change(s) have not reached Dropbox yet. Disconnect anyway? (They stay on this device.)`)) return;
    await dbx.disconnect();
    await refreshLocal();
    toast('Disconnected from Dropbox.');
  });
  $('about-connect')?.addEventListener('click', () => dbx.startLogin());
  $('check-btn')?.addEventListener('click', async () => {
    // Kept in state so the message survives the re-render that follows a sync.
    $('check-result').textContent = 'Checking…';
    try {
      const r = await dbx.checkConnection();
      state.checkResult = `OK — sign-in renewed without a password, and the app folder holds ${r.files.length} file(s)${r.files.length ? `: ${r.files.join(', ')}` : ''}. Checked ${new Date().toLocaleTimeString('en-GB')}.`;
      await doSync();
    } catch (e) {
      state.checkResult = `Problem: ${e.message}`;
      await refreshLocal();
    }
  });
}

// ---------- wire up ----------
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
document.querySelectorAll('[data-range]').forEach((b) => b.addEventListener('click', () => {
  state.range = Number(b.dataset.range);
  document.querySelectorAll('[data-range]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  render();
}));
$('show-us').addEventListener('change', render);
$('only-unchecked').addEventListener('change', renderHistory);
$('report-range').addEventListener('change', renderReport);
$('print-btn').addEventListener('click', () => window.print());
$('e-save').addEventListener('click', saveEdit);
$('e-delete').addEventListener('click', deleteEdit);
$('e-cancel').addEventListener('click', () => $('edit-dialog').close());
window.addEventListener('resize', () => { if (state.view === 'charts') render(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) doSync(); });
$('connect-btn').addEventListener('click', () => dbx.startLogin());
setupLog();
setupData();
if (location.hash) showView(location.hash.slice(1));
window.addEventListener('hashchange', () => { const v = location.hash.slice(1) || 'log'; if (v !== state.view) showView(v); });
init();
