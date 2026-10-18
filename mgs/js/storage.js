// Persistencia local en IndexedDB: discos (para no volver a elegir el archivo)
// y autoguardados (save states). Nada sale del dispositivo.

const DB_NAME = "mgs-web";
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("discs")) db.createObjectStore("discs", { keyPath: "slot" });
      if (!db.objectStoreNames.contains("states")) {
        const s = db.createObjectStore("states", { keyPath: "id" });
        s.createIndex("disc", "disc");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("Transacción abortada"));
  }));
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch (e) { /* no soportado */ }
  return false;
}

export async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate();
  } catch (e) { /* no soportado */ }
  return null;
}

// slot: "disc1" | "disc2"
export function saveDisc(slot, file) {
  return tx("discs", "readwrite", s => s.put({
    slot,
    name: file.name,
    size: file.size,
    added: Date.now(),
    blob: file,
  }));
}

export function getDisc(slot) {
  return tx("discs", "readonly", s => reqP(s.get(slot)));
}

export function listDiscs() {
  return tx("discs", "readonly", s => reqP(s.getAll())).then(all =>
    all.map(({ slot, name, size, added }) => ({ slot, name, size, added })));
}

export function deleteDisc(slot) {
  return tx("discs", "readwrite", s => s.delete(slot));
}

// Autoguardados en anillo: AUTO_SLOTS ranuras por disco, se sobreescribe la más antigua.
export const AUTO_SLOTS = 5;

export async function putState(disc, data, kind = "auto") {
  const all = await listStates(disc);
  let id;
  if (kind === "auto") {
    const autos = all.filter(s => s.kind === "auto");
    if (autos.length < AUTO_SLOTS) {
      id = `${disc}:auto:${autos.length}`;
    } else {
      autos.sort((a, b) => a.time - b.time);
      id = autos[0].id;
    }
  } else {
    id = `${disc}:${kind}`;
  }
  const record = { id, disc, kind, time: Date.now(), size: data.byteLength, data };
  await tx("states", "readwrite", s => s.put(record));
  return record;
}

export function listStates(disc) {
  return tx("states", "readonly", s => reqP(s.index("disc").getAll(disc))).then(all =>
    all.map(({ id, disc, kind, time, size }) => ({ id, disc, kind, time, size }))
       .sort((a, b) => b.time - a.time));
}

export function getState(id) {
  return tx("states", "readonly", s => reqP(s.get(id)));
}

export async function latestState(disc) {
  const list = await listStates(disc);
  return list.length ? getState(list[0].id) : null;
}
