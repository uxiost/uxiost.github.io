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

import { fromB64 } from "./fmp4.js?v=24";


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
  // (opts.noRvfc: el laboratorio simula una tele con plano de vídeo por hardware.)
  if (video.requestVideoFrameCallback && !opts.noRvfc) video.requestVideoFrameCallback(counter);

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
      // Búfer lleno o error: vaciar lo pendiente, liberar lo ya visto y esperar
      // una imagen clave.
      if (e && e.name === "QuotaExceededError") tr.full = true;
      tr.queue.length = 0;
      if (tr.k === "v") { s.waitKey = true; transport.send({ t: "key" }); }
    }
  };

  let lastRestartAsk = 0, selfRestarts = 0;
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
    // ¿Se perdió algo? (un mensaje que el Chromecast no entregó): en vídeo, lo que
    // venga después no se puede decodificar hasta la próxima imagen clave.
    const lost = () => {
      s.lost = (s.lost || 0) + 1;
      if (m.k === "v") { s.waitKey = true; transport.send({ t: "key" }); }
    };
    if (tr.lastN != null && m.n > tr.lastN + 1) lost();
    for (const pid of Object.keys(parts)) {
      // Trozos de una imagen anterior que ya no van a completarse.
      if (pid[0] === m.k && Number(pid.slice(1)) < m.n - 2) { delete parts[pid]; lost(); }
    }
    if (tr.lastN == null || m.n > tr.lastN) tr.lastN = m.n;
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
  let target = 0.1, lastStall = 0, ownSeek = 0, lastSeeked = 0;
  const lagHist = [];
  const note = (...e) => { if (cur) { cur.log.push([Math.round(performance.now()), ...e]); if (cur.log.length > 200) cur.log.shift(); } };
  const seek = t => { ownSeek = performance.now(); note("seek", Math.round((t - video.currentTime) * 1000)); video.currentTime = t; };
  for (const ev of ["waiting", "stalled", "seeked", "ratechange"]) video.addEventListener(ev, () => note(ev, Math.round(video.currentTime * 1000)));
  // En la LG real cada salto (currentTime = …) tarda ~1 s en completarse, con la
  // imagen parada: saltar para alcanzar el directo añade el mismo retraso que
  // quita, y se entraba en un bucle de saltos sin imagen. Mientras un salto se
  // asienta no se toca nada; para alcanzar el directo se acelera, y solo se salta
  // si se va muy por detrás.
  video.addEventListener("seeked", () => { lastSeeked = performance.now(); lagHist.length = 0; });
  const settling = () => video.seeking || performance.now() - Math.max(lastSeeked, ownSeek) < 1500;
  video.addEventListener("waiting", () => {
    const s = cur;
    // Los saltos que hacemos nosotros también avisan "waiting": esos no cuentan.
    if (!s || !s.started || video.seeking || performance.now() - ownSeek < 2500) return;
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
    if (settling()) { s.ctMovedAt = now; s.settles = (s.settles || 0) + 1; return; }
    // ¿Atascada? (la imagen no avanza aunque hay datos por delante): primero se
    // salta a la siguiente imagen clave; si sigue igual, se empieza de nuevo (el
    // móvil vuelve a mandar el inicio al ver que la tele pide "restart").
    if (Math.abs(video.currentTime - (s.lastCt ?? -1)) > 0.01) { s.lastCt = video.currentTime; s.ctMovedAt = now; s.stuck = 0; }
    else if (!video.paused && now - (s.ctMovedAt || now) > 2500 && r.end - video.currentTime > 0.5) {
      s.ctMovedAt = now;
      s.stuck = (s.stuck || 0) + 1;
      if (s.stuck === 1) { note("stuck-jump"); s.wantJump = true; transport.send({ t: "key" }); }
      else {
        note("stuck-restart");
        selfRestarts++;
        teardown();
        if (opts.onStop) opts.onStop();
        return;
      }
    }
    if (now - lastStall > 10000 && target > 0.08) { target = Math.max(0.08, target - 0.01); lastStall = now - 9000; }
    const lag = r.end - video.currentTime;
    lagHist.push(lag);
    if (lagHist.length > 30) lagHist.shift(); // 3 s: en la LG la posición se congela hasta ~1 s y luego salta (el reloj se actualiza a golpes): el mínimo de 3 s es el retraso de verdad
    const minLag = Math.min(...lagHist);
    if (video.currentTime < r.start - 0.01) {
      seek(r.start);
    } else if ((lag > 3 || (lagHist.length >= 10 && minLag > 2)) && !s.wantJump) {
      // Muy por detrás (p. ej. tras un corte de la red): pedir imagen clave y
      // saltar a ella cuando llegue.
      s.wantJump = true;
      transport.send({ t: "key" });
      setTimeout(() => { s.wantJump = false; }, 3000);
    } else {
      // Un poco por detrás: alcanzar el directo acelerando un poco (el audio va
      // adelantado, así que no se queda sin datos), sin saltos ni cortes.
      // Con el mínimo del último segundo: el retraso instantáneo sube y baja con
      // cada imagen que llega y haría oscilar la velocidad.
      const want = opts.noRate ? 1 : minLag > target + 0.06 ? Math.min(1.25, 1 + (minLag - target) * 0.5) : minLag < target + 0.02 ? 1 : video.playbackRate;
      if (Math.abs(video.playbackRate - want) > 0.01) { video.playbackRate = want; s.rateChanges = (s.rateChanges || 0) + 1; }
    }
    s.target = target;

    if (video.paused) video.play().catch(() => {});
    for (const tr of Object.values(s.tracks)) {
      const b = tr.sb.buffered;
      // Borrar lo ya visto de tarde en tarde (borrar mientras suena puede dar un
      // tirón): al pasar de 15 s, se dejan los últimos 5 (las teles tienen poca
      // memoria para esto).
      if (!tr.sb.updating && b.length && video.currentTime - b.start(0) > (tr.full ? 3 : 15)) {
        try { tr.sb.remove(0, video.currentTime - (tr.full ? 1 : 5)); tr.full = false; note("remove", tr.k); } catch (e) { /* luego */ }
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
  // Tres medidas de "se ve": imágenes pintadas (requestVideoFrameCallback),
  // imágenes decodificadas y avance de la reproducción. En muchas teles el vídeo
  // va por un plano de vídeo por hardware y el navegador no ve las imágenes
  // pintadas: ahí cuentan las otras dos.
  let lastDec = 0, lastCt = 0;
  const statsIv = setInterval(() => {
    const s = cur;
    if (!s) return;
    const now = performance.now();
    const dt = (now - lastShownT) / 1000;
    const shown = (presented - lastShown) / dt;
    lastShown = presented; lastShownT = now;
    const r = bufEnd();
    const q = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : {};
    // (La LG pone el contador a 0 durante los saltos: entonces no se cuenta.)
    const total = q.totalVideoFrames;
    const dec = total != null && total >= lastDec ? (total - lastDec) / dt : null;
    if (total || !lastDec) lastDec = total || 0;
    const adv = (video.currentTime - lastCt) / dt;
    lastCt = video.currentTime;
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
      dec: dec == null ? null : Math.round(dec * 10) / 10, adv: Math.round(adv * 100) / 100,
      lag: r ? Math.round((r.end - video.currentTime) * 1000) : null,
      dropped: q.droppedVideoFrames, rs: video.readyState, paused: video.paused, muted: video.muted,
      res: [video.videoWidth, video.videoHeight], jumps: s.jumps, drops: s.drops || 0, stalls: s.stalls || 0, lost: s.lost || 0, restarts: selfRestarts, target: Math.round(target * 1000), rate: Math.round(video.playbackRate * 100) / 100, rateChanges: s.rateChanges || 0,
      err: s.err || (video.error ? "media " + video.error.code + " " + video.error.message : undefined),
      keys: opts.getKeys ? opts.getKeys() : 0, ends, ct: Math.round(video.currentTime * 1000), qs, segs, ranges: s.tracks.v && s.tracks.v.sb ? s.tracks.v.sb.buffered.length : 0,
    };
    transport.send(st);
    if (opts.onStats) opts.onStats(st);
  }, 1000);

  const ranges = b => { const r = []; if (b) for (let i = 0; i < b.length; i++) r.push([Math.round(b.start(i) * 1000), Math.round(b.end(i) * 1000)]); return r; };
  return {
    get presented() { return presented; },
    get active() { return !!cur; },
    get state() { return cur; },
    // Todo el estado del reproductor, para mirar la tele desde otro equipo.
    dump() {
      const q = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : {};
      const s = cur;
      return {
        video: { rs: video.readyState, ns: video.networkState, paused: video.paused, ct: Math.round(video.currentTime * 1000), rate: video.playbackRate, muted: video.muted,
          res: [video.videoWidth, video.videoHeight], err: video.error && (video.error.code + " " + video.error.message), buffered: ranges(video.buffered),
          q: { total: q.totalVideoFrames, dropped: q.droppedVideoFrames, corrupted: q.corruptedVideoFrames } },
        target, presented, selfRestarts,
        s: s && { id: s.id, ms: s.ms.readyState, started: s.started, err: s.err, waitKey: s.waitKey, wantJump: s.wantJump, jumps: s.jumps, lost: s.lost, drops: s.drops, stalls: s.stalls, appended: s.appended,
          tracks: Object.fromEntries(Object.entries(s.tracks).map(([k, tr]) => [k, { mime: tr.mime, buffered: tr.sb ? ranges(tr.sb.buffered) : null, q: tr.queue.length, lastN: tr.lastN, segs: tr.segs, extra: tr.extra, full: tr.full, updating: tr.sb && tr.sb.updating }])),
          log: s.log.slice(-60) },
      };
    },
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

// Envía un lienzo (y una pista de audio) a la tele. Codificar y empaquetar va en
// un Worker (nativeworker.js → nativesender.js) para no quitarle hilo al
// emulador; aquí solo se capturan las imágenes y se pasan los mensajes.
// opts: { getCanvas(), audioTrack, transport, codecs, width, height, fps, kbps, audioLeadMs, onStats(tv, stats), onTvKeys(mask) }
export function startNativeSender(opts) {
  const { transport, codecs } = opts;
  const fps = opts.fps || 30;
  let kbps = opts.kbps || 3000;
  const id = Math.random().toString(36).slice(2, 8);
  const stats = { id, sentFrames: 0, msgs: 0, codec: codecs.video.codecString, audio: codecs.audio ? codecs.audio.kind : null };
  let stopped = false, pending = 0;
  const cfg = { id, codecs, width: opts.width, height: opts.height, fps, kbps, audioLeadMs: opts.audioLeadMs, audioWanted: !!opts.audioTrack };
  const vq = new URL(import.meta.url).search; // misma versión que este módulo

  const send = obj => {
    let p;
    try { p = transport.send(obj); } catch (e) { stats.sendErr = String(e); return; }
    if (p && p.then) {
      pending++;
      p.then(() => pending--, e => {
        pending--;
        stats.sendErr = String(e && e.message || e);
        if (obj.t === "seg") toSender({ t: "sendfail", k: obj.k, len: obj.d.length });
      });
    }
  };
  const onEmit = m => {
    if (m.t === "send") { if (!stopped) send(m.obj); }
    else if (m.t === "stats") Object.assign(stats, m.stats);
  };

  // En un Worker si se puede; si no (o si no se pueden pasar los flujos), aquí.
  let worker = null, local = null, localReady = null;
  const goLocal = () => {
    if (localReady) return localReady;
    if (worker) { worker.terminate(); worker = null; }
    stats.worker = false;
    localReady = import("./nativesender.js" + vq).then(({ createSender }) => { local = createSender(cfg, onEmit); });
    return localReady;
  };
  try {
    worker = new Worker(new URL("./nativeworker.js" + vq, import.meta.url), { type: "module" });
    worker.onmessage = e => onEmit(e.data);
    worker.onerror = e => { stats.err = "worker: " + (e.message || "error"); };
    worker.postMessage({ t: "config", cfg });
    stats.worker = true;
  } catch (e) {
    goLocal();
  }
  const toSender = m => {
    if (worker) worker.postMessage(m);
    else goLocal().then(() => local.message(m));
  };
  const sendStream = (kind, readable) => {
    if (worker) {
      try { worker.postMessage({ t: kind, readable }, [readable]); return; } catch (e) { stats.transferErr = String(e); }
    }
    goLocal().then(() => local[kind](readable));
  };

  // Imágenes del lienzo (si el emulador cambia de lienzo, se vuelve a capturar).
  let canvas = null, capTrack = null;
  const openCapture = () => {
    const c = opts.getCanvas();
    if (!c || c === canvas) return;
    canvas = c;
    if (capTrack) capTrack.stop();
    capTrack = c.captureStream().getVideoTracks()[0]; // sin límite de fps: el límite de Chrome se salta imágenes de un emulador irregular
    // Cola de unas pocas imágenes: si el hilo está ocupado con el emulador, no se pierden.
    sendStream("video", new MediaStreamTrackProcessor({ track: capTrack, maxBufferSize: 4 }).readable);
  };
  openCapture();
  const capIv = setInterval(() => { if (!stopped) openCapture(); }, 500);
  // Audio: una copia de la pista del juego (la original la sigue usando WebRTC).
  const audioClone = opts.audioTrack ? opts.audioTrack.clone() : null;
  if (audioClone) sendStream("audio", new MediaStreamTrackProcessor({ track: audioClone, maxBufferSize: 50 }).readable);
  // Control de flujo: el emisor deja de mandar imágenes si hay demasiados mensajes por confirmar.
  let lastPending = -1;
  const pendIv = setInterval(() => { if (pending !== lastPending) { lastPending = pending; toSender({ t: "pending", n: pending }); } }, 100);

  transport.onMessage(m => {
    if (!m || stopped) return;
    if (m.t === "key") toSender({ t: "key" });
    else if (m.t === "restart" && m.id === id) toSender({ t: "restart" });
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
    setBitrate(k) { kbps = k; toSender({ t: "bitrate", kbps: k }); },
    mute(on) { send({ t: "mute", on }); },
    // Vuelve a empezar en la tele (inicio + imagen clave) sin cortar el envío.
    restart() { stats.restarts = (stats.restarts || 0) + 1; toSender({ t: "restart" }); },
    stop(tellTv = true) {
      if (stopped) return;
      toSender({ t: "stop" });
      if (tellTv) send({ t: "stop" });
      stopped = true;
      clearInterval(capIv);
      clearInterval(pendIv);
      try { capTrack && capTrack.stop(); } catch (e) { /* ya parado */ }
      try { audioClone && audioClone.stop(); } catch (e) { /* ya parado */ }
      const w = worker;
      if (w) setTimeout(() => w.terminate(), 500);
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
// ¿La tele está mostrando el vídeo? (sirve aunque no pueda contar imágenes pintadas)
export function tvShowing(tv) {
  return !!tv && (tv.shown >= 3 || tv.dec >= 3 || (tv.adv >= 0.5 && tv.rs >= 2));
}
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
    // Lo que pinta la tele; si no lo puede medir (plano de vídeo por hardware), lo
    // que decodifica; si tampoco, solo cuentan saltos, descartes y la cola.
    const tvFps = tv.shown > 0 ? tv.shown : tv.dec > 0 ? tv.dec : null;
    const struggling = (tvFps != null && tvFps < Math.min(fps, sentFps) * 0.8) || jumps > 0 || drops > 0 || st.pending > 20;
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
    if (opts.onStatus) opts.onStatus(`En la tele ✓ · directo ${codecs.video.height}p${tvFps != null ? " · " + Math.round(tvFps) + " fps" : ""} · ${Math.round(NATIVE_KBPS[level] / 100) / 10} Mbps`, true);
  };
  sender.hello = hello;
  sender.lastTvStatsAt = Date.now();
  Object.defineProperty(sender, "level", { get: () => level });
  return sender;
}
