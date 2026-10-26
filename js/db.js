/* Local storage layer — IndexedDB on the device only. Nothing here is ever sent anywhere. */
(function (global) {
  'use strict';
  const DB_NAME = 'plate-audit';
  const DB_VER = 1;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('audits')) db.createObjectStore('audits', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('photos')) {
          const s = db.createObjectStore('photos', { keyPath: 'id' });
          s.createIndex('auditId', 'auditId');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  function tx(store, mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      Promise.resolve(fn(s)).then((v) => { out = v; });
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Storage transaction aborted'));
    }));
  }

  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  const DB = {
    get: (key) => tx('kv', 'readonly', (s) => reqP(s.get(key))),
    set: (key, val) => tx('kv', 'readwrite', (s) => { s.put(val, key); }),
    del: (key) => tx('kv', 'readwrite', (s) => { s.delete(key); }),

    putAudit: (a) => tx('audits', 'readwrite', (s) => { s.put(a); }),
    getAudit: (id) => tx('audits', 'readonly', (s) => reqP(s.get(id))),
    allAudits: () => tx('audits', 'readonly', (s) => reqP(s.getAll())).then((a) => a.sort((x, y) => y.startedAt.localeCompare(x.startedAt))),
    delAudit: async (id) => {
      await tx('photos', 'readwrite', (s) => new Promise((res) => {
        const r = s.index('auditId').openCursor(IDBKeyRange.only(id));
        r.onsuccess = () => { const c = r.result; if (c) { c.delete(); c.continue(); } else res(); };
      }));
      await tx('audits', 'readwrite', (s) => { s.delete(id); });
    },

    putPhoto: (p) => tx('photos', 'readwrite', (s) => { s.put(p); }),
    getPhoto: (id) => tx('photos', 'readonly', (s) => reqP(s.get(id))),
    delPhoto: (id) => tx('photos', 'readwrite', (s) => { s.delete(id); }),
    photosFor: (auditId) => tx('photos', 'readonly', (s) => reqP(s.index('auditId').getAll(IDBKeyRange.only(auditId)))),

    wipeAll: async () => {
      for (const st of ['kv', 'audits', 'photos']) await tx(st, 'readwrite', (s) => { s.clear(); });
    },

    async estimate() {
      try { return navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; } catch (e) { return null; }
    },
    async persist() {
      try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; } catch (e) { return false; }
    },
  };

  global.DB = DB;
})(window);
