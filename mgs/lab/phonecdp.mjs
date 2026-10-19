// Mira dentro del Chrome del móvil de verdad (Pixel) desde el ordenador, por adb:
// consola, errores y las estadísticas del envío directo (las del móvil y las que
// manda la tele cada segundo), en vivo.
//
//   adb forward tcp:9222 localabstract:chrome_devtools_remote
//   node lab/phonecdp.mjs                 # vigila la pestaña de play.html
//   node lab/phonecdp.mjs eval "expr"     # evalúa una expresión en esa pestaña
//
// Protocolo de DevTools (CDP) por WebSocket, sin dependencias.

const PORT = process.env.CDP_PORT || 9222;
const [cmd, expr] = process.argv.slice(2);
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

const tabs = await fetch(`http://127.0.0.1:${PORT}/json`).then(r => r.json());
const tab = tabs.find(t => t.type === "page" && /\/mgs\/play\.html|play\.html/.test(t.url)) || tabs.find(t => t.type === "page");
if (!tab) { console.error("sin pestañas:", tabs.map(t => t.url)); process.exit(1); }
log("pestaña", tab.url);

const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const waiting = new Map();
const call = (method, params = {}) => new Promise(res => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async e => {
  const r = await call("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
  return r.result && r.result.result ? r.result.result.value ?? r.result.result.description : r;
};
const fmt = a => a.map(x => x.value !== undefined ? (typeof x.value === "object" ? JSON.stringify(x.value) : x.value) : x.description || x.type).join(" ");
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); return; }
  if (m.method === "Runtime.consoleAPICalled") log("console." + m.params.type, fmt(m.params.args).slice(0, 500));
  else if (m.method === "Runtime.exceptionThrown") log("EXCEPCIÓN", m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
};

if (cmd === "eval") {
  console.log(JSON.stringify(await evaluate(expr), null, 1));
  process.exit(0);
}

await call("Runtime.enable");
// Cada segundo: estado del envío directo (móvil y tele).
const SNAP = `(() => {
  const s = window.__mgsTvNative;
  if (!s) return { native: false, tvState: (document.querySelector("#tvState") || {}).textContent };
  const st = s.stats, tv = st.tv || {};
  return { native: true, level: s.level, kbps: s.kbps, pending: s.pending, codec: st.codec, hw: s.hw,
    sent: st.sentFrames, sentFps: st.sentFps, msgs: st.msgs, chunk: st.chunk, sendFails: st.sendFails, sendErr: st.sendErr,
    flowDrops: st.flowDrops, dropped: st.dropped, enc: st.encMs, restarts: st.restarts, err: st.err, aErr: st.aErr,
    tv: { shown: tv.shown, dec: tv.dec, adv: tv.adv, lag: tv.lag, rs: tv.rs, lost: tv.lost, jumps: tv.jumps, drops: tv.drops, stalls: tv.stalls, restarts: tv.restarts, qs: tv.qs, segs: tv.segs, res: tv.res, rate: tv.rate, err: tv.err },
    tvAgeMs: Date.now() - (s.lastTvStatsAt || 0), tvState: (document.querySelector("#tvState") || {}).textContent };
})()`;
let last = "";
setInterval(async () => {
  const v = JSON.stringify(await evaluate(SNAP));
  if (v !== last) { log(v); last = v; }
}, 1000);
