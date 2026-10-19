// Prueba de la app completa (play.html con el emulador y un juego de PS1 libre)
// contra la tele simulada de tvlab.mjs. Comprueba que el juego llega a la tele,
// a qué fps, y que conectar un mando Bluetooth a mitad de partida no lo rompe.
//
//   node lab/applab.mjs [url_base] [ruta_disco.zip]

import { createRequire } from "module";
import fs from "fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || "/opt/node-tools/node_modules/playwright");

const BASE = process.argv[2] || "http://localhost:8765/";
const DISC = process.argv[3];
const code = "app" + Math.random().toString(36).slice(2, 7);
const errors = [];

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
const tv = await tvCtx.newPage();
tv.on("pageerror", e => errors.push("TV " + e.message));
await (await tvCtx.newCDPSession(tv)).send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.TV_CPU || 6) });
await tv.goto(BASE + "screen.html#" + code);
await tv.waitForFunction(() => document.querySelector("#state").textContent.includes("Esperando"), null, { timeout: 60000 });
await tv.evaluate(() => {
  const v = document.querySelector("#video");
  window.__f = [];
  const cb = now => { window.__f.push(now); v.requestVideoFrameCallback(cb); };
  v.requestVideoFrameCallback(cb);
});

// Móvil con un mando simulado que se "conecta" a mitad de partida.
const phoneBrowser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const phCtx = await phoneBrowser.newContext({ viewport: { width: 915, height: 412 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.6 });
await phCtx.addInitScript(() => {
  window.__pad = null;
  navigator.getGamepads = () => [window.__pad, null, null, null];
});
const phone = await phCtx.newPage();
phone.on("pageerror", e => errors.push("PHONE " + e.message));
await phone.goto(BASE + "play.html");
await phone.setInputFiles('input[data-pick="disc1"]', { name: "juego.zip", mimeType: "application/zip", buffer: fs.readFileSync(DISC) });
await phone.waitForSelector('[data-play="disc1"]');
await phone.fill("#tvCode", code);
await phone.click("#tvForm button"); // con disco guardado arranca solo
await phone.waitForFunction(() => window.EJS_emulator && window.EJS_emulator.started, null, { timeout: 120000 });
await tv.waitForFunction(() => document.querySelector("#video").videoWidth > 300, null, { timeout: 60000 });

const fpsBetween = async ms => {
  const a = await tv.evaluate(() => [performance.now(), window.__f.length]);
  await tv.waitForTimeout(ms);
  const b = await tv.evaluate(() => [performance.now(), window.__f.length]);
  return Math.round((b[1] - a[1]) / ((b[0] - a[0]) / 1000) * 10) / 10;
};
await tv.waitForTimeout(6000);
const before = await fpsBetween(10000);
const resBefore = await tv.evaluate(() => [document.querySelector("#video").videoWidth, document.querySelector("#video").videoHeight]);

// Conectar el mando: evento + estado de Gamepad API, y pulsar botones.
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
const after = await fpsBetween(10000);
const resAfter = await tv.evaluate(() => [document.querySelector("#video").videoWidth, document.querySelector("#video").videoHeight]);
const emuFps = await phone.evaluate(async () => {
  const a = [performance.now(), window.EJS_emulator.gameManager.getFrameNum()];
  await new Promise(r => setTimeout(r, 3000));
  return Math.round((window.EJS_emulator.gameManager.getFrameNum() - a[1]) / ((performance.now() - a[0]) / 1000));
});
const phoneInfo = await phone.evaluate(() => ({ body: document.body.className, tvState: document.querySelector("#tvState").textContent, canvas: [window.EJS_emulator.canvas.width, window.EJS_emulator.canvas.height] }));

const result = { emuFps, tvFpsBefore: before, resBefore, tvFpsAfterGamepad: after, resAfter, phone: phoneInfo, errors: errors.filter(e => !/Wake Lock/.test(e)) };
result.ok = before > 10 && after > 10 && !result.errors.length;
console.log(JSON.stringify(result, null, 2));
await tvBrowser.close();
await phoneBrowser.close();
process.exit(result.ok ? 0 : 1);
