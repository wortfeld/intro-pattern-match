export const KV = (() => {
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('intro-matcher-db', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function withStore(mode, fn) {
    return openDB().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction('kv', mode);
      const store = tx.objectStore('kv');
      let request;
      try { request = fn(store); } catch (e) { reject(e); return; }
      tx.oncomplete = () => resolve(request && request.result);
      tx.onerror = () => reject(tx.error || (request && request.error));
    }));
  }
  return {
    get: key => withStore('readonly', s => s.get(key)),
    set: (key, val) => withStore('readwrite', s => s.put(val, key)),
    del: key => withStore('readwrite', s => s.delete(key)),
    clear: () => withStore('readwrite', s => s.clear()),
    keys: () => openDB().then(db => new Promise((resolve, reject) => {
      const out = [];
      const req = db.transaction('kv','readonly').objectStore('kv').openKeyCursor();
      req.onsuccess = e => { const cur = e.target.result; if (cur) { out.push(cur.key); cur.continue(); } else resolve(out); };
      req.onerror = () => reject(req.error);
    }))
  };
})();
