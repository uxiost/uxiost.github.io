// Repite en la tele de verdad una emisión grabada con `REC=… lab/realcast.mjs`,
// con los mismos tiempos, y muestra lo que la tele cuenta cada segundo. Sirve para
// ajustar el reproductor de la tele (native.js) sin emulador ni móvil.
//
//   node lab/replay.mjs 192.168.1.131 grabacion.jsonl [BASE] [flags]
//   p. ej.  node lab/replay.mjs 192.168.1.131 rec.jsonl http://192.168.1.143:8765/ ";norate"

import fs from "fs";
import { connectCast, NS } from "./castv2.mjs";

const [HOST, FILE, BASE = "http://192.168.1.143:8765/", FLAGS = ""] = process.argv.slice(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

const recs = fs.readFileSync(FILE, "utf8").trim().split("\n").map(l => JSON.parse(l));
const from = recs.findIndex(r => r.s.startsWith('{"t":"start"'));
const msgs = recs.slice(from).filter(r => /^\{"t":"(start|seg)"/.test(r.s));

const c = await connectCast(HOST, { src: "sender-replay" });
const app = await c.launch("84912283", { fresh: true });
let hello = null, last = null, dump = null;
const stats = [];
c.on(NS.dashcast, m => {
  if (!m || !m.t) return;
  if (m.t === "hello") hello = m;
  else if (m.t === "stats") { stats.push(m); last = m; }
  else if (m.t === "dumpr") dump = m.r;
});
c.send(NS.dashcast, app.transportId, { url: BASE + "screen.html#rep" + Date.now() % 1000 + ";noaudio;native;dbg" + FLAGS, force: true, reload: false, reload_time: 0 });
for (let i = 0; i < 40 && !hello; i++) { await sleep(500); c.connect(app.transportId); c.send(NS.dashcast, app.transportId, { t: "ping" }); }
if (!hello) { log("sin saludo"); process.exit(1); }
log("hello v" + hello.v, "→ repitiendo", msgs.length, "mensajes,", Math.round((msgs.at(-1).at - msgs[0].at) / 1000), "s");

// SAMPLE=archivo.json: la tele anota cada 50 ms reloj, posición, finales de búfer,
// imágenes decodificadas y llegada de imágenes clave; al acabar se guarda aquí.
const SAMPLER = `(() => {
  window.__smp = [];
  const v = document.querySelector("#video");
  const end = b => b && b.length ? Math.round(b.end(b.length - 1) * 1000) : 0;
  setInterval(() => {
    const st = window.__mgsNative && __mgsNative.state;
    if (!st || !st.tracks.v || !st.tracks.v.sb) return;
    const tv = st.tracks.v, ta = st.tracks.a;
    __smp.push([Math.round(performance.now()), Math.round(v.currentTime * 1000), end(tv.sb.buffered), ta ? end(ta.sb.buffered) : 0,
      tv.sb.buffered.length, ta ? ta.sb.buffered.length : 0, v.getVideoPlaybackQuality().totalVideoFrames, v.readyState, st.appended, tv.last && tv.last.key ? 1 : 0, Math.round(v.playbackRate * 100)]);
    if (__smp.length > 3000) __smp.shift();
  }, 50);
  return true;
})()`;
const answer = new Map();
c.on(NS.dashcast, m => { if (m && m.t === "dbgr" && answer.has(m.id)) { answer.get(m.id)(m.r); answer.delete(m.id); } });
let qn = 100;
const dbg = (e, ms = 8000) => new Promise(res => { const id = ++qn; answer.set(id, res); c.send(NS.dashcast, app.transportId, { t: "dbg", id, e }); setTimeout(() => { if (answer.delete(id)) res(null); }, ms); });
if (process.env.SAMPLE) log("muestreo en la tele:", await dbg(SAMPLER));

const iv = setInterval(() => {
  const s = last;
  if (s && s.t === "stats") log(`shown ${s.shown} dec ${s.dec} adv ${s.adv} lag ${s.lag} rs ${s.rs} rate ${s.rate} target ${s.target} jumps ${s.jumps} stalls ${s.stalls} lost ${s.lost} restarts ${s.restarts}${s.err ? " err " + s.err : ""}`);
}, 1000);
const t0 = Date.now(), r0 = msgs[0].at;
for (const m of msgs) {
  const due = t0 + (m.at - r0);
  if (due > Date.now()) await sleep(due - Date.now());
  c.send(NS.dashcast, app.transportId, m.s);
}
await sleep(1500);
clearInterval(iv);
// Resumen: fps decodificados de media, retraso típico, saltos y paradas.
const tail = stats.slice(3);
const avg = k => Math.round(tail.reduce((a, s) => a + (s[k] || 0), 0) / Math.max(1, tail.length) * 10) / 10;
const lags = tail.map(s => s.lag).filter(x => x != null).sort((a, b) => a - b);
log(`RESUMEN dec ${avg("dec")} adv ${avg("adv")} lag p50 ${lags[Math.floor(lags.length / 2)]} p90 ${lags[Math.floor(lags.length * 0.9)]} jumps ${last && last.jumps} stalls ${last && last.stalls}`);
c.send(NS.dashcast, app.transportId, { t: "dump", id: 1 });
await sleep(1500);
if (dump) console.log(JSON.stringify(dump.s && dump.s.log.slice(-40)));
if (process.env.SAMPLE) {
  const smp = await dbg("__smp", 15000);
  fs.writeFileSync(process.env.SAMPLE, JSON.stringify(smp));
  log("muestras:", smp && smp.length, "→", process.env.SAMPLE);
}
c.close();
