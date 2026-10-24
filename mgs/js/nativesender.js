// Emisor del modo nativo: codifica (WebCodecs), empaqueta en MP4 fragmentado y
// entrega los mensajes para la tele. Corre en un Worker (nativeworker.js) para no
// quitarle tiempo al emulador, que vive en el hilo principal; si no hay Worker,
// el mismo código corre en el hilo principal.
//
// createSender(cfg, emit) → { video(readable), audio(readable), message(m) }
//   cfg: { id, codecs, width, height, fps, kbps, audioLeadMs, audioWanted }
//   emit({t:"send", obj})  mensaje para la tele
//   emit({t:"stats", stats})
//   readable: el ReadableStream de un MediaStreamTrackProcessor (de vídeo o de audio)
//   message: {t:"pending", n} {t:"key"} {t:"restart"} {t:"bitrate", kbps} {t:"stop"}

import { initSegment, fragment, mimeFor, toB64 } from "./fmp4.js?v=78";
import { stampTime } from "./stamp.js?v=78";

// Bytes por mensaje antes de base64. En la LG real, los mensajes de ~60 KB los
// rechazaba el Chromecast ("invalid_parameter"; el límite es 64 KB) y se perdían
// imágenes clave; si rechaza alguno, se encogen solos. El Pixel además da
// "timeout" (sin más) a todo mensaje de ~32 000 caracteres (24 KB): parece que
// cuenta el texto en UTF-16, así que el límite real son ~32 000 caracteres. Y
// solo aguanta unos 50-60 mensajes por segundo. Trozos de 18 KB (24 000
// caracteres): casi todas las imágenes caben en uno y quedan bajo el límite.
const CHUNK = 21000, MIN_CHUNK = 3000, TIMEOUT_FLOOR = 12000; // 21 KB = 28 000 caracteres: medido sin fallos en el Pixel; una imagen con la cámara en movimiento cabe en un mensaje

export function createSender(cfg, emit) {
  const { id, codecs, width, height } = cfg;
  const fps = cfg.fps || 30;
  let kbps = cfg.kbps || 3000;
  let chunk = cfg.chunk || CHUNK;
  let stopped = false, lastFailAt = -1e9;
  let needKey = true, forceKey = true;
  let vSeq = 0, aSeq = 0;
  let pending = 0;          // mensajes enviados sin confirmar (lo cuenta el hilo principal)
  const stats = { id, sentFrames: 0, dropped: 0, flowDrops: 0, bytes: 0, encMs: 0, msgs: 0, codec: codecs.video.codecString, audio: codecs.audio ? codecs.audio.kind : null };
  let t0 = null;            // origen común de tiempos (µs del reloj de este hilo)
  let vInit = null, aInit = null, started = false;
  const nowUs = () => performance.now() * 1000;

  const send = obj => { stats.msgs++; emit({ t: "send", obj }); };
  const sendBytes = (k, n, bytes, extra) => {
    const of = Math.ceil(bytes.length / chunk);
    for (let i = 0; i < of; i++) send({ t: "seg", id, k, n, i, of, ...extra, d: toB64(bytes.subarray(i * chunk, (i + 1) * chunk)) });
    stats.bytes += bytes.length;
    stats["n" + k] = (stats["n" + k] || 0) + 1;
  };
  // El "start" sale cuando están los segmentos de inicio de vídeo y de audio (o
  // solo vídeo si el audio no llega en 1,5 s).
  const audioWanted = !!(codecs.audio && cfg.audioWanted);
  const audioLeadUs = (cfg.audioLeadMs ?? 220) * 1000;
  let firstVideoAt = 0;
  const maybeStart = () => {
    if (started || !vInit) return;
    if (audioWanted && !aInit && performance.now() - firstVideoAt < 1500) return;
    started = true;
    stats.withAudio = !!aInit;
    send({ t: "start", id, v: vInit, a: aInit });
    forceKey = true;
  };

  // ---- vídeo
  // Modo "img": en vez de vídeo, una imagen (WebP) por fotograma a la resolución
  // nativa de la PS1. La tele las pinta según llegan (createImageBitmap + lienzo):
  // sin el colchón de ~200 ms de MSE, sin saltos, sin imágenes clave ni ráfagas,
  // y perder una no estropea las siguientes. (La LG no tiene WebCodecs útil.)
  const img = codecs.video.kind === "img";
  // Modo "tiles" (por defecto): codificador propio en WebAssembly (codec/, Rust). Solo
  // se envían los bloques de 16×16 que cambiaron, en un mosaico JPEG que la tele
  // decodifica con su decodificador nativo y pega en su sitio. Una imagen entera de
  // 640×480 se codifica en pocos ms (WebP del navegador: ~50 ms).
  const tiles = codecs.video.kind === "tiles";
  let tw = null, tilesCv = null, tilesG = null, tilesQ = 80, tilesFull = true, copyToRgba = null;
  const tilesQFor = k => k >= 6000 ? 90 : k >= 4500 ? 85 : k >= 3500 ? 80 : k >= 2500 ? 72 : k >= 1800 ? 62 : 50;
  if (tiles) {
    vInit = { mime: "image/x-mgs-tiles", d: "" };
    firstVideoAt = performance.now();
    const url = new URL("./mgscodec.wasm" + new URL(import.meta.url).search, import.meta.url);
    fetch(url).then(r => r.arrayBuffer()).then(b => WebAssembly.instantiate(b)).then(r => { tw = r.instance.exports; tw.init(width, height); })
      .catch(e => { stats.err = "tiles wasm: " + e; });
  }
  // Hasta 3 imágenes codificándose a la vez: en el Pixel cada WebP tarda ~50 ms
  // (la mayor parte esperando turno, el emulador ocupa la CPU), y de una en una no
  // pasaba de ~21 fps. Cada una lleva su número; la tele tira las que lleguen tarde.
  const IMG_PAR = 3;
  let imgQ = 0.8, imgBusy = 0;
  if (img) { vInit = { mime: codecs.video.codecString, d: "" }; firstVideoAt = performance.now(); }
  // Dos hilos de codificación (imgworker.js), por turnos.
  const imgPool = [], imgWait = new Map();
  let imgNext = 0, imgId = 0;
  if (img) {
    const url = new URL("./imgworker.js" + new URL(import.meta.url).search, import.meta.url);
    for (let i = 0; i < 2; i++) {
      try {
        const w = new Worker(url, { type: "module" });
        w.onmessage = e => { const r = imgWait.get(e.data.id); if (r) { imgWait.delete(e.data.id); r(e.data); } };
        imgPool.push(w);
      } catch (e) { stats.imgWorkerErr = String(e); }
    }
  }
  const encodeIn = (frame, ts) => new Promise(resolve => {
    const id = ++imgId;
    imgWait.set(id, resolve);
    imgPool[imgNext++ % imgPool.length].postMessage({ id, frame, w: width, h: height, q: imgQ, type: codecs.video.codecString, stamp: !!cfg.stamp }, [frame]);
  });
  const imgEncode = async (frame, ts) => {
    imgBusy++;
    const n = ++vSeq;
    try {
      const r = await encodeIn(frame, ts);
      if (r.err) throw new Error(r.err);
      const bytes = new Uint8Array(r.buf);
      if (!started || stopped) return;
      sendBytes("v", n, bytes, { key: 1, ts: ts / 1e6 });
      stats.sentFrames++;
      stats.imgKB = Math.round(bytes.length / 102.4) / 10;
      // Calidad según el caudal pedido (kbps): bytes por imagen objetivo.
      const want = kbps * 1000 / 8 / fps;
      if (bytes.length > want * 1.15) imgQ = Math.max(0.3, imgQ - 0.04);
      else if (bytes.length < want * 0.8) imgQ = Math.min(0.92, imgQ + 0.02);
      stats.imgQ = Math.round(imgQ * 100);
    } catch (e) { stats.err = "img: " + e; }
    finally { imgBusy--; }
  };
  let videoTrack = null;
  const venc = img || tiles ? null : new VideoEncoder({
    output: (chunk, meta) => {
      if (meta && meta.decoderConfig && !videoTrack) {
        videoTrack = {
          id: 1, kind: "video", codec: codecs.video.kind, codecString: codecs.video.codecString, timescale: 90000,
          width, height, description: meta.decoderConfig.description ? new Uint8Array(meta.decoderConfig.description) : null,
        };
        vInit = { mime: mimeFor(videoTrack), d: toB64(initSegment(videoTrack)) };
        firstVideoAt = performance.now();
        maybeStart();
      }
      if (!videoTrack || !started) return;
      if (!stats.firstKeySent) { if (chunk.type !== "key") return; stats.firstKeySent = true; }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      const t90 = Math.round(chunk.timestamp * 0.09);
      stats.vTs = Math.round(chunk.timestamp / 1000);
      stats.nowTs = Math.round((nowUs() - t0) / 1000);
      const dur = Math.round((chunk.duration || 1e6 / fps) * 0.09); // ver durFor()
      const key = chunk.type === "key";
      // vd: duración declarada (la tele la descuenta al medir su retraso).
      sendBytes("v", ++vSeq, fragment(videoTrack, vSeq, t90, [{ data, duration: dur, key }]), key ? { key: 1, ts: t90 / 90000, vd: dur / 90000 } : { vd: dur / 90000 });
      stats.sentFrames++;
    },
    error: e => { stats.err = String(e); },
  });
  const configure = () => {
    if (tiles) tilesQ = tilesQFor(kbps);
    if (venc) venc.configure({ ...codecs.video.cfg, width, height, framerate: fps, bitrate: kbps * 1000 });
  };
  configure();

  let lastSrc = null, lastVideoAt = performance.now();
  // Imágenes clave: cada 8 s, al empezar, y cuando se piden (pérdidas, fallos de
  // envío…) como mucho una cada 1,5 s. Son 5-10 veces más grandes que las demás:
  // en el Pixel, pedir una por cada fallo atascaba el envío, que fallaba más y
  // pedía más (bucle).
  let lastKeyAt = -1e9;
  const encodeFrame = src => {
    const now = performance.now();
    const key = forceKey || (needKey && now - lastKeyAt > 1500) || now - lastKeyAt > 8000;
    const tEnc = performance.now();
    venc.encode(src, { keyFrame: key });
    stats.encMs = Math.round((performance.now() - tEnc) * 10) / 10;
    if (key) { needKey = false; forceKey = false; lastKeyAt = now; stats.keys = (stats.keys || 0) + 1; }
    lastVideoAt = performance.now();
  };
  // Duración declarada de cada imagen: algo más que el ritmo real (media de los
  // huecos × 1,5). El reproductor da por cortado el vídeo, y tira todo hasta la
  // siguiente imagen clave, si entre dos imágenes pasa más del doble de la
  // duración declarada de la anterior, y el emulador no entrega las imágenes con
  // regularidad perfecta. Si aun así llega un hueco mayor, esa imagen sale como
  // imagen clave y no se pierde nada. (Declarar mucho más, p. ej. 0,3 s, hace que
  // Chrome pinte menos imágenes de las que recibe.)
  let lastTs = -1, gapEma = 1e6 / fps, lastDur = 1e6 / fps;
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
  const vPacer = setInterval(() => {
    if (img || tiles || stopped || !lastSrc || !started || venc.encodeQueueSize > 2) return;
    if (performance.now() - lastVideoAt < Math.max(60, lastDur / 1000 * 1.4)) return;
    const ts = nowUs() - t0;
    const f = new VideoFrame(lastSrc, { timestamp: ts, duration: durFor(ts) });
    encodeFrame(f);
    f.close();
    stats.repeats = (stats.repeats || 0) + 1;
  }, 20);

  // Imágenes del lienzo (de un MediaStreamTrackProcessor). Si el lienzo cambia,
  // llega otro `readable` y se sigue con ese.
  let reader = null, scaler = null, vOff = null, credit = 1, lastInTs = null;
  const video = async readable => {
    if (reader) { try { reader.cancel(); } catch (e) { /* ya parado */ } }
    const my = reader = readable.getReader();
    vOff = null;
    while (!stopped && my === reader) {
      const { value: frame, done } = await my.read();
      if (done) break;
      if (stopped || my !== reader) { frame.close(); break; }
      stats.framesIn = (stats.framesIn || 0) + 1;
      // fps objetivo, cola del codificador y control de flujo: si algo se atasca,
      // se descarta la imagen en lugar de acumular retraso.
      const now = nowUs();
      if (t0 == null) t0 = now;
      if (vOff == null) vOff = now - frame.timestamp;
      const ts = frame.timestamp + vOff - t0;
      // Ritmo: cada imagen que llega da "crédito" según el tiempo pasado y se
      // envía una cuando hay crédito para una. (Antes se tiraba toda imagen que
      // llegara a menos de 28 ms de la anterior: con el emulador del Pixel, que da
      // ~38 fps irregulares, eso tiraba una de cada dos y quedaban ~20 fps.)
      if (lastInTs != null) credit = Math.min(1.5, credit + (ts - lastInTs) * fps / 1e6);
      lastInTs = ts;
      if (lastTs >= 0 && credit < 1) { frame.close(); continue; }
      credit = Math.max(0, credit - 1);
      if (tiles) {
        if (!tw || !started) { frame.close(); stats.dropped++; continue; }
        if (pending > 12) { frame.close(); stats.flowDrops++; tilesFull = true; continue; }
        lastTs = ts;
        const t0 = performance.now();
        // ¿Cuánto lleva esperando esta imagen desde que la capturó Chrome? (timestamp
        // de la captura, si va en el mismo reloj)
        stats.capAge = Math.round(t0 - frame.timestamp / 1000);
        // Píxeles: si la imagen ya viene al tamaño de envío (la captura se pide así),
        // copyTo en RGBA directo a la memoria del wasm; si no, por un lienzo (lento:
        // reescalar en la CPU costaba ~70 ms por imagen en el Pixel).
        // (Ojo: displayWidth puede decir 640 con 960×720 píxeles de verdad: se copia
        // el rectángulo visible entero y se reduce en el wasm.)
        let viaCopy = false;
        const vr = frame.visibleRect;
        if (!cfg.stamp && vr && copyToRgba !== false) {
          try {
            const rect = { x: vr.x, y: vr.y, width: vr.width, height: vr.height };
            if (vr.width === width && vr.height === height) {
              await frame.copyTo(new Uint8Array(tw.memory.buffer, tw.frame_ptr(), width * height * 4), { format: "RGBA", rect });
            } else {
              const p = tw.src_ptr(vr.width, vr.height);
              await frame.copyTo(new Uint8Array(tw.memory.buffer, p, vr.width * vr.height * 4), { format: "RGBA", rect });
              tw.scale_from(vr.width, vr.height);
            }
            viaCopy = true; copyToRgba = true;
          } catch (e) { copyToRgba = false; stats.copyErr = String(e); }
        }
        const dst = new Uint8Array(tw.memory.buffer, tw.frame_ptr(), width * height * 4);
        if (!viaCopy) {
          if (!tilesCv) { tilesCv = new OffscreenCanvas(width, height); tilesG = tilesCv.getContext("2d", { willReadFrequently: true }); }
          tilesG.imageSmoothingEnabled = true;
          tilesG.imageSmoothingQuality = "low";
          tilesG.drawImage(frame, 0, 0, width, height);
          if (cfg.stamp) stampTime(tilesG, width, height);
          dst.set(tilesG.getImageData(0, 0, width, height).data);
        }
        stats.frameSize = [vr && vr.width, vr && vr.height, frame.format, viaCopy ? "copy" : "canvas"];
        frame.close();
        const t1 = performance.now();
        // Imagen entera al empezar, si la tele la pide (perdió algo) o tras atascos.
        const full = tilesFull || forceKey || needKey;
        const len = tw.encode(tilesQ, full ? 1 : 0, 6); // + 6 bloques de refresco por turnos
        if (full) { tilesFull = false; forceKey = false; needKey = false; stats.keys = (stats.keys || 0) + 1; }
        const t2 = performance.now();
        stats.readMs = Math.round(((stats.readMs || 0) * 0.9 + (t1 - t0) * 0.1) * 10) / 10;
        stats.encMs = Math.round(((stats.encMs || 0) * 0.9 + (t2 - t1) * 0.1) * 10) / 10;
        if (len) {
          const bytes = new Uint8Array(tw.memory.buffer, tw.out_ptr(), len).slice();
          const n = bytes[0] | (bytes[1] << 8);
          stats.tilesPct = Math.round(n / (Math.ceil(width / 16) * Math.ceil(height / 16)) * 100);
          stats.imgKB = Math.round(len / 102.4) / 10;
          if (full) stats.fullKB = stats.imgKB; // tamaño de la última imagen entera
          stats.imgQ = tilesQ;
          // Medida de retraso: c = hora de captura (época, ms), e = ms hasta tener el
          // mensaje listo; la tele mide el resto (ver "lat" en native.js).
          const meas = { c: Math.round((performance.timeOrigin + t0) * 10) / 10, e: Math.round((performance.now() - t0) * 10) / 10 };
          sendBytes("v", ++vSeq, bytes, full ? { key: 1, ...meas } : meas);
          stats.sentFrames++;
        }
        continue;
      }
      if (img) {
        if (imgBusy >= IMG_PAR || !started || !imgPool.length) { frame.close(); stats.dropped++; continue; }
        if (pending > 12) { frame.close(); stats.flowDrops++; continue; }
        lastTs = ts;
        imgEncode(frame, ts); // la imagen pasa (transferida) al hilo que la codifica
        continue;
      }
      if (venc.encodeQueueSize > 2) { frame.close(); stats.dropped++; continue; }
      if (pending > 30) { frame.close(); stats.flowDrops++; needKey = true; continue; }
      const dur = durFor(ts);
      let src;
      if (((frame.displayWidth !== width || frame.displayHeight !== height) && codecs.video.hw) || cfg.stamp) {
        // Reescalar al tamaño del codificador. (El codificador por software de
        // Chrome ya reescala él solo.) Con cfg.stamp, además la hora de captura en
        // la franja de arriba (lab/latcam.py la lee en la tele con la cámara).
        scaler = scaler || new OffscreenCanvas(width, height);
        const g = scaler.getContext("2d");
        g.drawImage(frame, 0, 0, width, height);
        if (cfg.stamp) stampTime(g, width, height);
        src = new VideoFrame(scaler, { timestamp: ts, duration: dur });
      } else {
        src = new VideoFrame(frame, { timestamp: ts, duration: dur });
      }
      frame.close();
      encodeFrame(src);
      if (lastSrc) lastSrc.close();
      lastSrc = src; // se guarda para repetirla si el lienzo deja de cambiar
    }
  };

  // ---- audio (se configura con la frecuencia que llegue: 44,1 o 48 kHz)
  // El reloj del audio del emulador no es exactamente el de la pared (y si el
  // emulador va lento, o el audio se para, llega menos audio del que toca). La
  // tele reproduce al ritmo de su reloj, así que el audio se reestampa seguido y
  // se ata al reloj de pared: si falta, se rellena con silencio; si sobra, se tira.
  let aenc = null, aReader = null, aPacer = null;
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
      // ~100 ms por mensaje: pocos mensajes (el audio va adelantado 220 ms, así que
      // no añade retraso ni deja a la tele sin audio).
      if (batch.reduce((a, s) => a + s.duration, 0) >= rate * 0.1) {
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
    } else if (behind > 300000) {
      // (El emulador da el audio a ráfagas: con margen de 120 ms se metía silencio
      // a cada rato y luego se tiraba el audio de verdad al llegar: sonido a trozos.)
      let n = Math.round((behind - 120000) / 1e6 * rate);
      const step = Math.round(rate / 50);
      const zero = new Float32Array(step);
      while (n > 0) { const k = Math.min(n, step); encodePlanes([k === step ? zero : new Float32Array(k)], k); n -= k; }
      stats.aFilled = (stats.aFilled || 0) + 1;
    }
  };
  const audio = async readable => {
    if (!audioWanted) return;
    aReader = readable.getReader();
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
      if (aPos - wall() > 400000 || aenc.encodeQueueSize > 20) { data.close(); stats.aSkipped = (stats.aSkipped || 0) + 1; continue; }
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
  };

  const startIv = setInterval(maybeStart, 200);
  const statsIv = setInterval(() => emit({ t: "stats", stats: { ...stats } }), 500);

  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const iv of [startIv, statsIv, vPacer, aPacer]) if (iv) clearInterval(iv);
    if (lastSrc) { lastSrc.close(); lastSrc = null; }
    try { reader && reader.cancel(); } catch (e) { /* ya parado */ }
    try { venc && venc.close(); } catch (e) { /* ya cerrado */ }
    for (const w of imgPool) w.terminate();
    try { aReader && aReader.cancel(); } catch (e) { /* ya parado */ }
    try { aenc && aenc.close(); } catch (e) { /* ya cerrado */ }
  };

  return {
    video: readable => video(readable).catch(e => { stats.err = String(e); }),
    audio: readable => audio(readable).catch(e => { stats.aErr = String(e); }),
    message(m) {
      if (m.t === "pending") pending = m.n;
      else if (m.t === "key") needKey = true;
      else if (m.t === "sendfail" && performance.now() - lastFailAt > 1000) {
        lastFailAt = performance.now();
        // La tele no recibió un trozo: una imagen clave para que no siga con un
        // hueco y, si fue por tamaño, más pequeños a partir de ahora. (Si fue por
        // atasco, "timeout", encoger solo multiplicaría los mensajes.)
        // (Un "timeout" de un trozo grande también puede ser por tamaño: se encoge,
        // pero sin bajar de 12 KB, que el Pixel siempre ha aceptado.)
        if (!/timeout/i.test(m.why || "")) chunk = Math.max(MIN_CHUNK, Math.floor(chunk * 0.6));
        else if (m.len > TIMEOUT_FLOOR * 4 / 3 && chunk > TIMEOUT_FLOOR) chunk = TIMEOUT_FLOOR;
        stats.chunk = chunk;
        stats.sendFails = (stats.sendFails || 0) + 1;
        needKey = true;
      }
      else if (m.t === "restart" && started) {
        // La tele soltó esta emisión: volver a mandar el inicio y una imagen clave.
        started = false;
        stats.firstKeySent = false;
        stats.restarts = (stats.restarts || 0) + 1;
        maybeStart();
      } else if (m.t === "bitrate") {
        kbps = m.kbps;
        try { configure(); forceKey = true; } catch (e) { /* sigue igual */ }
      } else if (m.t === "stop") stop();
    },
  };
}
