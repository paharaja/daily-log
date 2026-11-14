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
  };
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
export function planImport(records, user, { existingIds = new Set(), readings = [], now = new Date() } = {}) {
  const cands = [];
  const skipped = { undated: 0, already: 0, typed: 0 };
  const seen = new Set();
  for (const r of records) {
    const t = recordTime(r, now);
    if (!t.ok) { skipped.undated++; continue; }
    const id = deviceReadingId(r, user);
    if (existingIds.has(id) || seen.has(id)) { skipped.already++; continue; }
    seen.add(id);
    const pulse = r.pulse || null;
    const payload = {
      systolic: r.systolic, diastolic: r.diastolic, pulse,
      measured_at_utc: t.measured_at_utc, local_date: t.local_date, local_time: t.local_time,
      offset_minutes: t.offset_minutes, tz: TZ, source: SOURCE, device_user: user, context: 'home',
      monitor_time: t.monitor_time,
    };
    if (t.uncertain) payload.time_uncertain = true;
    if (r.ihb) payload.monitor_ihb = true;
    if (r.mov) payload.monitor_movement = true;
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
export async function readMonitor({ user = 1, onStatus = () => {}, bluetooth = globalThis.navigator?.bluetooth, timeoutMs = 2000 } = {}) {
  if (!bluetooth) throw new Error('This browser cannot use Bluetooth. Use Chrome or Edge on the computer the monitor is paired with.');
  const start = USER_START[user];
  if (start == null) throw new Error(`Unknown monitor user ${user}.`);
  onStatus('Pick the monitor in the list (press its Bluetooth button briefly if it is not listed)…');
  const device = await bluetooth.requestDevice({ filters: FILTERS, optionalServices: [SERVICE] });
  let gone = false;
  let waiter = null; // receives each reply (or null on disconnect) while a command is waiting
  let feed = assembler();
  let rx = null;
  const onGone = () => { gone = true; if (waiter) waiter(null); };
  const onValue = (ev) => {
    const dv = ev.target.value;
    for (const p of feed(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength))) if (waiter) waiter(p);
  };
  device.addEventListener?.('gattserverdisconnected', onGone);
  onStatus('Connecting to the monitor…');
  try {
    const server = await device.gatt.connect();
    const svc = await server.getPrimaryService(SERVICE);
    rx = await svc.getCharacteristic(RX);
    const tx = await svc.getCharacteristic(TX);
    rx.addEventListener('characteristicvaluechanged', onValue);
    await rx.startNotifications();
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
    await send(cmdStart(), '8000');
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
    waiter = null;
    if (rx) {
      rx.removeEventListener('characteristicvaluechanged', onValue);
      try { await rx.stopNotifications(); } catch { /* disconnecting anyway */ }
    }
    device.removeEventListener?.('gattserverdisconnected', onGone);
    try { device.gatt.disconnect(); } catch { /* already gone */ }
  }
}
