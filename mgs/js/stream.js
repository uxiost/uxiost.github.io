// Modo "la tele solo pinta": el emulador corre en el móvil y la imagen y el
// sonido viajan a la tele por WebRTC. La tele (screen.html) puede abrirse en
// su navegador o en su Chromecast integrado mediante un receptor público que
// carga páginas web (DashCast o URL Cast Receiver), sin registrar ninguna app.

import { PEER_PREFIX } from "./protocol.js?v=14";
import { report } from "./diag.js?v=14";

export const TV_PREFIX = PEER_PREFIX + "tv-";

// ---------------------------------------------------------------- audio
// El emulador manda el audio a ctx.destination. Interceptamos esas conexiones
// para sacar una copia (para la tele) y poder silenciar el altavoz del móvil.
// Debe instalarse antes de que arranque el emulador.

const taps = new Map(); // AudioContext -> { tap, local }
window.__mgsTaps = taps; // para diagnóstico
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

// Chrome puede dejar el audio del emulador en pausa si no hubo un toque reciente:
// entonces a la tele solo llega silencio. Lo reactivamos siempre que se pueda.
export function resumeAudio() {
  for (const ctx of taps.keys()) {
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
  }
}
["pointerdown", "keydown", "touchstart"].forEach(ev =>
  window.addEventListener(ev, resumeAudio, { capture: true, passive: true }));
setInterval(resumeAudio, 2000);

export function audioInfo() {
  const out = [];
  for (const [ctx, { tap, local }] of taps) {
    out.push({ state: ctx.state, rate: ctx.sampleRate, tracks: tap.stream.getAudioTracks().length, localGain: local.gain.value, muted: localMuted });
  }
  return out;
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

// Que el vídeo empiece nítido: por defecto WebRTC arranca a ~300 kbps y sube poco a poco.
export function boostBitrate(sdp) {
  const lines = sdp.split("\r\n");
  const vp8 = lines.filter(l => /^a=rtpmap:\d+ (VP8|H264)\/90000/i.test(l)).map(l => l.match(/^a=rtpmap:(\d+)/)[1]);
  // Sin mínimo forzado: si la wifi o la tele no dan abasto, el emisor debe poder bajar.
  const extra = "x-google-start-bitrate=400;x-google-max-bitrate=900";
  for (const pt of vp8) {
    const i = lines.findIndex(l => l.startsWith(`a=fmtp:${pt} `));
    if (i >= 0) {
      if (!lines[i].includes("x-google-start-bitrate")) lines[i] += ";" + extra;
    } else {
      const r = lines.findIndex(l => l.startsWith(`a=rtpmap:${pt} `));
      lines.splice(r + 1, 0, `a=fmtp:${pt} ${extra}`);
    }
  }
  return lines.join("\r\n");
}

export function lowLatencyReceivers(pc) {
  for (const r of pc.getReceivers()) {
    try { r.playoutDelayHint = 0; } catch (e) { /* no soportado */ }
    try { r.jitterBufferTarget = 0; } catch (e) { /* no soportado */ }
  }
}

// La tele del Chromecast decodifica VP8 por software y va justa de CPU:
// 480 líneas y 30 fps sobran para PS1 (240–480 de origen).
const MAX_LINES = 240;
const FPS = 30;

// Copiamos solo la imagen del juego (4:3, sin las bandas negras del lienzo del
// emulador) a un lienzo fijo de 640×480. Así la resolución en la tele no depende
// de cómo sujetes el móvil. 320×240 es la resolución nativa de MGS1 en PS1: no se
// pierde detalle, y la tele (sin aceleración gráfica) la decodifica sin esfuerzo.
const OUT_W = 320, OUT_H = 240;
function gameFeed(src) {
  const out = document.createElement("canvas");
  out.width = OUT_W;
  out.height = OUT_H;
  const g = out.getContext("2d", { alpha: false });
  g.imageSmoothingQuality = "high";
  const copy = () => {
    const w = src.width, h = src.height;
    if (!w || !h) return;
    let sw = w, sh = h;
    if (w / h > 4 / 3) sw = h * 4 / 3; else sh = w * 3 / 4;
    g.drawImage(src, (w - sw) / 2, (h - sh) / 2, sw, sh, 0, 0, OUT_W, OUT_H);
  };
  let raf = 0;
  const loop = () => { copy(); raf = requestAnimationFrame(loop); };
  loop();
  const track = out.captureStream(FPS).getVideoTracks()[0];
  track.contentHint = "motion";
  return { track, stop() { cancelAnimationFrame(raf); track.stop(); } };
}

async function tuneVideoSender(sender, height) {
  const p = sender.getParameters();
  p.degradationPreference = "balanced";
  p.encodings = p.encodings && p.encodings.length ? p.encodings : [{}];
  p.encodings[0].maxBitrate = 800_000;
  p.encodings[0].maxFramerate = FPS;
  p.encodings[0].scaleResolutionDownBy = Math.max(1, (height || MAX_LINES) / MAX_LINES);
  try { await sender.setParameters(p); } catch (e) { console.warn("setParameters", e); }
}

// Pantalla de estado que se manda como vídeo mientras el juego no ha empezado:
// así la tele enseña qué pasa en el móvil sin necesitar un canal de datos.
function statusCard() {
  const c = document.createElement("canvas");
  c.width = 640;
  c.height = 480;
  const g = c.getContext("2d");
  let text = "";
  let tick = 0;
  const draw = () => {
    g.fillStyle = "#0b0f0b";
    g.fillRect(0, 0, 640, 480);
    g.textAlign = "center";
    g.fillStyle = "#7fbf6a";
    g.font = "bold 34px system-ui, sans-serif";
    g.fillText("MGS WEB", 320, 150);
    g.fillStyle = "#d7e4d2";
    g.font = "26px system-ui, sans-serif";
    const words = text.split(" ");
    let line = "", y = 240;
    for (const w of words) {
      if (g.measureText(line + w).width > 560) { g.fillText(line, 320, y); line = ""; y += 36; }
      line += w + " ";
    }
    g.fillText(line, 320, y);
    g.fillStyle = "#8ea38a";
    g.fillText(".".repeat(1 + (tick++ % 3)), 320, y + 50);
  };
  draw();
  // captureStream solo emite cuando se dibuja: redibujamos a menudo.
  const iv = setInterval(draw, 400);
  const track = c.captureStream(5).getVideoTracks()[0];
  return { track, set(t) { text = t; draw(); }, stop() { clearInterval(iv); track.stop(); } };
}

function silentAudioTrack() {
  try {
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    const g = ctx.createGain();
    g.gain.value = 0;
    const o = ctx.createOscillator();
    o.connect(g);
    g.connect(dest);
    o.start();
    return dest.stream.getAudioTracks()[0];
  } catch (e) {
    return null;
  }
}

// Cómo va el emisor: fps codificados, si algo lo limita (cpu/ancho de banda), RTT…
async function sendStats(pc, tvCode, stage) {
  if (!pc || pc.connectionState === "closed") return;
  const out = { tv: tvCode, st: pc.connectionState };
  (await pc.getStats()).forEach(r => {
    if (r.type === "outbound-rtp" && r.kind === "video") Object.assign(out, {
      w: r.frameWidth, h: r.frameHeight, fps: r.framesPerSecond, limit: r.qualityLimitationReason,
      target: r.targetBitrate, encMs: r.framesEncoded ? Math.round(1000 * r.totalEncodeTime / r.framesEncoded) : null,
      nack: r.nackCount, pli: r.pliCount, keyframes: r.keyFramesEncoded, retx: r.retransmittedPacketsSent,
    });
    if (r.type === "candidate-pair" && r.nominated && r.state === "succeeded") Object.assign(out, {
      rttMs: r.currentRoundTripTime != null ? Math.round(r.currentRoundTripTime * 1000) : null,
      availOut: r.availableOutgoingBitrate,
    });
  });
  report("phone", stage, out);
}

function audioSenderTrack(pc) {
  const s = pc && pc.getSenders().find(x => x.track && x.track.kind === "audio");
  return s ? { label: s.track.label.slice(0, 40), state: s.track.readyState, muted: s.track.muted } : null;
}

// PeerJS añade un canal de datos a toda llamada de vídeo (para avisar del
// cierre), y el Chromecast de las LG tiene los canales de datos desactivados:
// rechaza la oferta entera. Llamamos sin él; el cierre lo vigilamos nosotros.
function callWithoutDataChannel(peer, id, stream, options) {
  const proto = RTCPeerConnection.prototype;
  const original = proto.createDataChannel;
  proto.createDataChannel = function () {
    return { readyState: "closed", close() {}, label: "" };
  };
  try {
    return peer.call(id, stream, options);
  } finally {
    proto.createDataChannel = original;
  }
}

// ---------------------------------------------------------------- llamada a la tele

// Llama a la pantalla de la tele y la mantiene: si se cae o aún no está
// lista (el Chromecast tarda unos segundos en abrirla), reintenta. Antes de
// que arranque el juego manda una pantalla de estado y, cuando arranca,
// cambia la imagen y el sonido por los del juego sin cortar la conexión.
export function streamTo(peer, tvCode, getCanvas, consoleId, onStatus) {
  let call = null;
  let stopped = false;
  let timer = null;
  let upgrade = null;
  const started = Date.now();

  const card = statusCard();
  const silent = silentAudioTrack();
  let feed = null;
  let gameVideo = null;
  let gameAudio = null;
  let gameHeight = 0;

  let lastSaid = "";
  const say = (msg, ok, tvMsg) => {
    if (msg === lastSaid) return;
    lastSaid = msg;
    onStatus(msg, ok);
    card.set(tvMsg || msg);
  };

  const currentTracks = () => {
    const canvas = getCanvas();
    if (canvas && !gameVideo) {
      feed = gameFeed(canvas);
      gameVideo = feed.track;
      gameHeight = OUT_H;
    }
    if (!gameAudio) gameAudio = audioTracks()[0] || null;
    return { video: gameVideo || card.track, audio: gameAudio || silent };
  };

  // Cambia en caliente la pantalla de estado por el juego cuando esté listo.
  const upgradeTracks = async () => {
    const pc = call && call.peerConnection;
    if (!pc || pc.connectionState !== "connected") return;
    const { video, audio } = currentTracks();
    for (const sender of pc.getSenders()) {
      const want = sender.track && sender.track.kind === "video" ? video : sender.track && sender.track.kind === "audio" ? audio : null;
      if (want && sender.track !== want) {
        await sender.replaceTrack(want).catch(e => report("phone", "replaceTrack", { msg: String(e) }));
        if (want === gameVideo) {
          tuneVideoSender(sender, gameHeight);
          say("En la tele ✓", true, "¡A jugar!");
          report("phone", "game-on-tv", { tv: tvCode, src: [getCanvas()?.width, getCanvas()?.height], audio: audioInfo(), gameAudio: !!gameAudio });
          setTimeout(() => report("phone", "audio-5s", { tv: tvCode, audio: audioInfo(), gameAudio: !!gameAudio, sender: audioSenderTrack(pc) }), 5000);
          setTimeout(() => sendStats(pc, tvCode, "enc-15s"), 15000);
          setTimeout(() => sendStats(pc, tvCode, "enc-60s"), 60000);
        }
      }
    }
    if (!gameVideo) say("Tele conectada ✓ Ahora pulsa ▶ Jugar en un disco (o carga uno).", true, "Móvil conectado ✓ · Pulsa ▶ Jugar en el móvil");
  };

  const attempt = () => {
    if (stopped) return;
    const { video, audio } = currentTracks();
    const stream = new MediaStream([video, audio].filter(Boolean));
    say("Conectando con la tele…", false, "Conectando…");
    const c = callWithoutDataChannel(peer, TV_PREFIX + tvCode, stream, {
      metadata: { console: consoleId },
      sdpTransform: sdp => boostBitrate(preferH264(sdp)),
    });
    call = c;
    const pcWatch = setInterval(() => {
      if (c !== call) return clearInterval(pcWatch);
      const pc = c.peerConnection;
      if (!pc) return;
      const st = pc.connectionState || pc.iceConnectionState;
      if (st !== c.__lastSt) {
        c.__lastSt = st;
        report("phone", "pc-state", { tv: tvCode, st });
        if (st === "connected") {
          const vs = pc.getSenders().find(x => x.track && x.track.kind === "video");
          if (vs) tuneVideoSender(vs, video === gameVideo ? gameHeight : MAX_LINES);
          if (video === gameVideo) say("En la tele ✓", true, "¡A jugar!");
          upgradeTracks();
        }
      }
      // "disconnected" suele recuperarse solo en unos segundos: no colgar por eso.
      if (st === "disconnected") c.__discSince = c.__discSince || Date.now();
      else c.__discSince = 0;
      const longDisc = c.__discSince && Date.now() - c.__discSince > 8000;
      if (st === "failed" || st === "closed" || longDisc) {
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

  upgrade = setInterval(upgradeTracks, 1000);
  attempt();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      clearInterval(upgrade);
      peer.off("error", onPeerError);
      const old = call;
      call = null;
      try { old && old.close(); } catch (e) { /* ya cerrada */ }
      card.stop();
      if (feed) feed.stop();
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
