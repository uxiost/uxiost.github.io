// Mando táctil: convierte el móvil en un mando de PS1 conectado a la consola.
// Dos caminos:
//  - Misma máquina (p. ej. Pixel con la tele por cable como segundo escritorio):
//    BroadcastChannel entre ventanas de Chrome. Sin red y sin retraso.
//  - Otro dispositivo (la tele o un PC): WebRTC con PeerJS.

import { PEER_PREFIX, FILE_CHUNK, formatBytes } from "./protocol.js?v=20";
import { attachTouchPad } from "./padui.js?v=20";

const $ = sel => document.querySelector(sel);
const HEARTBEAT_MS = 250;

let peer = null;
let conn = null;
let code = null;
let mask = 0;
let retry = 0;
let vibe = localStorage.getItem("mgs.vibe") !== "0";

const bc = "BroadcastChannel" in window ? new BroadcastChannel("mgs-web") : null;
const padId = Math.random().toString(36).slice(2);
let local = false;    // conectado a una consola en este mismo dispositivo
let lastBeat = 0;

// ---------------------------------------------------------------- UI

let toastTimer;
function toast(msg, ms = 2500) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}

function setStatus(text, ok) {
  const el = $("#status");
  el.textContent = text;
  el.classList.toggle("ok", !!ok);
}

// ---------------------------------------------------------------- conexión

function connect() {
  if (local) return;
  if (!peer || peer.destroyed) {
    peer = new Peer({ debug: 1 });
    peer.on("open", openConn);
    peer.on("disconnected", () => !peer.destroyed && peer.reconnect());
    peer.on("error", err => {
      console.warn("PeerJS", err.type, err);
      if (err.type === "peer-unavailable") setStatus(`No encuentro la consola “${code}”`);
      else setStatus("Sin conexión");
      scheduleRetry();
    });
  } else if (peer.open) {
    openConn();
  }
}

function openConn() {
  if (conn && conn.open) return;
  setStatus("Conectando…");
  conn = peer.connect(PEER_PREFIX + code, { serialization: "json", reliable: true });
  conn.on("open", () => {
    retry = 0;
    setStatus("Conectado", true);
    sendState();
  });
  conn.on("data", onMessage);
  conn.on("close", () => { setStatus("Desconectado"); scheduleRetry(); });
  conn.on("error", () => scheduleRetry());
}

let retryTimer;
function scheduleRetry() {
  clearTimeout(retryTimer);
  const wait = Math.min(1000 * 2 ** retry++, 15000);
  retryTimer = setTimeout(connect, wait);
}

function onMessage(msg) {
  if (!msg) return;
  if (msg.t === "hello") {
    if (msg.player !== undefined) setStatus(`Mando ${msg.player + 1}`, true);
    if (!msg.running) {
      const has = (msg.discs || []).length;
      toast(has ? "Pulsa START para empezar" : "Envía tu disco desde ☰ Menú", 5000);
    }
  } else if (msg.t === "toast") {
    toast(msg.msg);
  }
}

function send(msg) {
  if (local) bc.postMessage({ from: padId, ...msg });
  else if (conn && conn.open) conn.send(msg);
}

// ---------------------------------------------------------------- consola local (misma máquina)

function tryLocal(timeout = 700) {
  if (!bc) return Promise.resolve(false);
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(false), timeout);
    pendingLocal = ok => { clearTimeout(t); resolve(ok); };
    bc.postMessage({ from: padId, t: "hello?" });
  });
}
let pendingLocal = null;

if (bc) {
  bc.onmessage = e => {
    const m = e.data;
    if (!m || m.to !== padId) return;
    lastBeat = Date.now();
    if (m.t === "hello") {
      if (!local) {
        local = true;
        clearTimeout(retryTimer);
        if (conn) { conn.close(); conn = null; }
        toast("Conectado a la consola de este móvil");
      }
      if (pendingLocal) { pendingLocal(true); pendingLocal = null; }
    }
    if (m.t === "beat") return;
    onMessage(m);
  };
  // Si la consola local se cierra, volvemos a buscarla (y a la remota, si hay código).
  setInterval(async () => {
    if (local && Date.now() - lastBeat > 3500) {
      local = false;
      setStatus("Consola cerrada");
      if (code) connect();
    }
    if (!local && !(conn && conn.open)) await tryLocal();
  }, 2000);
  window.addEventListener("pagehide", () => bc.postMessage({ from: padId, t: "bye" }));
}

function sendState() {
  send({ t: "s", b: mask });
  lastSent = Date.now();
}

let lastSent = 0;
setInterval(() => {
  // Reenvío periódico: si se perdió un "soltar", el botón no se queda pulsado.
  if (Date.now() - lastSent >= HEARTBEAT_MS) sendState();
}, HEARTBEAT_MS);

// ---------------------------------------------------------------- entrada táctil

const padEl = $("#pad");
const touch = attachTouchPad(padEl, (m, newly) => {
  mask = m;
  sendState();
  if (newly && vibe && navigator.vibrate) navigator.vibrate(12);
});

// Si la app pasa a segundo plano, soltamos todo.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    touch.releaseAll();
  } else {
    keepAwake();
  }
});

// ---------------------------------------------------------------- menú

$("#menuBtn").onclick = () => $("#padMenu").showModal();
$("#padMenu").addEventListener("click", e => {
  const c = e.target.dataset && e.target.dataset.cmd;
  if (!c) return;
  send({ t: "cmd", c });
  $("#padMenu").close();
});
$("#optVibe").checked = vibe;
$("#optVibe").onchange = e => {
  vibe = e.target.checked;
  localStorage.setItem("mgs.vibe", vibe ? "1" : "0");
};
$("#fsBtn").onclick = goFullscreen;
$("#changeCode").onclick = () => {
  localStorage.removeItem("mgs.padcode");
  location.hash = "";
  location.reload();
};
$("#sendFile").onchange = e => {
  const f = e.target.files[0];
  if (f) sendDisc(f, $("#sendSlot").value);
  e.target.value = "";
};

async function goFullscreen() {
  try {
    await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    await screen.orientation.lock("landscape");
  } catch (e) { /* iOS no lo permite: girar el móvil a mano */ }
}

let wakeLock = null;
async function keepAwake() {
  try {
    if ("wakeLock" in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }
  } catch (e) { /* sin soporte */ }
}

// ---------------------------------------------------------------- envío de disco

function sendDisc(file, slot) {
  if (local) {
    // Misma máquina: se pasa el archivo tal cual, sin copiarlo por la red.
    bc.postMessage({ from: padId, t: "file", file, slot });
    $("#sendText").textContent = "Disco enviado a la consola";
    return;
  }
  if (!peer || !peer.open) return toast("No conectado");
  const prog = $("#sendProg");
  const text = $("#sendText");
  prog.hidden = false;
  prog.value = 0;
  text.textContent = `Enviando ${file.name} (${formatBytes(file.size)})…`;

  const fc = peer.connect(PEER_PREFIX + code, { label: "file", serialization: "raw", reliable: true });
  fc.on("data", d => {
    let m;
    try { m = JSON.parse(d); } catch (e) { return; }
    if (m.t === "rx") {
      prog.value = m.got / m.total;
      text.textContent = `Recibido ${formatBytes(m.got)} de ${formatBytes(m.total)}`;
    } else if (m.t === "rxdone") {
      prog.value = 1;
      text.textContent = "¡Disco guardado en la consola!";
      toast("Disco enviado. Pulsa START para jugar");
    } else if (m.t === "rxerr") {
      text.textContent = m.msg;
    }
  });
  fc.on("error", err => { text.textContent = `Error: ${err.type || err}`; });
  fc.on("open", async () => {
    const dc = fc.dataChannel;
    dc.bufferedAmountLowThreshold = 1024 * 1024;
    const drained = () => new Promise(res => {
      dc.addEventListener("bufferedamountlow", res, { once: true });
    });
    fc.send(JSON.stringify({ name: file.name, size: file.size, slot }));
    for (let off = 0; off < file.size; off += FILE_CHUNK) {
      if (!fc.open) return;
      if (dc.bufferedAmount > 8 * 1024 * 1024) await drained();
      fc.send(await file.slice(off, off + FILE_CHUNK).arrayBuffer());
    }
    fc.send("EOF");
    text.textContent = "Terminando…";
  });
}

// ---------------------------------------------------------------- arranque

async function start(c) {
  code = c ? c.trim().toLowerCase() : null;
  if (code) localStorage.setItem("mgs.padcode", code);
  $("#join").classList.add("hidden");
  $("#pad").classList.remove("hidden");
  keepAwake();
  // Primero, ¿hay una consola abierta en este mismo dispositivo?
  if (await tryLocal()) return;
  if (code) connect();
}

$("#joinForm").onsubmit = e => {
  e.preventDefault();
  start($("#joinCode").value);
  goFullscreen();
};

// El primer toque en el mando pasa a pantalla completa (requiere gesto del usuario).
padEl.addEventListener("pointerdown", function once() {
  if (!document.fullscreenElement) goFullscreen();
  padEl.removeEventListener("pointerdown", once);
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

const initial = location.hash.slice(1) || localStorage.getItem("mgs.padcode");
if (initial) start(initial);
else tryLocal().then(ok => ok ? start(null) : $("#join").classList.remove("hidden"));
