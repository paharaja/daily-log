// Omron M7 Intelli IT AFib (HEM-7380T1) over Web Bluetooth (Chrome or Edge).
// Protocol, memory addresses and record layout follow omblepy (github.com/userx14/omblepy),
// omblepy.py, deviceSpecific/hem-7380t.py and sharedDriver.py. The monitor must already be paired with the computer.
// The pure parts (framing, decoding, import planning) are exported for node tests.
// This code is public: it must never contain readings.
import { fromLocal, TZ } from './model.js';

export const SERVICE = '0000fe4a-0000-1000-8000-00805f9b34fb';
export const RX = '49123040-aee8-11e1-a74d-0002a5d5c51b'; // monitor -> app (notify)
export const TX = 'db5b55e0-aee7-11e1-965e-0002a5d5c51b'; // app -> monitor (write without response)
// Windows listed this monitor as "BLESmart_…"; other Omron units advertise "BLEsmart_…", and a paired
// monitor may show its own name instead. Any one of these filters is enough to list it.
export const FILTERS = [{ namePrefix: 'BLESmart_' }, { namePrefix: 'BLEsmart_' }, { namePrefix: 'M7Intelli' }, { services: [SERVICE] }];
export const MODEL = 'HEM-7380T';
export const SOURCE = `device:${MODEL}`;
export const USER_START = { 1: 0x01c4, 2: 0x0804 };
export const SLOTS = 100;
export const REC_SIZE = 16;
export const isDeviceSource = (s) => typeof s === 'string' && s.startsWith('device:');

const pad = (n) => String(n).padStart(2, '0');

// ---------- framing ----------
// Every command and reply ends with a byte that makes the XOR of the whole packet zero.
export function withXor(body) {
  let x = 0;
  for (const b of body) x ^= b;
  return Uint8Array.from([...body, x]);
}
export const cmdStart = () => withXor([0x08, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00]);
export const cmdRead = (addr, size = REC_SIZE) => withXor([0x08, 0x01, 0x00, (addr >> 8) & 0xff, addr & 0xff, size, 0x00]);
export const cmdEnd = () => withXor([0x08, 0x0f, 0x00, 0x00, 0x00, 0x00, 0x00]);

// Byte 0 of a reply is its full length. A reply can arrive split over several notifications, and a
// notification can carry more than one reply: return every complete reply, keep any partial tail.
export function assembler() {
  let acc = [];
  return (chunk) => {
    acc.push(...chunk);
    const out = [];
    while (acc.length) {
      if (acc[0] < 3) { acc = []; break; } // cannot be the start of a reply: drop it
      if (acc.length < acc[0]) break;
      out.push(Uint8Array.from(acc.slice(0, acc[0])));
      acc = acc.slice(acc[0]);
    }
    return out;
  };
}

export const replyType = (p) => ((p[1] << 8) | p[2]).toString(16).padStart(4, '0');
export const replyAddr = (p) => (p[3] << 8) | p[4];

// Returns null when the reply is good, otherwise what is wrong with it.
export function checkReply(p, expect) {
  if (!p || p.length < 3) return 'short reply';
  let x = 0;
  for (const b of p) x ^= b;
  if (x !== 0) return 'checksum failed';
  const t = replyType(p);
  return t === expect ? null : `unexpected reply ${t}`;
}

// Data bytes of a memory-read reply: [len][type x2][addr x2][datalen][data...][0][xor].
// Like omblepy, a reply that declares more data than it carries is read as empty (0xFF) memory.
export function blockData(p, addr) {
  const len = p[5];
  if (replyAddr(p) !== addr) throw new Error(`address mismatch ${replyAddr(p).toString(16)} vs ${addr.toString(16)}`);
  if (len > p.length - 8) return new Uint8Array(len).fill(0xff);
  return p.slice(6, 6 + len);
}

// ---------- records ----------
// omblepy's bit numbering: the record is read as one little-endian integer and bit 0 is its top bit.
export function bits(rec, first, last) {
  let v = 0;
  for (let i = first; i <= last; i++) {
    const byte = rec[rec.length - 1 - (i >> 3)];
    v = (v << 1) | ((byte >> (7 - (i & 7))) & 1);
  }
  return v;
}

// One 16-byte memory slot -> reading, or null for an empty slot.
export function decodeRecord(rec) {
  if (rec.length !== REC_SIZE) throw new Error(`record of ${rec.length} bytes`);
  if (rec.every((b) => b === 0xff)) return null;
  if (bits(rec, 120, 127) > 0xfa) return null;
  return {
    year: bits(rec, 98, 103) + 2000, month: bits(rec, 82, 85), day: bits(rec, 86, 90),
    hour: bits(rec, 91, 95), minute: bits(rec, 68, 73), second: bits(rec, 74, 79),
    systolic: bits(rec, 120, 127) + 25, diastolic: bits(rec, 112, 119), pulse: bits(rec, 104, 111),
    ihb: bits(rec, 81, 81), mov: bits(rec, 80, 80),
    // Not in omblepy, and not confirmed by any public source. Seen on this monitor (2026-11-14, one set):
    // the 3 readings of a TruRead measurement carried 1, 2, 3 here; 41 ordinary readings carried 0.
    truread: bits(rec, 64, 65),
  };
}

// A TruRead measurement is stored as 3 separate readings numbered 1, 2, 3. Records are first put in time
// order (how the memory is ordered once it holds 100 readings is not known), then each run of consecutively
// numbered readings taken within 15 minutes is one set; every other reading is a group of one.
export const TRUREAD_SET = 3;
const recMs = (r) => Date.UTC(r.year, r.month - 1, r.day, r.hour, r.minute, Math.min(r.second, 59));
export function groupTruRead(records) {
  const groups = [];
  let cur = null;
  const inTimeOrder = records.map((r, i) => ({ r, i })).sort((a, b) => recMs(a.r) - recMs(b.r) || a.i - b.i).map((x) => x.r);
  for (const r of inTimeOrder) {
    const n = r.truread || 0;
    const last = cur && cur[cur.length - 1];
    if (n > 0 && last && n === last.truread + 1 && Math.abs(recMs(r) - recMs(cur[0])) <= 15 * 60000) { cur.push(r); continue; }
    cur = n > 0 ? [r] : null;
    groups.push(cur || [r]);
  }
  return groups;
}

// The monitor's clock is local time. A reading has no usable date when the clock was never set
// (this monitor then stored 1 Jan 2024 00:00), the date is impossible, or it is in the future.
// omblepy notes the seconds field "can range up to 63"; like omblepy, values above 59 are read as 59.
// A time in the hour the UK clocks skip or repeat is converted but marked uncertain.
export function recordTime(r, now = new Date()) {
  const { year, month, day, hour, minute } = r;
  const second = Math.min(r.second, 59);
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const real = minute <= 59 && hour <= 23 && d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
  if (!real || year < 2025) return { ok: false, why: 'no date' };
  const local_date = `${year}-${pad(month)}-${pad(day)}`;
  const local_time = `${pad(hour)}:${pad(minute)}`;
  const res = fromLocal(local_date, local_time);
  let c = res.candidates[0];
  if (res.status === 'nonexistent') c = { utc: new Date(Date.UTC(year, month - 1, day, hour, minute)).toISOString(), offset_minutes: 0 };
  const utc = new Date(Date.parse(c.utc) + second * 1000);
  if (utc.getTime() > now.getTime() + 24 * 3600e3) return { ok: false, why: 'future' };
  return {
    ok: true, measured_at_utc: utc.toISOString(), local_date, local_time, offset_minutes: c.offset_minutes, seconds: second,
    monitor_time: `${local_date} ${local_time}:${pad(r.second)}`, uncertain: res.status !== 'ok',
  };
}

// Same reading read twice gives the same id, so nothing is ever imported twice.
// The raw seconds are kept, so two readings that differ only there stay two readings.
export function deviceReadingId(r, user) {
  return `${SOURCE}#u${user}-${r.year}-${pad(r.month)}-${pad(r.day)}T${pad(r.hour)}:${pad(r.minute)}:${pad(r.second)}-${r.systolic}-${r.diastolic}-${r.pulse}`;
}

// Decide what to add. existingIds: reading ids already known (including deleted ones, so a deleted
// monitor reading does not come back). readings: current readings, used to spot ones already typed in.
// A typed reading matches at most one monitor reading: same systolic and diastolic, pulse equal when
// both have one, within 10 minutes, nearest first. Matched monitor readings are returned, not dropped.
// Every reading id the app has ever held, deleted ones included, plus the monitor readings behind every
// TruRead average it has ever held (from each reading's full history, so a deleted average counts too).
export function knownIdsFrom(folded) {
  const ids = new Set(folded.keys());
  for (const r of folded.values()) for (const e of r.history || []) for (const m of e.payload?.monitor_reading_ids || []) ids.add(m);
  return ids;
}

export function planImport(records, user, { existingIds = new Set(), readings = [], now = new Date() } = {}) {
  const cands = [];
  const skipped = { undated: 0, already: 0, typed: 0, pending: 0, pendingSets: 0 };
  const seen = new Set();
  // Readings already in the app as part of an average count as known too.
  const known = new Set(existingIds);
  for (const x of readings) for (const m of x.monitor_reading_ids || []) known.add(m);
  // Each group is one reading for the app: an ordinary reading, or the average of a TruRead set
  // (rounded to whole numbers, at the time of the set's first reading, with the set's readings kept).
  // A set any of whose readings is already in the app (imported one by one before) is left alone.
  // A set with fewer than 3 readings whose last one is under 15 minutes old may still be running:
  // it is left for the next import.
  for (const g of groupTruRead(records)) {
    const ts = g.map((r) => recordTime(r, now));
    if (ts.some((t) => !t.ok)) { skipped.undated += g.length; continue; }
    const isSet = (g[0].truread || 0) > 0;
    if (isSet && g[g.length - 1].truread < TRUREAD_SET && now.getTime() - Date.parse(ts[ts.length - 1].measured_at_utc) < 15 * 60000) {
      skipped.pending += g.length;
      skipped.pendingSets++;
      continue;
    }
    const ids = g.map((r) => deviceReadingId(r, user));
    const id = g.length > 1 ? `${ids[0]}-truread` : ids[0];
    if ([id, ...ids].some((x) => known.has(x) || seen.has(x))) { skipped.already += g.length; continue; }
    seen.add(id);
    for (const x of ids) seen.add(x);
    const t = ts[0];
    const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
    const pulse = mean(g.map((r) => r.pulse).filter(Boolean));
    const payload = {
      systolic: mean(g.map((r) => r.systolic)), diastolic: mean(g.map((r) => r.diastolic)), pulse,
      measured_at_utc: t.measured_at_utc, local_date: t.local_date, local_time: t.local_time,
      offset_minutes: t.offset_minutes, tz: TZ, source: SOURCE, device_user: user, context: 'home',
      monitor_time: t.monitor_time,
    };
    if (g.length > 1) {
      payload.truread_count = g.length;
      payload.monitor_readings = g.map((r, i) => ({ systolic: r.systolic, diastolic: r.diastolic, pulse: r.pulse || null, monitor_time: ts[i].monitor_time }));
      payload.monitor_reading_ids = ids;
    }
    if (ts.some((x) => x.uncertain)) payload.time_uncertain = true;
    if (g.some((r) => r.ihb)) payload.monitor_ihb = true;
    if (g.some((r) => r.mov)) payload.monitor_movement = true;
    cands.push({ reading_id: id, payload, at: Date.parse(t.measured_at_utc), typed: null });
  }
  // Pair typed and monitor readings nearest-first, each used at most once.
  const typed = readings.filter((x) => !isDeviceSource(x.source)).map((x) => ({ x, at: Date.parse(x.measured_at_utc), used: false }));
  const pairs = [];
  for (const c of cands) {
    for (const m of typed) {
      const p = c.payload;
      if (m.x.systolic === p.systolic && m.x.diastolic === p.diastolic && (m.x.pulse == null || p.pulse == null || m.x.pulse === p.pulse)
        && Math.abs(m.at - c.at) <= 10 * 60000) pairs.push({ c, m, d: Math.abs(m.at - c.at) });
    }
  }
  pairs.sort((a, b) => a.d - b.d);
  for (const { c, m } of pairs) if (!c.typed && !m.used) { c.typed = m.x; m.used = true; }
  const add = [];
  const typedMatches = [];
  for (const c of cands) {
    if (c.typed) { skipped.typed++; typedMatches.push({ reading_id: c.reading_id, payload: c.payload, typed: c.typed }); }
    else add.push({ reading_id: c.reading_id, payload: c.payload });
  }
  return { add, typedMatches, skipped, total: records.length };
}

// ---------- Web Bluetooth ----------
// Asks the person to pick the monitor, reads one user's memory, and disconnects.
// Seen on Windows (2026-11-14): connect() resolved and the link dropped about 0.3 s later at times when the
// monitor would not hold a connection; it held one some seconds after its Bluetooth button was pressed.
// So connecting is retried until it holds, for at most connectMs in all. Chromium on Windows asks the OS to
// maintain the connection, and gatt.disconnect() closes that session, so between tries the loop only waits and
// asks again; it closes the link and opens it again only after 2 failures on a link that stayed up.
// The read in progress on each device: a late connect() from an earlier read must not close a later read's link.
const activeReads = new Map();
export async function readMonitor({ user = 1, onStatus = () => {}, bluetooth = globalThis.navigator?.bluetooth, timeoutMs = 2000, connectMs = 60000, retryMs = 2500 } = {}) {
  if (!bluetooth) throw new Error('This browser cannot use Bluetooth. Use Chrome or Edge on the computer the monitor is paired with.');
  const start = USER_START[user];
  if (start == null) throw new Error(`Unknown monitor user ${user}.`);
  onStatus('Pick the monitor in the list…');
  const device = await bluetooth.requestDevice({ filters: FILTERS, optionalServices: [SERVICE] });
  const readKey = device.id ?? device;
  const thisRead = {};
  activeReads.set(readKey, thisRead);
  let gone = false;
  let finished = false; // set once the read is over: a connect() that completes after that is closed again
  let waiter = null; // receives each reply (or null on disconnect) while a command is waiting
  let feed = assembler();
  let rx = null;
  // A disconnect event that arrives while the link is up belongs to an earlier try: ignore it.
  const onGone = () => { if (device.gatt && device.gatt.connected === true) return; gone = true; if (waiter) waiter(null); };
  const onValue = (ev) => {
    const dv = ev.target.value;
    for (const p of feed(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength))) if (waiter) waiter(p);
  };
  device.addEventListener?.('gattserverdisconnected', onGone);
  onStatus('Connecting to the monitor…');
  try {
    let tx = null;
    const giveUp = Date.now() + connectMs;
    // Every step must start and finish before the overall deadline; once it has passed, no step is started.
    // The finally block disconnects whatever is still pending.
    const inTime = (step) => {
      if (Date.now() >= giveUp) return Promise.reject(new Error('no answer in time'));
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('no answer in time')), giveUp - Date.now());
        Promise.resolve().then(step).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
      });
    };
    const connect = () => {
      const c = device.gatt.connect();
      Promise.resolve(c).then(() => {
        if (finished && activeReads.get(readKey) === thisRead) { try { device.gatt.disconnect(); } catch { /* already closed */ } }
      }, () => {});
      return c;
    };
    const write = (b) => (tx.writeValueWithoutResponse ? tx.writeValueWithoutResponse(b) : tx.writeValue(b));
    // Send a command and wait for its answer. Replies of another type, or for another address, are
    // late answers to an earlier attempt: they are ignored and the wait goes on. Up to 5 attempts.
    const send = async (cmd, expect, addr = null) => {
      let last = 'no reply';
      for (let i = 0; i < 5 && !gone; i++) {
        feed = assembler();
        const got = new Promise((resolve) => {
          let timer = null;
          const done = (v) => { clearTimeout(timer); waiter = null; resolve(v); };
          timer = setTimeout(() => done(null), timeoutMs);
          waiter = (p) => {
            if (p === null) return done(null);
            const err = checkReply(p, expect);
            if (err && err.startsWith('unexpected reply')) return; // late answer to another command
            if (!err && addr != null && replyAddr(p) !== addr) return; // late answer for another address
            if (!err && addr != null && p[5] !== REC_SIZE) return done({ err: `reply of ${p[5]} bytes` });
            done({ p, err });
          };
        });
        try { await write(cmd); } catch (e) { if (gone) break; throw e; }
        const r = await got;
        if (r && !r.err) return r.p;
        last = r ? r.err : 'no reply';
      }
      throw new Error(gone ? 'The monitor disconnected.' : `The monitor stopped answering (${last}).`);
    };
    // The link counts as up only once the monitor has answered the start command.
    let server = null;
    let failsOnLink = 0; // failures while the link stayed up: after 2, that link is closed and reopened
    for (let attempt = 1; ; attempt++) {
      try {
        if (attempt > 1 && Date.now() >= giveUp) throw new Error('no answer in time');
        if (!server || device.gatt.connected !== true) { server = await inTime(connect); failsOnLink = 0; }
        const svc = await inTime(() => server.getPrimaryService(SERVICE));
        const r = await inTime(() => svc.getCharacteristic(RX));
        tx = await inTime(() => svc.getCharacteristic(TX));
        await inTime(() => r.startNotifications());
        if (r !== rx) {
          if (rx) rx.removeEventListener('characteristicvaluechanged', onValue);
          rx = r;
          rx.addEventListener('characteristicvaluechanged', onValue);
        }
        if (device.gatt.connected === false) throw new Error('the link dropped while connecting');
        gone = false;
        await inTime(() => send(cmdStart(), '8000'));
        break;
      } catch (e) {
        if (Date.now() + retryMs >= giveUp) {
          throw new Error(`Could not connect to the monitor (${e && e.message ? e.message : e}).`);
        }
        if (device.gatt.connected === true && ++failsOnLink >= 2) {
          try { device.gatt.disconnect(); } catch { /* already closed */ }
          server = null;
        }
        onStatus(`Waiting for the monitor to connect — press its Bluetooth button if you haven't (try ${attempt})…`);
        await new Promise((r) => setTimeout(r, retryMs));
      }
    }
    const records = [];
    for (let k = 0; k < SLOTS; k++) {
      onStatus(`Reading the monitor's memory… ${Math.round((k / SLOTS) * 100)}%`);
      const addr = start + k * REC_SIZE;
      const r = decodeRecord(blockData(await send(cmdRead(addr), '8100', addr), addr));
      if (r) records.push(r);
    }
    try { await send(cmdEnd(), '8f00'); } catch { /* the readings are already in hand */ }
    return records;
  } finally {
    // Stop any command still waiting, so nothing more is written once the read is over.
    gone = true;
    if (waiter) waiter(null);
    waiter = null;
    if (rx) {
      rx.removeEventListener('characteristicvaluechanged', onValue);
      // Waits at most 1 second: disconnecting ends the notifications anyway.
      if (device.gatt.connected !== false) {
        let t = null;
        try { await Promise.race([rx.stopNotifications(), new Promise((r) => { t = setTimeout(r, 1000); })]); } catch { /* disconnecting anyway */ }
        clearTimeout(t);
      }
    }
    device.removeEventListener?.('gattserverdisconnected', onGone);
    try { device.gatt.disconnect(); } catch { /* already gone */ }
    finished = true; // only now: a connect() completing before this point is closed by the disconnect above
  }
}
