const DB_NAME = 'boxit';
const DB_VERSION = 1;
const BOX_STORE = 'boxes';
const FILE_STORE = 'files';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function patchFile(fileId, patch = {}) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_STORE, 'readwrite');
    const store = tx.objectStore(FILE_STORE);
    const request = store.get(fileId);
    let updated = null;
    request.onsuccess = () => {
      if (!request.result) return;
      updated = { ...request.result, ...patch };
      store.put(updated);
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => { db.close(); resolve(updated); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error('BoxIt could not update that file.')); };
  });
}

export async function moveFile(fileId, boxId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([BOX_STORE, FILE_STORE], 'readwrite');
    const boxes = tx.objectStore(BOX_STORE);
    const files = tx.objectStore(FILE_STORE);
    const boxRequest = boxes.get(boxId);
    let updated = null;
    let missingBox = false;
    boxRequest.onsuccess = () => {
      if (!boxRequest.result) {
        missingBox = true;
        tx.abort();
        return;
      }
      const fileRequest = files.get(fileId);
      fileRequest.onsuccess = () => {
        if (!fileRequest.result) return;
        updated = { ...fileRequest.result, boxId };
        files.put(updated);
      };
      fileRequest.onerror = () => reject(fileRequest.error);
    };
    boxRequest.onerror = () => reject(boxRequest.error);
    tx.oncomplete = () => { db.close(); resolve(updated); };
    tx.onabort = () => {
      db.close();
      reject(missingBox ? new Error('The destination box no longer exists.') : (tx.error || new Error('BoxIt could not move that file.')));
    };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
