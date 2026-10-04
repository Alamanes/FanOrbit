// IndexedDB avatar blob cache shared by the service worker and the
// generator page.

globalThis.AvatarCache = (() => {
  const DB_NAME = 'fanorbit_cache';
  const STORE = 'avatars';

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // For get() the value must be read from the request on success —
  // resolving the request object itself would be a bug.
  function transact(mode, fn, readResult = false) {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => {
        db.close();
        resolve(readResult ? (req.result || null) : undefined);
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error || new Error('transaction aborted'));
      };
    }));
  }

  return {
    put: (url, blob) => transact('readwrite', (s) => s.put(blob, url)),
    get: (url) => transact('readonly', (s) => s.get(url), true),
    clear: () => transact('readwrite', (s) => s.clear()),
    count: () => transact('readonly', (s) => s.count(), true)
  };
})();
