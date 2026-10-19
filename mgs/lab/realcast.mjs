// El móvil simulado en el Chrome de este ordenador, con el emulador y el disco de
// verdad, enviando a la tele de verdad: el SDK de Cast del móvil se sustituye por
// uno que habla CASTV2 con el Chromecast por la red local (lab/castv2.mjs).
//
//   PLAYWRIGHT=/ruta/node_modules/playwright-core node lab/realcast.mjs 192.168.1.131 BASE DISCO [segundos]
//
// BASE: dónde está play.html (la tele abre screen.html del mismo sitio, así que
// debe poder alcanzarlo: el sitio publicado, o http://IP-de-este-equipo:8765/).
// Ojo: no es el Pixel. El codificador (VideoToolbox) y el camino de los mensajes
// de Cast (aquí un socket directo) son distintos; lo que se prueba es la tele.

import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";
import { connectCast, NS } from "./castv2.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || "playwright-core");

const [HOST = "192.168.1.131", BASE = "https://uxiost.github.io/mgs/", DISC, SECS = "60"] = process.argv.slice(2);
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- SDK de Cast del móvil, puenteado al Chromecast real
const BRIDGE_SENDER = `(() => {
  const listeners = {};
  let current = null;
  const session = {
    sendMessage(ns, msg) { return window.realCastSend(ns, typeof msg === "string" ? msg : JSON.stringify(msg)); },
    addMessageListener(ns, cb) { (listeners[ns] = listeners[ns] || []).push(cb); },
    removeMessageListener(ns, cb) { listeners[ns] = (listeners[ns] || []).filter(x => x !== cb); },
    setMute() { return Promise.resolve(); },
    setVolume() { return Promise.resolve(); },
    getApplicationMetadata() { return { applicationId: window.__appId }; },
  };
  window.__realCastIn = (ns, msg) => (listeners[ns] || []).forEach(cb => cb(ns, msg));
  window.chrome = window.chrome || {};
  chrome.cast = { AutoJoinPolicy: { PAGE_SCOPED: "page_scoped", ORIGIN_SCOPED: "origin_scoped" } };
  const ctx = {
    setOptions(o) { window.__appId = o.receiverApplicationId; },
    getCurrentSession: () => current,
    endCurrentSession() { current = null; },
    requestSession() { current = session; return window.realCastLaunch(window.__appId).then(() => undefined); },
  };
  window.cast = { framework: { CastContext: { getInstance: () => ctx } } };
  setTimeout(() => window.__onGCastApiAvailable && window.__onGCastApiAvailable(true), 0);
})();`;

// REC=archivo.jsonl: guarda lo que se manda a la tele (para repetirlo con lab/replay.mjs).
const rec = process.env.REC ? fs.createWriteStream(process.env.REC) : null;
let c = await connectCast(HOST, { src: "sender-lab" });
let app = null;
const stats = { out: 0, outBytes: 0, in: 0, maxOut: 0 };

const profile = path.join(os.tmpdir(), "mgs-realcast-profile");
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chrome", headless: false,
  viewport: { width: 915, height: 412 },
  args: ["--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"],
});
await ctx.route(/cast_sender\.js/, r => r.fulfill({ contentType: "text/javascript", body: BRIDGE_SENDER }));
const phone = ctx.pages()[0] || await ctx.newPage();
phone.on("pageerror", e => log("PHONE error", e.message));
phone.on("console", m => { if (m.type() === "error" || m.type() === "warning") log("PHONE " + m.type(), m.text().slice(0, 300)); });

// Mensajes de la tele → móvil, en orden.
const q = [];
let busy = false;
const flush = async () => {
  if (busy || !q.length) return;
  busy = true;
  const batch = q.splice(0, q.length);
  try { await phone.evaluate(ms => ms.forEach(([ns, s]) => window.__realCastIn && window.__realCastIn(ns, s)), batch); } catch (e) { /* navegando */ }
  busy = false;
  flush();
};
const fromTv = (obj, m) => { stats.in++; q.push([m.ns, typeof obj === "string" ? obj : JSON.stringify(obj)]); flush(); };
c.on(NS.dashcast, fromTv);

await phone.exposeBinding("realCastLaunch", async (src, appId) => {
  app = await c.launch(appId, { fresh: true });
  log("lanzada", app.displayName, app.transportId);
});
// La página del móvil en localhost (WebCodecs exige contexto seguro): la tele la
// pide a la IP de este equipo en la red local. Y con ;dbg, para tvprobe --eval.
const lanIp = Object.values(os.networkInterfaces()).flat().find(i => i.family === "IPv4" && !i.internal && /^192\.168\.|^10\./.test(i.address))?.address;
await phone.exposeBinding("realCastSend", (src, ns, str) => new Promise((res, rej) => {
  if (!app) return rej(new Error("sin sesión"));
  const m = str.length < 400 ? JSON.parse(str) : null;
  if (m && typeof m.url === "string") {
    m.url = m.url.replace(/\/\/localhost:/, "//" + lanIp + ":") + ";dbg";
    str = JSON.stringify(m);
    log("abre", m.url);
    // Tras navegar, volver a conectar con la app (por si la conexión virtual se pierde).
    for (let i = 1; i <= 8; i++) setTimeout(() => c.connect(app.transportId), i * 1500);
  }
  stats.out++; stats.outBytes += str.length; stats.maxOut = Math.max(stats.maxOut, str.length);
  if (rec) rec.write(JSON.stringify({ at: Date.now(), ns, s: str }) + "\n");
  if (str.length > 64000) return rej(new Error("invalid_parameter"));
  c.send(ns, app.transportId, str);
  // Como el SDK: se confirma cuando el mensaje ha salido.
  if (c.sock.writableNeedDrain) c.sock.once("drain", () => res()); else res();
}));

await phone.goto(BASE + "play.html");
const hasDisc = await phone.locator('[data-play="disc1"]').count();
if (!hasDisc) {
  if (!DISC) throw new Error("falta el disco");
  log("guardando disco", DISC);
  await phone.setInputFiles('input[data-pick="disc1"]', DISC);
  await phone.waitForSelector('[data-play="disc1"]', { timeout: 300000 });
}
await phone.evaluate(() => { document.querySelector("#castMode").value = "native"; });
await phone.click("#castBtn");
await phone.waitForFunction(() => window.EJS_emulator && window.EJS_emulator.started, null, { timeout: 120000 });
log("emulador en marcha");

const t0 = Date.now();
let lastOut = 0;
while (Date.now() - t0 < Number(SECS) * 1000) {
  await sleep(2000);
  const s = await phone.evaluate(() => {
    const n = window.__mgsTvNative;
    if (!n) return { native: false, state: document.querySelector("#tvState").textContent };
    const st = n.stats, tv = st.tv || {};
    return { level: n.level, pending: n.pending, codec: st.codec, sent: st.sentFrames, sentFps: st.sentFps, chunk: st.chunk, sendFails: st.sendFails, flow: st.flowDrops, restarts: st.restarts,
      tv: { shown: tv.shown, dec: tv.dec, adv: tv.adv, lag: tv.lag, lost: tv.lost, jumps: tv.jumps, stalls: tv.stalls, drops: tv.drops, restarts: tv.restarts, rate: tv.rate, res: tv.res, err: tv.err } };
  }).catch(e => ({ err: String(e) }));
  const kbps = Math.round((stats.outBytes - lastOut) * 8 / 2 / 1000);
  lastOut = stats.outBytes;
  log(JSON.stringify(s), `→tele ${stats.out} msgs ${kbps} kbps (base64)  ←tele ${stats.in}`);
}
if (process.env.KEEP) { log("KEEP: sigue enviando; Ctrl+C para parar"); await new Promise(() => {}); }
await ctx.close();
c.close();
