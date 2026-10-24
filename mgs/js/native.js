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

import { fromB64 } from "./fmp4.js?v=78";
import { openTunnelSender, tunnelReceiver } from "./tunnel.js?v=78";


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

// ---- modo ;wc: vídeo decodificado con WebCodecs y pintado en un lienzo
// MSE en la LG tiene un colchón mínimo de ~200 ms y cada salto para la imagen ~1 s.
// Con VideoDecoder cada imagen se pinta en cuanto se decodifica: sin colchón ni
// saltos. (El sonido sigue por MSE: es la única ruta que suena en la LG.)
function boxes(bytes, want) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let o = 0; o + 8 <= bytes.length;) {
    const size = dv.getUint32(o), type = String.fromCharCode(...bytes.subarray(o + 4, o + 8));
    if (type === want) return bytes.subarray(o + 8, o + size);
    if (size < 8) break;
    o += size;
  }
  return null;
}
function avcC(init) {
  for (let i = 4; i + 4 < init.length; i++) {
    if (init[i] === 0x61 && init[i + 1] === 0x76 && init[i + 2] === 0x63 && init[i + 3] === 0x43) { // "avcC"
      const size = new DataView(init.buffer, init.byteOffset).getUint32(i - 4);
      return init.slice(i + 4, i - 4 + size);
    }
  }
  return null;
}
// La LG rechaza H.264 con `description` (avcC): se le da en Annex B (cada NAL con
// código de inicio 00 00 00 01) y con SPS/PPS delante de cada imagen clave.
function avcParamSets(avcc) {
  const sets = [];
  let o = 5;
  const nSps = avcc[o++] & 31;
  for (let i = 0; i < nSps; i++) { const l = (avcc[o] << 8) | avcc[o + 1]; sets.push(avcc.subarray(o + 2, o + 2 + l)); o += 2 + l; }
  const nPps = avcc[o++];
  for (let i = 0; i < nPps; i++) { const l = (avcc[o] << 8) | avcc[o + 1]; sets.push(avcc.subarray(o + 2, o + 2 + l)); o += 2 + l; }
  return sets;
}
function toAnnexB(sample, prefix) {
  const out = [];
  let n = 0;
  const push = nal => { out.push(nal); n += 4 + nal.length; };
  for (const ps of prefix || []) push(ps);
  for (let o = 0; o + 4 <= sample.length;) {
    const l = ((sample[o] << 24) | (sample[o + 1] << 16) | (sample[o + 2] << 8) | sample[o + 3]) >>> 0;
    push(sample.subarray(o + 4, o + 4 + l));
    o += 4 + l;
  }
  const b = new Uint8Array(n);
  let w = 0;
  for (const nal of out) { b[w + 3] = 1; b.set(nal, w + 4); w += 4 + nal.length; }
  return b;
}
export const wcSupported = () => typeof VideoDecoder !== "undefined" && typeof EncodedVideoChunk !== "undefined";

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
    if (cur.wc) { try { cur.wc.dec.close(); } catch (e) { /* ya cerrado */ } }
    if (cur.aud) { clearInterval(cur.aud.iv); try { audioEl.pause(); audioEl.removeAttribute("src"); audioEl.load(); } catch (e) { /* nada */ } }
    canvas.hidden = true;
    try { video.pause(); } catch (e) { /* nada */ }
    try { URL.revokeObjectURL(video.src); } catch (e) { /* nada */ }
    video.removeAttribute("src");
    try { video.load(); } catch (e) { /* nada */ }
    cur = null;
  };

  // Lienzo para el modo ;wc, encima del <video> (que sigue sonando).
  const canvas = document.createElement("canvas");
  canvas.hidden = true;
  canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;object-fit:contain;background:#000;z-index:1";
  video.after(canvas);
  const g2 = canvas.getContext("2d", { alpha: false, desynchronized: true });
  let wcOut = 0;
  const startWc = (s, v) => {
    const init = fromB64(v.d);
    const codec = (v.mime.match(/codecs="([^"]+)"/) || [])[1];
    const w = { dec: null, waitKey: true, n: 0, sent: new Map(), latSum: 0, latN: 0, drops: 0, errs: 0 };
    w.dec = new VideoDecoder({
      output: frame => {
        const t0 = w.sent.get(frame.timestamp);
        if (t0 != null) { w.latSum += performance.now() - t0; w.latN++; w.sent.delete(frame.timestamp); }
        if (canvas.width !== frame.displayWidth) { canvas.width = frame.displayWidth; canvas.height = frame.displayHeight; }
        g2.drawImage(frame, 0, 0, canvas.width, canvas.height);
        frame.close();
        wcOut++;
        canvas.hidden = false;
      },
      error: e => { w.errs++; s.err = "wc: " + e; w.waitKey = true; transport.send({ t: "key" }); },
    });
    w.ps = avcParamSets(avcC(init));
    w.dec.configure({ codec, optimizeForLatency: true });
    s.wc = w;
  };
  // Modo img: se pinta siempre la última imagen recibida (si llegan más rápido de
  // lo que la tele las decodifica, se saltan las intermedias: nunca se acumula).
  const imgSeg = (s, bytes) => {
    const im = s.img;
    if (im.pending) im.drops++;
    im.pending = bytes;
    if (im.busy) return;
    im.busy = true;
    (async () => {
      while (im.pending && !s.dead) {
        const b = im.pending; im.pending = null;
        const t0 = performance.now();
        try {
          const bmp = await createImageBitmap(new Blob([b], { type: im.mime }));
          if (canvas.width !== bmp.width) { canvas.width = bmp.width; canvas.height = bmp.height; }
          g2.drawImage(bmp, 0, 0);
          bmp.close();
          wcOut++;
          canvas.hidden = false;
          im.decMs = Math.round((im.decMs * 0.9 + (performance.now() - t0) * 0.1) * 10) / 10;
        } catch (e) { s.err = "img: " + e; }
      }
      im.busy = false;
    })();
  };
  // Modo tiles: cada mensaje lleva la lista de bloques cambiados y un JPEG con ellos
  // en mosaico (ver codec/src/lib.rs). La tele lo decodifica con su decodificador
  // nativo y pega los bloques (por tramos seguidos) en su sitio. El orden importa:
  // si falta un mensaje, se pide una imagen entera y se espera a ella.
  const tilesSeg = (s, m, bytes) => {
    const t = s.tiles;
    if (t.lastN != null && m.n !== t.lastN + 1 && !m.key) { t.lost++; if (!t.waitKey) { t.waitKey = true; transport.send({ t: "key" }); } }
    t.lastN = m.n;
    if (t.waitKey && !m.key) return;
    if (m.key) { t.waitKey = false; t.queue.length = 0; }
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = dv.getUint16(0, true), aw = dv.getUint16(2, true), tw = dv.getUint16(4, true), th = dv.getUint16(6, true);
    const idx = new Uint16Array(n);
    for (let i = 0; i < n; i++) idx[i] = dv.getUint16(8 + 2 * i, true);
    const jpeg = bytes.subarray(8 + 2 * n);
    // Se decodifican en paralelo según llegan; se pintan en orden.
    t.queue.push({ n, aw, tw, th, idx, bmp: createImageBitmap(new Blob([jpeg], { type: "image/jpeg" })),
      size: bytes.length, c: m.c, e: m.e, s: m.s, at: m.at, f: m.f, pieces: m.of || 1, recv: epochNow() });
    // (Pegar bloques cuesta ~0,5 ms: aunque lleguen varios juntos tras un tirón de
    // la wifi se alcanza solo. Tirar y pedir una imagen entera solo si se acumula
    // más de ~0,6 s; con 6 se tiraba a menudo y se veía un salto.)
    if (t.queue.length > 20) { t.over++; t.queue.length = 0; t.waitKey = true; transport.send({ t: "key" }); return; }
    if (t.busy) return;
    t.busy = true;
    (async () => {
      while (t.queue.length && !s.dead) {
        const it = t.queue[0];
        let bmp;
        try { bmp = await it.bmp; } catch (e) { s.err = "tiles: " + e; t.queue.shift(); continue; }
        if (t.queue[0] !== it) { bmp.close(); continue; } // se vació la cola (imagen entera pedida)
        t.queue.shift();
        const d0 = performance.now();
        if (canvas.width !== it.tw * 16 || canvas.height !== it.th * 16) { canvas.width = it.tw * 16; canvas.height = it.th * 16; }
        // Tramos: bloques seguidos en el mosaico que también van seguidos en pantalla.
        for (let k = 0; k < it.n;) {
          const i = it.idx[k];
          let len = 1;
          while (k + len < it.n && (k + len) % it.aw !== 0 && it.idx[k + len] === i + len && (i + len) % it.tw !== 0) len++;
          g2.drawImage(bmp, (k % it.aw) * 16, Math.floor(k / it.aw) * 16, len * 16, 16, (i % it.tw) * 16, Math.floor(i / it.tw) * 16, len * 16, 16);
          k += len;
        }
        bmp.close();
        wcOut++;
        canvas.hidden = false;
        t.drawMs = Math.round((t.drawMs * 0.9 + (performance.now() - d0) * 0.1) * 10) / 10;
        // Retraso medido de esta imagen, por tramos (ms). Con el reloj común se pasa
        // la hora de captura del móvil al reloj de la tele.
        if (it.c != null && clockOff != null) {
          const tDec = performance.timeOrigin + d0, tDraw = epochNow();
          requestAnimationFrame(() => {
            const tPaint = epochNow(), cap = it.c + clockOff;
            // net = entrega (sale del móvil → llega a la página); tvIn = de llegar a la
            // página a estar en cola para decodificar (hilo principal de la tele ocupado).
            const arrive = it.at || it.recv;
            t.lat.push({ size: it.size, n: it.n, f: it.f, pieces: it.pieces, enc: it.e, queue: it.s - it.c - it.e, net: arrive - (it.s + clockOff), tvIn: it.recv - arrive, dec: tDec - it.recv,
              draw: tDraw - tDec, paint: tPaint - tDraw, total: tPaint - cap });
            if (t.lat.length > 600) t.lat.shift();
          });
        }
      }
      t.busy = false;
    })();
  };
  const wcSeg = (s, m, bytes) => {
    const w = s.wc;
    if (w.dec.state !== "configured") return;
    // Si la tele no da abasto, tirar hasta la próxima imagen clave en vez de
    // acumular retraso.
    if (w.dec.decodeQueueSize > 3 && !m.key) { w.drops++; if (!w.waitKey) { w.waitKey = true; transport.send({ t: "key" }); } return; }
    if (w.waitKey && !m.key) return;
    w.waitKey = false;
    const data = boxes(bytes, "mdat");
    if (!data) return;
    const ts = ++w.n * 33333;
    w.sent.set(ts, performance.now());
    if (w.sent.size > 120) w.sent.delete(w.sent.keys().next().value);
    try { w.dec.decode(new EncodedVideoChunk({ type: m.key ? "key" : "delta", timestamp: ts, data: toAnnexB(data, m.key ? w.ps : null) })); } catch (e) { w.errs++; s.err = "wc: " + e; w.waitKey = true; }
  };

  const audioEl = document.createElement("audio");
  const startSplitAudio = (s, a) => {
    const ms2 = new MediaSource();
    const au = s.aud = { ms: ms2, sb: null, queue: [fromB64(a.d)] };
    const pumpA = () => { if (s.dead || !au.sb || au.sb.updating || !au.queue.length) return; try { au.sb.appendBuffer(au.queue.shift()); } catch (e) { au.queue.length = 0; } };
    au.pump = pumpA;
    audioEl.src = URL.createObjectURL(ms2);
    audioEl.muted = muted;
    ms2.addEventListener("sourceopen", () => {
      try { ms2.duration = Infinity; } catch (e) { /* no */ }
      au.sb = ms2.addSourceBuffer(a.mime);
      au.sb.addEventListener("updateend", pumpA);
      pumpA();
    }, { once: true });
    // Mantener el sonido ~0,25 s por detrás de lo recibido.
    au.iv = setInterval(() => {
      const b = au.sb && au.sb.buffered;
      if (!b || !b.length || s.dead) return;
      const end = b.end(b.length - 1);
      if (audioEl.paused) { audioEl.currentTime = Math.max(b.start(b.length - 1), end - 0.25); audioEl.play().catch(() => {}); }
      else if (end - audioEl.currentTime > 0.8) audioEl.currentTime = end - 0.25;
      if (!au.sb.updating && audioEl.currentTime - b.start(0) > 60) { try { au.sb.remove(0, audioEl.currentTime - 20); } catch (e) { /* luego */ } }
    }, 500);
  };

  const start = m => {
    teardown();
    const ms = new MediaSource();
    const s = { id: m.id, ms, tracks: {}, started: false, jumps: 0, appended: 0, log: [], lastSegAt: performance.now() };
    const useWc = opts.wc && wcSupported() && m.v && /avc1/.test(m.v.mime);
    const useTiles = m.v && m.v.mime === "image/x-mgs-tiles";
    const useImg = m.v && /^image\//.test(m.v.mime);
    if (useTiles) s.tiles = { queue: [], busy: false, waitKey: true, lastN: null, lost: 0, over: 0, drawMs: 0, lat: [] };
    else if (useImg) s.img = { mime: m.v.mime, pending: null, busy: false, decMs: 0, drops: 0 };
    if (useTiles) s.img = { mime: "image/jpeg", tilesMode: true, decMs: 0, drops: 0 }; // (para que el resto lo trate como modo img: sonido aparte, sin búfer de vídeo)
    // ;split: el sonido en un <audio> aparte, para que el <video> lleve solo vídeo
    // en directo (prueba: ¿así Chromium usa su modo de poco retraso en la LG?).
    const split = opts.split && m.v && m.a && !useWc && !useImg;
    if (split) startSplitAudio(s, m.a);
    for (const k of ["v", "a"]) {
      if (m[k] && !(k === "v" && (useWc || useImg)) && !(k === "a" && split)) s.tracks[k] = { k, mime: m[k].mime, sb: null, queue: [{ bytes: fromB64(m[k].d) }], extra: k === "v" ? m.vDur || 0 : 0 };
    }
    if (useWc) startWc(s, m.v);
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
    if (!Object.keys(cur.tracks).length) return null; // modo img sin sonido: no hay búfer que vigilar
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
    if (m.k === "a" && s.aud) { s.aud.queue.push(fromB64(m.d)); s.aud.pump(); return; }
    const tr = s.tracks[m.k] || (m.k === "v" && (s.wc || s.img) ? (s.wcTr = s.wcTr || { k: "v", queue: [] }) : null);
    if (!tr) return;
    // ¿Se perdió algo? (un mensaje que el Chromecast no entregó): en vídeo, lo que
    // venga después no se puede decodificar hasta la próxima imagen clave.
    const lost = () => {
      s.lost = (s.lost || 0) + 1;
      if (m.k === "v") { s.waitKey = true; transport.send({ t: "key" }); }
    };
    if (tr.lastN != null && m.n > tr.lastN + 1 && !s.img) lost();
    for (const pid of Object.keys(parts)) {
      // Trozos de una imagen anterior que ya no van a completarse.
      if (pid[0] === m.k && Number(pid.slice(1)) < m.n - 2) { delete parts[pid]; lost(); }
    }
    if (tr.lastN == null || m.n > tr.lastN) tr.lastN = m.n;
    let bytes;
    if (m.of > 1) {
      const id = m.k + m.n;
      const p = parts[id] || (parts[id] = []);
      p[m.i] = m.bin || fromB64(m.d);
      if (p.filter(Boolean).length < m.of) return;
      delete parts[id];
      const len = p.reduce((a, b) => a + b.length, 0);
      bytes = new Uint8Array(len);
      let o = 0;
      for (const b of p) { bytes.set(b, o); o += b.length; }
    } else {
      bytes = m.bin || fromB64(m.d);
    }
    // Si se acumula cola (la tele no da abasto), tirar lo pendiente (salvo el
    // segmento de inicio si aún no entró) y pedir imagen clave: mejor saltar que
    // ir con retraso.
    if (tr.queue.length > 20) {
      tr.queue.length = tr.sb ? 0 : 1;
      if (m.k === "v") { s.waitKey = true; transport.send({ t: "key" }); }
      s.drops = (s.drops || 0) + 1;
    }
    if (m.k === "v" && s.wc) { s.lastSegAt = performance.now(); wcSeg(s, m, bytes); return; }
    if (m.k === "v" && s.tiles) { tilesSeg(s, m, bytes); return; }
    if (m.k === "v" && s.img) { if (m.n > (s.img.lastN || 0)) { s.img.lastN = m.n; imgSeg(s, bytes); } else s.img.late = (s.img.late || 0) + 1; return; }
    if (m.k === "v" && s.waitKey) {
      if (!m.key) return;       // sin la imagen clave, lo demás no se puede decodificar
      s.waitKey = false;
    }
    tr.segs = (tr.segs || 0) + 1;
    if (m.vd) tr.extra = m.vd;
    tr.queue.push({ bytes, key: !!m.key, ts: m.ts });
    if (m.key && m.ts != null) (tr.keyTs = tr.keyTs || []).push(m.ts);
    pump(s, tr);
  };

  const epochNow = () => performance.timeOrigin + performance.now();
  let clockOff = null, clockRtt = null;
  // Túnel WebRTC (js/tunnel.js): lo que llega por él entra igual que por Cast.
  const tun = typeof RTCPeerConnection !== "undefined" ? tunnelReceiver(transport, (head, bytes, at) => {
    if (head.t !== "seg") return;
    head.bin = bytes; head.at = at; head.tun = 1;
    onSeg(head);
  }) : null;
  transport.onMessage((m, meta) => {
    if (!m || !m.t) return;
    if (m.t === "clk") { transport.send({ t: "clkr", p: m.p, tv: epochNow() }); return; }
    // Prueba de entrega: hora de llegada (reloj de la tele) de cada mensaje de prueba.
    if (m.t === "bench") { transport.send({ t: "benchr", i: m.i, recv: epochNow(), len: m.d ? m.d.length : 0 }); return; }
    if (m.t === "off") { clockOff = m.off; clockRtt = m.rtt; return; }
    if (m.t === "start") start(m);
    else if (m.t === "seg") { if (meta && meta.at) m.at = meta.at; onSeg(m); }
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
  // (Un salto que no termina —p. ej. a un hueco del búfer— deja video.seeking
  // puesto para siempre: como mucho 3 s de espera.)
  const settling = () => (video.seeking && performance.now() - ownSeek < 3000) || performance.now() - Math.max(lastSeeked, ownSeek) < 1500;
  // Huecos en el búfer (el emulador se paró un momento y la línea de tiempo del
  // vídeo quedó con un agujero): la LG se queda esperando al final del trozo para
  // siempre. Si la posición está al final de un trozo y hay otro después, saltar.
  const gapAhead = () => {
    const b = video.buffered, t = video.currentTime;
    for (let i = 0; i < b.length - 1; i++) {
      if (t >= b.start(i) - 0.05 && t <= b.end(i) + 0.05 && b.end(i) - t < 0.25) return b.start(i + 1);
    }
    if (b.length && t < b.start(0) - 0.05) return b.start(0);
    return null;
  };
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
    const gap = gapAhead();
    if (gap != null && (video.readyState < 3 || now - (s.ctMovedAt || now) > 300)) {
      note("gap", Math.round((gap - video.currentTime) * 1000));
      s.gaps = (s.gaps || 0) + 1;
      seek(gap + 0.02);
      return;
    }
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
    // Modo img: el búfer solo lleva sonido (la imagen va aparte, sin búfer): colchón
    // de 250 ms y sin cambios de velocidad salvo que se vaya muy por detrás (en
    // la LG cambiar la velocidad del sonido se oye, y cada parada es un corte).
    const floor = s.img ? 0.25 : 0.08;
    if (target < floor) target = floor;
    if (now - lastStall > 10000 && target > floor) { target = Math.max(floor, target - 0.01); lastStall = now - 9000; }
    const lag = r.end - video.currentTime;
    // En la LG la posición se congela hasta ~1 s y luego salta (el reloj se
    // actualiza a golpes): solo vale el retraso medido justo cuando la posición
    // acaba de cambiar. Se guardan esos (con su hora) y se usa el mínimo de 3 s.
    if (video.currentTime !== s.lagCt) { s.lagCt = video.currentTime; lagHist.push([now, lag]); }
    while (lagHist.length && now - lagHist[0][0] > 3000) lagHist.shift();
    const minLag = lagHist.length ? Math.min(...lagHist.map(x => x[1])) : lag;
    // (Antes aquí: "si la posición está antes del inicio del búfer, saltar allí";
    // pero ese inicio era el del último trozo, y con un hueco pequeño en el búfer
    // saltaba 1-2 s hacia delante, con ~1 s de imagen parada en la LG. Los huecos
    // y el principio del búfer ya los resuelve gapAhead, saltando solo el hueco.)
    if (s.img && lagHist.length >= 5 && minLag > target + 0.8 && !s.wantJump) {
      // Modo img (solo sonido): muy por detrás (p. ej. al arrancar) → un salto, que
      // en sonido solo es un corte breve; acelerar al 1,02× tardaría un minuto.
      s.jumps++;
      seek(r.end - target);
    } else if ((lag > 3 || (lagHist.length >= 5 && minLag > 2)) && !s.wantJump) {
      // Muy por detrás (p. ej. tras un corte de la red): pedir imagen clave y
      // saltar a ella cuando llegue.
      s.wantJump = true;
      transport.send({ t: "key" });
      setTimeout(() => { s.wantJump = false; }, 3000);
    } else {
      // Un poco por detrás: alcanzar el directo acelerando un poco (el audio va
      // adelantado, así que no se queda sin datos), sin saltos ni cortes.
      // Con el mínimo del último segundo: el retraso instantáneo sube y baja con
      // cada imagen que llega y haría oscilar la velocidad. Como mucho 1,1× (a más
      // velocidad la LG tira imágenes); 1,25× solo si va más de 1 s por detrás.
      // Modo img (solo sonido en el búfer): 1,02× con histéresis (se queda acelerado
      // hasta alcanzar el objetivo): pocos cambios, que en la LG se oyen.
      const imgRate = s.img && !opts.noRate ? (minLag > target + 0.15 ? 1.02 : minLag < target + 0.03 ? 1 : video.playbackRate) : null;
      const want = imgRate != null ? imgRate : opts.noRate ? 1 : minLag > target + 0.06 ? Math.min(minLag > 1 ? 1.25 : 1.1, 1 + (minLag - target) * 0.5) : minLag < target + 0.02 ? 1 : video.playbackRate;
      if (Math.abs(video.playbackRate - want) > 0.01) { video.playbackRate = want; s.rateChanges = (s.rateChanges || 0) + 1; }
    }
    s.target = target;

    if (video.paused) video.play().catch(() => {});
    for (const tr of Object.values(s.tracks)) {
      const b = tr.sb.buffered;
      // Borrar lo ya visto de tarde en tarde (borrar mientras suena puede dar un
      // tirón): al pasar de 15 s, se dejan los últimos 5 (las teles tienen poca
      // memoria para esto).
      // En vídeo, solo hasta una imagen clave ya pasada: MSE borra también todo lo
      // que depende de lo borrado hasta la siguiente imagen clave, y con imágenes
      // clave cada 8 s eso se llevaba lo que se estaba viendo (salto de ~1 s).
      let upTo = video.currentTime - (tr.full ? 1 : 5);
      if (tr.k === "v") upTo = Math.max(0, ...(tr.keyTs || []).filter(t => t <= upTo));
      // (Solo sonido —modo img—: borrar de tarde en tarde, que cada borrado puede
      // dar un pequeño corte; 2 minutos de AAC son ~2 MB.)
      const keepS = s.img ? 120 : 15;
      if (!tr.sb.updating && b.length && video.currentTime - b.start(0) > (tr.full ? 3 : keepS) && upTo > b.start(0) + 0.5) {
        try { tr.sb.remove(0, upTo); tr.full = false; note("remove", tr.k); } catch (e) { /* luego */ }
        if (tr.keyTs) tr.keyTs = tr.keyTs.filter(t => t >= upTo);
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
  // Parones del hilo principal de la tele (recolector de basura, borrar búfer…):
  // mientras dura uno no se leen los mensajes de Cast y al móvil le dan "timeout".
  let loopMax = 0, loopAt = performance.now(), msgsIn = 0, bytesIn = 0;
  const loopIv = setInterval(() => { const n = performance.now(); loopMax = Math.max(loopMax, n - loopAt - 50); loopAt = n; }, 50);
  transport.onMessage(m => { if (m && m.t === "seg") { msgsIn++; bytesIn += m.d.length; } });
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
    const total = s.wc || s.img ? wcOut : q.totalVideoFrames;
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
      res: [video.videoWidth, video.videoHeight], jumps: s.jumps, drops: s.drops || 0, stalls: s.stalls || 0, lost: s.lost || 0, gaps: s.gaps || 0, restarts: selfRestarts, target: Math.round(target * 1000), rate: Math.round(video.playbackRate * 100) / 100, rateChanges: s.rateChanges || 0,
      err: s.err || (video.error ? "media " + video.error.code + " " + video.error.message : undefined),
      loop: Math.round(loopMax), mIn: msgsIn, kIn: Math.round(bytesIn / 1024),
      img: s.img ? { decMs: s.img.decMs, drops: s.img.drops, res: [canvas.width, canvas.height] } : undefined,
      tun: tun ? { ...tun.stats } : undefined,
      tiles: s.tiles ? { lost: s.tiles.lost, over: s.tiles.over, q: s.tiles.queue.length, drawMs: s.tiles.drawMs, lat: latSummary(s.tiles.lat.slice(-90)), clk: clockOff == null ? null : Math.round(clockRtt) } : undefined,
      wc: s.wc ? { lat: s.wc.latN ? Math.round(s.wc.latSum / s.wc.latN) : null, q: s.wc.dec.decodeQueueSize, drops: s.wc.drops, errs: s.wc.errs, st: s.wc.dec.state } : undefined,
      keys: opts.getKeys ? opts.getKeys() : 0, ends, ct: Math.round(video.currentTime * 1000), qs, segs, ranges: s.tracks.v && s.tracks.v.sb ? s.tracks.v.sb.buffered.length : 0,
    };
    loopMax = 0; msgsIn = 0; bytesIn = 0;
    transport.send(st);
    if (opts.onStats) opts.onStats(st);
  }, 1000);

  // Resumen del retraso por tramos: mediana y p90 (y máximo del total), separando
  // imágenes pequeñas (pocos bloques) de grandes (cámara en movimiento).
  const latSummary = arr => {
    if (!arr.length) return null;
    const q = (a, p) => { const v = a.slice().sort((x, y) => x - y); return Math.round(v[Math.min(v.length - 1, Math.floor(v.length * p))]); };
    const grp = a => {
      if (!a.length) return null;
      const o = { n: a.length };
      for (const k of ["enc", "queue", "net", "tvIn", "dec", "draw", "paint", "total"]) o[k] = [q(a.map(x => x[k]), 0.5), q(a.map(x => x[k]), 0.9)];
      o.max = Math.round(Math.max(...a.map(x => x.total)));
      return o;
    };
    return { all: grp(arr), small: grp(arr.filter(x => x.size < 8000)), big: grp(arr.filter(x => x.size >= 8000)) };
  };
  const ranges = b => { const r = []; if (b) for (let i = 0; i < b.length; i++) r.push([Math.round(b.start(i) * 1000), Math.round(b.end(i) * 1000)]); return r; };
  return {
    get presented() { return presented; },
    get active() { return !!cur; },
    get state() { return cur; },
    // Captura pequeña del lienzo (modos img/tiles), para ver desde otro equipo qué pinta.
    async snap(w = 320) {
      if (canvas.hidden || !canvas.width) return null;
      const c = new OffscreenCanvas(w, Math.round(w * canvas.height / canvas.width));
      c.getContext("2d").drawImage(canvas, 0, 0, c.width, c.height);
      const b = await c.convertToBlob({ type: "image/jpeg", quality: 0.7 });
      const u = new Uint8Array(await b.arrayBuffer());
      let s = "";
      for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192));
      return btoa(s);
    },
    // Todo el estado del reproductor, para mirar la tele desde otro equipo.
    dump() {
      const q = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : {};
      const s = cur;
      return {
        video: { rs: video.readyState, ns: video.networkState, paused: video.paused, ct: Math.round(video.currentTime * 1000), rate: video.playbackRate, muted: video.muted,
          res: [video.videoWidth, video.videoHeight], err: video.error && (video.error.code + " " + video.error.message), buffered: ranges(video.buffered),
          q: { total: q.totalVideoFrames, dropped: q.droppedVideoFrames, corrupted: q.corruptedVideoFrames } },
        target, presented, selfRestarts,
        lat: s && s.tiles ? { summary: latSummary(s.tiles.lat), last: s.tiles.lat.slice(-40) } : undefined, clockOff, clockRtt,
        s: s && { id: s.id, ms: s.ms.readyState, started: s.started, err: s.err, waitKey: s.waitKey, wantJump: s.wantJump, jumps: s.jumps, lost: s.lost, drops: s.drops, stalls: s.stalls, appended: s.appended,
          tracks: Object.fromEntries(Object.entries(s.tracks).map(([k, tr]) => [k, { mime: tr.mime, buffered: tr.sb ? ranges(tr.sb.buffered) : null, q: tr.queue.length, lastN: tr.lastN, segs: tr.segs, extra: tr.extra, full: tr.full, updating: tr.sb && tr.sb.updating }])),
          log: s.log.slice(-60) },
      };
    },
    stop() { teardown(); clearInterval(keeper); clearInterval(statsIv); clearInterval(keysIv); clearInterval(loopIv); },
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
  // Imágenes (WebP) a la resolución nativa de la PS1, si la tele las sabe pintar:
  // es lo de menos retraso en la LG (ver nativesender.js).
  if (tvSupport.tiles && tvSupport.mode !== "img" && typeof WebAssembly !== "undefined" && typeof OffscreenCanvas !== "undefined") {
    // Bloques (codificador propio en wasm): por defecto, a 640×480.
    const w = tvSupport.imgW || 640;
    video = { kind: "tiles", codecString: "image/x-mgs-tiles", width: w, height: Math.round(w * 3 / 4), hw: true };
  } else if (tvSupport.img && typeof OffscreenCanvas !== "undefined" && OffscreenCanvas.prototype.convertToBlob) {
    const w = tvSupport.imgW || 480;
    video = { kind: "img", codecString: tvSupport.imgType || "image/webp", width: w, height: Math.round(w * 3 / 4), hw: true };
  }
  const avc = { avc: { format: "avc" } };
  const candidates = [
    tvSupport.h264main && ["avc1.4D401F", "avc1", avc],
    tvSupport.h264 && ["avc1.42E01F", "avc1", avc],
    tvSupport.vp9 && ["vp09.00.10.08", "vp09", {}],
  ].filter(Boolean);
  for (const [codec, kind, extra] of video ? [] : candidates) {
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
  let stopped = false, pending = 0, failRun = 0;
  const cfg = { id, codecs, width: opts.width, height: opts.height, fps, kbps, audioLeadMs: opts.audioLeadMs, audioWanted: !!opts.audioTrack, stamp: !!opts.stamp };
  const vq = new URL(import.meta.url).search; // misma versión que este módulo

  // Ventana de envío (4: con 3 y confirmaciones de ~70 ms no pasaban de ~42 msg/s, justo lo que hace falta): como mucho WINDOW mensajes sin confirmar; el resto espera en
  // cola y sale según llegan las confirmaciones (~30 ms cada una en el Pixel). El
  // Cast del Pixel daba "timeout" a todos los trozos de una imagen clave cuando
  // salían de golpe (100-200 KB a la vez); uno detrás de otro llegan bien.
  // `pending` cuenta los de la cola y los que están en vuelo.
  // (8: con imágenes de ~50 KB al mover la cámara, 4 en vuelo —~10 Mbps medidos— se
  // quedaba corto y la cola crecía hasta 300 ms; con 8 el Pixel da ~21 Mbps sin fallos.)
  const WINDOW = 8, queue = [];
  let inFlight = 0;
  const pump = () => {
    while (inFlight < WINDOW && queue.length && !stopped) sendNow(queue.shift());
  };
  // Túnel WebRTC directo para el vídeo (si conecta; si no, todo sigue por Cast).
  const tunnel = opts.tunnel !== false ? openTunnelSender(transport) : null;
  const send = obj => {
    if (tunnel && tunnel.ready && obj.t === "seg" && obj.k === "v") {
      const { d, ...head } = obj;
      head.s = Math.round(epoch() * 10) / 10;
      head.f = -1; // (por el túnel: sin cola de Cast)
      tunnel.send(head, fromB64(d));
      stats.viaTunnel = (stats.viaTunnel || 0) + 1;
      return;
    }
    pending++; queue.push(obj); pump();
  };
  // (sendNow cuenta el mensaje en `pending` al salir; send ya lo contó al encolarlo.)
  const epoch = () => performance.timeOrigin + performance.now();
  const sendNow = obj => {
    if (obj.t === "seg" && obj.k === "v") { obj.s = Math.round(epoch() * 10) / 10; obj.f = inFlight; } // sale hacia la tele (y cuántos había por delante)
    let p;
    try { p = transport.send(obj); } catch (e) { pending--; stats.sendErr = String(e); return; }
    if (!(p && p.then)) { pending--; return; }
    inFlight++;
    {
      const t0 = performance.now();
      const done = () => { inFlight--; pending--; pump(); };
      p.then(() => {
        done();
        failRun = 0;
        const ms = performance.now() - t0;
        stats.ackMs = Math.round((stats.ackMs || ms) * 0.9 + ms * 0.1);
        stats.ackMax = Math.max(stats.ackMax || 0, Math.round(ms));
      }, e => {
        done();
        stats.sendErr = String(e && e.message || e);
        // Qué mensajes fallan (tipo, tamaño, cuánto tardó el error, cuántos había en vuelo).
        (stats.failLog = stats.failLog || []).push([obj.t, obj.k, obj.d ? obj.d.length : JSON.stringify(obj).length, Math.round(performance.now() - t0), pending]);
        if (stats.failLog.length > 12) stats.failLog.shift();
        // Todo falla y nada llega (la sesión de Cast se cerró): parar en vez de
        // seguir mandando miles de mensajes al vacío; el vigilante de console.js
        // ve el error y decide (reiniciar o pasar a WebRTC).
        if (++failRun >= 40 && !stats.err) stats.err = "sesión de Cast caída: " + stats.sendErr;
        if (obj.t === "seg") { stats.sendFails = (stats.sendFails || 0) + 1; toSender({ t: "sendfail", k: obj.k, len: obj.d.length, why: stats.sendErr }); }
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
    // El núcleo dibuja a la densidad de la pantalla (2520×1890 en el Pixel): que
    // Chrome entregue las imágenes ya reducidas (en la GPU) al doble de lo que se
    // envía, en vez de mover y reducir 5 millones de píxeles por imagen.
    // (Modo tiles: justo al tamaño de envío, para leer los píxeles sin reescalar en la CPU.)
    const k = codecs.video.kind === "tiles" ? 1 : 2;
    capTrack.applyConstraints({ width: { max: opts.width * k }, height: { max: opts.height * k } }).catch(e => { stats.capErr = String(e); });
    // Cola de unas pocas imágenes: si el hilo está ocupado con el emulador, no se pierden.
    // Modo tiles: cola de 1 = siempre la imagen más reciente (con 4, y el emulador
    // a 60 fps cuando enviamos 30, se procesaba la más vieja: hasta ~66 ms de más).
    sendStream("video", new MediaStreamTrackProcessor({ track: capTrack, maxBufferSize: codecs.video.kind === "tiles" ? 1 : 4 }).readable);
  };
  openCapture();
  // Vigilante: al cambiar el tamaño del lienzo Chrome deja de entregar imágenes de
  // la captura; si no llega ninguna en 2 s (y el juego sigue), volver a capturar.
  let lastIn = -1, lastInAt = performance.now();
  const capIv = setInterval(() => {
    if (stopped) return;
    if (stats.framesIn !== lastIn) { lastIn = stats.framesIn; lastInAt = performance.now(); }
    else if (performance.now() - lastInAt > 2000 && canvas) { stats.recaptures = (stats.recaptures || 0) + 1; canvas = null; lastInAt = performance.now(); }
    openCapture();
  }, 500);
  // Audio: una copia de la pista del juego (la original la sigue usando WebRTC).
  const audioClone = opts.audioTrack ? opts.audioTrack.clone() : null;
  if (audioClone) sendStream("audio", new MediaStreamTrackProcessor({ track: audioClone, maxBufferSize: 50 }).readable);
  // Control de flujo: el emisor deja de mandar imágenes si hay demasiados mensajes por confirmar.
  let lastPending = -1;
  const pendIv = setInterval(() => { if (pending !== lastPending) { lastPending = pending; toSender({ t: "pending", n: pending }); } }, 100);

  // Reloj común con la tele (para medir el retraso de punta a punta): ida y vuelta
  // cada segundo; vale la muestra con menos ida y vuelta de las últimas 10.
  const clk = [];
  const clkIv = setInterval(() => { if (!stopped) try { transport.send({ t: "clk", p: epoch() }); } catch (e) { /* luego */ } }, 1000);
  transport.onMessage(m => {
    if (!m || stopped) return;
    if (m.t === "clkr") {
      const now = epoch(), rtt = now - m.p;
      clk.push({ rtt, off: m.tv - (m.p + rtt / 2) });
      if (clk.length > 10) clk.shift();
      const best = clk.reduce((a, b) => (b.rtt < a.rtt ? b : a));
      stats.clock = { off: Math.round(best.off), rtt: Math.round(best.rtt) };
      if (tunnel) stats.tunnel = { ...tunnel.stats };
      try { transport.send({ t: "off", off: best.off, rtt: best.rtt }); } catch (e) { /* luego */ }
      return;
    }
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
      if (tellTv) { pending++; sendNow({ t: "stop" }); }
      stopped = true;
      clearInterval(capIv);
      clearInterval(pendIv);
      clearInterval(clkIv);
      if (tunnel) tunnel.close();
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
    // (Solo la tele de nuestra versión: al abrirla, la página anterior aún puede
    // contestar un momento antes de irse.)
    const mine = typeof window !== "undefined" && /^\d+$/.test(window.MGS_BUILD || "") ? Number(window.MGS_BUILD) : null;
    // (Si tras 3 s solo contesta otra versión, se acepta: mejor eso que quedarse colgado.)
    const t0 = Date.now();
    transport.onMessage(m => { if (!done && m && m.t === "hello" && (mine == null || m.v == null || m.v === mine || Date.now() - t0 > 3000)) { done = true; resolve(m); } });
    const ping = () => { if (!done) { try { transport.send({ t: "ping" }); } catch (e) { /* aún no */ } } };
    ping();
    const iv = setInterval(ping, 1000);
    setTimeout(() => { clearInterval(iv); if (!done) { done = true; resolve(null); } }, opts.waitMs || 15000);
  });
  if (!hello) { report("phone", "native-no-hello", {}); return null; }
  const width = opts.width || 960, height = opts.height || 720, fps = opts.fps || 30;
  let level = NATIVE_START;
  const codecs = await pickCodecs({ ...(hello.mse || {}), img: !!hello.img && !opts.noImg, tiles: !!hello.tiles && !opts.noImg, mode: opts.mode, imgW: opts.imgW, imgType: opts.imgType }, { width, height, fps, kbps: NATIVE_KBPS[level] });
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
    getCanvas: opts.getCanvas, audioTrack, transport, codecs, width: codecs.video.width, height: codecs.video.height, fps, kbps: NATIVE_KBPS[level], tunnel: opts.tunnel,
    onTvKeys: opts.onTvKeys, audioLeadMs: opts.audioLeadMs, stamp: opts.stamp,
    onStats: (tv, st) => adapt(tv, st),
  });
  // Ajuste de caudal: baja si la tele no pinta lo que llega o se acumula retraso;
  // sube despacio si va holgada.
  let bad = 0, good = 0, lastChange = Date.now(), lastJumps = 0, lastDrops = 0, ticks = 0, lastFails = 0, prevQueue = 0;
  // Tope de calidad: por el Cast del Pixel, 4,5 Mbps ya atascaba los mensajes;
  // 3,5 Mbps iba bien. Se baja si hay atascos y se vuelve a subir hasta aquí.
  const maxLevel = NATIVE_START, startedAt = Date.now();
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
    // La sesión de Cast del móvil se atasca (mensajes sin confirmar, timeouts): bajar
    // ya, sin esperar, y no volver a subir por encima de ese nivel.
    const fails = (st.sendFails || 0) - lastFails;
    lastFails = st.sendFails || 0;
    // (Los primeros segundos no cuentan: al arrancar va el inicio, una imagen clave
    // y lo acumulado, y el Pixel da algún "timeout" suelto aunque luego vaya bien.)
    // (Cada imagen clave deja ~10-15 mensajes en cola un momento: eso no es atasco;
    // atasco es una cola grande dos segundos seguidos.)
    const queued = st.pending > 20 && prevQueue > 20;
    prevQueue = st.pending;
    if ((queued || fails > 0) && Date.now() - startedAt > 8000 && level < NATIVE_KBPS.length - 1 && since > 1500) {
      level++; bad = 0; good = 0; lastChange = Date.now();
      sender.setBitrate(NATIVE_KBPS[level]);
    } else if (bad >= 3 && level < NATIVE_KBPS.length - 1 && since > 4000) {
      level++; bad = 0; lastChange = Date.now();
      sender.setBitrate(NATIVE_KBPS[level]);
    } else if (good >= 10 && level > maxLevel && since > 10000) {
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
