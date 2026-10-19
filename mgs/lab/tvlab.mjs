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
import fs from "fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || "/opt/node-tools/node_modules/playwright");

const BASE = process.argv[2] || "http://localhost:8765/";
const SECONDS = Number(process.argv[3] || 45);
// Ralentización de la "tele": por defecto se calibra para que la prueba de CPU de
// test.html tarde lo mismo que en la LG real (~1350 ms), sea cual sea esta máquina.
const LG_BENCH_MS = 1350;
let TV_CPU_SLOWDOWN = Number(process.env.TV_CPU || 0);
const code = "lab" + Math.random().toString(36).slice(2, 7);

// La "tele" limitada también en capacidad total de CPU (decodificador de vídeo y
// compositor incluidos, que la ralentización de DevTools no toca), con un cgroup:
// TV_CORES núcleos de esta máquina en total (por defecto 0.65 ≈ 4 núcleos ARM lentos).
import { execSync } from "child_process";
// 1.3 reproduce lo medido en la LG real (640×480 → ~25 fps pintados); 0.8 = tele en apuros.
const TV_CORES = Number(process.env.TV_CORES ?? 1.3);
const tvServer = await chromium.launchServer({ args: ["--autoplay-policy=no-user-gesture-required", "--disable-gpu"] });
let cgroup = null;
if (TV_CORES > 0) {
  try {
    cgroup = "/sys/fs/cgroup/cpu/tvlab-" + process.pid;
    fs.mkdirSync(cgroup, { recursive: true });
    fs.writeFileSync(cgroup + "/cpu.cfs_period_us", "20000");
    fs.writeFileSync(cgroup + "/cpu.cfs_quota_us", String(Math.round(TV_CORES * 20000)));
    const root = tvServer.process().pid;
    const tree = execSync(`ps -e -o pid=,ppid=`).toString().trim().split("\n").map(l => l.trim().split(/\s+/).map(Number));
    const pids = new Set([root]);
    for (let changed = true; changed;) {
      changed = false;
      for (const [p, pp] of tree) if (pids.has(pp) && !pids.has(p)) { pids.add(p); changed = true; }
    }
    for (const p of pids) { try { fs.writeFileSync(cgroup + "/cgroup.procs", String(p)); } catch (e) { /* ya terminó */ } }
  } catch (e) {
    console.error("sin cgroup (", e.message, "): solo se ralentiza el hilo principal");
    cgroup = null;
  }
}
const tvBrowser = await chromium.connect(tvServer.wsEndpoint());
const phoneBrowser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const errors = [];

// ---- tele
const tvCtx = await tvBrowser.newContext({
  viewport: process.env.TV_720 ? { width: 1280, height: 720 } : { width: 1920, height: 1080 },
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
if (!TV_CPU_SLOWDOWN) {
  await tv.goto("about:blank");
  const bench = await tv.evaluate(() => {
    const runs = [];
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now(); let x = 1, acc = 0;
      for (let i = 0; i < 30_000_000; i++) { x = (x * 1103515245 + 12345) | 0; acc ^= x >>> 7; }
      runs.push(performance.now() - t0 + (acc === 0.5 ? 1 : 0));
    }
    return Math.min(...runs);
  });
  TV_CPU_SLOWDOWN = Math.max(1, Math.round(LG_BENCH_MS / bench * 10) / 10);
}
await cdp.send("Emulation.setCPUThrottlingRate", { rate: TV_CPU_SLOWDOWN });
await tv.goto(BASE + "screen.html#" + code + (process.env.TV_FLAGS ? ";" + process.env.TV_FLAGS : ""));
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
  const pc = window.__mgsCall && window.__mgsCall.peerConnection;
  if (pc) (await pc.getStats()).forEach(r => {
    if (r.type === "inbound-rtp" && r.kind === "video") Object.assign(out, {
      jbAvgMs: r.jitterBufferEmittedCount ? Math.round(1000 * r.jitterBufferDelay / r.jitterBufferEmittedCount) : null,
      jbTargetMs: r.jitterBufferEmittedCount ? Math.round(1000 * r.jitterBufferTargetDelay / r.jitterBufferEmittedCount) : null,
      procMs: r.framesDecoded ? Math.round(1000 * r.totalProcessingDelay / r.framesDecoded) : null,
      decMs: r.framesDecoded ? Math.round(1000 * r.totalDecodeTime / r.framesDecoded * 10) / 10 : null,
      received: r.framesReceived, decoded: r.framesDecoded, dropped: r.framesDropped, freezes: r.freezeCount, pli: r.pliCount, nack: r.nackCount,
    });
  });
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
  variant: [process.env.Q, process.env.TV_FLAGS, process.env.TV_720 && "720"].filter(Boolean).join(" ") || "default", base: BASE, tvCpuSlowdown: TV_CPU_SLOWDOWN, tvCores: cgroup ? TV_CORES : "sin límite", phoneCpuSlowdown: Number(process.env.PHONE_CPU || 1), seconds: SECONDS,
  steady, tv: tvStats, phone: phoneStats, audio, tvRemoteKeys: tvRemote, recoverAfterFreezeMs: recoverMs,
  errors: errors.filter(e => !/Wake Lock/.test(e)),
};
// La tele se juzga por lo que recibe: debe pintar casi todo lo que el móvil envía
// (si el móvil de pruebas no llega a 30 fps, es cosa de esta máquina, no de la tele).
const sentFps = phoneStats.encFps || 30;
result.phoneLimited = phoneStats.limit && phoneStats.limit !== "none";
const pass = {
  fps: steady.shownFps >= Math.min(25, sentFps * 0.85) && steady.shownFps >= 18,
  latency: steady.latencyMs.p95 != null && steady.latencyMs.p95 <= (result.phoneLimited ? 300 : 200),
  stalls: steady.stalls200ms <= (result.phoneLimited ? 4 : 1),
  audio: audio.peak > 0.1,
  recovery: recoverMs != null && recoverMs <= 8000,
  tvRemote: tvRemote.includes(1 << 7) && tvRemote[tvRemote.length - 1] === 0,
};
result.pass = pass;
result.ok = Object.values(pass).every(Boolean);
console.log(JSON.stringify(result, null, 2));
await tvBrowser.close();
await tvServer.close();
await phoneBrowser.close();
if (cgroup) { try { fs.rmdirSync(cgroup); } catch (e) { /* quedan procesos cerrándose */ } }
process.exit(result.ok ? 0 : 1);
