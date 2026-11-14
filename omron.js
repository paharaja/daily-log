// Omron M7 Intelli IT AFib (HEM-7380T1) over Web Bluetooth (Chrome or Edge).
// Protocol, memory addresses and record layout follow omblepy (github.com/userx14/omblepy),
// deviceSpecific/hem-7380t.py and sharedDriver.py. The monitor must already be paired with the computer.
// The pure parts (framing, decoding, import planning) are exported for node tests.
// This code is public: it must never contain readings.
import { fromLocal, TZ } from './model.js';

export const SERVICE = '0000fe4a-0000-1000-8000-00805f9b34fb';
export const RX = '49123040-aee8-11e1-a74d-0002a5d5c51b'; // monitor -> app (notify)
export const TX = 'db5b55e0-aee7-11e1-965e-0002a5d5c51b'; // app -> monitor (write without response)
export const NAME_PREFIX = 'BLESmart_';
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

// A reply can arrive split over several notifications; its first byte is its full length.
export function assembler() {
  let acc = [];
  return (chunk) => {
    if (acc.length && acc.length >= acc[0]) acc = [];
    acc.push(...chunk);
    if (acc.length && acc.length >= acc[0]) {
      const p = Uint8Array.from(acc.slice(0, acc[0]));
      acc = [];
      return p;
    }
    return null;
  };
}

export const replyType = (p) => ((p[1] << 8) | p[2]).toString(16).padStart(4, '0');

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
export function blockData(p, addr) {
  const raddr = (p[3] << 8) | p[4];
  const len = p[5];
  if (raddr !== addr) throw new Error(`address mismatch ${raddr.toString(16)} vs ${addr.toString(16)}`);
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
// (the monitor then stores 1 Jan 2024 with seconds 63), the date is impossible, or it is in the future.
export function recordTime(r, now = new Date()) {
  const { year, month, day, hour, minute, second } = r;
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const real = second <= 59 && minute <= 59 && hour <= 23 && d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
  if (!real || year < 2025) return { ok: false, why: 'no date' };
  const local_date = `${year}-${pad(month)}-${pad(day)}`;
  const local_time = `${pad(hour)}:${pad(minute)}`;
  const res = fromLocal(local_date, local_time);
  let c = res.candidates[0];
  if (res.status === 'nonexistent') c = { utc: new Date(Date.UTC(year, month - 1, day, hour, minute)).toISOString(), offset_minutes: 0 };
  const utc = new Date(Date.parse(c.utc) + second * 1000);
  if (utc.getTime() > now.getTime() + 24 * 3600e3) return { ok: false, why: 'future' };
  return { ok: true, measured_at_utc: utc.toISOString(), local_date, local_time, offset_minutes: c.offset_minutes, seconds: second };
}

// Same reading read twice gives the same id, so nothing is ever imported twice.
export function deviceReadingId(r, user) {
  return `${SOURCE}#u${user}-${r.year}-${pad(r.month)}-${pad(r.day)}T${pad(r.hour)}:${pad(r.minute)}:${pad(r.second)}-${r.systolic}-${r.diastolic}-${r.pulse}`;
}

// Decide what to add. existingIds: reading ids already known (including deleted ones, so a deleted
// monitor reading does not come back). readings: current readings, used to spot ones already typed in.
export function planImport(records, user, { existingIds = new Set(), readings = [], now = new Date() } = {}) {
  const add = [];
  const skipped = { undated: 0, already: 0, typed: 0 };
  const seen = new Set();
  const typed = readings.filter((x) => !isDeviceSource(x.source));
  for (const r of records) {
    const t = recordTime(r, now);
    if (!t.ok) { skipped.undated++; continue; }
    const id = deviceReadingId(r, user);
    if (existingIds.has(id) || seen.has(id)) { skipped.already++; continue; }
    seen.add(id);
    const at = Date.parse(t.measured_at_utc);
    if (typed.some((x) => x.systolic === r.systolic && x.diastolic === r.diastolic && Math.abs(Date.parse(x.measured_at_utc) - at) <= 10 * 60000)) { skipped.typed++; continue; }
    const payload = {
      systolic: r.systolic, diastolic: r.diastolic, pulse: r.pulse || null,
      measured_at_utc: t.measured_at_utc, local_date: t.local_date, local_time: t.local_time,
      offset_minutes: t.offset_minutes, tz: TZ, source: SOURCE, device_user: user, context: 'home',
    };
    if (r.ihb) payload.monitor_ihb = true;
    if (r.mov) payload.monitor_movement = true;
    add.push({ reading_id: id, payload });
  }
  return { add, skipped, total: records.length };
}

// ---------- Web Bluetooth ----------
// Asks the person to pick the monitor, reads one user's memory, and disconnects.
export async function readMonitor({ user = 1, onStatus = () => {}, bluetooth = globalThis.navigator?.bluetooth } = {}) {
  if (!bluetooth) throw new Error('This browser cannot use Bluetooth. Use Chrome or Edge on the computer the monitor is paired with.');
  const start = USER_START[user];
  if (start == null) throw new Error(`Unknown monitor user ${user}.`);
  onStatus('Pick the monitor in the list (press its Bluetooth button first if it is not listed)…');
  const device = await bluetooth.requestDevice({ filters: [{ namePrefix: NAME_PREFIX }], optionalServices: [SERVICE] });
  onStatus('Connecting to the monitor…');
  const server = await device.gatt.connect();
  try {
    const svc = await server.getPrimaryService(SERVICE);
    const rx = await svc.getCharacteristic(RX);
    const tx = await svc.getCharacteristic(TX);
    let feed = assembler();
    let waiter = null;
    const onValue = (ev) => {
      const dv = ev.target.value;
      const p = feed(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
      if (p && waiter) { const w = waiter; waiter = null; w(p); }
    };
    rx.addEventListener('characteristicvaluechanged', onValue);
    await rx.startNotifications();
    const write = (b) => (tx.writeValueWithoutResponse ? tx.writeValueWithoutResponse(b) : tx.writeValue(b));
    const send = async (cmd, expect) => {
      let last = 'no reply';
      for (let i = 0; i < 5; i++) {
        feed = assembler();
        const got = new Promise((resolve) => {
          waiter = resolve;
          setTimeout(() => { if (waiter === resolve) { waiter = null; resolve(null); } }, 2000);
        });
        await write(cmd);
        const p = await got;
        last = p ? checkReply(p, expect) : 'no reply';
        if (!last) return p;
      }
      throw new Error(`The monitor stopped answering (${last}).`);
    };
    await send(cmdStart(), '8000');
    const records = [];
    for (let k = 0; k < SLOTS; k++) {
      onStatus(`Reading the monitor's memory… ${Math.round((k / SLOTS) * 100)}%`);
      const addr = start + k * REC_SIZE;
      const r = decodeRecord(blockData(await send(cmdRead(addr), '8100'), addr));
      if (r) records.push(r);
    }
    try { await send(cmdEnd(), '8f00'); } catch { /* the readings are already in hand */ }
    rx.removeEventListener('characteristicvaluechanged', onValue);
    try { await rx.stopNotifications(); } catch { /* disconnecting anyway */ }
    return records;
  } finally {
    try { device.gatt.disconnect(); } catch { /* already gone */ }
  }
}
