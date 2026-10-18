// Descarga de discos desde un enlace (archive.org u otra URL con CORS).
// archive.org no permite descargar desde otras webs en sus servidores normales,
// pero sí a través de cors.archive.org, que es lo que usamos aquí.

const DISC_EXT = ["chd", "pbp", "zip", "7z", "cue", "iso", "img", "bin", "m3u", "exe"];
// Preferencia cuando un item trae varios formatos del mismo disco.
const EXT_RANK = { chd: 0, pbp: 1, zip: 2, "7z": 3, cue: 4, iso: 5, img: 6, bin: 7 };

const ext = name => (name.split(".").pop() || "").toLowerCase();

export function parseArchiveUrl(input) {
  let u;
  try { u = new URL(input.trim()); } catch (e) { return null; }
  if (!/(^|\.)archive\.org$/.test(u.hostname)) return null;
  const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  // /details/<id>[/<file>]  ·  /download/<id>[/<file>]  ·  /cors/<id>/<file>
  const i = parts.findIndex(p => ["details", "download", "cors"].includes(p));
  if (i < 0 || !parts[i + 1]) return null;
  const file = parts.slice(i + 2).join("/");
  return { id: parts[i + 1], file: file || null };
}

export function corsUrl(id, name) {
  return `https://cors.archive.org/cors/${encodeURIComponent(id)}/${name.split("/").map(encodeURIComponent).join("/")}`;
}

// Devuelve las opciones de disco que hay en un item de archive.org.
// Cada opción: { label, files: [{name, size}] } (cue+bin van juntos).
export async function listArchiveOptions(id) {
  const res = await fetch(`https://archive.org/metadata/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`archive.org respondió ${res.status}`);
  const meta = await res.json();
  if (!meta || !meta.files) throw new Error("No encuentro ese item en archive.org. Revisa el enlace.");
  if (meta.is_dark || meta.metadata?.["access-restricted-item"] === "true") {
    throw new Error("Ese item está restringido en archive.org (requiere sesión). Descárgalo en el navegador y usa “Elegir archivo”.");
  }
  const files = meta.files
    .filter(f => f.source !== "metadata" && DISC_EXT.includes(ext(f.name)))
    .map(f => ({ name: f.name, size: Number(f.size) || 0 }));
  return groupOptions(files);
}

function groupOptions(files) {
  const byName = new Map(files.map(f => [f.name.toLowerCase(), f]));
  const used = new Set();
  const opts = [];
  // Los .cue arrastran sus .bin del mismo nombre base.
  for (const f of files.filter(f => ext(f.name) === "cue")) {
    const base = f.name.replace(/\.cue$/i, "");
    const bins = files.filter(b => ext(b.name) === "bin" && b.name.startsWith(base));
    bins.forEach(b => used.add(b.name));
    used.add(f.name);
    opts.push({ label: f.name, files: [f, ...bins], kind: "cue" });
  }
  for (const f of files) {
    if (used.has(f.name)) continue;
    const e = ext(f.name);
    if (e === "m3u") continue;
    if (e === "bin" && byName.has(f.name.replace(/\.bin$/i, ".cue").toLowerCase())) continue;
    opts.push({ label: f.name, files: [f], kind: e });
  }
  opts.forEach(o => { o.size = o.files.reduce((n, f) => n + f.size, 0); });
  opts.sort((a, b) => (EXT_RANK[a.kind] ?? 9) - (EXT_RANK[b.kind] ?? 9) || a.label.localeCompare(b.label));
  return opts;
}

// Intenta adivinar a qué disco corresponde un nombre de archivo.
export function guessSlot(name) {
  return /dis[ck]\s*0?2|cd\s*0?2|\(d2\)/i.test(name) ? "disc2" : "disc1";
}

// Descarga un archivo en streaming, juntando trozos en Blobs intermedios para
// que el navegador pueda guardarlos en disco en lugar de llenar la RAM.
// Calcula a la vez el CRC32, que hace falta para empaquetar cue+bin en un zip.
async function download(url, expectedSize, onBytes, wantCrc) {
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error("No se pudo descargar: el servidor no permite descargas desde otras webs (CORS) o no hay conexión.");
  }
  if (!res.ok) throw new Error(`El servidor respondió ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get("content-length")) || expectedSize || 0;
  const reader = res.body.getReader();
  let parts = [];
  let pending = [];
  let pendingBytes = 0;
  let got = 0;
  let crc = wantCrc ? 0xffffffff : 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (wantCrc) crc = crc32Update(crc, value);
    pending.push(value);
    pendingBytes += value.byteLength;
    got += value.byteLength;
    if (pendingBytes >= 32 * 1024 * 1024) {
      parts = [new Blob([...parts, ...pending])];
      pending = [];
      pendingBytes = 0;
    }
    onBytes(got, total);
  }
  const blob = new Blob([...parts, ...pending]);
  return { blob, crc: wantCrc ? (crc ^ 0xffffffff) >>> 0 : 0 };
}

// Descarga una opción (uno o varios archivos) y devuelve un File listo para el emulador.
export async function fetchOption(id, opt, onProgress) {
  const totalAll = opt.size;
  let doneBefore = 0;
  const report = (got) => onProgress(doneBefore + got, totalAll);

  if (opt.files.length === 1 && opt.kind !== "cue" && opt.kind !== "bin") {
    const f = opt.files[0];
    const { blob } = await download(corsUrl(id, f.name), f.size, report, false);
    return new File([blob], baseName(f.name));
  }

  // Un .cue con una sola pista de datos (como MGS1): basta con el .bin, y así
  // el móvil no tiene que manejar una copia extra de cientos de MB.
  const cueFile = opt.files.find(f => ext(f.name) === "cue");
  const bins = opt.files.filter(f => ext(f.name) === "bin");
  if (bins.length === 1 && (!cueFile || await isSingleTrack(id, cueFile))) {
    const { blob } = await download(corsUrl(id, bins[0].name), bins[0].size, report, false);
    return new File([blob], baseName(bins[0].name));
  }

  // Varias pistas (música en CD): cue + bins en un .zip sin comprimir para que
  // el emulador reciba todo junto.
  const entries = [];
  for (const f of opt.files) {
    const { blob, crc } = await download(corsUrl(id, f.name), f.size, report, true);
    doneBefore += blob.size;
    entries.push({ name: baseName(f.name), blob, crc });
  }
  if (!entries.some(e => ext(e.name) === "cue")) {
    const bin = entries.find(e => ext(e.name) === "bin") || entries[0];
    const text = `FILE "${bin.name}" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n`;
    const bytes = new TextEncoder().encode(text);
    entries.unshift({ name: bin.name.replace(/\.[^.]+$/, "") + ".cue", blob: new Blob([bytes]), crc: crc32(bytes) });
  }
  const zipName = baseName(opt.label).replace(/\.[^.]+$/, "") + ".zip";
  return new File([makeStoreZip(entries)], zipName);
}

// Descarga directa de una URL cualquiera (debe permitir CORS).
export async function fetchGeneric(url, onProgress) {
  const { blob } = await download(url, 0, onProgress, false);
  let name = baseName(new URL(url).pathname) || "juego.bin";
  if (!DISC_EXT.includes(ext(name))) name += ".bin";
  return new File([blob], name);
}

async function isSingleTrack(id, cueFile) {
  const res = await fetch(corsUrl(id, cueFile.name));
  if (!res.ok) return false;
  const text = await res.text();
  return (text.match(/^\s*TRACK\s/gim) || []).length === 1;
}

function baseName(p) {
  return decodeURIComponent(p.split("/").pop() || "");
}

// ---------------------------------------------------------------- zip sin compresión

export function makeStoreZip(entries) {
  const enc = new TextEncoder();
  const out = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const size = e.blob.size;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);       // versión necesaria
    local.setUint16(6, 0x0800, true);   // nombres en UTF-8
    local.setUint16(8, 0, true);        // sin compresión
    local.setUint32(14, e.crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    out.push(local.buffer, name, e.blob);

    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint32(16, e.crc, true);
    c.setUint32(20, size, true);
    c.setUint32(24, size, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.push(c.buffer, name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...out, ...central, end.buffer]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32Update(crc, bytes) {
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return crc;
}

export function crc32(bytes) {
  return (crc32Update(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
}
