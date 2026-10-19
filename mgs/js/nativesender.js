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

import { initSegment, fragment, mimeFor, toB64 } from "./fmp4.js?v=21";

const CHUNK = 45000; // bytes por mensaje antes de base64 (Cast: máx. 64 KB por mensaje)

export function createSender(cfg, emit) {
  const { id, codecs, width, height } = cfg;
  const fps = cfg.fps || 30;
  let kbps = cfg.kbps || 3000;
  let stopped = false;
  let needKey = true;
  let vSeq = 0, aSeq = 0;
  let pending = 0;          // mensajes enviados sin confirmar (lo cuenta el hilo principal)
  const stats = { id, sentFrames: 0, dropped: 0, flowDrops: 0, bytes: 0, encMs: 0, msgs: 0, codec: codecs.video.codecString, audio: codecs.audio ? codecs.audio.kind : null };
  let t0 = null;            // origen común de tiempos (µs del reloj de este hilo)
  let vInit = null, aInit = null, started = false;
  const nowUs = () => performance.now() * 1000;

  const send = obj => { stats.msgs++; emit({ t: "send", obj }); };
  const sendBytes = (k, n, bytes, extra) => {
    const of = Math.ceil(bytes.length / CHUNK);
    for (let i = 0; i < of; i++) send({ t: "seg", id, k, n, i, of, ...extra, d: toB64(bytes.subarray(i * CHUNK, (i + 1) * CHUNK)) });
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
  const configure = () => venc.configure({ ...codecs.video.cfg, width, height, framerate: fps, bitrate: kbps * 1000 });
  configure();

  let lastSrc = null, lastVideoAt = performance.now();
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
    if (stopped || !lastSrc || !started || venc.encodeQueueSize > 2) return;
    if (performance.now() - lastVideoAt < Math.max(60, lastDur / 1000 * 1.4)) return;
    const ts = nowUs() - t0;
    const f = new VideoFrame(lastSrc, { timestamp: ts, duration: durFor(ts) });
    encodeFrame(f);
    f.close();
    stats.repeats = (stats.repeats || 0) + 1;
  }, 20);

  // Imágenes del lienzo (de un MediaStreamTrackProcessor). Si el lienzo cambia,
  // llega otro `readable` y se sigue con ese.
  let reader = null, scaler = null, vOff = null;
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
      if (lastTs >= 0 && ts - lastTs < 1e6 / fps * 0.85) { frame.close(); continue; }
      if (venc.encodeQueueSize > 2) { frame.close(); stats.dropped++; continue; }
      if (pending > 40) { frame.close(); stats.flowDrops++; needKey = true; continue; }
      const dur = durFor(ts);
      let src;
      if ((frame.displayWidth !== width || frame.displayHeight !== height) && codecs.video.hw) {
        // Reescalar al tamaño del codificador. (El codificador por software de
        // Chrome ya reescala él solo.)
        scaler = scaler || new OffscreenCanvas(width, height);
        scaler.getContext("2d").drawImage(frame, 0, 0, width, height);
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
  };

  const startIv = setInterval(maybeStart, 200);
  const statsIv = setInterval(() => emit({ t: "stats", stats: { ...stats } }), 500);

  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const iv of [startIv, statsIv, vPacer, aPacer]) if (iv) clearInterval(iv);
    if (lastSrc) { lastSrc.close(); lastSrc = null; }
    try { reader && reader.cancel(); } catch (e) { /* ya parado */ }
    try { venc.close(); } catch (e) { /* ya cerrado */ }
    try { aReader && aReader.cancel(); } catch (e) { /* ya parado */ }
    try { aenc && aenc.close(); } catch (e) { /* ya cerrado */ }
  };

  return {
    video: readable => video(readable).catch(e => { stats.err = String(e); }),
    audio: readable => audio(readable).catch(e => { stats.aErr = String(e); }),
    message(m) {
      if (m.t === "pending") pending = m.n;
      else if (m.t === "key") needKey = true;
      else if (m.t === "restart" && started) {
        // La tele soltó esta emisión: volver a mandar el inicio y una imagen clave.
        started = false;
        stats.firstKeySent = false;
        stats.restarts = (stats.restarts || 0) + 1;
        maybeStart();
      } else if (m.t === "bitrate") {
        kbps = m.kbps;
        try { configure(); needKey = true; } catch (e) { /* sigue igual */ }
      } else if (m.t === "stop") stop();
    },
  };
}
