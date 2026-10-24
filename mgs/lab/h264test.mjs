// ¿Decodifica la tele H.264 en WebAssembly (tinyh264) lo bastante rápido? Le manda un
// vídeo .h264 (Annex B, con AUD por imagen) y mide en la tele: ms por imagen al
// decodificar, y ms por imagen al pasar YUV→RGB y pintarla en un lienzo 2D.
// La página de la tele debe estar abierta con ;dbg (lab/tvprobe.mjs --fresh --dbg).
//
//   node lab/h264test.mjs 192.168.1.131 video.h264

import fs from "fs";
import { connectCast, NS } from "./castv2.mjs";

const [HOST, FILE] = process.argv.slice(2);
const d = fs.readFileSync(FILE);
// Unidades por imagen: cortar en cada AUD (00 00 00 01 09).
const cuts = [];
for (let i = 0; i + 5 <= d.length; i++) if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 0 && d[i + 3] === 1 && d[i + 4] === 9) cuts.push(i);
const aus = cuts.map((a, k) => d.subarray(a, cuts[k + 1] ?? d.length).toString("base64"));

const c = await connectCast(HOST, { src: "sender-h264test" });
const app = await c.launch("84912283");
const answers = new Map();
c.on(NS.dashcast, m => { if (m && m.t === "dbgr" && answers.has(m.id)) { answers.get(m.id)(m.r); answers.delete(m.id); } });
let id = 2000;
const dbg = (e, ms = 60000) => new Promise(res => { const i = ++id; answers.set(i, res); c.send(NS.dashcast, app.transportId, { t: "dbg", id: i, e }); setTimeout(() => { if (answers.delete(i)) res("sin respuesta"); }, ms); });

await dbg("window.__AU = []; 1");
let batch = [], size = 0;
for (const a of aus) {
  if (size + a.length > 40000 && batch.length) { await dbg(`__AU.push(...${JSON.stringify(batch)}); __AU.length`); batch = []; size = 0; }
  batch.push(a); size += a.length;
}
if (batch.length) await dbg(`__AU.push(...${JSON.stringify(batch)}); __AU.length`);

const r = await dbg(`(async () => {
  const Module = (await import("/lab/vendor/tinyh264/TinyH264.js")).default;
  const Dec = (await import("/lab/vendor/tinyh264/TinyH264Decoder.js")).default;
  const mod = await Module();
  let pics = 0, last = null, W = 0, H = 0;
  const dec = new Dec(mod, (pic, w, h) => { pics++; last = pic.slice(); W = w; H = h; });
  const aus = __AU.map(b => Uint8Array.from(atob(b), ch => ch.charCodeAt(0)));
  const t = [];
  for (const au of aus) { const a = performance.now(); dec.decode(au); t.push(performance.now() - a); }
  t.sort((x, y) => x - y);
  // YUV 4:2:0 → RGBA en JS (enteros) y putImageData en un lienzo 2D.
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  cv.style.cssText = "position:fixed;inset:0;width:100%;height:100%;z-index:9";
  document.body.appendChild(cv);
  const g = cv.getContext("2d"); const img = g.createImageData(W, H); const o = img.data;
  const conv = () => {
    const Y = last, U = W * H, V = U + (W * H >> 2), cw = W >> 1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const yy = (Y[y * W + x] - 16) * 298, ci = (y >> 1) * cw + (x >> 1), u = Y[U + ci] - 128, v = Y[V + ci] - 128, p = (y * W + x) * 4;
      o[p] = (yy + 409 * v + 128) >> 8; o[p + 1] = (yy - 100 * u - 208 * v + 128) >> 8; o[p + 2] = (yy + 516 * u + 128) >> 8; o[p + 3] = 255;
    }
  };
  const t1 = performance.now(); for (let k = 0; k < 20; k++) { conv(); g.putImageData(img, 0, 0); } const convMs = (performance.now() - t1) / 20;
  // Lo mismo con la conversión en wasm (js/mgsyuv.wasm), y aparte solo putImageData.
  const yw = (await WebAssembly.instantiate(await (await fetch("/js/mgsyuv.wasm")).arrayBuffer())).instance.exports;
  const p = yw.ptr(W, H); new Uint8Array(yw.memory.buffer, p, W * H * 3 / 2).set(last);
  const img2 = new ImageData(new Uint8ClampedArray(yw.memory.buffer, yw.rgba_ptr(W, H), W * H * 4), W, H);
  const t2 = performance.now(); for (let k = 0; k < 20; k++) yw.convert(W, H); const wasmConvMs = (performance.now() - t2) / 20;
  const t3 = performance.now(); for (let k = 0; k < 20; k++) g.putImageData(img2, 0, 0); const putMs = (performance.now() - t3) / 20;
  const simd = WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]));
  setTimeout(() => cv.remove(), 3000);
  return { frames: aus.length, pics, W, H, decP50: Math.round(t[t.length >> 1] * 10) / 10, decP90: Math.round(t[Math.floor(t.length * 0.9)] * 10) / 10, decMax: Math.round(t[t.length - 1]), convMs: Math.round(convMs * 10) / 10, wasmConvMs: Math.round(wasmConvMs * 10) / 10, putMs: Math.round(putMs * 10) / 10, simd };
})()`, 180000);
console.log(FILE.split("/").pop(), JSON.stringify(r));
c.close();
