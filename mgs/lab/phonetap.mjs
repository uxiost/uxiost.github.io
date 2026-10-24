// Toca un elemento (selector CSS) de play.html en el Pixel con un toque de verdad
// (cuenta como gesto del usuario, p. ej. para abrir el selector de Chromecast).
//   adb forward tcp:9222 localabstract:chrome_devtools_remote
//   node lab/phonetap.mjs "#castBtn"
const sel = process.argv[2];
const t = (await (await fetch("http://127.0.0.1:9222/json")).json()).find(t => t.type === "page" && t.url.includes("play.html"));
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const wait = new Map();
ws.onmessage = m => { const d = JSON.parse(m.data); if (wait.has(d.id)) { wait.get(d.id)(d.result); wait.delete(d.id); } };
const call = (method, params) => new Promise(r => { wait.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const where = `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: "center" }); const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`;
if (!(await call("Runtime.evaluate", { expression: where, returnByValue: true })).result.value) { console.log("no existe", sel); process.exit(1); }
await new Promise(r => setTimeout(r, 300));
const [x, y] = (await call("Runtime.evaluate", { expression: where, returnByValue: true })).result.value;
await call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
await call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
console.log("tocado", sel, Math.round(x), Math.round(y));
process.exit(0);
