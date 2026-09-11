const DB_NAME = 'boxit';
const DB_VERSION = 1;
const BOX_STORE = 'boxes';
const FILE_STORE = 'files';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BOX_STORE)) {
        db.createObjectStore(BOX_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(FILE_STORE)) {
        const store = db.createObjectStore(FILE_STORE, { keyPath: 'id' });
        store.createIndex('boxId', 'boxId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(name, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode);
    const store = tx.objectStore(name);
    let result;
    try {
      result = fn(store);
    } catch (error) {
      db.close();
      reject(error);
      return;
    }
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function listBoxes() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BOX_STORE, 'readonly');
    const request = tx.objectStore(BOX_STORE).getAll();
    request.onsuccess = () => resolve(request.result.sort((a, b) => a.createdAt - b.createdAt));
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

export async function createBox(name) {
  const box = {
    id: crypto.randomUUID(),
    name: name.trim() || 'Untitled box',
    createdAt: Date.now()
  };
  await withStore(BOX_STORE, 'readwrite', store => store.add(box));
  return box;
}

export async function deleteBox(boxId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([BOX_STORE, FILE_STORE], 'readwrite');
    tx.objectStore(BOX_STORE).delete(boxId);
    const index = tx.objectStore(FILE_STORE).index('boxId');
    const cursor = index.openCursor(IDBKeyRange.only(boxId));
    cursor.onsuccess = () => {
      const current = cursor.result;
      if (!current) return;
      current.delete();
      current.continue();
    };
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function addFiles(boxId, files) {
  const records = [...files].map(file => ({
    id: crypto.randomUUID(),
    boxId,
    name: file.name,
    type: file.type || 'application/octet-stream',
    size: file.size,
    lastModified: file.lastModified,
    blob: file,
    createdAt: Date.now()
  }));
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_STORE, 'readwrite');
    const store = tx.objectStore(FILE_STORE);
    records.forEach(record => store.add(record));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return records;
}

export async function listFiles(boxId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_STORE, 'readonly');
    const request = tx.objectStore(FILE_STORE).index('boxId').getAll(boxId);
    request.onsuccess = () => resolve(request.result.sort((a, b) => b.createdAt - a.createdAt));
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

export async function getFile(fileId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_STORE, 'readonly');
    const request = tx.objectStore(FILE_STORE).get(fileId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

export async function deleteFile(fileId) {
  await withStore(FILE_STORE, 'readwrite', store => store.delete(fileId));
}
