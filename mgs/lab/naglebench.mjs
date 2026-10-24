// ¿Los tirones de entrega son del búfer de TCP (Nagle + ACK retardado)? Manda a la tele
// mensajes de prueba a 30 Hz desde este equipo, con Nagle activado y desactivado, y
// mide la ida y vuelta (la tele contesta "benchr" a cada uno).
//   node lab/naglebench.mjs 192.168.1.131
import { connectCast, NS } from "./castv2.mjs";
const HOST = process.argv[2] || "192.168.1.131";
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (const noDelay of [false, true]) {
  const c = await connectCast(HOST, { src: "sender-nagle" });
  c.sock.setNoDelay(noDelay);
  const app = await c.launch("84912283");
  const sent = new Map(), rtts = {};
  c.on(NS.dashcast, m => { if (m && m.t === "benchr" && sent.has(m.i)) { const [kb, t] = sent.get(m.i); (rtts[kb] = rtts[kb] || []).push(performance.now() - t); } });
  let i = 0;
  for (const kb of [2, 4, 8, 16]) {
    const pad = "x".repeat(kb * 1024);
    for (let k = 0; k < 120; k++) { sent.set(++i, [kb, performance.now()]); c.send(NS.dashcast, app.transportId, { t: "bench", i, d: pad }); await sleep(33); }
    await sleep(800);
  }
  for (const [kb, a] of Object.entries(rtts)) {
    a.sort((x, y) => x - y);
    const q = p => Math.round(a[Math.min(a.length - 1, Math.floor(a.length * p))]);
    console.log(`Nagle ${noDelay ? "OFF" : "ON "} ${String(kb).padStart(2)} KB: n=${a.length} ida-vuelta p50 ${q(.5)} p90 ${q(.9)} p99 ${q(.99)} max ${q(1)} ms`);
  }
  c.close();
  await sleep(1000);
}
