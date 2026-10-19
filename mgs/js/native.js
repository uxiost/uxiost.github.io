// Modo "nativo": el móvil codifica con su codificador por hardware (WebCodecs) y
// la tele reproduce con su reproductor por hardware (Media Source Extensions),
// igual que las apps de vídeo. La tele apenas gasta CPU (ni decodifica ni compone
// por software), así que admite más resolución y fps, y el sonido sale por el
// mismo reproductor que el vídeo (como en YouTube o Netflix). Los datos viajan
// por los mensajes de la propia sesión de Chromecast (o, en el laboratorio, por
// un canal simulado).
//
// Transporte: { send(obj) → Promise?, onMessage(cb) } con objetos JSON.
// Mensajes:
//   móvil → tele  {t:"ping"}                       tele → móvil  {t:"hello", mse, viewport, v}
//   móvil → tele  {t:"start", id, v:{mime,d}, a:{mime,d}|null}   (segmentos de inicio en base64)
//   móvil → tele  {t:"seg", id, k:"v"|"a", n, i, of, d}           (n: secuencia; i/of: trozos)
//   móvil → tele  {t:"stop"}   {t:"mute", on}
//   tele → móvil  {t:"stats", shown, lag, ...}  cada segundo
//   tele → móvil  {t:"keys", k}                 botones del mando de la tele, al cambiar
//   tele → móvil  {t:"key"}                     pide una imagen clave

import { initSegment, fragment, mimeFor, toB64, fromB64 } from "./fmp4.js?v=19";

const CHUNK = 45000; // bytes por mensaje antes de base64 (Cast: máx. 64 KB por mensaje)

// ---------------------------------------------------------------- tele

export function nativeSupport() {
  const ms = typeof MediaSource !== "undefined" ? MediaSource : null;
  const t = m => !!(ms && ms.isTypeSupported(m));
  return {
    h264: t('video/mp4; codecs="avc1.42E01F"'),
    h264main: t('video/mp4; codecs="avc1.4D401F"'),
    vp9: t('video/mp4; codecs="vp09.00.10.08"'),
    aac: t('audio/mp4; codecs="mp4a.40.2"'),
    opus: t('audio/mp4; codecs="opus"'),
  };
}

// Reproduce lo que llega en `video` (el <video> de la pantalla).
// opts: { onStats(st), getKeys(), onStart(), onStop(), muted }
export function startNativeReceiver(transport, video, opts = {}) {
  let cur = null;      // { id, ms, tracks: {v, a}, started }
  const parts = {};    // reensamblado de trozos
  let presented = 0, lastShown = 0, lastShownT = performance.now();
  let muted = !!opts.muted;
  const counter = () => { presented++; video.requestVideoFrameCallback(counter); };
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(counter);

  const teardown = () => {
    if (!cur) return;
    cur.dead = true;
    try { video.pause(); } catch (e) { /* nada */ }
    try { URL.revokeObjectURL(video.src); } catch (e) { /* nada */ }
    video.removeAttribute("src");
    try { video.load(); } catch (e) { /* nada */ }
    cur = null;
  };

  const start = m => {
    teardown();
    const ms = new MediaSource();
    const s = { id: m.id, ms, tracks: {}, started: false, jumps: 0, appended: 0, log: [], lastSegAt: performance.now() };
    for (const k of ["v", "a"]) {
      if (m[k]) s.tracks[k] = { k, mime: m[k].mime, sb: null, queue: [{ bytes: fromB64(m[k].d) }], extra: k === "v" ? m.vDur || 0 : 0 };
    }
    cur = s;
    video.srcObject = null;
    video.muted = muted || !s.tracks.a;
    video.src = URL.createObjectURL(ms);
    ms.addEventListener("sourceopen", () => {
      if (s.dead) return;
      try {
        // Directo: sin duración fija (el reproductor de Chrome va en modo de poco retraso).
        try { ms.duration = Infinity; } catch (e) { /* no admitido */ }
        for (const tr of Object.values(s.tracks)) {
          tr.sb = ms.addSourceBuffer(tr.mime);
          tr.sb.mode = "segments";
          tr.sb.addEventListener("updateend", () => {
            // Salto limpio: en cuanto entra una imagen clave pedida, ir a ella
            // (sin decodificar nada de lo anterior).
            const it = tr.last;
            if (it && it.key && s.wantJump && it.ts > video.currentTime + 0.05) {
              s.wantJump = false;
              s.jumps++;
              seek(it.ts + 0.001);
            }
            pump(s, tr);
          });
        }
        for (const tr of Object.values(s.tracks)) pump(s, tr);
      } catch (e) {
        s.err = String(e);
      }
    }, { once: true });
    if (opts.onStart) opts.onStart();
  };

  const bufEnd = () => {
    // Fin de lo que se puede reproducir: el menor de los finales de cada pista.
    let end = Infinity, startT = 0;
    for (const tr of Object.values(cur.tracks)) {
      const b = tr.sb && tr.sb.buffered;
      if (!b || !b.length) return null;
      end = Math.min(end, b.end(b.length - 1) - tr.extra);
      startT = Math.max(startT, b.start(b.length - 1));
    }
    return { end, start: startT };
  };

  const pump = (s, tr) => {
    if (s.dead || !tr.sb || tr.sb.updating || !tr.queue.length) return;
    try {
      tr.last = tr.queue.shift();
      tr.sb.appendBuffer(tr.last.bytes);
      s.appended++;
    } catch (e) {
      s.err = String(e);
      // Búfer lleno o error: vaciar lo pendiente y esperar una imagen clave.
      tr.queue.length = 0;
      if (tr.k === "v") { s.waitKey = true; transport.send({ t: "key" }); }
    }
  };

  let lastRestartAsk = 0;
  const onSeg = m => {
    const s = cur;
    if (!s || s.id !== m.id) {
      // Llegan datos de una emisión que ya no tenemos (p. ej. la cortamos porque
      // el móvil dejó de enviar un rato): pedir que empiece de nuevo.
      if (performance.now() - lastRestartAsk > 1000) { lastRestartAsk = performance.now(); transport.send({ t: "restart", id: m.id }); }
      return;
    }
    s.lastSegAt = performance.now();
    const tr = s.tracks[m.k];
    if (!tr) return;
    let bytes;
    if (m.of > 1) {
      const id = m.k + m.n;
      const p = parts[id] || (parts[id] = []);
      p[m.i] = fromB64(m.d);
      if (p.filter(Boolean).length < m.of) return;
      delete parts[id];
      const len = p.reduce((a, b) => a + b.length, 0);
      bytes = new Uint8Array(len);
      let o = 0;
      for (const b of p) { bytes.set(b, o); o += b.length; }
    } else {
      bytes = fromB64(m.d);
    }
    // Si se acumula cola (la tele no da abasto), tirar lo pendiente (salvo el
    // segmento de inicio si aún no entró) y pedir imagen clave: mejor saltar que
    // ir con retraso.
    if (tr.queue.length > 20) {
      tr.queue.length = tr.sb ? 0 : 1;
      if (m.k === "v") { s.waitKey = true; transport.send({ t: "key" }); }
      s.drops = (s.drops || 0) + 1;
    }
    if (m.k === "v" && s.waitKey) {
      if (!m.key) return;       // sin la imagen clave, lo demás no se puede decodificar
      s.waitKey = false;
    }
    tr.segs = (tr.segs || 0) + 1;
    if (m.vd) tr.extra = m.vd;
    tr.queue.push({ bytes, key: !!m.key, ts: m.ts });
    pump(s, tr);
  };

  transport.onMessage(m => {
    if (!m || !m.t) return;
    if (m.t === "start") start(m);
    else if (m.t === "seg") onSeg(m);
    else if (m.t === "stop") { teardown(); if (opts.onStop) opts.onStop(); }
    else if (m.t === "mute") { muted = !!m.on; if (cur) video.muted = muted || !cur.tracks.a; }
  });

  // Mantenerse en directo: arrancar en cuanto haya datos, no acumular retraso y
  // no guardar más búfer del necesario (la memoria de la tele es escasa).
  // Colchón objetivo (s): pequeño, y crece solo si el vídeo se queda sin datos
  // (llegan a tirones); con el tiempo vuelve a bajar.
  let target = 0.1, lastStall = 0, ownSeek = 0;
  const lagHist = [];
  const note = (...e) => { if (cur) { cur.log.push([Math.round(performance.now()), ...e]); if (cur.log.length > 200) cur.log.shift(); } };
  const seek = t => { ownSeek = performance.now(); note("seek", Math.round((t - video.currentTime) * 1000)); video.currentTime = t; };
  for (const ev of ["waiting", "stalled", "seeked", "ratechange"]) video.addEventListener(ev, () => note(ev, Math.round(video.currentTime * 1000)));
  video.addEventListener("waiting", () => {
    const s = cur;
    // Los saltos que hacemos nosotros también avisan "waiting": esos no cuentan.
    if (!s || !s.started || performance.now() - ownSeek < 1000) return;
    s.stalls = (s.stalls || 0) + 1;
    target = Math.min(0.35, target + 0.04);
    lastStall = performance.now();
  });
  const keeper = setInterval(() => {
    const s = cur;
    if (!s) return;
    // El móvil ha dejado de enviar (pantalla apagada, página recargada…): soltar
    // el modo nativo para volver a aceptar la conexión normal.
    if (performance.now() - s.lastSegAt > 5000) { teardown(); if (opts.onStop) opts.onStop(); return; }
    const r = bufEnd();
    if (!r) return;
    if (!s.started) {
      s.started = true;
      seek(Math.max(r.start, r.end - target));
      video.play().catch(e => { s.err = "play: " + e; });
      return;
    }
    const now = performance.now();
    if (now - lastStall > 10000 && target > 0.08) { target = Math.max(0.08, target - 0.01); lastStall = now - 9000; }
    const lag = r.end - video.currentTime;
    lagHist.push(lag);
    if (lagHist.length > 10) lagHist.shift();
    const minLag = Math.min(...lagHist);
    if (video.currentTime < r.start - 0.01) {
      seek(r.start);
    } else if ((lag > 1.5 || (lagHist.length >= 10 && minLag > target + 0.5)) && !s.wantJump) {
      // Muy por detrás: pedir imagen clave y saltar a ella cuando llegue.
      s.wantJump = true;
      transport.send({ t: "key" });
      setTimeout(() => { s.wantJump = false; }, 3000);
    } else {
      // Un poco por detrás: alcanzar el directo acelerando un poco (el audio va
      // adelantado, así que no se queda sin datos), sin saltos ni cortes.
      // Con el mínimo del último segundo: el retraso instantáneo sube y baja con
      // cada imagen que llega y haría oscilar la velocidad.
      const want = opts.noRate ? 1 : minLag > target + 0.06 ? Math.min(1.1, 1 + (minLag - target) * 0.5) : minLag < target + 0.02 ? 1 : video.playbackRate;
      if (Math.abs(video.playbackRate - want) > 0.01) { video.playbackRate = want; s.rateChanges = (s.rateChanges || 0) + 1; }
    }
    s.target = target;

    if (video.paused) video.play().catch(() => {});
    for (const tr of Object.values(s.tracks)) {
      const b = tr.sb.buffered;
      // Borrar lo ya visto de tarde en tarde (borrar mientras suena puede dar un
      // tirón): al pasar de 30 s, se dejan los últimos 10.
      if (!tr.sb.updating && b.length && video.currentTime - b.start(0) > 30) {
        try { tr.sb.remove(0, video.currentTime - 10); note("remove", tr.k); } catch (e) { /* luego */ }
      }
    }
  }, 100);

  // Botones del mando de la tele: al momento.
  let lastKeys = 0;
  const keysIv = setInterval(() => {
    const k = opts.getKeys ? opts.getKeys() : 0;
    if (k !== lastKeys && cur) { lastKeys = k; transport.send({ t: "keys", k }); }
  }, 16);

  // Estadísticas para el móvil (y para la telemetría).
  const statsIv = setInterval(() => {
    const s = cur;
    if (!s) return;
    const now = performance.now();
    const shown = (presented - lastShown) / ((now - lastShownT) / 1000);
    lastShown = presented; lastShownT = now;
    const r = bufEnd();
    const q = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : {};
    const ends = {};
    const qs = {}, segs = {};
    for (const [k, tr] of Object.entries(s.tracks)) {
      const b = tr.sb && tr.sb.buffered;
      ends[k] = b && b.length ? Math.round((b.end(b.length - 1) - tr.extra) * 1000) : null;
      qs[k] = tr.queue.length;
      segs[k] = tr.segs || 0;
    }
    const st = {
      t: "stats", id: s.id, shown: Math.round(shown * 10) / 10,
      lag: r ? Math.round((r.end - video.currentTime) * 1000) : null,
      dropped: q.droppedVideoFrames, rs: video.readyState, paused: video.paused, muted: video.muted,
      res: [video.videoWidth, video.videoHeight], jumps: s.jumps, drops: s.drops || 0, stalls: s.stalls || 0, target: Math.round(target * 1000), rate: Math.round(video.playbackRate * 100) / 100, rateChanges: s.rateChanges || 0,
      err: s.err || (video.error ? "media " + video.error.code + " " + video.error.message : undefined),
      keys: opts.getKeys ? opts.getKeys() : 0, ends, ct: Math.round(video.currentTime * 1000), qs, segs, ranges: s.tracks.v && s.tracks.v.sb ? s.tracks.v.sb.buffered.length : 0,
    };
    transport.send(st);
    if (opts.onStats) opts.onStats(st);
  }, 1000);

  return {
    get presented() { return presented; },
    get active() { return !!cur; },
    get state() { return cur; },
    stop() { teardown(); clearInterval(keeper); clearInterval(statsIv); clearInterval(keysIv); },
  };
}

// ---------------------------------------------------------------- móvil

// Elige códecs según lo que admite la tele y lo que sabe codificar este móvil.
// Con codificador por hardware, a la resolución pedida; si solo lo hay por
// software (gasta la misma CPU que necesita el emulador), a 640×480.
export async function pickCodecs(tvSupport, { width, height, fps, kbps }) {
  const venc = typeof VideoEncoder !== "undefined" ? VideoEncoder : null;
  const aenc = typeof AudioEncoder !== "undefined" ? AudioEncoder : null;
  let video = null, audio = null;
  const tryV = async (codec, kind, w, h, extra = {}) => {
    if (!venc) return false;
    try {
      const cfg = { codec, width: w, height: h, bitrate: kbps * 1000, framerate: fps, latencyMode: "realtime", ...extra };
      const r = await venc.isConfigSupported(cfg);
      if (r.supported) { video = { kind, codecString: codec, cfg, width: w, height: h, hw: extra.hardwareAcceleration === "prefer-hardware" }; return true; }
    } catch (e) { /* no */ }
    return false;
  };
  const avc = { avc: { format: "avc" } };
  const candidates = [
    tvSupport.h264main && ["avc1.4D401F", "avc1", avc],
    tvSupport.h264 && ["avc1.42E01F", "avc1", avc],
    tvSupport.vp9 && ["vp09.00.10.08", "vp09", {}],
  ].filter(Boolean);
  for (const [codec, kind, extra] of candidates) {
    if (await tryV(codec, kind, width, height, { ...extra, hardwareAcceleration: "prefer-hardware" })) break;
  }
  const swH = Math.min(height, 480), swW = Math.round(swH * width / height / 16) * 16;
  for (const [codec, kind, extra] of video ? [] : candidates) {
    if (await tryV(codec, kind, swW, swH, extra)) break;
  }
  const tryA = async (codec, kind) => {
    if (!aenc) return false;
    try {
      const cfg = { codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 }; // se reajusta al audio real
      const r = await aenc.isConfigSupported(cfg);
      if (r.supported) { audio = { kind, cfg }; return true; }
    } catch (e) { /* no */ }
    return false;
  };
  if (tvSupport.aac) await tryA("mp4a.40.2", "mp4a");
  if (!audio && tvSupport.opus) await tryA("opus", "opus");
  return { video, audio };
}

// Envía un lienzo (y una pista de audio) a la tele.
// opts: { getCanvas(), audioTrack, transport, codecs, width, height, fps, kbps, onStats(tv, stats), onTvKeys(mask) }
export function startNativeSender(opts) {
  const { transport, codecs } = opts;
  const width = opts.width, height = opts.height;
  let fps = opts.fps || 30;
  let kbps = opts.kbps || 3000;
  let stopped = false;
  let needKey = true;
  let vSeq = 0, aSeq = 0;
  let pending = 0;          // mensajes enviados sin confirmar (control de flujo)
  const id = Math.random().toString(36).slice(2, 8);
  const stats = { id, sentFrames: 0, dropped: 0, flowDrops: 0, bytes: 0, encMs: 0, msgs: 0, codec: codecs.video.codecString, audio: codecs.audio ? codecs.audio.kind : null };
  let t0 = null;            // origen común de tiempos (µs de performance.now)
  let vInit = null, aInit = null, started = false;
  const nowUs = () => performance.now() * 1000;

  const send = obj => {
    stats.msgs++;
    let p;
    try { p = transport.send(obj); } catch (e) { stats.sendErr = String(e); return; }
    if (p && p.then) { pending++; p.then(() => pending--, e => { pending--; stats.sendErr = String(e && e.message || e); }); }
  };
  const sendBytes = (k, n, bytes, extra) => {
    const of = Math.ceil(bytes.length / CHUNK);
    for (let i = 0; i < of; i++) send({ t: "seg", id, k, n, i, of, ...extra, d: toB64(bytes.subarray(i * CHUNK, (i + 1) * CHUNK)) });
    stats.bytes += bytes.length;
    stats["n" + k] = (stats["n" + k] || 0) + 1;
  };
  // El "start" sale cuando están los segmentos de inicio de vídeo y de audio (o
  // solo vídeo si el audio no llega en 1,5 s).
  const audioWanted = !!(codecs.audio && opts.audioTrack);
  const audioLeadUs = (opts.audioLeadMs ?? 220) * 1000;
  const firstVideoAt = { t: 0 };
  const maybeStart = () => {
    if (started || !vInit) return;
    if (audioWanted && !aInit && performance.now() - firstVideoAt.t < 1500) return;
    started = true;
    stats.withAudio = !!aInit;
    send({ t: "start", id, v: vInit, a: aInit });
    needKey = true;
  };

  // ---- vídeo
  let videoTrack = null;
  const venc = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta && meta.decoderConfig && !videoTrack) {
        videoTrack = {
          id: 1, kind: "video", codec: codecs.video.kind, codecString: codecs.video.codecString, timescale: 90000,
          width, height, description: meta.decoderConfig.description ? new Uint8Array(meta.decoderConfig.description) : null,
        };
        vInit = { mime: mimeFor(videoTrack), d: toB64(initSegment(videoTrack)) };
        firstVideoAt.t = performance.now();
        maybeStart();
      }
      if (!videoTrack || !started) return;
      if (!stats.firstKeySent) { if (chunk.type !== "key") return; stats.firstKeySent = true; }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      const t90 = Math.round(chunk.timestamp * 0.09);
      stats.vTs = Math.round(chunk.timestamp / 1000);
      stats.nowTs = Math.round(nowUs() - t0) / 1000 | 0;
      const dur = Math.round((chunk.duration || 1e6 / fps) * 0.09); // ver durFor()
      const key = chunk.type === "key";
      // vd: duración declarada (la tele la descuenta al medir su retraso).
      sendBytes("v", ++vSeq, fragment(videoTrack, vSeq, t90, [{ data, duration: dur, key }]), key ? { key: 1, ts: t90 / 90000, vd: dur / 90000 } : { vd: dur / 90000 });
      stats.sentFrames++;
    },
    error: e => { stats.err = String(e); },
  });
  const configure = () => venc.configure({ ...codecs.video.cfg, width, height, framerate: fps, bitrate: kbps * 1000 });
  configure();

  const encodeFrame = src => {
    const key = needKey || stats.sentFrames % (fps * 4) === 0;
    const tEnc = performance.now();
    venc.encode(src, { keyFrame: key });
    stats.encMs = Math.round((performance.now() - tEnc) * 10) / 10;
    if (key) needKey = false;
    lastVideoAt = performance.now();
  };
  // Duración declarada de cada imagen: algo más que el ritmo real (media de los
  // huecos × 1,5). El reproductor da por cortado el vídeo, y tira todo hasta la
  // siguiente imagen clave, si entre dos imágenes pasa más del doble de la
  // duración declarada de la anterior, y el emulador no entrega las imágenes con
  // regularidad perfecta. Si aun así llega un hueco mayor, esa imagen sale como
  // imagen clave y no se pierde nada. (Declarar mucho más, p. ej. 0,3 s, hace que
  // Chrome pinte menos imágenes de las que recibe.)
  let gapEma = 1e6 / fps, lastDur = 1e6 / fps;
  const durFor = ts => {
    if (lastTs >= 0) {
      const gap = ts - lastTs;
      if (gap > lastDur * 1.9) { needKey = true; stats.gapKeys = (stats.gapKeys || 0) + 1; }
      gapEma = gapEma * 0.9 + Math.min(gap, 200000) * 0.1;
    }
    lastTs = ts;
    lastDur = Math.round(Math.min(150000, Math.max(1e6 / fps, gapEma * 1.5)));
    return lastDur;
  };
  // Si el lienzo no cambia (pausa, pantalla fija) no da fotogramas y la tele se
  // quedaría sin vídeo; si el emulador da un tirón, el hueco cortaría el vídeo:
  // en ambos casos se repite la última imagen.
  let lastSrc = null, lastVideoAt = performance.now();
  const vPacer = setInterval(() => {
    if (stopped || !lastSrc || !started || venc.encodeQueueSize > 2) return;
    if (performance.now() - lastVideoAt < Math.max(60, lastDur / 1000 * 1.4)) return;
    const ts = nowUs() - t0;
    const f = new VideoFrame(lastSrc, { timestamp: ts, duration: durFor(ts) });
    encodeFrame(f);
    f.close();
    stats.repeats = (stats.repeats || 0) + 1;
  }, 20);

  // Fotogramas del lienzo: un procesador de pistas los entrega sin bloquear la página.
  let canvas = null, capTrack = null, reader = null;
  let lastTs = -1, scaler = null, vOff = null;
  const openCapture = () => {
    canvas = opts.getCanvas();
    if (!canvas) return false;
    if (capTrack) { try { reader.cancel(); capTrack.stop(); } catch (e) { /* ya parado */ } }
    capTrack = canvas.captureStream(fps).getVideoTracks()[0];
    reader = new MediaStreamTrackProcessor({ track: capTrack }).readable.getReader();
    vOff = null;
    return true;
  };
  (async () => {
    while (!stopped) {
      if (!reader || opts.getCanvas() !== canvas) {
        if (!openCapture()) { await new Promise(r => setTimeout(r, 300)); continue; }
      }
      const myReader = reader;
      const { value: frame, done } = await myReader.read();
      if (done) { if (myReader === reader) reader = null; continue; }
      if (stopped) { frame.close(); break; }
      stats.framesIn = (stats.framesIn || 0) + 1;
      // fps objetivo, cola del codificador y control de flujo: si algo se atasca,
      // se descarta la imagen en lugar de acumular retraso.
      const now = nowUs();
      if (t0 == null) t0 = now;
      if (vOff == null) vOff = now - frame.timestamp;
      const ts = frame.timestamp + vOff - t0;
      const minGap = 1e6 / fps * 0.85;
      if (lastTs >= 0 && ts - lastTs < minGap) { frame.close(); continue; }
      if (venc.encodeQueueSize > 2) { frame.close(); stats.dropped++; continue; }
      if (pending > 40) { frame.close(); stats.flowDrops++; needKey = true; continue; }
      const dur = durFor(ts);
      let src;
      if (frame.displayWidth !== width || frame.displayHeight !== height) {
        // Reescalar (en la GPU) al tamaño del codificador.
        scaler = scaler || new OffscreenCanvas(width, height);
        const g = scaler.getContext("2d");
        g.drawImage(frame, 0, 0, width, height);
        src = new VideoFrame(scaler, { timestamp: ts, duration: dur });
      } else {
        src = new VideoFrame(frame, { timestamp: ts, duration: dur });
      }
      frame.close();
      encodeFrame(src);
      if (lastSrc) lastSrc.close();
      lastSrc = src; // se guarda para repetirla si el lienzo deja de cambiar
    }
  })().catch(e => { stats.err = String(e); });

  // ---- audio (se configura con la frecuencia que llegue: 44,1 o 48 kHz)
  // El reloj del audio del emulador no es exactamente el de la pared (y si el
  // emulador va lento, o el audio se para, llega menos audio del que toca). La
  // tele reproduce al ritmo de su reloj, así que el audio se reestampa seguido y
  // se ata al reloj de pared: si falta, se rellena con silencio; si sobra, se tira.
  let aenc = null, aReader = null, aPacer = null;
  if (audioWanted) {
    let rate = 0, chans = 0, audioTrackInfo = null;
    let aPos = null, outPos = null; // µs en la línea común: próxima muestra que entra / que sale
    const batch = [];
    const wall = () => nowUs() - t0 + audioLeadUs;
    const makeEncoder = () => new AudioEncoder({
      output: (chunk, meta) => {
        if (!audioTrackInfo) {
          const desc = meta && meta.decoderConfig && meta.decoderConfig.description ? new Uint8Array(meta.decoderConfig.description) : null;
          if (codecs.audio.kind === "mp4a" && !desc) return;
          audioTrackInfo = { id: 1, kind: "audio", codec: codecs.audio.kind, timescale: rate, sampleRate: rate, channels: chans, description: desc };
          aInit = { mime: mimeFor(audioTrackInfo), d: toB64(initSegment(audioTrackInfo)) };
          maybeStart();
        }
        // El audio va adelantado en la línea de tiempo (audioLeadUs): el reproductor
        // necesita ~0,2 s de audio por delante para no pararse, y así el vídeo puede
        // ir casi en directo (el sonido llega ese poco más tarde que la imagen).
        const ts = outPos;
        outPos += chunk.duration || 0;
        if (!started || !stats.withAudio || ts < 0) return;
        stats.aTs = Math.round(ts / 1000);
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        const k = rate / 1e6;
        batch.push({ data, t: Math.round(ts * k), duration: Math.max(1, Math.round((chunk.duration || 0) * k)), key: true });
        // ~60 ms por mensaje: pocos mensajes (el audio va adelantado, no añade retraso).
        if (batch.reduce((a, s) => a + s.duration, 0) >= rate * 0.06) {
          const samples = batch.splice(0, batch.length);
          sendBytes("a", ++aSeq, fragment(audioTrackInfo, aSeq, samples[0].t, samples));
        }
      },
      error: e => { stats.aErr = String(e); },
    });
    const encodePlanes = (planes, n) => {
      const data = new Float32Array(n * chans);
      for (let c = 0; c < chans; c++) data.set(planes[c] || planes[0], c * n);
      const ad = new AudioData({ format: "f32-planar", sampleRate: rate, numberOfFrames: n, numberOfChannels: chans, timestamp: Math.round(aPos), data });
      aenc.encode(ad);
      ad.close();
      aPos += n / rate * 1e6;
    };
    const catchUp = () => {
      if (!aenc || aPos == null || stopped) return;
      const behind = wall() - aPos;
      if (behind > 1e6) {
        // Hueco grande (página congelada…): saltar en vez de rellenar segundos.
        aPos += behind - 40000;
        outPos += behind - 40000;
        stats.aGaps = (stats.aGaps || 0) + 1;
      } else if (behind > 120000) {
        let n = Math.round((behind - 40000) / 1e6 * rate);
        const step = Math.round(rate / 50);
        const zero = new Float32Array(step);
        while (n > 0) { const k = Math.min(n, step); encodePlanes([k === step ? zero : new Float32Array(k)], k); n -= k; }
        stats.aFilled = (stats.aFilled || 0) + 1;
      }
    };
    aReader = new MediaStreamTrackProcessor({ track: opts.audioTrack }).readable.getReader();
    (async () => {
      while (!stopped) {
        const { value: data, done } = await aReader.read();
        if (done) break;
        if (stopped) { data.close(); break; }
        if (t0 == null) t0 = nowUs();
        if (!aenc) {
          rate = data.sampleRate;
          chans = Math.min(2, data.numberOfChannels);
          aenc = makeEncoder();
          aenc.configure({ ...codecs.audio.cfg, sampleRate: rate, numberOfChannels: chans });
          aPos = outPos = wall();
          aPacer = setInterval(catchUp, 50);
        }
        catchUp();
        if (aPos - wall() > 150000 || aenc.encodeQueueSize > 20) { data.close(); stats.aSkipped = (stats.aSkipped || 0) + 1; continue; }
        const n = data.numberOfFrames;
        const planes = [];
        try {
          for (let c = 0; c < chans; c++) {
            const p = new Float32Array(n);
            data.copyTo(p, { planeIndex: c, format: "f32-planar" });
            planes.push(p);
          }
        } catch (e) {
          stats.aErr = "copy: " + e;
          data.close();
          continue;
        }
        data.close();
        encodePlanes(planes, n);
      }
    })().catch(e => { stats.aErr = String(e); });
  }
  const startIv = setInterval(maybeStart, 200);

  transport.onMessage(m => {
    if (!m || stopped) return;
    if (m.t === "key") needKey = true;
    else if (m.t === "restart" && m.id === id && started) {
      // La tele soltó esta emisión: volver a mandar el inicio y una imagen clave.
      started = false;
      stats.firstKeySent = false;
      stats.restarts = (stats.restarts || 0) + 1;
      maybeStart();
    }
    else if (m.t === "keys") { if (opts.onTvKeys) opts.onTvKeys(m.k); }
    else if (m.t === "stats" && m.id === id) {
      stats.tv = m;
      stats.pending = pending;
      if (opts.onStats) opts.onStats(m, stats);
    }
  });

  return {
    stats,
    get pending() { return pending; },
    get kbps() { return kbps; },
    setBitrate(k) {
      kbps = k;
      try { configure(); needKey = true; } catch (e) { /* sigue igual */ }
    },
    mute(on) { send({ t: "mute", on }); },
    stop(tellTv = true) {
      if (stopped) return;
      stopped = true;
      clearInterval(startIv);
      clearInterval(vPacer);
      if (aPacer) clearInterval(aPacer);
      if (lastSrc) { lastSrc.close(); lastSrc = null; }
      if (tellTv) send({ t: "stop" });
      try { reader && reader.cancel(); } catch (e) { /* ya parado */ }
      try { capTrack && capTrack.stop(); } catch (e) { /* ya parado */ }
      try { venc.close(); } catch (e) { /* ya cerrado */ }
      try { aReader && aReader.cancel(); } catch (e) { /* ya parado */ }
      try { aenc && aenc.close(); } catch (e) { /* ya cerrado */ }
    },
  };
}

// ---------------------------------------------------------------- de principio a fin (móvil)

// Calidades del modo nativo: la resolución es fija (la tele escala por hardware);
// se ajusta el caudal según lo que la tele cuenta que pinta.
export const NATIVE_KBPS = [6000, 4500, 3500, 2500, 1800, 1200];
const NATIVE_START = 2;

// Saluda a la tele por `transport`; si contesta y hay códecs comunes, empieza a
// enviar. Devuelve el emisor (con .stats, .stop()…) o null si no es posible.
// opts: { getCanvas, getAudioTrack, onStatus(msg, ok), onTvKeys, width, height, fps, waitMs, report }
export async function startNative(transport, opts) {
  const report = opts.report || (() => {});
  const hello = await new Promise(resolve => {
    let done = false;
    transport.onMessage(m => { if (!done && m && m.t === "hello") { done = true; resolve(m); } });
    const ping = () => { if (!done) { try { transport.send({ t: "ping" }); } catch (e) { /* aún no */ } } };
    ping();
    const iv = setInterval(ping, 1000);
    setTimeout(() => { clearInterval(iv); if (!done) { done = true; resolve(null); } }, opts.waitMs || 15000);
  });
  if (!hello) { report("phone", "native-no-hello", {}); return null; }
  const width = opts.width || 960, height = opts.height || 720, fps = opts.fps || 30;
  let level = NATIVE_START;
  const codecs = await pickCodecs(hello.mse || {}, { width, height, fps, kbps: NATIVE_KBPS[level] });
  if (codecs.video && !codecs.video.hw) level = Math.max(level, 3); // 640×480: menos caudal
  report("phone", "native-hello", { mse: hello.mse, viewport: hello.viewport, tvV: hello.v, video: codecs.video && codecs.video.codecString, audio: codecs.audio && codecs.audio.kind });
  if (!codecs.video) return null;
  // Esperar a que el juego esté en marcha (lienzo) y, un poco, a su sonido.
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const alive = () => !opts.alive || opts.alive();
  while (alive() && !opts.getCanvas()) await sleep(300);
  for (let i = 0; i < 10 && alive() && opts.getAudioTrack && !opts.getAudioTrack(); i++) await sleep(200);
  if (!alive()) return null;
  const audioTrack = opts.getAudioTrack ? opts.getAudioTrack() : null;
  const sender = startNativeSender({
    getCanvas: opts.getCanvas, audioTrack, transport, codecs, width: codecs.video.width, height: codecs.video.height, fps, kbps: NATIVE_KBPS[level],
    onTvKeys: opts.onTvKeys, audioLeadMs: opts.audioLeadMs,
    onStats: (tv, st) => adapt(tv, st),
  });
  // Ajuste de caudal: baja si la tele no pinta lo que llega o se acumula retraso;
  // sube despacio si va holgada.
  let bad = 0, good = 0, lastChange = Date.now(), lastJumps = 0, lastDrops = 0, ticks = 0;
  let lastSent = 0, lastAt = Date.now();
  const adapt = (tv, st) => {
    ticks++;
    sender.lastTvStatsAt = Date.now();
    const jumps = (tv.jumps || 0) - lastJumps, drops = (tv.drops || 0) - lastDrops;
    lastJumps = tv.jumps || 0; lastDrops = tv.drops || 0;
    // La tele se juzga por lo que recibe (si el emulador va a 20 fps, no es culpa suya).
    const sentFps = (st.sentFrames - lastSent) / Math.max(0.5, (Date.now() - lastAt) / 1000);
    lastSent = st.sentFrames; lastAt = Date.now();
    st.sentFps = Math.round(sentFps * 10) / 10;
    const struggling = tv.shown < Math.min(fps, sentFps) * 0.8 || jumps > 0 || drops > 0 || st.pending > 20;
    if (struggling) { bad++; good = 0; } else { good++; bad = 0; }
    const since = Date.now() - lastChange;
    if (bad >= 3 && level < NATIVE_KBPS.length - 1 && since > 4000) {
      level++; bad = 0; lastChange = Date.now();
      sender.setBitrate(NATIVE_KBPS[level]);
    } else if (good >= 20 && level > 0 && since > 20000) {
      level--; good = 0; lastChange = Date.now();
      sender.setBitrate(NATIVE_KBPS[level]);
    }
    if (ticks % 20 === 5) {
      report("phone", "native-tick", { level, kbps: NATIVE_KBPS[level], sent: st.sentFrames, dropped: st.dropped, flowDrops: st.flowDrops, pending: st.pending, msgs: st.msgs, enc: st.encMs, err: st.err, aErr: st.aErr, sendErr: st.sendErr, withAudio: st.withAudio, sentFps: st.sentFps, hw: codecs.video.hw, nv: st.nv, na: st.na, repeats: st.repeats, aFilled: st.aFilled, aSkipped: st.aSkipped, vTs: st.vTs, aTs: st.aTs, nowTs: st.nowTs, tv: { ...tv, t: undefined } });
    }
    if (opts.onStatus) opts.onStatus(`En la tele ✓ · directo ${codecs.video.height}p · ${Math.round(tv.shown)} fps · ${Math.round(NATIVE_KBPS[level] / 100) / 10} Mbps`, true);
  };
  sender.hello = hello;
  sender.lastTvStatsAt = Date.now();
  Object.defineProperty(sender, "level", { get: () => level });
  return sender;
}
