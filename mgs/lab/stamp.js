// Marca de tiempo dentro de la imagen: 24 bits (ms del reloj de pared módulo 2^24)
// como bloques blancos/negros grandes en la franja superior, más dos bloques guía.
// Sobrevive al recorte 4:3, al escalado a la resolución de envío y a la compresión.

export const BITS = 24;
const ROW_H = 0.07;   // alto de la franja, en fracción del alto
const COLS = BITS + 2; // guía blanca + guía negra + 24 bits

export function stampTime(g, width, height = width * 3 / 4) {
  const now = Date.now() % (1 << BITS);
  const w = width / COLS, h = height * ROW_H;
  g.fillStyle = "#fff"; g.fillRect(0, 0, w, h);      // guía: blanco
  g.fillStyle = "#000"; g.fillRect(w, 0, w, h);      // guía: negro
  for (let i = 0; i < BITS; i++) {
    g.fillStyle = (now >> (BITS - 1 - i)) & 1 ? "#fff" : "#000";
    g.fillRect((i + 2) * w, 0, w, h);
  }
}

// Lee la marca de un fotograma ya pintado en un canvas 2D de ancho `width`.
// Devuelve el retraso en ms o null si la franja no se puede leer.
export function readLatency(g, width, height = width * 3 / 4) {
  const w = width / COLS, h = height * ROW_H;
  const px = g.getImageData(0, Math.floor(h / 2), width, 1).data;
  const lum = col => {
    const x = Math.floor((col + 0.5) * w);
    return (px[x * 4] + px[x * 4 + 1] + px[x * 4 + 2]) / 3;
  };
  const white = lum(0), black = lum(1);
  if (white - black < 80) return null;
  const mid = (white + black) / 2;
  let v = 0;
  for (let i = 0; i < BITS; i++) v = (v << 1) | (lum(i + 2) > mid ? 1 : 0);
  let d = (Date.now() % (1 << BITS)) - v;
  if (d < 0) d += 1 << BITS;
  return d < 10000 ? d : null;
}
