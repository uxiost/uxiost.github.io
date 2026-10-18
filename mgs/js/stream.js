// Modo "la tele solo pinta": el emulador corre en el móvil y la imagen y el
// sonido viajan a la tele por WebRTC. La tele (screen.html) puede abrirse en
// su navegador o en su Chromecast integrado mediante un receptor público que
// carga páginas web (DashCast o URL Cast Receiver), sin registrar ninguna app.

import { PEER_PREFIX } from "./protocol.js";
import { report } from "./diag.js";

export const TV_PREFIX = PEER_PREFIX + "tv-";

// ---------------------------------------------------------------- audio
// El emulador manda el audio a ctx.destination. Interceptamos esas conexiones
// para sacar una copia (para la tele) y poder silenciar el altavoz del móvil.
// Debe instalarse antes de que arranque el emulador.

const taps = new Map(); // AudioContext -> { tap, local }
let localMuted = false;

export function installAudioTap() {
  const AN = window.AudioNode;
  if (!AN || AN.prototype.__mgsTapped) return;
  const connect = AN.prototype.connect;
  AN.prototype.__mgsTapped = true;
  AN.prototype.connect = function (dest, ...rest) {
    if (dest instanceof AudioDestinationNode) {
      const t = tapFor(this.context, connect);
      connect.call(this, t.tap);
      return connect.call(this, t.local, ...rest);
    }
    return connect.call(this, dest, ...rest);
  };
}

function tapFor(ctx, connect) {
  let t = taps.get(ctx);
  if (!t) {
    const tap = ctx.createMediaStreamDestination();
    const local = ctx.createGain();
    local.gain.value = localMuted ? 0 : 1;
    connect.call(local, ctx.destination);
    t = { tap, local };
    taps.set(ctx, t);
  }
  return t;
}

export function setLocalMuted(muted) {
  localMuted = muted;
  for (const { local } of taps.values()) local.gain.value = muted ? 0 : 1;
}

function audioTracks() {
  for (const { tap } of taps.values()) {
    const tr = tap.stream.getAudioTracks();
    if (tr.length) return tr;
  }
  return [];
}

// ---------------------------------------------------------------- vídeo

// Preferimos H.264: las teles lo decodifican por hardware.
export function preferH264(sdp) {
  const lines = sdp.split("\r\n");
  const mi = lines.findIndex(l => l.startsWith("m=video"));
  if (mi < 0) return sdp;
  const h264 = lines
    .filter(l => /^a=rtpmap:\d+ H264\/90000/i.test(l))
    .map(l => l.match(/^a=rtpmap:(\d+)/)[1]);
  if (!h264.length) return sdp;
  const parts = lines[mi].split(" ");
  const head = parts.slice(0, 3);
  const pts = parts.slice(3);
  lines[mi] = [...head, ...h264, ...pts.filter(p => !h264.includes(p))].join(" ");
  return lines.join("\r\n");
}

export function lowLatencyReceivers(pc) {
  for (const r of pc.getReceivers()) {
    try { r.playoutDelayHint = 0; } catch (e) { /* no soportado */ }
    try { r.jitterBufferTarget = 0; } catch (e) { /* no soportado */ }
  }
}

async function tuneSenders(pc, canvas) {
  for (const s of pc.getSenders()) {
    if (!s.track || s.track.kind !== "video") continue;
    const p = s.getParameters();
    p.degradationPreference = "maintain-framerate";
    p.encodings = p.encodings && p.encodings.length ? p.encodings : [{}];
    p.encodings[0].maxBitrate = 6_000_000;
    p.encodings[0].maxFramerate = 60;
    // Hasta 720 líneas: suficiente para PS1 (240–480 de origen) y ligero para la wifi.
    p.encodings[0].scaleResolutionDownBy = Math.max(1, canvas.height / 720);
    try { await s.setParameters(p); } catch (e) { console.warn("setParameters", e); }
  }
}

// ---------------------------------------------------------------- llamada a la tele

// Llama a la pantalla de la tele y la mantiene: si se cae o aún no está
// lista (el Chromecast tarda unos segundos en abrirla), reintenta.
export function streamTo(peer, tvCode, getCanvas, consoleId, onStatus) {
  let call = null;
  let stopped = false;
  let timer = null;
  const started = Date.now();

  // Canal de avisos: la tele enseña en pantalla qué está pasando en el móvil
  // (y si llega, sabemos que la conexión entre los dos funciona).
  let statusConn = null;
  let lastTvMsg = "";
  const tell = msg => {
    lastTvMsg = msg;
    if (statusConn && statusConn.open) statusConn.send({ t: "status", msg });
  };
  const openStatus = () => {
    if (stopped || (statusConn && statusConn.open)) return;
    statusConn = peer.connect(TV_PREFIX + tvCode, { serialization: "json", metadata: { status: true } });
    statusConn.on("open", () => statusConn.send({ t: "status", msg: lastTvMsg }));
  };
  const say = (msg, ok, tvMsg) => { onStatus(msg, ok); tell(tvMsg || msg); };

  const attempt = () => {
    if (stopped) return;
    openStatus();
    const canvas = getCanvas();
    if (!canvas) {
      say("Tele lista. Ahora pulsa ▶ Jugar en un disco (o carga uno).", false,
        "Móvil conectado ✓ · Ahora pulsa ▶ Jugar en el móvil");
      timer = setTimeout(attempt, 1500);
      return;
    }
    const stream = canvas.captureStream(60);
    stream.getVideoTracks().forEach(t => { t.contentHint = "motion"; });
    audioTracks().forEach(t => stream.addTrack(t));
    say("Conectando con la tele…", false, "Recibiendo el juego…");
    const c = peer.call(TV_PREFIX + tvCode, stream, {
      metadata: { console: consoleId },
      sdpTransform: preferH264,
    });
    call = c;
    let connected = false;
    const pcWatch = setInterval(() => {
      if (c !== call) return clearInterval(pcWatch);
      const pc = c.peerConnection;
      if (!pc) return;
      const st = pc.connectionState || pc.iceConnectionState;
      if (st !== c.__lastSt) { c.__lastSt = st; report("phone", "pc-state", { tv: tvCode, st }); }
      if (st === "connected" && !connected) {
        connected = true;
        tuneSenders(pc, canvas);
        say("En la tele ✓", true);
      }
      if (["failed", "closed", "disconnected"].includes(st)) {
        clearInterval(pcWatch);
        retry();
      }
    }, 500);
    // Solo reaccionamos a la llamada vigente, no a cierres de intentos anteriores.
    const lost = () => { clearInterval(pcWatch); if (c === call) retry(); };
    c.on("close", lost);
    c.on("error", lost);
  };

  const retry = () => {
    if (stopped) return;
    const old = call;
    call = null; // antes de cerrar: así su evento "close" ya no cuenta como vigente
    try { old && old.close(); } catch (e) { /* ya cerrada */ }
    clearTimeout(timer);
    if (Date.now() - started > 3 * 60 * 1000) {
      say("No encuentro la tele. ¿Está abierta la pantalla con ese código?");
    } else {
      say("Esperando a la tele…");
    }
    timer = setTimeout(attempt, 2000);
  };

  // PeerJS avisa de "peer-unavailable" en el objeto peer, no en la llamada.
  const onPeerError = err => {
    report("phone", "peer-error", { tv: tvCode, type: err && err.type, msg: String(err && err.message) });
    if (err && err.type === "peer-unavailable" && String(err.message).includes(TV_PREFIX + tvCode)) retry();
  };
  peer.on("error", onPeerError);

  attempt();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      peer.off("error", onPeerError);
      const old = call;
      call = null;
      try { old && old.close(); } catch (e) { /* ya cerrada */ }
      try { statusConn && statusConn.close(); } catch (e) { /* ya cerrada */ }
    },
  };
}

// ---------------------------------------------------------------- Chromecast sin registrar app
// Receptores públicos que abren una página web en el Chromecast:
//   DashCast (84912283), mensaje {url, force, reload, reload_time}
//   URL Cast Receiver (5CB45E5A), mensaje {type: "iframe"|"loc", url}

export const RECEIVERS = {
  dashcast: {
    appId: "84912283",
    ns: "urn:x-cast:com.madmod.dashcast",
    msg: url => ({ url, force: false, reload: false, reload_time: 0 }),
  },
  urlcast: {
    appId: "5CB45E5A",
    ns: "urn:x-cast:com.url.cast",
    msg: url => ({ type: "iframe", url }),
  },
};

let castLoad = null;
function loadCastSdk() {
  if (castLoad) return castLoad;
  castLoad = new Promise((resolve, reject) => {
    window.__onGCastApiAvailable = ok => ok ? resolve() : reject(new Error("Este navegador no puede enviar a Chromecast (usa Chrome en Android)."));
    const s = document.createElement("script");
    s.src = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";
    s.onerror = () => reject(new Error("No se pudo cargar el SDK de Chromecast."));
    document.head.appendChild(s);
    setTimeout(() => reject(new Error("Este navegador no ofrece Chromecast (usa Chrome en Android).")), 10000);
  });
  return castLoad;
}

// Se debe llamar desde un toque del usuario (Chrome lo exige para abrir el selector).
export async function castPage(url, which = "dashcast") {
  const r = RECEIVERS[which];
  await loadCastSdk();
  const ctx = cast.framework.CastContext.getInstance();
  ctx.setOptions({ receiverApplicationId: r.appId, autoJoinPolicy: chrome.cast.AutoJoinPolicy.PAGE_SCOPED });
  const current = ctx.getCurrentSession();
  if (current && current.getApplicationMetadata && current.getApplicationMetadata()?.applicationId !== r.appId) {
    ctx.endCurrentSession(true);
  }
  if (!ctx.getCurrentSession()) {
    const err = await ctx.requestSession();
    if (err) throw new Error(err === "cancel" ? "Cancelado" : `Chromecast: ${err}`);
  }
  await ctx.getCurrentSession().sendMessage(r.ns, r.msg(url));
}
