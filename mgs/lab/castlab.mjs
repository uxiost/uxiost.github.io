// Prueba de extremo a extremo del botón «Enviar al Chromecast», sin Chromecast:
// simula el SDK de Cast en el móvil y el receptor en la tele, con un juego libre.
//
//   node lab/castlab.mjs [url_base] [ruta_disco.zip]
//
// SDK simulado del móvil: requestSession «abre» la app receptora (página en blanco
// en la tele), y el mensaje de DashCast con force=true navega la tele a la página
// pedida, como hace el receptor de verdad. El receptor simulado (CAF) entrega a la
// página de la tele los mensajes de la sesión y devuelve sus respuestas.
//
// Comprueba el envío directo (vídeo y sonido por el reproductor de la tele), que
// conectar un mando a mitad de partida no lo rompe y, con CAST_BROKEN=1 (la tele no
// entrega los mensajes de la sesión), que se queda en WebRTC y sigue viéndose.

import { createRequire } from "module";
import fs from "fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || "/opt/node-tools/node_modules/playwright");

const BASE = process.argv[2] || "http://localhost:8765/";
const DISC = process.argv[3];
const BROKEN = !!process.env.CAST_BROKEN;
const errors = [];
const log = [];

// ---- SDK de Cast simulado (móvil)
const FAKE_SENDER = `(() => {
  const listeners = {};
  let current = null;
  const session = {
    sendMessage(ns, msg) { return window.labCastSend(ns, typeof msg === "string" ? msg : JSON.stringify(msg)).then(() => undefined); },
    addMessageListener(ns, cb) { (listeners[ns] = listeners[ns] || []).push(cb); },
    removeMessageListener(ns, cb) { listeners[ns] = (listeners[ns] || []).filter(x => x !== cb); },
    setMute() { return Promise.resolve(); },
    setVolume() { return Promise.resolve(); },
    getApplicationMetadata() { return { applicationId: window.__labAppId }; },
  };
  window.__labCastIn = (ns, msg) => (listeners[ns] || []).forEach(cb => cb(ns, msg));
  window.chrome = window.chrome || {};
  chrome.cast = { AutoJoinPolicy: { PAGE_SCOPED: "page_scoped", ORIGIN_SCOPED: "origin_scoped" } };
  const ctx = {
    setOptions(o) { window.__labAppId = o.receiverApplicationId; },
    getCurrentSession: () => current,
    endCurrentSession() { current = null; window.labCastEnd(); },
    requestSession() { current = session; return window.labCastLaunch(window.__labAppId).then(() => undefined); },
  };
  window.cast = { framework: { CastContext: { getInstance: () => ctx } } };
  setTimeout(() => window.__onGCastApiAvailable && window.__onGCastApiAvailable(true), 0);
})();`;

// ---- receptor CAF simulado (tele)
const FAKE_RECEIVER = `(() => {
  const ls = {};
  window.__labCafIn = (ns, m) => (ls[ns] || []).forEach(cb => cb({ senderId: "phone", data: m }));
  const ctx = {
    addCustomMessageListener(ns, cb) { (ls[ns] = ls[ns] || []).push(cb); },
    start() { window.__labCafStarted = true; },
    sendCustomMessage(ns, sender, obj) { window.labCafOut(ns, JSON.stringify(obj)); },
  };
  window.cast = { framework: {
    CastReceiverContext: { getInstance: () => ctx },
    CastReceiverOptions: function () {},
    system: { MessageType: { JSON: "json" } },
  } };
})();`;

// Mensajes en orden y por lotes hacia una página.
function pipe(getPage, fn) {
  const q = [];
  let busy = false;
  const flush = async () => {
    if (busy || !q.length) return;
    busy = true;
    const batch = q.splice(0, q.length);
    try { await getPage().evaluate(([fn, ms]) => ms.forEach(a => window[fn] && window[fn](...a)), [fn, batch]); } catch (e) { /* navegando */ }
    busy = false;
    flush();
  };
  return (...args) => { q.push(args); flush(); };
}

// ---- tele
const tvBrowser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--disable-gpu"] });
const tvCtx = await tvBrowser.newContext({
  viewport: { width: 1920, height: 1080 },
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 CrKey/1.56.500000 TVLAB",
});
await tvCtx.addInitScript(() => {
  const P = RTCPeerConnection.prototype;
  for (const m of ["setLocalDescription", "setRemoteDescription"]) {
    const o = P[m];
    P[m] = function (d, ...r) {
      if (d && d.sdp && d.sdp.includes("m=application")) return Promise.reject(new DOMException("Failed to create data channel.", "OperationError"));
      return o.call(this, d, ...r);
    };
  }
});
await tvCtx.route(/cast_receiver_framework\.js/, r => r.fulfill({ contentType: "text/javascript", body: FAKE_RECEIVER }));
const tv = await tvCtx.newPage();
tv.on("pageerror", e => errors.push("TV " + e.message));
await (await tvCtx.newCDPSession(tv)).send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.TV_CPU || 6) });
await tv.goto("about:blank");

// ---- móvil
const phoneBrowser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const phCtx = await phoneBrowser.newContext({ viewport: { width: 915, height: 412 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.6 });
await phCtx.addInitScript(() => {
  window.__pad = null;
  navigator.getGamepads = () => [window.__pad, null, null, null];
});
await phCtx.route(/cast_sender\.js/, r => r.fulfill({ contentType: "text/javascript", body: FAKE_SENDER }));
const phone = await phCtx.newPage();
phone.on("pageerror", e => errors.push("PHONE " + e.message));

const stats = { toTv: 0, toPhone: 0, navigations: [] };
const toTv = pipe(() => tv, "__labCafIn");
const toPhone = pipe(() => phone, "__labCastIn");
await phone.exposeBinding("labCastLaunch", async () => { log.push("launch"); await tv.goto("about:blank").catch(() => {}); });
await phone.exposeBinding("labCastEnd", () => { log.push("end"); });
await phone.exposeBinding("labCastSend", (src, ns, str) => {
  const m = JSON.parse(str);
  if (typeof m.url === "string" && (m.force !== undefined || m.type)) {
    // Receptor DashCast / URL Cast: abre la dirección (force/loc: a pantalla completa).
    stats.navigations.push({ force: !!m.force || m.type === "loc", url: m.url.replace(/^.*screen/, "screen") });
    tv.goto(m.url).catch(e => errors.push("TV goto " + e.message));
    return;
  }
  stats.toTv++;
  if (!BROKEN) toTv(ns, m);
});
await tv.exposeBinding("labCafOut", (src, ns, str) => { stats.toPhone++; toPhone(ns, str); });

await phone.goto(BASE + "play.html");
await phone.setInputFiles('input[data-pick="disc1"]', { name: "juego.zip", mimeType: "application/zip", buffer: fs.readFileSync(DISC) });
await phone.waitForSelector('[data-play="disc1"]');
const castMode = await phone.evaluate(() => document.querySelector("#castMode").value);
await phone.click("#castBtn"); // abre la tele y, con disco guardado, arranca el juego
await phone.waitForFunction(() => window.EJS_emulator && window.EJS_emulator.started, null, { timeout: 120000 });

// Esperar a que la tele muestre el juego (envío directo, o WebRTC si falla).
const t0 = Date.now();
let mode = null;
while (Date.now() - t0 < 90000) {
  await phone.waitForTimeout(1000);
  mode = await tv.evaluate(() => {
    const v = document.querySelector("#video");
    if (!v || v.videoWidth < 300) return null;
    if (window.__mgsNative && window.__mgsNative.active) return "native";
    if (v.srcObject) return "webrtc";
    return null;
  }).catch(() => null);
  if (mode === "native" || (mode && BROKEN && Date.now() - t0 > 30000)) break;
}
const tFirst = Math.round((Date.now() - t0) / 1000);
await tv.evaluate(() => {
  const v = document.querySelector("#video");
  window.__f = [];
  const cb = now => { window.__f.push(now); v.requestVideoFrameCallback(cb); };
  v.requestVideoFrameCallback(cb);
});
// fps que pinta la tele, y (envío directo) los que manda el móvil en el mismo rato:
// el móvil de pruebas no siempre llega a 30, y la tele se juzga por lo que recibe.
const sentNow = () => phone.evaluate(() => [performance.now(), window.__mgsTvNative ? window.__mgsTvNative.stats.sentFrames : null]);
const sentFps = [];
const fpsBetween = async ms => {
  const a = await tv.evaluate(() => [performance.now(), window.__f.length]);
  const pa = await sentNow();
  await tv.waitForTimeout(ms);
  const b = await tv.evaluate(() => [performance.now(), window.__f.length]);
  const pb = await sentNow();
  sentFps.push(pa[1] != null && pb[1] != null ? Math.round((pb[1] - pa[1]) / ((pb[0] - pa[0]) / 1000) * 10) / 10 : null);
  return Math.round((b[1] - a[1]) / ((b[0] - a[0]) / 1000) * 10) / 10;
};
await tv.waitForTimeout(3000);
const before = await fpsBetween(10000);

// ¿Sale sonido por el reproductor de la tele? ¿Está callado el móvil?
const tvAudio = await tv.evaluate(async () => {
  const v = document.querySelector("#video");
  if (!(window.__mgsNative && window.__mgsNative.active)) return { route: "webrtc", muted: v.muted };
  const cap = v.captureStream();
  if (!cap.getAudioTracks().length) return { route: "native", track: false, muted: v.muted };
  const ctx = new AudioContext();
  await ctx.resume();
  const an = ctx.createAnalyser();
  ctx.createMediaStreamSource(cap).connect(an);
  const b = new Float32Array(2048);
  let peak = 0;
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 100)); an.getFloatTimeDomainData(b); for (const x of b) peak = Math.max(peak, Math.abs(x)); }
  return { route: "native", track: true, muted: v.muted, peak: Math.round(peak * 1000) / 1000 };
});
const phoneAudio = await phone.evaluate(() => {
  const t = window.__mgsTaps ? [...window.__mgsTaps.values()][0] : null;
  return t ? { localGain: t.local.gain.value } : null;
});

// Mando Bluetooth conectado a mitad de partida.
await phone.evaluate(() => {
  window.__pad = { id: "Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)", index: 0, connected: true, mapping: "standard", axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })), timestamp: 1 };
  window.dispatchEvent(new Event("gamepadconnected"));
});
for (let i = 0; i < 6; i++) {
  await phone.evaluate(i => { window.__pad.buttons[i % 4].pressed = true; window.__pad.axes = [i % 2 ? 0.9 : -0.9, 0, 0, 0]; window.__pad.timestamp++; }, i);
  await phone.waitForTimeout(300);
  await phone.evaluate(i => { window.__pad.buttons[i % 4].pressed = false; window.__pad.axes = [0, 0, 0, 0]; window.__pad.timestamp++; }, i);
  await phone.waitForTimeout(300);
}
const emuFps = async () => {
  const a = await phone.evaluate(() => [performance.now(), window.EJS_emulator.gameManager.getFrameNum(), window.__mgsTvNative ? window.__mgsTvNative.stats.framesIn : 0]);
  await phone.waitForTimeout(3000);
  const b = await phone.evaluate(() => [performance.now(), window.EJS_emulator.gameManager.getFrameNum(), window.__mgsTvNative ? window.__mgsTvNative.stats.framesIn : 0]);
  const dt = (b[0] - a[0]) / 1000;
  return { emu: Math.round((b[1] - a[1]) / dt), captured: Math.round((b[2] - a[2]) / dt) };
};
const phoneRates = await emuFps();
const after = await fpsBetween(10000);
const tvInfo = await tv.evaluate(() => {
  const v = document.querySelector("#video");
  const n = window.__mgsNative && window.__mgsNative.state;
  return { url: location.hash, res: [v.videoWidth, v.videoHeight], stat: document.querySelector("#stat").textContent,
    native: n ? { jumps: n.jumps, drops: n.drops || 0, stalls: n.stalls || 0, err: n.err, target: n.target } : null };
});
const phoneInfo = await phone.evaluate(() => ({ tvState: document.querySelector("#tvState").textContent, toast: document.querySelector("#toast").textContent,
  reports: (window.__mgsReports || []).filter(e => /native|fallback|pc-state/.test(e.s)).slice(-12) }));
tvInfo.reports = await tv.evaluate(() => (window.__mgsReports || []).filter(e => /native|call|pc-state/.test(e.s)).slice(-12));

const result = {
  variant: BROKEN ? "cast-broken" : "cast", castMode, mode, firstImageS: tFirst, tvFpsBefore: before, tvFpsAfterGamepad: after, phoneSentFps: sentFps, phoneRates,
  tvAudio, phoneAudio, tv: tvInfo, phone: phoneInfo, messages: stats, log, errors: errors.filter(e => !/Wake Lock/.test(e)),
};
result.pass = BROKEN
  ? { webrtc: mode === "webrtc", fps: before > 10 && after > 10, noErrors: !result.errors.length }
  : {
    native: mode === "native",
    fps: [before, after].every((f, i) => f >= Math.min(25, (process.env.CI ? 0.7 : 0.85) * (sentFps[i] || 30)) && f >= 10),
    noErrors: !result.errors.length,
    tvSound: tvAudio.track === true && tvAudio.muted === false, phoneQuiet: !!phoneAudio && phoneAudio.localGain === 0,
  };
result.ok = Object.values(result.pass).every(Boolean);
console.log(JSON.stringify(result, null, 2));
await tvBrowser.close();
await phoneBrowser.close();
process.exit(result.ok ? 0 : 1);
