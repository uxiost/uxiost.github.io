// Mide la tele de verdad por la red local, sin móvil: abre screen.html a pantalla
// completa en el Chromecast (DashCast, force), saluda y mide el mayor mensaje que
// acepta y cuántos mensajes por segundo entrega.
//
//   node lab/tvprobe.mjs 192.168.1.131 [base] [--fresh] [--dbg] [--sizes] [--rate]
//   node lab/tvprobe.mjs 192.168.1.131 --dump            # estado del reproductor de la tele
//   node lab/tvprobe.mjs 192.168.1.131 --watch           # ídem, cada segundo
//   node lab/tvprobe.mjs 192.168.1.131 --eval "expr"     # solo si la página se abrió con ;dbg
//
// Cada {t:"ping"} recibe un {t:"hello"} de la página: con un relleno de N bytes
// en el ping se sabe si un mensaje de ese tamaño llegó. Las consultas (dump, dbg)
// no le quitan las estadísticas al móvil que esté enviando.

import { connectCast, NS } from "./castv2.mjs";

const HOST = process.argv[2] || "192.168.1.131";
const BASE = process.argv.slice(3).find(a => /^https?:/.test(a)) || "https://uxiost.github.io/mgs/";
const has = f => process.argv.includes(f);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

let c = await connectCast(HOST);
let app = await c.launch("84912283", { fresh: has("--fresh") });
log("app", app.displayName, app.statusText, app.transportId);

const hellos = [];
const answers = new Map();
const watch = () => c.on(NS.dashcast, m => {
  if (m && m.t === "hello") hellos.push({ at: Date.now(), m });
  else if (m && (m.t === "dumpr" || m.t === "dbgr") && answers.has(m.id)) { answers.get(m.id)(m); answers.delete(m.id); }
  else if (m && m.t && !has("--quiet")) log("tv:", JSON.stringify(m).slice(0, 200));
});
watch();
let qid = 0;
const ask = (obj, ms = 5000) => new Promise(res => {
  const id = ++qid;
  answers.set(id, res);
  c.send(NS.dashcast, app.transportId, { ...obj, id });
  setTimeout(() => { if (answers.delete(id)) res(null); }, ms);
});

// Consultas a la página que ya está abierta (sin saludar: el saludo le quitaría
// las respuestas al móvil).
const evalArg = process.argv.indexOf("--eval");
if (has("--dump") || has("--watch") || evalArg > 0) {
  do {
    const r = evalArg > 0 ? await ask({ t: "dbg", e: process.argv[evalArg + 1] }) : await ask({ t: "dump" });
    console.log(has("--watch") ? new Date().toISOString().slice(11, 23) + " " + JSON.stringify(r && r.r) : JSON.stringify(r && r.r, null, 1));
    if (has("--watch")) await sleep(1000);
  } while (has("--watch") && !c.closed);
  c.close();
  process.exit(0);
}

async function hello(ms = 4000, extra = {}) {
  const n = hellos.length;
  c.send(NS.dashcast, app.transportId, { t: "ping", ...extra });
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (hellos.length > n) return hellos[hellos.length - 1].m; await sleep(20); }
  return null;
}

let h = await hello(2500);
if (!h || has("--fresh")) {
  // La página no está (o se pide de nuevo): que DashCast la abra a pantalla completa.
  const url = BASE + "screen.html#mac" + Math.random().toString(36).slice(2, 5) + ";noaudio;native" + (has("--dbg") ? ";dbg" : "");
  log("abriendo", url);
  h = null;
  c.send(NS.dashcast, app.transportId, { url, force: true, reload: false, reload_time: 0 });
  for (let i = 0; i < 30 && !h; i++) {
    await sleep(1000);
    if (c.closed) { c = await connectCast(HOST); watch(); }
    const st = await c.status();
    app = (st.applications || []).find(a => a.appId === "84912283") || app;
    c.connect(app.transportId);
    h = await hello(1000);
  }
}
log("hello", JSON.stringify(h));
if (!h) process.exit(1);

if (has("--sizes")) {
  // Tamaños crecientes hasta que deje de contestar (o se corte la conexión).
  for (const kb of [8, 16, 24, 32, 40, 48, 56, 60, 62, 63, 64, 65, 70, 80, 96, 128]) {
    const pad = "x".repeat(kb * 1024 - 20);
    const r = await hello(4000, { pad });
    log(`ping ${kb} KB →`, r ? "ok" : "SIN RESPUESTA", c.closed ? "(conexión cerrada)" : "");
    if (c.closed) { c = await connectCast(HOST); watch(); c.connect(app.transportId); }
    if (!r && kb > 64) break;
  }
}

if (has("--rate")) {
  // Ráfagas de pings con relleno de 12 KB a ritmo creciente: ¿cuántos llegan?
  for (const [perSec, kb] of [[10, 12], [30, 12], [60, 12], [100, 12], [200, 12], [60, 32], [120, 32]]) {
    const n0 = hellos.length, total = perSec * 3;
    const pad = "x".repeat(kb * 1024 - 20);
    const t0 = Date.now();
    for (let i = 0; i < total; i++) {
      c.send(NS.dashcast, app.transportId, { t: "ping", i, pad });
      const due = t0 + (i + 1) * 1000 / perSec;
      if (due > Date.now()) await sleep(due - Date.now());
    }
    const sentIn = (Date.now() - t0) / 1000;
    await sleep(3000);
    const got = hellos.length - n0;
    log(`${perSec}/s × ${kb} KB (${Math.round(perSec * kb * 8 / 1000 * 4 / 3 * 10) / 10} Mbps en base64): ${got}/${total} respuestas, enviado en ${sentIn.toFixed(1)} s`);
  }
}
c.close();
