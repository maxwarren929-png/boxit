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

function normalizeLifecycle(value = {}) {
  const mode = ['persistent', 'expires', 'session'].includes(value.mode)
    ? value.mode
    : 'persistent';
  const expiresAt = mode === 'expires' && Number(value.expiresAt) > Date.now()
    ? Number(value.expiresAt)
    : null;

  return {
    mode: mode === 'expires' && !expiresAt ? 'persistent' : mode,
    expiresAt,
    deleteAfterUse: Boolean(value.deleteAfterUse)
  };
}

function fileRecord(boxId, blob, name, lastModified = Date.now(), source = 'local') {
  return {
    id: crypto.randomUUID(),
    boxId,
    name,
    type: blob.type || 'application/octet-stream',
    size: blob.size,
    lastModified,
    blob,
    source,
    createdAt: Date.now()
  };
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

export async function getBox(boxId) {
  if (!boxId) return null;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BOX_STORE, 'readonly');
    const request = tx.objectStore(BOX_STORE).get(boxId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

export async function createBox(name, options = {}) {
  const box = {
    id: crypto.randomUUID(),
    name: name.trim() || 'Untitled box',
    createdAt: Date.now(),
    lifecycle: normalizeLifecycle(options.lifecycle)
  };
  await withStore(BOX_STORE, 'readwrite', store => store.add(box));
  return box;
}

export async function renameBox(boxId, name) {
  const nextName = String(name || '').trim();
  if (!nextName) throw new Error('Box name cannot be empty.');

  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BOX_STORE, 'readwrite');
    const store = tx.objectStore(BOX_STORE);
    const request = store.get(boxId);
    let updated = null;

    request.onsuccess = () => {
      const box = request.result;
      if (!box) return;
      updated = { ...box, name: nextName.slice(0, 48) };
      store.put(updated);
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => {
      db.close();
      resolve(updated);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function updateBoxLifecycle(boxId, lifecycle) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BOX_STORE, 'readwrite');
    const store = tx.objectStore(BOX_STORE);
    const request = store.get(boxId);
    let updated = null;

    request.onsuccess = () => {
      const box = request.result;
      if (!box) return;
      updated = {
        ...box,
        lifecycle: normalizeLifecycle(lifecycle)
      };
      store.put(updated);
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => {
      db.close();
      resolve(updated);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function findBoxByName(name) {
  const boxes = await listBoxes();
  const normalized = String(name || '').trim().toLowerCase();
  return boxes.find(box => box.name.trim().toLowerCase() === normalized) || null;
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

export async function deleteExpiredBoxes(now = Date.now()) {
  const boxes = await listBoxes();
  const expired = boxes.filter(box => (
    box.lifecycle?.mode === 'expires' &&
    Number(box.lifecycle.expiresAt) > 0 &&
    Number(box.lifecycle.expiresAt) <= now
  ));

  for (const box of expired) await deleteBox(box.id);
  return expired;
}

export async function deleteSessionBoxes() {
  const boxes = await listBoxes();
  const sessionBoxes = boxes.filter(box => box.lifecycle?.mode === 'session');
  for (const box of sessionBoxes) await deleteBox(box.id);
  return sessionBoxes;
}

export async function addFiles(boxId, files) {
  const records = [...files].map(file => fileRecord(
    boxId,
    file,
    file.name,
    file.lastModified,
    'local'
  ));
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

export async function addBlob(boxId, blob, name, options = {}) {
  if (!boxId) throw new Error('A destination box is required.');
  if (!(blob instanceof Blob)) throw new Error('Captured content is not a valid file.');

  const record = fileRecord(
    boxId,
    blob,
    String(name || 'capture').trim() || 'capture',
    options.lastModified || Date.now(),
    options.source || 'capture'
  );
  await withStore(FILE_STORE, 'readwrite', store => store.add(record));
  return record;
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

export async function listAllFiles() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_STORE, 'readonly');
    const request = tx.objectStore(FILE_STORE).getAll();
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

export async function renameFile(fileId, name) {
  const nextName = String(name || '').trim();
  if (!nextName) throw new Error('File name cannot be empty.');

  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_STORE, 'readwrite');
    const store = tx.objectStore(FILE_STORE);
    const request = store.get(fileId);
    let updated = null;

    request.onsuccess = () => {
      const record = request.result;
      if (!record) return;
      updated = { ...record, name: nextName.slice(0, 180) };
      store.put(updated);
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => {
      db.close();
      resolve(updated);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function setFileHash(fileId, hash) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_STORE, 'readwrite');
    const store = tx.objectStore(FILE_STORE);
    const request = store.get(fileId);
    let updated = null;

    request.onsuccess = () => {
      const record = request.result;
      if (!record) return;
      updated = { ...record, hash: String(hash || '') };
      store.put(updated);
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => {
      db.close();
      resolve(updated);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function deleteFile(fileId) {
  await withStore(FILE_STORE, 'readwrite', store => store.delete(fileId));
}
