// Audio en el Chromecast de las LG: recibe el audio de WebRTC (llega con señal a
// Web Audio) pero no lo saca por los altavoces; solo suena lo que pasa por su
// reproductor multimedia normal. Así que, dentro de la propia tele, convertimos
// el audio recibido en un flujo Opus/WebM y lo reproducimos con MediaSource en
// un <audio>, igual que haría una app de streaming.

const MIME_REC = "audio/webm;codecs=opus";
const MIME_MSE = 'audio/webm; codecs="opus"';
const MAX_LAG = 0.35;   // s de retraso tolerado antes de saltar al directo
const TARGET_LAG = 0.12;

export function mseAudioSupported() {
  return typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(MIME_REC)
    && typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(MIME_MSE);
}

// ctx + node: el audio recibido dentro de Web Audio (un MediaStreamAudioSourceNode).
export function startMseAudio(ctx, node) {
  const dest = ctx.createMediaStreamDestination();
  node.connect(dest);
  const el = new Audio();
  el.autoplay = true;
  const ms = new MediaSource();
  el.src = URL.createObjectURL(ms);
  const queue = [];
  const info = { chunks: 0, bytes: 0, jumps: 0, err: null };
  let sb = null;
  let rec = null;

  const pump = () => {
    if (!sb || sb.updating || !queue.length || ms.readyState !== "open") return;
    try {
      sb.appendBuffer(queue.shift());
    } catch (e) {
      info.err = String(e);
    }
  };

  ms.addEventListener("sourceopen", () => {
    try {
      sb = ms.addSourceBuffer(MIME_MSE);
      sb.mode = "sequence";
      sb.addEventListener("updateend", pump);
    } catch (e) {
      info.err = String(e);
      return;
    }
    rec = new MediaRecorder(dest.stream, { mimeType: MIME_REC, audioBitsPerSecond: 96000 });
    rec.ondataavailable = async e => {
      if (!e.data || !e.data.size) return;
      const buf = await e.data.arrayBuffer();
      info.chunks++;
      info.bytes += buf.byteLength;
      queue.push(buf);
      pump();
    };
    rec.onerror = e => { info.err = String(e.error || e); };
    rec.start(100); // trozos de 100 ms: poco retraso
    el.play().catch(e => { info.err = "play: " + e; });
  }, { once: true });

  // Mantenerse cerca del directo y no acumular audio viejo.
  const keeper = setInterval(() => {
    const b = el.buffered;
    if (!b.length) return;
    const end = b.end(b.length - 1);
    if (end - el.currentTime > MAX_LAG) {
      el.currentTime = end - TARGET_LAG;
      info.jumps++;
    }
    if (el.paused) el.play().catch(() => {});
    if (sb && !sb.updating && el.currentTime > 30 && b.start(0) < el.currentTime - 20) {
      try { sb.remove(0, el.currentTime - 10); } catch (e) { /* se reintenta luego */ }
    }
  }, 500);

  return {
    el,
    info() {
      const b = el.buffered;
      return {
        ...info,
        paused: el.paused,
        t: Math.round(el.currentTime * 10) / 10,
        lagMs: b.length ? Math.round((b.end(b.length - 1) - el.currentTime) * 1000) : null,
        ready: el.readyState,
        rec: rec && rec.state,
      };
    },
    stop() {
      clearInterval(keeper);
      try { rec && rec.state !== "inactive" && rec.stop(); } catch (e) { /* ya parado */ }
      try { node.disconnect(dest); } catch (e) { /* ya desconectado */ }
      el.pause();
      URL.revokeObjectURL(el.src);
    },
  };
}

// Pitido corto al abrir la pantalla: si se oye, el audio de la tele funciona.
export function beep() {
  const rate = 22050, secs = 0.18, n = Math.floor(rate * secs);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 200, (n - i) / 200);
    v.setInt16(44 + i * 2, Math.sin(2 * Math.PI * 880 * i / rate) * 9000 * env, true);
  }
  const a = new Audio(URL.createObjectURL(new Blob([buf], { type: "audio/wav" })));
  return a.play().then(() => "ok", e => "blocked: " + e.name);
}
