const DB_NAME = 'pending_ttd_db';
const DB_VERSION = 1;
const STORE_GROUPS = 'pod_groups';
const STORE_META = 'app_meta';

export async function initStoragePersistence() {
  if (navigator.storage && navigator.storage.persist) {
    try {
      await navigator.storage.persist();
    } catch (err) {
      console.warn('Storage persist tidak didukung:', err);
    }
  }
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_GROUPS)) {
        const store = db.createObjectStore(STORE_GROUPS, { keyPath: 'id' });
        store.createIndex('status', 'status', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveGroup(group) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_GROUPS, 'readwrite');
    tx.objectStore(STORE_GROUPS).put(group);
    tx.oncomplete = () => resolve(group);
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllGroups() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_GROUPS, 'readonly');
    const req = tx.objectStore(STORE_GROUPS).getAll();
    req.onsuccess = () => {
      const list = req.result || [];
      list.sort((a, b) => b.createdAt - a.createdAt);
      resolve(list);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getGroupById(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_GROUPS, 'readonly');
    const req = tx.objectStore(STORE_GROUPS).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteGroup(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_GROUPS, 'readwrite');
    tx.objectStore(STORE_GROUPS).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveMeta(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readwrite');
    tx.objectStore(STORE_META).put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getMeta(key, defaultValue = null) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readonly');
    const req = tx.objectStore(STORE_META).get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : defaultValue);
    req.onerror = () => reject(req.error);
  });
}

// Hapus otomatis item DONE yang berumur lebih dari 14 hari
export async function cleanupOldDoneGroups(maxAgeDays = 14) {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const groups = await getAllGroups();
  const expired = groups.filter(
    (g) => g.status === 'DONE' && (g.completedAt || g.createdAt) < cutoff
  );
  for (const item of expired) {
    await deleteGroup(item.id);
  }
  return expired.length;
}

