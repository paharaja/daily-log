// Local storage on this device: every event, the outbox of events not yet in Dropbox, and settings.
// Two implementations with the same interface: IndexedDB (browser) and in-memory (tests).

export function memoryStore() {
  const events = new Map();
  const outbox = new Set();
  const meta = new Map();
  return {
    async open() {},
    async allEvents() { return [...events.values()]; },
    async putEvents(list, { pending = false } = {}) {
      for (const e of list) {
        if (!events.has(e.eid)) events.set(e.eid, e);
        if (pending) outbox.add(e.eid);
      }
    },
    async outboxEids() { return [...outbox]; },
    async clearOutbox(eids) { for (const id of eids) outbox.delete(id); },
    async getMeta(k) { return meta.get(k); },
    async setMeta(k, v) { meta.set(k, v); },
    async wipe() { events.clear(); outbox.clear(); meta.clear(); },
  };
}

export function idbStore(name = 'bp-tracker') {
  let db;
  const tx = (stores, mode, fn) => new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
    result = fn(t);
  });
  const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  return {
    async open() {
      db = await new Promise((resolve, reject) => {
        const r = indexedDB.open(name, 1);
        r.onupgradeneeded = () => {
          const d = r.result;
          d.createObjectStore('events', { keyPath: 'eid' });
          d.createObjectStore('outbox');
          d.createObjectStore('meta');
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    },
    async allEvents() {
      const t = db.transaction('events');
      return req(t.objectStore('events').getAll());
    },
    // Event and outbox entry are written in ONE transaction: a saved reading is never lost between the two.
    async putEvents(list, { pending = false } = {}) {
      await tx(['events', 'outbox'], 'readwrite', (t) => {
        const ev = t.objectStore('events');
        const ob = t.objectStore('outbox');
        for (const e of list) {
          ev.put(e);
          if (pending) ob.put(true, e.eid);
        }
      });
    },
    async outboxEids() {
      const t = db.transaction('outbox');
      return req(t.objectStore('outbox').getAllKeys());
    },
    async clearOutbox(eids) {
      await tx(['outbox'], 'readwrite', (t) => { for (const id of eids) t.objectStore('outbox').delete(id); });
    },
    async getMeta(k) {
      const t = db.transaction('meta');
      return req(t.objectStore('meta').get(k));
    },
    async setMeta(k, v) {
      await tx(['meta'], 'readwrite', (t) => t.objectStore('meta').put(v, k));
    },
    async wipe() {
      await tx(['events', 'outbox', 'meta'], 'readwrite', (t) => {
        t.objectStore('events').clear(); t.objectStore('outbox').clear(); t.objectStore('meta').clear();
      });
    },
  };
}
