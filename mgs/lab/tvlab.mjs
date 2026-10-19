// Laboratorio automático: reproduce la tele LG (Chromecast integrado) en Chromium
// y mide el envío móvil → tele de verdad, sin nadie delante.
//
//   node lab/tvlab.mjs [url_base] [segundos]
//
// "Tele": identidad CrKey, sin canales de datos WebRTC (igual que la LG), sin GPU
// y con la CPU ralentizada 6× (la LG tarda ~1.3–1.45 s en la prueba de CPU que
// aquí tarda ~0.21 s). "Móvil": lab/phone.html, el mismo código de envío que la
// app con una fuente sintética de 60 fps que lleva la hora codificada en la imagen.
//
// Mide: fps que se pintan en la tele, retraso real extremo a extremo (leyendo la
// hora de la imagen), tirones, coste de decodificación, lo que limita al emisor,
// que el sonido sale por el reproductor multimedia y cuánto tarda en recuperarse
// si el móvil congela la página unos segundos.

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || "/opt/node-tools/node_modules/playwright");

const BASE = process.argv[2] || "http://localhost:8765/";
const SECONDS = Number(process.argv[3] || 45);
const TV_CPU_SLOWDOWN = Number(process.env.TV_CPU || 6);
const code = "lab" + Math.random().toString(36).slice(2, 7);

const tvBrowser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--disable-gpu"] });
const phoneBrowser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const errors = [];

// ---- tele
const tvCtx = await tvBrowser.newContext({
  viewport: { width: 1920, height: 1080 },
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 CrKey/1.56.500000 TVLAB",
});
await tvCtx.addInitScript(() => {
  // La LG rechaza cualquier SDP con canal de datos.
  const P = RTCPeerConnection.prototype;
  for (const m of ["setLocalDescription", "setRemoteDescription"]) {
    const o = P[m];
    P[m] = function (d, ...r) {
      if (d && d.sdp && d.sdp.includes("m=application")) {
        return Promise.reject(new DOMException("Failed to create data channel.", "OperationError"));
      }
      return o.call(this, d, ...r);
    };
  }
});
const tv = await tvCtx.newPage();
tv.on("pageerror", e => errors.push("TV " + e.message));
const cdp = await tvCtx.newCDPSession(tv);
await cdp.send("Emulation.setCPUThrottlingRate", { rate: TV_CPU_SLOWDOWN });
await tv.goto(BASE + "screen.html#" + code);
await tv.waitForFunction(() => document.querySelector("#state").textContent.includes("Esperando"), null, { timeout: 60000 });

// ---- móvil simulado
const phone = await (await phoneBrowser.newContext({ viewport: { width: 915, height: 412 } })).newPage();
phone.on("pageerror", e => errors.push("PHONE " + e.message));
// Móvil sobrecargado (emulador + calor): PHONE_CPU=3 lo ralentiza 3×.
if (process.env.PHONE_CPU) {
  const pc = await phone.context().newCDPSession(phone);
  await pc.send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.PHONE_CPU) });
}
await phone.goto(BASE + "lab/phone.html" + (process.env.Q ? "?" + process.env.Q : "") + "#" + code);
await phone.waitForFunction(() => window.labStatus && window.labStatus.some(s => s.includes("En la tele")), null, { timeout: 60000 });
await phone.evaluate(() => window.startTone());

// ---- medición en la tele
await tv.evaluate(async base => {
  const { readLatency } = await import(base + "lab/stamp.js");
  const v = document.querySelector("#video");
  const c = document.createElement("canvas");
  const g = c.getContext("2d", { willReadFrequently: true });
  window.__lab = { frames: [], lat: [] };
  let n = 0;
  const onFrame = (now, meta) => {
    window.__lab.frames.push(now);
    // Leer la hora 1 de cada 3 fotogramas (leerla cuesta CPU en la "tele" lenta).
    if (++n % 3 === 0 && v.videoWidth) {
      const w = v.videoWidth, h = v.videoHeight;
      if (c.width !== w) { c.width = w; c.height = Math.ceil(h * 0.07); }
      g.drawImage(v, 0, 0, w, c.height, 0, 0, w, c.height);
      const l = readLatency(g, w, h);
      if (l != null) window.__lab.lat.push([now, l]);
    }
    v.requestVideoFrameCallback(onFrame);
  };
  v.requestVideoFrameCallback(onFrame);
}, BASE);

async function window_(page, ms) { await page.waitForTimeout(ms); }
await window_(tv, 8000); // calentamiento
const t0 = await tv.evaluate(() => performance.now());
await window_(tv, SECONDS * 1000);
const t1 = await tv.evaluate(() => performance.now());

const steady = await tv.evaluate(async ([t0, t1]) => {
  const fr = window.__lab.frames.filter(t => t >= t0 && t <= t1);
  const gaps = fr.slice(1).map((t, i) => t - fr[i]);
  const lat = window.__lab.lat.filter(([t]) => t >= t0 && t <= t1).map(([, l]) => l).sort((a, b) => a - b);
  const q = p => lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : null;
  const out = {
    shownFps: Math.round(fr.length / ((t1 - t0) / 1000) * 10) / 10,
    stalls200ms: gaps.filter(x => x > 200).length,
    worstGapMs: Math.round(Math.max(0, ...gaps)),
    latencyMs: { p50: q(0.5), p95: q(0.95), max: lat.length ? lat[lat.length - 1] : null, samples: lat.length },
  };
  return out;
}, [t0, t1]);

// Estadísticas WebRTC de ambos lados
const tvStats = await tv.evaluate(async () => {
  const v = document.querySelector("#video");
  const out = { res: [v.videoWidth, v.videoHeight] };
  const m = window.__mgsAudio && window.__mgsAudio.mse;
  if (m) out.mse = m.info();
  return out;
});
const phoneStats = await phone.evaluate(async () => {
  const out = { level: window.labStream && window.labStream.level, tvFpsViaBack: window.labStream && window.labStream.tvFps, backSamples: window.labStream && window.labStream.tvSamples, status: window.labStatus.slice(-3) };
  const pcs = Object.values(window.labPeer.connections).flat().map(c => c.peerConnection).filter(Boolean);
  const pc = pcs.find(p => p.connectionState === "connected");
  if (!pc) return { pc: "none" };
  (await pc.getStats()).forEach(r => {
    if (r.type === "outbound-rtp" && r.kind === "video") Object.assign(out, {
      sentRes: [r.frameWidth, r.frameHeight], encFps: r.framesPerSecond, limit: r.qualityLimitationReason,
      limitDurations: r.qualityLimitationDurations, targetKbps: Math.round((r.targetBitrate || 0) / 1000),
      encMs: r.framesEncoded ? Math.round(1000 * r.totalEncodeTime / r.framesEncoded * 10) / 10 : null, codec: r.codecId,
    });
  });
  return out;
});

// Audio: ¿sale la señal por el reproductor multimedia de la tele?
const audio = await tv.evaluate(async () => {
  const m = window.__mgsAudio && window.__mgsAudio.mse;
  if (!m) return { route: "sin MSE" };
  const ctx = new AudioContext();
  await ctx.resume();
  const an = ctx.createAnalyser();
  ctx.createMediaStreamSource(m.el.captureStream()).connect(an);
  const b = new Float32Array(2048);
  let peak = 0;
  for (let i = 0; i < 10; i++) { await new Promise(r => setTimeout(r, 100)); an.getFloatTimeDomainData(b); for (const x of b) peak = Math.max(peak, Math.abs(x)); }
  return { route: "MSE", peak: Math.round(peak * 1000) / 1000, ...m.info() };
});

// Mando de la tele: flecha derecha en la "tele" → debe llegar al móvil por el vídeo de vuelta.
await tv.keyboard.down("ArrowRight");
await tv.waitForTimeout(400);
await tv.keyboard.up("ArrowRight");
await tv.waitForTimeout(600);
const tvRemote = await phone.evaluate(() => window.labKeys.slice());

// Robustez: el móvil congela la página 6 s (pantalla apagada, cambio de app…).
const phoneCdp = await phone.context().newCDPSession(phone);
await phoneCdp.send("Page.setWebLifecycleState", { state: "frozen" });
await phone.waitForTimeout(6000);
const tFreezeEnd = await tv.evaluate(() => performance.now());
await phoneCdp.send("Page.setWebLifecycleState", { state: "active" });
let recoverMs = null;
for (let i = 0; i < 60; i++) {
  await tv.waitForTimeout(500);
  const ok = await tv.evaluate(t => window.__lab.lat.some(([ts, l]) => ts > t && l < 1000), tFreezeEnd);
  if (ok) { recoverMs = Math.round((await tv.evaluate(() => performance.now())) - tFreezeEnd); break; }
}

const result = {
  variant: process.env.Q || "default", base: BASE, tvCpuSlowdown: TV_CPU_SLOWDOWN, phoneCpuSlowdown: Number(process.env.PHONE_CPU || 1), seconds: SECONDS,
  steady, tv: tvStats, phone: phoneStats, audio, tvRemoteKeys: tvRemote, recoverAfterFreezeMs: recoverMs,
  errors: errors.filter(e => !/Wake Lock/.test(e)),
};
const pass = {
  fps: steady.shownFps >= 25,
  latency: steady.latencyMs.p95 != null && steady.latencyMs.p95 <= 200,
  stalls: steady.stalls200ms <= 1,
  audio: audio.peak > 0.1,
  recovery: recoverMs != null && recoverMs <= 8000,
  tvRemote: tvRemote.includes(1 << 7) && tvRemote[tvRemote.length - 1] === 0,
};
result.pass = pass;
result.ok = Object.values(pass).every(Boolean);
console.log(JSON.stringify(result, null, 2));
await tvBrowser.close();
await phoneBrowser.close();
process.exit(result.ok ? 0 : 1);
