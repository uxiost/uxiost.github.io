// ¿A qué velocidad decodifica la tele con WebCodecs? Le manda vídeo de prueba (IVF de
// ffmpeg: VP8/VP9) por la sesión de Cast y mide en la tele el tiempo por imagen.
// La página de la tele debe estar abierta con ;dbg (lab/tvprobe.mjs --fresh --dbg).
//
//   node lab/dectest.mjs 192.168.1.131 vp8 prueba.ivf [ancho alto]

import fs from "fs";
import { connectCast, NS } from "./castv2.mjs";

const [HOST, CODEC, FILE, W = "640", H = "480"] = process.argv.slice(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// IVF: cabecera de 32 bytes; cada imagen, 4 bytes de tamaño + 8 de tiempo + datos.
const ivf = fs.readFileSync(FILE);
const frames = [];
for (let o = 32; o + 12 <= ivf.length;) {
  const n = ivf.readUInt32LE(o);
  const d = ivf.subarray(o + 12, o + 12 + n);
  // VP8: bit 0 del primer byte a 0 = imagen clave. VP9: perfil 0, show_existing 0, frame_type 0 = clave.
  const key = CODEC.startsWith("vp8") ? !(d[0] & 1) : !((d[0] >> 2) & 1);
  frames.push([key ? 1 : 0, d.toString("base64")]);
  o += 12 + n;
}

const c = await connectCast(HOST, { src: "sender-dectest" });
const app = await c.launch("84912283");
const answers = new Map();
c.on(NS.dashcast, m => { if (m && m.t === "dbgr" && answers.has(m.id)) { answers.get(m.id)(m.r); answers.delete(m.id); } });
let id = 1000;
const dbg = (e, ms = 60000) => new Promise(res => { const i = ++id; answers.set(i, res); c.send(NS.dashcast, app.transportId, { t: "dbg", id: i, e }); setTimeout(() => { if (answers.delete(i)) res("sin respuesta"); }, ms); });

await dbg("window.__T = []; 1");
let batch = [], size = 0;
for (const f of frames) {
  if (size + f[1].length > 40000 && batch.length) { await dbg(`__T.push(...${JSON.stringify(batch)}); __T.length`); batch = []; size = 0; }
  batch.push(f); size += f[1].length;
}
if (batch.length) await dbg(`__T.push(...${JSON.stringify(batch)}); __T.length`);

const r = await dbg(`(async () => {
  const fr = __T.map(([k, b]) => [k, Uint8Array.from(atob(b), ch => ch.charCodeAt(0))]);
  let out = 0, err = null; const lat = [];
  const sent = new Map();
  const dec = new VideoDecoder({ output: f => { out++; const t = sent.get(f.timestamp); if (t) lat.push(performance.now() - t); f.close(); }, error: e => { err = String(e); } });
  dec.configure({ codec: ${JSON.stringify(CODEC)}, codedWidth: ${W}, codedHeight: ${H}, optimizeForLatency: true });
  // A ritmo real (30 fps), como en directo: retraso por imagen y si da abasto.
  const t0 = performance.now();
  for (let i = 0; i < fr.length; i++) {
    const due = t0 + i * 33.3; while (performance.now() < due) await new Promise(r => setTimeout(r, 2));
    sent.set(i * 33333, performance.now());
    dec.decode(new EncodedVideoChunk({ type: fr[i][0] ? "key" : "delta", timestamp: i * 33333, data: fr[i][1] }));
  }
  await dec.flush().catch(e => { err = err || String(e); });
  // Y a toda velocidad: capacidad máxima.
  const dec2 = new VideoDecoder({ output: f => f.close(), error: e => { err = err || String(e); } });
  dec2.configure({ codec: ${JSON.stringify(CODEC)}, codedWidth: ${W}, codedHeight: ${H} });
  const t1 = performance.now();
  for (let i = 0; i < fr.length; i++) dec2.decode(new EncodedVideoChunk({ type: fr[i][0] ? "key" : "delta", timestamp: i * 33333, data: fr[i][1] }));
  await dec2.flush().catch(e => { err = err || String(e); });
  const maxFps = Math.round(fr.length / ((performance.now() - t1) / 1000));
  lat.sort((a, b) => a - b);
  return { frames: fr.length, out, err, latP50: Math.round(lat[lat.length >> 1]), latP90: Math.round(lat[Math.floor(lat.length * 0.9)]), maxFps };
})()`, 120000);
console.log(CODEC, W + "x" + H, JSON.stringify(r));
c.close();
