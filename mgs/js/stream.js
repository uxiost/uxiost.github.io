// Modo "la tele solo pinta": el emulador corre en el móvil y la imagen y el
// sonido viajan a la tele por WebRTC. La tele (screen.html) puede abrirse en
// su navegador o en su Chromecast integrado mediante un receptor público que
// carga páginas web (DashCast o URL Cast Receiver), sin registrar ninguna app.

import { PEER_PREFIX } from "./protocol.js?v=16";
import { report } from "./diag.js?v=16";
import { readBackChannel } from "./backchan.js?v=16";

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

// Eventos del móvil que pueden cortar el envío (pantalla apagada, cambiar de app,
// mando Bluetooth…): se anotan en el diagnóstico mientras se envía a la tele.
let streaming = false;
for (const ev of ["visibilitychange", "freeze", "resume", "gamepadconnected", "gamepaddisconnected", "online", "offline"]) {
  (ev === "visibilitychange" || ev === "freeze" || ev === "resume" ? document : window).addEventListener(ev, e => {
    if (!streaming) return;
    report("phone", "event", { e: ev, vis: document.visibilityState, pad: e.gamepad ? e.gamepad.id.slice(0, 40) : undefined });
  });
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
export function boostBitrate(sdp, startKbps = Math.round(MAX_KBPS / 2), maxKbps = Math.round(MAX_KBPS * 1.15)) {
  const lines = sdp.split("\r\n");
  const vp8 = lines.filter(l => /^a=rtpmap:\d+ (VP8|H264)\/90000/i.test(l)).map(l => l.match(/^a=rtpmap:(\d+)/)[1]);
  // Sin mínimo forzado: si la wifi o la tele no dan abasto, el emisor debe poder bajar.
  const extra = `x-google-start-bitrate=${startKbps};x-google-max-bitrate=${maxKbps}`;
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
let MAX_LINES = 480;
let FPS = 30;
let MAX_KBPS = 1600;
// Para el laboratorio: probar otras resoluciones, fps o caudal sin tocar el código.
export function tuneStream({ lines, fps, kbps } = {}) {
  if (lines) MAX_LINES = lines;
  if (fps) FPS = fps;
  if (kbps) MAX_KBPS = kbps;
}

// Imagen del juego para la tele. Camino rápido: capturar el lienzo del emulador
// tal cual (sin trabajo en el hilo principal, que en el móvil ya va cargado con
// el emulador) y que el codificador lo reduzca a 480 líneas. Solo si el lienzo
// no es 4:3 (bandas negras) se recorta copiando a un lienzo aparte, que cuesta CPU.
const OUT_W = 640, OUT_H = 480;
const is43 = (w, h) => w && h && Math.abs(w / h - 4 / 3) < 0.06;

function gameFeed(src) {
  if (is43(src.width, src.height)) {
    const track = src.captureStream().getVideoTracks()[0];
    track.contentHint = "motion";
    return {
      track,
      mode: "direct",
      height: () => src.height,
      ok: () => is43(src.width, src.height),
      stop() { track.stop(); },
    };
  }
  const out = document.createElement("canvas");
  out.width = OUT_W;
  out.height = OUT_H;
  const g = out.getContext("2d", { alpha: false });
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
  return {
    track,
    mode: "copy",
    height: () => OUT_H,
    ok: () => !is43(src.width, src.height),
    stop() { cancelAnimationFrame(raf); track.stop(); },
  };
}

async function tuneVideoSender(sender, height) {
  const p = sender.getParameters();
  // En un juego importa más la fluidez que la nitidez: bajar resolución antes que fps.
  p.degradationPreference = "maintain-framerate";
  p.encodings = p.encodings && p.encodings.length ? p.encodings : [{}];
  p.encodings[0].maxBitrate = MAX_KBPS * 1000;
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

// Niveles de calidad para la tele (de mejor a más ligero). En "auto" el móvil
// baja o sube de nivel según los fotogramas que la tele dice que pinta.
export const QUALITY = [
  { name: "720p", lines: 720, fps: 30, kbps: 4000 },
  { name: "576p", lines: 576, fps: 30, kbps: 3000 },
  { name: "480p", lines: 480, fps: 30, kbps: 2200 },
  { name: "360p", lines: 360, fps: 30, kbps: 1400 },
];

// Muestra cada 5 s (diferencias, no acumulados) del lado del móvil.
function phoneSampler(pc) {
  let prev = null;
  let frames0 = null;
  return async extra => {
    const now = { t: performance.now() };
    (await pc.getStats()).forEach(r => {
      if (r.type === "outbound-rtp" && r.kind === "video") Object.assign(now, {
        enc: r.framesEncoded, encT: r.totalEncodeTime, bytes: r.bytesSent, w: r.frameWidth, h: r.frameHeight,
        limit: r.qualityLimitationReason,
      });
      if (r.type === "remote-inbound-rtp" && r.kind === "video") Object.assign(now, {
        rtt: r.roundTripTime, loss: r.fractionLost, jitter: r.jitter,
      });
    });
    const gm = window.EJS_emulator && window.EJS_emulator.gameManager;
    const frameNum = gm && gm.getFrameNum ? gm.getFrameNum() : null;
    let out = null;
    if (prev) {
      const dt = (now.t - prev.t) / 1000;
      const dEnc = now.enc - prev.enc;
      out = {
        encFps: Math.round(dEnc / dt * 10) / 10,
        encMs: dEnc ? Math.round((now.encT - prev.encT) / dEnc * 1000 * 10) / 10 : null,
        kbps: Math.round((now.bytes - prev.bytes) * 8 / dt / 1000),
        res: [now.w, now.h], limit: now.limit,
        rttMs: now.rtt != null ? Math.round(now.rtt * 1000) : null,
        loss: now.loss, jitterMs: now.jitter != null ? Math.round(now.jitter * 1000) : null,
        emuFps: frameNum != null && frames0 != null ? Math.round((frameNum - frames0) / dt) : null,
        vis: document.visibilityState,
        pads: [...(navigator.getGamepads ? navigator.getGamepads() : [])].filter(Boolean).length,
        ...extra,
      };
    }
    prev = now;
    frames0 = frameNum;
    return out;
  };
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
export function streamTo(peer, tvCode, getCanvas, consoleId, onStatus, quality = "auto", opts = {}) {
  let call = null;
  // Calidad: "auto" empieza en 720p y se adapta; o un nivel fijo (0–3).
  let auto = quality === "auto";
  let level = auto ? 0 : Math.min(QUALITY.length - 1, Math.max(0, Number(quality) || 0));
  let lastChange = Date.now();
  let floor = QUALITY.length - 1;  // nivel más bajo permitido (sube si bajar no ayuda)
  const fpsAt = {};                // fps de la tele medidos en cada nivel
  const applyLevel = () => {
    const q = QUALITY[level];
    tuneStream({ lines: q.lines, fps: q.fps, kbps: q.kbps });
    const pc = call && call.peerConnection;
    const vs = pc && pc.getSenders().find(x => x.track && x.track === gameVideo);
    if (vs) tuneVideoSender(vs, gameHeight);
  };
  applyLevel();
  // Lo que la tele nos cuenta por su vídeo de vuelta (backchan.js).
  const tvSamples = [];   // { at, shownFps, decMs }
  let tvKeys = 0;
  let back = null, backCall = null;
  const listenBack = (c, stream) => {
    if (backCall === c) return;
    if (back) back.stop();
    backCall = c;
    back = readBackChannel(stream, m => {
      if (m.stats) {
        tvSamples.push({ at: Date.now(), shownFps: m.shownFps, decMs: m.decMs });
        while (tvSamples.length && Date.now() - tvSamples[0].at > 20000) tvSamples.shift();
      }
      if (m.keys !== tvKeys) {
        tvKeys = m.keys;
        if (opts.onTvKeys) opts.onTvKeys(m.keys);
      }
    });
  };
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
      gameHeight = feed.height();
    }
    if (!gameAudio) gameAudio = audioTracks()[0] || null;
    return { video: gameVideo || card.track, audio: gameAudio || silent };
  };

  // Cambia en caliente la pantalla de estado por el juego cuando esté listo.
  const upgradeTracks = async () => {
    const pc = call && call.peerConnection;
    if (!pc || pc.connectionState !== "connected") return;
    // Si el lienzo cambia de forma o tamaño (girar el móvil, conectar un mando),
    // rehacemos la captura o reajustamos la escala del codificador.
    if (feed && !feed.ok()) {
      feed.stop();
      feed = gameFeed(getCanvas());
      gameVideo = feed.track;
      gameHeight = feed.height();
    } else if (feed && feed.height() !== gameHeight) {
      gameHeight = feed.height();
      const vs = pc.getSenders().find(x => x.track === gameVideo);
      if (vs) tuneVideoSender(vs, gameHeight);
    }
    const { video, audio } = currentTracks();
    for (const sender of pc.getSenders()) {
      const want = sender.track && sender.track.kind === "video" ? video : sender.track && sender.track.kind === "audio" ? audio : null;
      if (want && sender.track !== want) {
        await sender.replaceTrack(want).catch(e => report("phone", "replaceTrack", { msg: String(e) }));
        if (want === gameVideo) {
          tuneVideoSender(sender, gameHeight);
          say("En la tele ✓", true, "¡A jugar!");
          report("phone", "game-on-tv", { tv: tvCode, src: [getCanvas()?.width, getCanvas()?.height], mode: feed && feed.mode, audio: audioInfo(), gameAudio: !!gameAudio });
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
    c.on("stream", st => listenBack(c, st)); // vídeo de vuelta de la tele
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

  // Al volver a la página (pantalla encendida, volver de otra app), reconectar ya
  // si la llamada se cayó, sin esperar a los temporizadores.
  const onVisible = () => {
    if (document.visibilityState !== "visible" || stopped) return;
    const pc = call && call.peerConnection;
    if (!pc || ["failed", "closed", "disconnected"].includes(pc.connectionState)) retry();
  };
  document.addEventListener("visibilitychange", onVisible);
  document.addEventListener("resume", onVisible);

  // Mantener la pantalla del móvil encendida mientras se envía a la tele.
  let wake = null;
  const keepAwake = async () => {
    if (wake || document.visibilityState !== "visible" || !navigator.wakeLock) return;
    try {
      wake = await navigator.wakeLock.request("screen");
      wake.addEventListener("release", () => { wake = null; });
    } catch (e) { /* sin permiso o sin soporte */ }
  };
  keepAwake();
  const wakeIv = setInterval(keepAwake, 5000);

  // Cada 5 s: estado del envío a la telemetría y, en "auto", ajuste de calidad
  // según los fps que la propia tele dice estar pintando.
  let sampler = null, samplerPc = null;
  const tick = setInterval(async () => {
    const pc = call && call.peerConnection;
    if (!pc || pc.connectionState !== "connected" || !gameVideo) return;
    if (pc !== samplerPc) { samplerPc = pc; sampler = phoneSampler(pc); }
    const s = await sampler({ level: QUALITY[level].name, auto, mode: feed && feed.mode });
    if (s) report("phone", "tick", { tv: tvCode, ...s });
    if (!auto) return;
    {
      // Ventana de los últimos 6 s, ignorando los primeros segundos tras un cambio.
      // Se compara lo que la tele pinta con lo que el móvil realmente envía: si el
      // emulador va lento (arrancando, cargando), la tele no tiene la culpa.
      const win = tvSamples.filter(e => Date.now() - e.at < 6000 && e.at > lastChange + 4000);
      const sent = s && s.encFps;
      if (win.length < 10 || !sent) return;
      const fps = win.map(e => e.shownFps);
      const avg = fps.reduce((a, b) => a + b, 0) / fps.length;
      const target = QUALITY[level].fps;
      const sourceOk = sent >= target * 0.85;
      // Si al bajar de nivel la tele no ha mejorado, el límite no es la resolución
      // (es pintar en pantalla): volvemos al nivel anterior y no bajamos más.
      if (sourceOk && fpsAt[level - 1] != null && fpsAt[level] == null) {
        fpsAt[level] = avg;
        if (avg < fpsAt[level - 1] * 1.1) {
          level--; floor = level; lastChange = Date.now(); applyLevel();
          report("phone", "quality-revert", { tv: tvCode, to: QUALITY[level].name, tvFps: avg });
          onStatus(`En la tele ✓ · calidad ${QUALITY[level].name}`, true);
          return;
        }
      }
      if (sourceOk && avg < sent * 0.8 && level < floor) {
        fpsAt[level] = avg;
        level++; lastChange = Date.now(); applyLevel();
        report("phone", "quality-down", { tv: tvCode, to: QUALITY[level].name, tvFps: avg, sent });
        onStatus(`En la tele ✓ · calidad ${QUALITY[level].name} (la tele iba a ${Math.round(avg)} de ${Math.round(sent)} fps)`, true);
      } else if (sourceOk && avg >= sent * 0.93 && Math.min(...fps) >= sent * 0.8 && level > 0 && Date.now() - lastChange > 30000) {
        fpsAt[level] = avg;
        level--; delete fpsAt[level]; lastChange = Date.now(); applyLevel();
        report("phone", "quality-up", { tv: tvCode, to: QUALITY[level].name, tvFps: avg, sent });
        onStatus(`En la tele ✓ · calidad ${QUALITY[level].name}`, true);
      }
    }
  }, 5000);
  streaming = true;
  attempt();
  return {
    setQuality(q) {
      auto = q === "auto";
      if (!auto) level = Math.min(QUALITY.length - 1, Math.max(0, Number(q) || 0));
      lastChange = Date.now();
      applyLevel();
    },
    get level() { return QUALITY[level].name; },
    get tvFps() { const l = tvSamples[tvSamples.length - 1]; return l ? l.shownFps : null; },
    get tvSamples() { return tvSamples.length; },
    stop() {
      stopped = true;
      streaming = false;
      clearTimeout(timer);
      clearInterval(upgrade);
      clearInterval(tick);
      clearInterval(wakeIv);
      if (back) back.stop();
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("resume", onVisible);
      if (wake) wake.release().catch(() => {});
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
