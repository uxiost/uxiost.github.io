// Consola: ejecuta el emulador de PS1 (EmulatorJS, núcleo PCSX-ReARMed en
// WebAssembly), recibe mandos remotos por WebRTC y hace autoguardado.

import * as store from "./storage.js?v=21";
import { PEER_PREFIX, BUTTONS, BUTTON_COUNT, randomCode, formatBytes, timeAgo } from "./protocol.js?v=21";
import { attachTouchPad, PAD_HTML } from "./padui.js?v=21";
import { parseArchiveUrl, listArchiveOptions, fetchOption, fetchGeneric, guessSlot } from "./fetcher.js?v=21";
import { installAudioTap, setLocalMuted, streamTo, castPage, castTransport, rejoinCast, getAudioTrack } from "./stream.js?v=21";
import { startNative } from "./native.js?v=21";
import { report } from "./diag.js?v=21";

// Antes de que arranque el emulador: así podemos mandar su audio a la tele.
installAudioTap();

const EJS_DATA = "https://cdn.emulatorjs.org/4.2.3/data/";
const GAME_NAME = "Metal Gear Solid"; // misma Memory Card para ambos discos
const MAX_PLAYERS = 4;
const BOOT_GRACE_MS = 15000; // no autoguardar durante el arranque de la BIOS

const $ = sel => document.querySelector(sel);
const params = new URLSearchParams(location.search);

let started = false;
let startedAt = 0;
let currentSlot = null;
let currentDiscId = null;
let autosaveTimer = null;
let lastSave = 0;
let peer = null;
const pads = new Map(); // conn.peer -> { conn, player, mask }

// ---------------------------------------------------------------- UI helpers

let toastTimer;
function toast(msg, ms = 2500) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("action");
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
  broadcast({ t: "toast", msg });
}

// Aviso con un botón (p. ej. "¿No se oye? → sonido en el móvil").
function toastAction(msg, label, fn, ms = 9000) {
  const el = $("#toast");
  el.textContent = msg + " ";
  const b = document.createElement("button");
  b.textContent = label;
  b.onclick = () => { el.classList.remove("show", "action"); fn(); };
  el.appendChild(b);
  el.classList.add("show", "action");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show", "action"), ms);
}

function broadcast(msg) {
  for (const { conn } of pads.values()) {
    if (conn.open) conn.send(msg);
  }
}

function discId(rec) {
  return `${rec.slot}|${rec.name}|${rec.size}`;
}

function ejs() {
  return window.EJS_emulator && window.EJS_emulator.gameManager;
}

// ---------------------------------------------------------------- discos

async function renderDiscs() {
  const discs = await store.listDiscs();
  const box = $("#discs");
  box.innerHTML = "";
  for (const slot of ["disc1", "disc2"]) {
    const d = discs.find(x => x.slot === slot);
    const row = document.createElement("div");
    row.className = "disc";
    row.innerHTML = `
      <div><b>Disco ${slot.slice(-1)}</b><br>
        <span class="muted small">${d ? `${escapeHtml(d.name)} · ${formatBytes(d.size)}` : "vacío"}</span></div>
      <div class="row">
        ${d ? `<button class="primary" data-play="${slot}">Jugar</button>` : ""}
        <label class="btn">${d ? "Cambiar" : "Elegir archivo"}
          <input type="file" data-pick="${slot}" hidden accept=".chd,.pbp,.zip,.7z,.iso,.bin,.cue,.img,.m3u"></label>
        ${d ? `<button data-del="${slot}" title="Borrar">✕</button>` : ""}
      </div>`;
    box.appendChild(row);
  }
  box.querySelectorAll("[data-play]").forEach(b => b.onclick = () => startGame(b.dataset.play));
  box.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
    await store.deleteDisc(b.dataset.del);
    renderDiscs();
  });
  box.querySelectorAll("[data-pick]").forEach(inp => inp.onchange = async () => {
    const f = inp.files[0];
    if (!f) return;
    await storeDisc(inp.dataset.pick, f);
  });
  const est = await store.storageEstimate();
  if (est) $("#quota").textContent = `Espacio usado: ${formatBytes(est.usage)} de ${formatBytes(est.quota)}`;
  broadcast({ t: "hello", discs, running: started });
}

async function storeDisc(slot, file) {
  toast(`Guardando ${file.name}…`, 10000);
  try {
    await store.requestPersistence();
    await store.saveDisc(slot, file);
    toast(`Disco ${slot.slice(-1)} listo`);
  } catch (e) {
    console.error(e);
    toast("No cabe en el almacenamiento del navegador. Prueba con un .chd (más pequeño).", 6000);
  }
  renderDiscs();
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------- emulador

// Mapeo por posición física: el botón de abajo del mando (✕ en PlayStation,
// A en Xbox) es ✕ en el juego, el de la derecha ○, etc.
function defaultControls() {
  const k = (value, value2) => ({ value, value2 });
  const p0 = {
    0: k("x", "BUTTON_1"),
    1: k("a", "BUTTON_3"),
    2: k("v", "SELECT"),
    3: k("enter", "START"),
    4: k("up arrow", "DPAD_UP"),
    5: k("down arrow", "DPAD_DOWN"),
    6: k("left arrow", "DPAD_LEFT"),
    7: k("right arrow", "DPAD_RIGHT"),
    8: k("z", "BUTTON_2"),
    9: k("s", "BUTTON_4"),
    10: k("q", "LEFT_TOP_SHOULDER"),
    11: k("e", "RIGHT_TOP_SHOULDER"),
    12: k("tab", "LEFT_BOTTOM_SHOULDER"),
    13: k("r", "RIGHT_BOTTOM_SHOULDER"),
    14: k("", "LEFT_STICK"),
    15: k("", "RIGHT_STICK"),
    16: k("h", "LEFT_STICK_X:+1"),
    17: k("f", "LEFT_STICK_X:-1"),
    18: k("g", "LEFT_STICK_Y:+1"),
    19: k("t", "LEFT_STICK_Y:-1"),
    20: k("l", "RIGHT_STICK_X:+1"),
    21: k("j", "RIGHT_STICK_X:-1"),
    22: k("k", "RIGHT_STICK_Y:+1"),
    23: k("i", "RIGHT_STICK_Y:-1"),
    24: k("1", ""),
    25: k("2", ""),
    26: k("", ""),
    27: k("space", ""),
    28: k("", ""),
    29: k("", ""),
  };
  return { 0: p0, 1: {}, 2: {}, 3: {} };
}

async function startGame(slot) {
  if (started) {
    // EmulatorJS no se puede reiniciar limpiamente en la misma página.
    await saveNow("auto");
    location.search = `?disc=${slot}`;
    return;
  }
  const rec = await store.getDisc(slot);
  if (!rec) {
    toast(`El disco ${slot.slice(-1)} está vacío`);
    return;
  }
  started = true;
  currentSlot = slot;
  currentDiscId = discId(rec);
  document.body.classList.add("playing");
  $("#setup").classList.add("hidden");

  Object.assign(window, {
    EJS_player: "#game",
    EJS_core: "psx",
    EJS_pathtodata: EJS_DATA,
    // Debe ser un File para que EmulatorJS detecte el formato por la extensión.
    EJS_gameUrl: rec.blob instanceof File ? rec.blob : new File([rec.blob], rec.name),
    EJS_gameName: GAME_NAME,
    EJS_startOnLoaded: true,
    EJS_language: "es-ES",
    EJS_color: "#4d7c43",
    EJS_backgroundColor: "#000",
    EJS_CacheLimit: 1, // el disco ya está en nuestra IndexedDB; no duplicarlo
    EJS_defaultControls: defaultControls(),
    EJS_defaultOptions: {
      "save-save-interval": "30",
      // Con nuestros controles laterales, el mando virtual del emulador sobra.
      "virtual-gamepad": touchMode() ? "disabled" : "enabled",
    },
    EJS_onGameStart: onGameStart,
  });
  const s = document.createElement("script");
  s.src = EJS_DATA + "loader.js";
  document.body.appendChild(s);
}

async function onGameStart() {
  startedAt = Date.now();
  showHud();
  broadcast({ t: "hello", running: true, disc: currentSlot });
  scheduleAutosave();

  // Continuar automáticamente desde el último guardado de este disco.
  const latest = await store.latestState(currentDiscId).catch(() => null);
  if (latest) {
    setTimeout(() => {
      loadStateRecord(latest);
      toast(`Continuando desde ${timeAgo(latest.time)} · ☰ para otros guardados`, 5000);
    }, 800);
  }
}

function loadStateRecord(rec) {
  const gm = ejs();
  if (!gm) return;
  gm.loadState(new Uint8Array(rec.data));
  lastSave = Date.now();
  toast(`Partida cargada (${timeAgo(rec.time)})`);
}

// ---------------------------------------------------------------- autoguardado

function intervalSeconds() {
  const v = parseInt(localStorage.getItem("mgs.autosave") ?? "60", 10);
  return isNaN(v) ? 60 : v;
}

function scheduleAutosave() {
  clearInterval(autosaveTimer);
  const s = intervalSeconds();
  if (s > 0) autosaveTimer = setInterval(() => saveNow("auto"), s * 1000);
}

async function saveNow(kind = "auto") {
  const gm = ejs();
  if (!started || !gm || !startedAt) return;
  if (kind === "auto") {
    if (Date.now() - startedAt < BOOT_GRACE_MS) return;
    if (window.EJS_emulator.paused) return;
  }
  try {
    gm.saveSaveFiles(); // vuelca la Memory Card a IndexedDB
    const data = gm.getState();
    await store.putState(currentDiscId, data, kind);
    lastSave = Date.now();
    updateHud();
    if ($("#menu").open) renderStateList();
    if (kind !== "auto") toast("Partida guardada");
  } catch (e) {
    console.error("Fallo al guardar", e);
    if (kind !== "auto") toast("No se pudo guardar");
  }
}

async function loadLatest() {
  const rec = await store.latestState(currentDiscId);
  if (rec) loadStateRecord(rec);
  else toast("No hay guardados todavía");
}

async function renderStateList() {
  const list = await store.listStates(currentDiscId || "");
  const ul = $("#stateList");
  ul.innerHTML = list.length ? "" : "<li class='muted'>Ninguno todavía</li>";
  for (const s of list) {
    const li = document.createElement("li");
    li.innerHTML = `<span>${s.kind === "auto" ? "Auto" : "Manual"} · ${timeAgo(s.time)}</span>`;
    const b = document.createElement("button");
    b.textContent = "Cargar";
    b.onclick = async () => { loadStateRecord(await store.getState(s.id)); $("#menu").close(); };
    li.appendChild(b);
    ul.appendChild(li);
  }
}

function download(name, data) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data]));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function exportSave() {
  const gm = ejs();
  if (!gm) return;
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  download(`mgs-${currentSlot}-${stamp}.state`, gm.getState());
  const card = gm.getSaveFile();
  if (card) download(`mgs-memorycard-${stamp}.srm`, card);
}

async function importState(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  await store.putState(currentDiscId, data, "manual");
  ejs()?.loadState(data);
  toast("Partida importada");
}

// Guardar al salir o al pasar a segundo plano (cerrar pestaña, bloquear móvil…).
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveNow("auto");
});
window.addEventListener("pagehide", () => saveNow("auto"));

// ---------------------------------------------------------------- HUD

let hudTimer;
function showHud() {
  const hud = $("#hud");
  hud.classList.remove("hidden");
  updateHud();
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => hud.classList.add("faded"), 6000);
}

function updateHud() {
  $("#hudCode").textContent = peer && peer.id ? `Código ${peer.id.slice(PEER_PREFIX.length)}` : "";
  $("#hudPads").textContent = `🎮 ${pads.size}`;
  $("#hudSave").textContent = (lastSave ? `💾 ${timeAgo(lastSave)}` : "") + ` · v${window.MGS_BUILD}`;
}
setInterval(() => started && updateHud(), 10000);

$("#hud").addEventListener("pointerdown", () => { $("#hud").classList.remove("faded"); showHud(); });
$("#hudMenu").onclick = openMenu;

function openMenu() {
  $("#menuTv").appendChild($("#tvbox")); // el mismo panel de "Ver en la tele", dentro del menú
  renderStateList();
  $("#interval").value = String(intervalSeconds());
  $("#menu").showModal();
}

$("#interval").onchange = e => {
  localStorage.setItem("mgs.autosave", e.target.value);
  scheduleAutosave();
};
$("#importState").onchange = e => e.target.files[0] && importState(e.target.files[0]);
$("#menu").addEventListener("click", e => {
  const act = e.target.dataset && e.target.dataset.act;
  if (act) runCommand(act);
});

function runCommand(c) {
  switch (c) {
    case "save": return saveNow("manual");
    case "load": return started ? loadLatest() : null;
    case "export": return exportSave();
    case "pause": {
      const emu = window.EJS_emulator;
      if (emu && emu.togglePlaying) emu.togglePlaying();
      return;
    }
    case "reset": return ejs()?.restart();
    case "menu": return started ? openMenu() : null;
    case "disc1":
    case "disc2":
      if (started && currentSlot === c) return toast(`Ya estás en el disco ${c.slice(-1)}`);
      return startGame(c);
  }
}

// ---------------------------------------------------------------- mandos remotos (WebRTC)

function codeForPeer() {
  let code = localStorage.getItem("mgs.code");
  if (!code) {
    code = randomCode();
    localStorage.setItem("mgs.code", code);
  }
  return code;
}

function startPeer(code) {
  peer = new Peer(PEER_PREFIX + code, { debug: 1 });
  peer.on("open", id => {
    const c = id.slice(PEER_PREFIX.length);
    const url = new URL("pad.html#" + c, location.href).href;
    $("#code").textContent = c.toUpperCase();
    $("#padUrl").textContent = url;
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    $("#qr").innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    updateHud();
  });
  peer.on("connection", conn => {
    if (conn.label === "file") acceptFile(conn);
    else acceptPad(conn);
  });
  peer.on("disconnected", () => setTimeout(() => peer && !peer.destroyed && peer.reconnect(), 2000));
  peer.on("error", err => {
    console.warn("PeerJS", err.type, err);
    if (err.type === "unavailable-id") {
      // Otra pestaña ya usa este código: generamos otro.
      localStorage.removeItem("mgs.code");
      peer.destroy();
      startPeer(codeForPeer());
    } else if (err.type === "network" || err.type === "server-error") {
      $("#code").textContent = "sin conexión";
    }
  });
}

function freePlayer() {
  // Los controles táctiles de la consola usan el jugador 1 y se ocultan en
  // cuanto se conecta un mando, así que no reservamos plaza para ellos.
  const used = new Set([...pads.values()].map(p => p.player));
  for (let i = 0; i < MAX_PLAYERS; i++) if (!used.has(i)) return i;
  return -1;
}

function applyMask(pad, mask) {
  const gm = ejs();
  const diff = pad.mask ^ mask;
  pad.mask = mask;
  if (!gm || !diff) return;
  for (let i = 0; i < BUTTON_COUNT; i++) {
    if (diff & (1 << i)) gm.simulateInput(pad.player, i, (mask >> i) & 1);
  }
}

async function acceptPad(conn) {
  conn.on("open", async () => {
    const player = freePlayer();
    if (player < 0) {
      conn.send({ t: "toast", msg: "Ya hay 4 mandos conectados" });
      setTimeout(() => conn.close(), 500);
      return;
    }
    // La pantalla de la tele (screen.html) también abre este canal para reenviar
    // su mando; no cuenta como "mando conectado" a efectos de ocultar los táctiles.
    const pad = { conn, player, mask: 0, tv: !!(conn.metadata && conn.metadata.tv) };
    pads.set(conn.connectionId, pad);
    conn.send({ t: "hello", player, running: started, disc: currentSlot, discs: await store.listDiscs() });
    toast(pad.tv ? "Tele conectada" : `Mando ${player + 1} conectado`);
    updateHud();
    renderPads();
  });
  conn.on("data", msg => {
    const pad = pads.get(conn.connectionId);
    if (!pad || !msg) return;
    if (msg.t === "s") {
      // Sin partida en marcha: Start/✕ en el móvil arranca el primer disco disponible.
      if (!started && (msg.b & 0b1001)) autoStartFromPad();
      applyMask(pad, msg.b | 0);
    } else if (msg.t === "cmd") {
      runCommand(msg.c);
    }
  });
  const drop = () => {
    const pad = pads.get(conn.connectionId);
    if (!pad) return;
    applyMask(pad, 0); // soltar todos los botones
    pads.delete(conn.connectionId);
    toast(`Mando ${pad.player + 1} desconectado`);
    updateHud();
    renderPads();
  };
  conn.on("close", drop);
  conn.on("error", drop);
}

let autoStarting = false;
async function autoStartFromPad() {
  if (autoStarting) return;
  autoStarting = true;
  const discs = await store.listDiscs();
  const first = discs.find(d => d.slot === "disc1") || discs[0];
  if (first) startGame(first.slot);
  else toast("Primero elige o envía un disco");
  autoStarting = false;
}

function renderPads() {
  applyTouchMode();
  const ul = $("#pads");
  ul.innerHTML = "";
  for (const p of [...pads.values()].sort((a, b) => a.player - b.player)) {
    const li = document.createElement("li");
    li.textContent = `🎮 Mando ${p.player + 1} conectado`;
    ul.appendChild(li);
  }
}

// Recepción de un disco enviado desde el móvil. Juntamos los trozos en Blobs
// intermedios para que el navegador pueda pasarlos a disco y no llenar la RAM.
function acceptFile(conn) {
  let header = null;
  let parts = [];
  let pending = [];
  let pendingBytes = 0;
  let got = 0;
  let lastReport = 0;
  const FLUSH = 32 * 1024 * 1024;

  const flush = () => {
    if (pending.length) parts = [new Blob([...parts, ...pending])];
    pending = [];
    pendingBytes = 0;
  };

  conn.on("data", async data => {
    if (typeof data === "string") {
      if (!header) {
        header = JSON.parse(data);
        if (!["disc1", "disc2"].includes(header.slot)) header.slot = "disc1";
        toast(`Recibiendo ${header.name}…`, 4000);
        return;
      }
      if (data === "EOF") {
        flush();
        const file = new File(parts, header.name);
        parts = [];
        if (file.size !== header.size) {
          conn.send(JSON.stringify({ t: "rxerr", msg: "Tamaño incorrecto, reinténtalo" }));
          return;
        }
        await storeDisc(header.slot, file);
        conn.send(JSON.stringify({ t: "rxdone" }));
        setTimeout(() => conn.close(), 1000);
      }
      return;
    }
    const chunk = data instanceof ArrayBuffer ? data : data.buffer;
    pending.push(chunk);
    pendingBytes += chunk.byteLength;
    got += chunk.byteLength;
    if (pendingBytes >= FLUSH) flush();
    if (Date.now() - lastReport > 500) {
      lastReport = Date.now();
      conn.send(JSON.stringify({ t: "rx", got, total: header ? header.size : 0 }));
    }
  });
}

// ---------------------------------------------------------------- mandos en este mismo dispositivo
// Con el Pixel conectado a la tele por cable (Android 16: la tele es un segundo
// escritorio), la consola va en una ventana de Chrome en la tele y pad.html en
// la pantalla del móvil. Se hablan por BroadcastChannel: sin red, sin retraso.

const bc = "BroadcastChannel" in window ? new BroadcastChannel("mgs-web") : null;
const localConns = new Map(); // padId -> conexión imitando la interfaz de PeerJS

function makeLocalConn(id) {
  const handlers = {};
  return {
    connectionId: "bc:" + id,
    open: true,
    lastSeen: Date.now(),
    on(ev, cb) { (handlers[ev] ||= []).push(cb); },
    emit(ev, arg) { (handlers[ev] || []).forEach(f => f(arg)); },
    send(msg) { if (this.open) bc.postMessage({ to: id, ...msg }); },
    close() {
      if (!this.open) return;
      this.open = false;
      this.emit("close");
    },
  };
}

if (bc) {
  bc.onmessage = async e => {
    const m = e.data;
    if (!m || !m.from || m.to) return;
    let c = localConns.get(m.from);
    if (m.t === "hello?") {
      if (!c) {
        c = makeLocalConn(m.from);
        localConns.set(m.from, c);
        acceptPad(c);
        c.emit("open");
      } else {
        const pad = pads.get(c.connectionId);
        c.send({ t: "hello", player: pad ? pad.player : 0, running: started, disc: currentSlot });
      }
      return;
    }
    if (!c) return;
    c.lastSeen = Date.now();
    if (m.t === "bye") {
      c.close();
      localConns.delete(m.from);
    } else if (m.t === "file" && m.file) {
      await storeDisc(["disc1", "disc2"].includes(m.slot) ? m.slot : "disc1", m.file);
    } else {
      c.emit("data", m);
    }
  };
  setInterval(() => {
    for (const [id, c] of localConns) {
      if (Date.now() - c.lastSeen > 4000) {
        c.close();
        localConns.delete(id);
      } else {
        c.send({ t: "beat" });
      }
    }
  }, 1000);
}

// ---------------------------------------------------------------- controles táctiles locales
// Para jugar con el emulador en el propio móvil (y verlo en la tele por cable o
// “Enviar pantalla”): la imagen queda en el centro y los botones en las franjas
// laterales, así no tapan el juego en la tele.

const localPad = { player: 0, mask: 0 };
const sideMasks = { l: 0, r: 0 };

function touchMode() {
  const saved = localStorage.getItem("mgs.touch");
  if (saved !== null) return saved === "1";
  return matchMedia("(pointer: coarse)").matches;
}

function applyTouchMode() {
  // Fuera si hay un mando Bluetooth o un móvil conectado como mando.
  const on = touchMode() && !hasGamepad() && ![...pads.values()].some(p => !p.tv);
  document.body.classList.toggle("touch", on);
  $("#optTouch").checked = touchMode();
  if (!on) {
    sideMasks.l = sideMasks.r = 0;
    applyMask(localPad, 0);
  }
}

function hasGamepad() {
  return [...(navigator.getGamepads ? navigator.getGamepads() : [])].some(Boolean);
}

$(".slot-dpad").innerHTML = PAD_HTML.dpad;
$(".slot-face").innerHTML = PAD_HTML.face;
for (const [key, el] of [["l", $("#lctl")], ["r", $("#rctl")]]) {
  attachTouchPad(el, (m, newly) => {
    sideMasks[key] = m;
    applyMask(localPad, sideMasks.l | sideMasks.r);
    if (newly && navigator.vibrate) navigator.vibrate(10);
  });
}
$("#optTouch").onchange = e => {
  localStorage.setItem("mgs.touch", e.target.checked ? "1" : "0");
  applyTouchMode();
};
// Si conectas un mando Bluetooth, los botones táctiles se apartan y el juego ocupa la pantalla.
window.addEventListener("gamepadconnected", () => { applyTouchMode(); toast("Mando conectado"); });
window.addEventListener("gamepaddisconnected", applyTouchMode);
applyTouchMode();

// ---------------------------------------------------------------- stick izquierdo como cruceta
// El núcleo emula un mando digital: el stick de un DualShock 4 / Xbox no movería
// a Snake. Lo traducimos a la cruceta para el mando del jugador 1.

const stickPad = { player: 0, mask: 0 };
function pollSticks() {
  let m = 0;
  if (started) {
    const gp = [...(navigator.getGamepads ? navigator.getGamepads() : [])].find(Boolean);
    if (gp && gp.axes.length >= 2) {
      const [x, y] = gp.axes;
      if (x < -0.5) m |= 1 << BUTTONS.left;
      if (x > 0.5) m |= 1 << BUTTONS.right;
      if (y < -0.5) m |= 1 << BUTTONS.up;
      if (y > 0.5) m |= 1 << BUTTONS.down;
    }
  }
  if (m !== stickPad.mask) applyMask(stickPad, m);
  requestAnimationFrame(pollSticks);
}
requestAnimationFrame(pollSticks);

// ---------------------------------------------------------------- descarga desde enlace

let downloading = false;

$("#linkForm").onsubmit = e => {
  e.preventDefault();
  loadFromLink($("#linkUrl").value, $("#linkSlot").value);
};

async function loadFromLink(url, slotChoice = "auto", { autoplay = false } = {}) {
  if (downloading) return;
  const text = $("#linkText");
  const list = $("#linkOpts");
  list.innerHTML = "";
  const ia = parseArchiveUrl(url);
  try {
    if (ia) {
      text.textContent = "Buscando archivos en archive.org…";
      let opts = await listArchiveOptions(ia.id);
      if (ia.file) {
        const want = opts.filter(o => o.files.some(f => f.name === ia.file));
        if (want.length) opts = want;
      }
      if (!opts.length) throw new Error("Ese item no tiene archivos de disco de PS1 (.chd, .cue/.bin, .pbp, .zip…).");
      // Si hay varios discos u opciones, que elija. Si hay uno, adelante.
      const distinct = opts.filter(o => o.kind === opts[0].kind);
      if (distinct.length > 1 && !autoplay) {
        text.textContent = "Elige qué archivo descargar:";
        for (const o of distinct) {
          const li = document.createElement("li");
          li.innerHTML = `<span>${escapeHtml(o.label)} · ${formatBytes(o.size)}</span>`;
          const b = document.createElement("button");
          b.textContent = "Descargar";
          b.onclick = () => { list.innerHTML = ""; runDownload(() => fetchOption(ia.id, o, progress), o.label, slotChoice, url, autoplay); };
          li.appendChild(b);
          list.appendChild(li);
        }
        return;
      }
      const o = distinct[0];
      await runDownload(() => fetchOption(ia.id, o, progress), o.label, slotChoice, url, autoplay);
    } else {
      await runDownload(() => fetchGeneric(url, progress), url, slotChoice, url, autoplay);
    }
  } catch (err) {
    console.error(err);
    text.textContent = err.message || String(err);
  }
}

function progress(got, total) {
  const prog = $("#linkProg");
  prog.hidden = false;
  if (total) prog.value = got / total; else prog.removeAttribute("value");
  $("#linkText").textContent = `Descargando… ${formatBytes(got)}${total ? " de " + formatBytes(total) : ""}`;
}

async function runDownload(job, label, slotChoice, url, autoplay) {
  downloading = true;
  const text = $("#linkText");
  try {
    await store.requestPersistence();
    text.textContent = "Conectando…";
    const file = await job();
    const slot = slotChoice === "auto" ? guessSlot(label) : slotChoice;
    text.textContent = `Guardando en el disco ${slot.slice(-1)}…`;
    await storeDisc(slot, file);
    localStorage.setItem(`mgs.src.${slot}`, url);
    $("#linkProg").hidden = true;
    const bookmark = new URL(location.pathname, location.href);
    bookmark.searchParams.set("src", url);
    text.innerHTML = `Listo. Enlace para favoritos: <span class="break">${escapeHtml(bookmark.href)}</span>`;
    // Si ya estás enviando a la tele, al terminar la descarga arranca solo.
    if (autoplay || tvStream) startGame(slot);
  } catch (err) {
    console.error(err);
    text.textContent = err.message || String(err);
  } finally {
    downloading = false;
  }
}

// ---------------------------------------------------------------- ver en la tele (streaming)

let tvStream = null;   // envío por WebRTC (streamTo)
let tvNative = null;   // envío directo al reproductor de la tele (startNative)
let tvOn = 0;          // sube en cada conexión/desconexión: invalida intentos viejos
const tvRemotePad = { player: 0, mask: 0 };

function peerReady() {
  return new Promise(resolve => {
    if (peer && peer.open) return resolve();
    const t = setInterval(() => { if (peer && peer.open) { clearInterval(t); resolve(); } }, 200);
  });
}

let tvConnectedAt = 0;
function tvStatus(msg, ok) {
  const el = $("#tvState");
  el.textContent = msg;
  el.style.color = ok ? "var(--accent)" : "";
  if (ok) { tvConnectedAt = tvConnectedAt || Date.now(); toast(msg); }
}

// ¿Dónde suena el juego? Con el envío directo, en la tele (por su reproductor
// normal). Con WebRTC en el Chromecast de las LG el audio de la tele no sale por
// ninguna vía probada, así que ahí suena el móvil.
function soundOnTv(viaCast) {
  const v = $("#soundOut").value;
  if (v === "phone") return false;
  if (v === "tv") return true;
  return tvNative ? true : !viaCast;
}
function applySound() {
  if (!tvStream && !tvNative) return setLocalMuted(false);
  const onTv = soundOnTv(tvViaCast);
  setLocalMuted(onTv);
  if (tvNative) tvNative.mute(!onTv);
}

// Escala del lienzo de 960×720 dentro de la zona de juego (ver style.css).
new ResizeObserver(() => {
  const g = $("#game");
  if (g.clientWidth) g.style.setProperty("--tvs", String(g.clientWidth / 960));
}).observe($("#game"));

const gameCanvas = () => (started && window.EJS_emulator && window.EJS_emulator.started ? window.EJS_emulator.canvas : null);

let tvViaCast = false;
async function startTv(tvCode, viaCast = tvViaCast) {
  tvCode = tvCode.trim().toLowerCase();
  if (!tvCode) return;
  stopTv();
  const gen = tvOn;
  tvViaCast = viaCast;
  tvConnectedAt = 0;
  localStorage.setItem("mgs.tvcast", viaCast ? "1" : "0");
  localStorage.setItem("mgs.tv", tvCode);
  document.body.classList.add("tvstream"); // zona de juego siempre 4:3: se captura sin copiar
  $("#tvStop").hidden = false;
  setLocalMuted(soundOnTv(viaCast));
  await peerReady();
  if (gen !== tvOn) return;
  tvStream = streamTo(peer, tvCode, gameCanvas, peer.id, tvStatus, $("#tvQuality").value, {
    // Mando de la tele (o mando emparejado con ella) por el vídeo de vuelta.
    onTvKeys: m => applyMask(tvRemotePad, m),
  });
}

function stopTv() {
  tvOn++;
  if (tvStream) tvStream.stop();
  tvStream = null;
  stopNative();
  localStorage.removeItem("mgs.tv");
  document.body.classList.remove("tvstream");
  setLocalMuted(false);
  $("#tvStop").hidden = true;
  $("#tvState").textContent = "";
}

// ---- envío directo (Chromecast con la página a pantalla completa)
// El móvil codifica por hardware y la tele reproduce con su reproductor por
// hardware, como una app de vídeo: más nitidez, menos trabajo para la tele y el
// sonido sale por la tele. Si algo falla, se vuelve solo a WebRTC.
function stopNative(tellTv = true) {
  if (!tvNative) return;
  clearInterval(tvNative.watch);
  tvNative.stop(tellTv);
  tvNative.transport.close();
  tvNative = null;
}

async function tryNative(cast, tvCode) {
  const gen = tvOn;
  const alive = () => gen === tvOn;
  let transport;
  try { transport = castTransport(cast); } catch (e) { report("phone", "native-error", { msg: String(e) }); return; }
  const sender = await startNative(transport, {
    getCanvas: gameCanvas, getAudioTrack, alive, report, waitMs: 20000,
    onStatus: msg => { if (tvNative === sender) { $("#tvState").textContent = msg; $("#tvState").style.color = "var(--accent)"; } },
    onTvKeys: m => applyMask(tvRemotePad, m),
  }).catch(e => { report("phone", "native-error", { msg: String(e) }); return null; });
  if (!sender || !alive()) { if (sender) sender.stop(); transport.close(); return; }
  // Relevo: la tele cuelga WebRTC en cuanto empieza el envío directo.
  if (tvStream) { tvStream.stop(); tvStream = null; }
  tvNative = sender;
  window.__mgsTvNative = sender; // diagnóstico
  sender.transport = transport;
  applySound();
  report("phone", "native-on", { tv: tvCode, codec: sender.stats.codec, audio: sender.stats.audio });
  const t0 = Date.now();
  let blind = 0;
  const fallback = why => {
    if (tvNative !== sender) return;
    report("phone", "native-fallback", { tv: tvCode, why, stats: { ...sender.stats, tv: undefined }, tvStats: sender.stats.tv });
    stopNative();
    toast("El envío directo no va en esta tele: sigo por WebRTC.", 5000);
    if (alive()) startTv(tvCode, true).then(() => applySound());
  };
  sender.watch = setInterval(() => {
    const st = sender.stats;
    if (st.err) return fallback("encoder: " + st.err);
    const visible = document.visibilityState === "visible";
    if (visible && gameCanvas() && Date.now() - sender.lastTvStatsAt > 10000) return fallback("sin respuesta de la tele");
    const tv = st.tv;
    if (visible && gameCanvas() && Date.now() - t0 > 8000 && (!tv || tv.shown < 3)) blind++; else blind = 0;
    if (blind >= 4) fallback("la tele no muestra imagen: " + (tv && tv.err || "sin fotogramas"));
  }, 2000);
  setTimeout(() => {
    if (tvNative !== sender || !sender.stats.tv || sender.stats.tv.shown < 3) return;
    if (soundOnTv(true)) {
      toastAction("En la tele en directo, con sonido. ¿No se oye en la tele?", "Sonido en el móvil", () => {
        $("#soundOut").value = "phone";
        try { localStorage.setItem("mgs.sound", "phone"); } catch (e) { /* sin almacenamiento */ }
        applySound();
      }, 12000);
    } else toast("En la tele en directo ✓", 4000);
  }, 6000);
}

$("#tvForm").onsubmit = async e => {
  e.preventDefault();
  await startTv($("#tvCode").value, false);
  await playAfterTvConnect();
};

// Lo que la tele muestra sale del juego en marcha: si aún no has pulsado Jugar,
// arrancamos el primer disco guardado. Si no hay ninguno, lo decimos claro.
async function playAfterTvConnect() {
  if (started) return;
  const discs = await store.listDiscs();
  const first = discs.find(d => d.slot === "disc1") || discs[0];
  if (first) {
    toast(`Arrancando ${first.name} en la tele…`, 4000);
    startGame(first.slot);
  } else {
    toast("Tele lista. Ahora carga tu disco: pega el enlace o elige el archivo.", 6000);
    $("#link").scrollIntoView({ behavior: "smooth", block: "center" });
  }
}
$("#tvStop").onclick = stopTv;
try { $("#tvQuality").value = localStorage.getItem("mgs.tvq") || "auto"; } catch (e) { /* sin almacenamiento */ }
$("#tvQuality").onchange = e => {
  try { localStorage.setItem("mgs.tvq", e.target.value); } catch (err) { /* sin almacenamiento */ }
  if (tvStream) tvStream.setQuality(e.target.value);
};
try { $("#soundOut").value = localStorage.getItem("mgs.sound") || "auto"; } catch (e) { /* sin almacenamiento */ }
$("#soundOut").onchange = e => {
  try { localStorage.setItem("mgs.sound", e.target.value); } catch (err) { /* sin almacenamiento */ }
  applySound();
};
const nativeCapable = typeof VideoEncoder !== "undefined" && typeof MediaStreamTrackProcessor !== "undefined";
try { $("#castMode").value = (nativeCapable && localStorage.getItem("mgs.castmode")) || (nativeCapable ? "native" : "iframe"); } catch (e) { /* sin almacenamiento */ }
$("#castMode").onchange = e => {
  try { localStorage.setItem("mgs.castmode", e.target.value); } catch (err) { /* sin almacenamiento */ }
};

$("#castBtn").onclick = async () => {
  const tvCode = randomCode();
  const native = nativeCapable && $("#castMode").value === "native";
  const rcv = $("#castRcv").value;
  // ;noaudio: con WebRTC la tele no reproduce sonido (suena el móvil) y ahorra CPU.
  // ;native: la tele escucha los mensajes de la sesión para el envío directo.
  const url = new URL(`screen.html?t=${Date.now()}#${tvCode}${soundOnTv(true) && !native ? "" : ";noaudio"}${native ? ";native" : ""}`, location.href).href;
  try {
    tvStatus("Elige tu tele en la lista…");
    const cast = await castPage(url, rcv, { force: native, fresh: true });
    try { localStorage.setItem("mgs.castrcv", rcv); } catch (e) { /* sin almacenamiento */ }
    tvStatus("Abriendo la pantalla en la tele…");
    await startTv(tvCode, true);
    if (native) {
      tryNative(cast, tvCode);
      // Si la página a pantalla completa no llega a abrir en esta tele, ofrecer el
      // modo compatible (necesita un toque: Chrome lo exige para elegir la tele).
      const gen = tvOn;
      setTimeout(() => {
        if (gen !== tvOn || tvNative || tvConnectedAt) return;
        report("phone", "native-page-silent", { tv: tvCode, rcv });
        toastAction("La tele no responde.", "Probar modo compatible", () => {
          $("#castMode").value = "iframe";
          try { localStorage.setItem("mgs.castmode", "iframe"); } catch (e) { /* sin almacenamiento */ }
          $("#castBtn").click();
        }, 20000);
      }, 30000);
    }
    await playAfterTvConnect();
  } catch (err) {
    console.error(err);
    tvStatus(err.message || String(err));
  }
};

// ---------------------------------------------------------------- arranque

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

// Aviso de versión nueva (la tele se actualiza sola; el móvil, al recargar).
(async () => {
  const get = () => fetch("version.json", { cache: "no-store" }).then(r => r.json()).then(j => j.v).catch(() => null);
  const mine = await get();
  setInterval(async () => {
    const v = await get();
    if (mine && v && v !== mine) toast("Hay una versión nueva de la app: recarga la página cuando puedas", 6000);
  }, 120000);
})();

$("#buildTag").textContent = "v" + window.MGS_BUILD;
renderDiscs();
startPeer(codeForPeer());
if (localStorage.getItem("mgs.tv")) {
  const code = localStorage.getItem("mgs.tv"), viaCast = localStorage.getItem("mgs.tvcast") === "1";
  $("#tvCode").value = code;
  startTv(code, viaCast).then(async () => {
    // Tras recargar: si la sesión de Chromecast sigue abierta, retomar el envío directo.
    if (!viaCast || !nativeCapable || $("#castMode").value !== "native") return;
    const cast = await rejoinCast(localStorage.getItem("mgs.castrcv") || "dashcast").catch(() => null);
    if (cast) tryNative(cast, code);
  });
}

const autoDisc = params.get("disc");
const src = params.get("src");
if (src && !autoDisc) {
  // play.html?src=<enlace>: si ya está descargado, juega; si no, lo descarga y juega.
  $("#linkUrl").value = src;
  (async () => {
    const discs = await store.listDiscs();
    const known = discs.find(d => localStorage.getItem(`mgs.src.${d.slot}`) === src);
    if (known) startGame(known.slot);
    else loadFromLink(src, "auto", { autoplay: true });
  })();
}
if (autoDisc === "disc1" || autoDisc === "disc2") {
  history.replaceState(null, "", location.pathname + (src ? "?src=" + encodeURIComponent(src) : ""));
  startGame(autoDisc);
}
