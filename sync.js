// Sync with Dropbox. Each browser install writes ONLY its own files (events-<device>-<year>.jsonl)
// and reads everyone's. Uploads are rev-guarded; a rejected upload is merged and retried, never forced.
// Pure module: the Dropbox client and the local store are passed in (tests use fakes).

export const LOG_RE = /^events-([0-9a-f-]+)-(\d{4})\.jsonl$/i;

export function parseLog(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip a damaged line; never rewrite another device's file */ }
  }
  return out;
}

export function toLog(events) {
  return events
    .slice()
    .sort((a, b) => (a.recorded_at === b.recorded_at ? a.eid.localeCompare(b.eid) : a.recorded_at.localeCompare(b.recorded_at)))
    .map((e) => JSON.stringify(e))
    .join('\n') + '\n';
}

function unionByEid(...lists) {
  const m = new Map();
  for (const l of lists) for (const e of l) if (!m.has(e.eid)) m.set(e.eid, e);
  return [...m.values()];
}

const yearOf = (e) => e.recorded_at.slice(0, 4);

async function withLock(fn) {
  const locks = globalThis.navigator?.locks;
  return locks ? locks.request('bp-dropbox-sync', fn) : fn();
}

// Returns { pulled, pushed, files }. useLock=false is for tests that simulate two tabs inside one process.
export async function sync({ store, dbx, deviceId, useLock = true }) {
  return (useLock ? withLock : (fn) => fn())(async () => {
    const entries = await dbx.listFolder();
    const logs = entries.filter((e) => LOG_RE.test(e.name));
    const known = (await store.getMeta('known')) || {};
    let pulled = 0;
    for (const f of logs) {
      if (known[f.name] === f.content_hash) continue;
      const { text } = await dbx.download(`/${f.name}`);
      const evs = parseLog(text);
      await store.putEvents(evs);
      pulled += evs.length;
      known[f.name] = f.content_hash;
    }
    await store.setMeta('known', known);

    const pendingIds = new Set(await store.outboxEids());
    if (!pendingIds.size) return { pulled, pushed: 0, files: logs.length };
    const all = await store.allEvents();
    const mine = all.filter((e) => e.device_id === deviceId);
    const pendingYears = [...new Set(mine.filter((e) => pendingIds.has(e.eid)).map(yearOf))];
    let pushed = 0;
    for (const year of pendingYears) {
      const name = `events-${deviceId}-${year}.jsonl`;
      const local = mine.filter((e) => yearOf(e) === year);
      for (let attempt = 1; ; attempt++) {
        const entry = attempt === 1 ? logs.find((f) => f.name === name) : (await dbx.listFolder()).find((f) => f.name === name);
        let remote = [];
        let rev = null;
        if (entry) {
          const d = await dbx.download(`/${name}`);
          remote = parseLog(d.text);
          rev = d.rev;
          await store.putEvents(remote);
        }
        const merged = unionByEid(remote, local);
        const remoteIds = new Set(remote.map((e) => e.eid));
        if (entry && merged.every((e) => remoteIds.has(e.eid))) {
          // Already there (e.g. an earlier upload succeeded but its reply was lost).
          await store.clearOutbox(local.map((e) => e.eid));
          break;
        }
        try {
          const meta = await dbx.upload(`/${name}`, toLog(merged), rev);
          await store.clearOutbox(local.map((e) => e.eid));
          known[name] = meta.content_hash;
          await store.setMeta('known', known);
          pushed += merged.length - remote.length;
          break;
        } catch (err) {
          if (err && err.conflict && attempt < 5) continue;
          throw err;
        }
      }
    }
    return { pulled, pushed, files: logs.length };
  });
}
