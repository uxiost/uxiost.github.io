// Depura WebRTC entre el móvil (Chrome del Pixel por adb/DevTools) y la tele (página
// abierta con ;dbg), con este equipo de mensajero: sin PeerJS ni servidores. Muestra
// los candidatos ICE de cada lado, si conecta, por qué par, el tiempo de ida y vuelta
// del camino UDP y si la tele admite transformaciones de imágenes codificadas.
//
//   adb forward tcp:9222 localabstract:chrome_devtools_remote
//   node lab/tvprobe.mjs 192.168.1.131 https://mgs-web-lemon.vercel.app/ --fresh --dbg
//   node lab/rtcprobe.mjs 192.168.1.131

import { connectCast, NS } from "./castv2.mjs";

const HOST = process.argv[2] || "192.168.1.131";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

// ---- tele (eval por la sesión de Cast)
const c = await connectCast(HOST, { src: "sender-rtc" });
const app = await c.launch("84912283");
const answers = new Map();
c.on(NS.dashcast, m => { if (m && m.t === "dbgr" && answers.has(m.id)) { answers.get(m.id)(m.r); answers.delete(m.id); } });
let qid = 3000;
const tv = (e, ms = 20000) => new Promise(res => { const i = ++qid; answers.set(i, res); c.send(NS.dashcast, app.transportId, { t: "dbg", id: i, e }); setTimeout(() => { if (answers.delete(i)) res({ error: "sin respuesta" }); }, ms); });

// ---- el otro extremo: el móvil (CDP por adb) o, con --mac, el Chrome de este equipo
let phone, ws = { close() {} }, closeMac = async () => {};
if (process.argv.includes("--mac")) {
  const { createRequire } = await import("module");
  const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || "playwright-core");
  const b = await chromium.launch({ channel: "chrome", headless: true });
  const pg = await b.newPage();
  await pg.goto("https://mgs-web-lemon.vercel.app/test.html");
  phone = e => pg.evaluate(e);
  closeMac = () => b.close();
} else {
  const tabs = await (await fetch("http://127.0.0.1:9222/json")).json();
  const tab = tabs.find(t => t.type === "page" && t.url.includes("play.html"));
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let cid = 0; const wait = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && wait.has(m.id)) { wait.get(m.id)(m.result); wait.delete(m.id); } };
  phone = async e => {
    const r = await new Promise(res => { const i = ++cid; wait.set(i, res); ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression: e, returnByValue: true, awaitPromise: true } })); });
    return r && r.result ? r.result.value : r;
  };
}

// Lado de la tele: recibe la oferta, contesta, junta candidatos y estado.
const TV_SETUP = `(async () => {
  const S = window.__rtc = { cands: [], state: [], err: null };
  const pc = S.pc = new RTCPeerConnection({ iceServers: [], encodedInsertableStreams: true });
  pc.onicecandidate = e => { if (e.candidate) S.cands.push(e.candidate.toJSON()); };
  pc.oniceconnectionstatechange = () => S.state.push(["ice", pc.iceConnectionState, Math.round(performance.now())]);
  pc.onconnectionstatechange = () => S.state.push(["pc", pc.connectionState, Math.round(performance.now())]);
  pc.ontrack = e => { S.track = e.track.kind; try { const st = e.receiver.createEncodedStreams(); S.insertable = true; S.frames = 0; S.bytes = 0;
    st.readable.pipeTo(new WritableStream({ write(f) { S.frames++; S.bytes += f.data.byteLength; S.lastFrameAt = performance.timeOrigin + performance.now(); } })).catch(e => S.err = String(e)); } catch (e) { S.insertable = String(e); } };
  return { ok: true, scriptTransform: typeof RTCRtpScriptTransform };
})()`;
const PHONE_SETUP = `(async () => {
  const S = window.__rtc = { cands: [], state: [] };
  const pc = S.pc = new RTCPeerConnection({ iceServers: [], encodedInsertableStreams: true });
  pc.onicecandidate = e => { if (e.candidate) S.cands.push(e.candidate.toJSON()); };
  pc.oniceconnectionstatechange = () => S.state.push(["ice", pc.iceConnectionState, Math.round(performance.now())]);
  pc.onconnectionstatechange = () => S.state.push(["pc", pc.connectionState, Math.round(performance.now())]);
  const cv = document.createElement("canvas"); cv.width = 320; cv.height = 240; const g = cv.getContext("2d");
  S.iv = setInterval(() => { g.fillStyle = "hsl(" + (Date.now() / 10 % 360) + ",60%,50%)"; g.fillRect(0, 0, 320, 240); }, 33);
  const track = cv.captureStream(30).getVideoTracks()[0];
  const sender = pc.addTrack(track, new MediaStream([track]));
  try { const st = sender.createEncodedStreams(); S.insertable = true; st.readable.pipeTo(st.writable); } catch (e) { S.insertable = String(e); }
  await pc.setLocalDescription(await pc.createOffer());
  return pc.localDescription.toJSON();
})()`;

const tvInit = await tv(TV_SETUP);
log("tele:", JSON.stringify(tvInit));
const offer = await phone(PHONE_SETUP);
log("oferta del móvil:", offer && offer.sdp ? offer.sdp.split("\r\n").filter(l => /^a=candidate|^m=|^c=/.test(l)).join(" | ") : JSON.stringify(offer));
const answer = await tv(`(async () => { const pc = __rtc.pc; await pc.setRemoteDescription(${JSON.stringify(offer)}); await pc.setLocalDescription(await pc.createAnswer()); return pc.localDescription.toJSON(); })()`);
log("respuesta de la tele:", answer && answer.sdp ? answer.sdp.split("\r\n").filter(l => /^a=candidate|^m=|^c=/.test(l)).join(" | ") : JSON.stringify(answer));
await phone(`__rtc.pc.setRemoteDescription(${JSON.stringify(answer)}).then(() => "ok")`);

// Intercambio de candidatos (ida y vuelta, unas cuantas rondas).
const seenP = new Set(), seenT = new Set();
for (let round = 0; round < 12; round++) {
  const pc = await phone(`__rtc.cands`), tc = await tv(`__rtc.cands`);
  for (const x of pc || []) { const k = x.candidate; if (!seenP.has(k)) { seenP.add(k); log("móvil →", k); await tv(`__rtc.pc.addIceCandidate(${JSON.stringify(x)}).then(() => "ok", e => "ERR " + e)`); } }
  for (const x of tc || []) { const k = x.candidate; if (!seenT.has(k)) { seenT.add(k); log("tele  →", k); await phone(`__rtc.pc.addIceCandidate(${JSON.stringify(x)}).then(() => "ok", e => "ERR " + e)`); } }
  await sleep(700);
}
log("estado móvil:", JSON.stringify(await phone(`__rtc.state`)));
log("estado tele: ", JSON.stringify(await tv(`__rtc.state`)));
// Pares de candidatos: comprobaciones enviadas y respuestas recibidas en cada sentido.
const STATS = `(async () => { const c = {}, out = []; const st = await __rtc.pc.getStats(); st.forEach(r => { if (r.type === "local-candidate" || r.type === "remote-candidate") c[r.id] = (r.address || r.ip) + ":" + r.port + "/" + r.protocol; });
  st.forEach(r => { if (r.type === "candidate-pair") out.push({ pair: c[r.localCandidateId] + " -> " + c[r.remoteCandidateId], state: r.state, reqSent: r.requestsSent, respRecv: r.responsesReceived, reqRecv: r.requestsReceived, respSent: r.responsesSent, rtt: r.currentRoundTripTime }); }); return out; })()`;
for (const x of (await phone(STATS)) || []) log("móvil par:", JSON.stringify(x));
for (const x of (await tv(STATS)) || []) log("tele  par:", JSON.stringify(x));
log("tele recibe:", JSON.stringify(await tv(`({ track: __rtc.track, insertable: __rtc.insertable, frames: __rtc.frames, bytes: __rtc.bytes, err: __rtc.err })`)));
ws.close(); c.close(); await closeMac();
