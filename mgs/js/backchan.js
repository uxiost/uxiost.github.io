// Canal de vuelta tele → móvil dentro del propio vídeo.
//
// El Chromecast de las LG no tiene canales de datos WebRTC, pero sí envía vídeo.
// La tele dibuja en un lienzo diminuto (64×64, 15 fps) una rejilla de 8×8
// casillas blancas/negras con: los fps que pinta, lo que tarda en decodificar y
// los botones pulsados en su mando o en un mando emparejado con ella. El móvil
// recibe ese vídeo y lee las casillas.
//
// 64 bits por imagen:
//   0–7   patrón de sincronía 10110010 (para validar y calibrar blanco/negro)
//   8–15  secuencia
//   16–23 fps mostrados × 4
//   24–31 ms de decodificación × 4
//   32–47 botones (máscara de 16 bits, índices RetroPad)
//   48–55 retraso del búfer de recepción / 8 (ms; 0–2040)
//   56–63 suma de comprobación (bytes 1–6 módulo 256)

const N = 8, CELL = 8, SIZE = N * CELL;
const SYNC = 0b10110010;

export function makeBackChannel(fps = 15) {
  const c = document.createElement("canvas");
  c.width = c.height = SIZE;
  const g = c.getContext("2d", { alpha: false });
  const fields = { seq: 0, shownFps: 0, decMs: 0, keys: 0, jbMs: 0 };
  const draw = () => {
    fields.seq = (fields.seq + 1) & 255;
    const bytes = [
      SYNC,
      fields.seq,
      Math.min(255, Math.round(fields.shownFps * 4)),
      Math.min(255, Math.round(fields.decMs * 4)),
      (fields.keys >> 8) & 255,
      fields.keys & 255,
      Math.min(255, Math.round(fields.jbMs / 8)),
    ];
    bytes.push(bytes.slice(1, 7).reduce((a, b) => a + b, 0) & 255);
    for (let i = 0; i < 64; i++) {
      const bit = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
      g.fillStyle = bit ? "#fff" : "#000";
      g.fillRect((i % N) * CELL, Math.floor(i / N) * CELL, CELL, CELL);
    }
  };
  draw();
  const iv = setInterval(draw, 1000 / fps);
  const stream = c.captureStream(fps);
  return {
    stream,
    set(f) { Object.assign(fields, f); },
    drawNow: draw,
    stop() { clearInterval(iv); stream.getTracks().forEach(t => t.stop()); },
  };
}

// Lee el canal desde un MediaStream recibido. cb({seq, shownFps, decMs, keys, jbMs, stats}).
export function readBackChannel(stream, cb) {
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.srcObject = stream;
  // Chrome no entrega fotogramas de un vídeo fuera de la página: lo colgamos
  // invisible (1 px) para poder leerlo.
  v.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1";
  document.body.appendChild(v);
  v.play().catch(() => {});
  const c = document.createElement("canvas");
  c.width = c.height = SIZE;
  const g = c.getContext("2d", { willReadFrequently: true });
  let stopped = false;
  let last = -1;
  const read = () => {
    if (!v.videoWidth) return;
    g.drawImage(v, 0, 0, SIZE, SIZE);
    const px = g.getImageData(0, 0, SIZE, SIZE).data;
    const lum = i => {
      const x = (i % N) * CELL + CELL / 2, y = Math.floor(i / N) * CELL + CELL / 2;
      const o = (y * SIZE + x) * 4;
      return (px[o] + px[o + 1] + px[o + 2]) / 3;
    };
    // Calibrar con el patrón de sincronía (sus 1 y sus 0 conocidos).
    let hi = 0, lo = 0, nh = 0, nl = 0;
    for (let i = 0; i < 8; i++) {
      if ((SYNC >> (7 - i)) & 1) { hi += lum(i); nh++; } else { lo += lum(i); nl++; }
    }
    hi /= nh; lo /= nl;
    if (hi - lo < 60) return;
    const mid = (hi + lo) / 2;
    const bytes = [];
    for (let b = 0; b < 8; b++) {
      let v8 = 0;
      for (let k = 0; k < 8; k++) v8 = (v8 << 1) | (lum(b * 8 + k) > mid ? 1 : 0);
      bytes.push(v8);
    }
    if (bytes[0] !== SYNC) return;
    if ((bytes.slice(1, 7).reduce((a, b) => a + b, 0) & 255) !== bytes[7]) return;
    if (bytes[1] === last) return; // imagen repetida
    last = bytes[1];
    cb({ seq: bytes[1], shownFps: bytes[2] / 4, decMs: bytes[3] / 4, keys: (bytes[4] << 8) | bytes[5], jbMs: bytes[6] * 8, stats: bytes[2] > 0 });
  };
  // Temporizador (no requestVideoFrameCallback: este vídeo no se pinta en pantalla
  // y esa llamada solo salta con vídeos que se componen).
  const iv = setInterval(() => { if (!stopped) read(); }, 40);
  return { stop() { stopped = true; clearInterval(iv); v.srcObject = null; v.remove(); } };
}
