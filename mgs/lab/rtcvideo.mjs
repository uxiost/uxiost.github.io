// WebRTC de vídeo "normal" del móvil a la tele, medido: el lienzo del emulador del
// Pixel (por adb/DevTools) como pista de vídeo VP8 a 640×480, directo por UDP, y la
// tele lo pinta en un <video>. Cada imagen lleva la hora de captura del móvil (en
// una transformación codificada, 8 bytes al final que la tele quita antes de
// decodificar); la tele anota cuándo la pinta (requestVideoFrameCallback). Con el
// reloj común (ida y vuelta por la sesión de Cast) da el retraso de cristal a cristal
// hasta la composición, como las medidas de los otros modos.
//
//   node lab/tvprobe.mjs 192.168.1.131 https://mgs-web-lemon.vercel.app/ --fresh --dbg
//   node lab/rtcvideo.mjs 192.168.1.131 [segundos] [kbps]

import { connectCast, NS } from "./castv2.mjs";

const HOST = process.argv[2] || "192.168.1.131";
const SECS = Number(process.argv[3] || 25), KBPS = Number(process.argv[4] || 4000);
const JBT = process.env.JBT ?? "1", PDH = process.env.PDH ?? "0"; // ms y segundos
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

const c = await connectCast(HOST, { src: "sender-rtcvideo" });
const app = await c.launch("84912283");
const answers = new Map();
c.on(NS.dashcast, m => { if (m && m.t === "dbgr" && answers.has(m.id)) { answers.get(m.id)(m.r); answers.delete(m.id); } });
let qid = 4000;
const tv = (e, ms = 20000) => new Promise(res => { const i = ++qid; answers.set(i, res); c.send(NS.dashcast, app.transportId, { t: "dbg", id: i, e }); setTimeout(() => { if (answers.delete(i)) res({ error: "sin respuesta" }); }, ms); });

const tab = (await (await fetch("http://127.0.0.1:9222/json")).json()).find(t => t.type === "page" && t.url.includes("play.html"));
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let cid = 0; const wait = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && wait.has(m.id)) { wait.get(m.id)(m.result); wait.delete(m.id); } };
const phone = async e => { const r = await new Promise(res => { const i = ++cid; wait.set(i, res); ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression: e, returnByValue: true, awaitPromise: true } })); }); return r && r.result ? r.result.value : r; };

// Reloj común: offset tele − móvil (la muestra de menor ida y vuelta).
const nowP = () => phone("performance.timeOrigin + performance.now()");
const nowT = () => tv("performance.timeOrigin + performance.now()");
let best = null;
for (let i = 0; i < 12; i++) {
  const a = await nowP(); const t = await nowT(); const b = await nowP();
  // (el Mac en medio: ida y vuelta Mac→móvil y Mac→tele; aproximación por el centro)
  const rtt = b - a, off = t - (a + b) / 2;
  if (!best || rtt < best.rtt) best = { rtt, off };
}
log("reloj tele−móvil", Math.round(best.off), "ms (±" + Math.round(best.rtt / 2) + ")");

await tv(`(() => {
  const S = window.__rv = { cands: [], lat: [], state: [], map: new Map() };
  const pc = S.pc = new RTCPeerConnection({ iceServers: [], encodedInsertableStreams: true });
  pc.onicecandidate = e => { if (e.candidate) S.cands.push(e.candidate.toJSON()); };
  pc.onconnectionstatechange = () => S.state.push(pc.connectionState);
  const v = S.v = document.createElement("video");
  v.muted = true; v.autoplay = true; v.playsInline = true;
  v.style.cssText = "position:fixed;inset:0;width:100%;height:100%;object-fit:contain;z-index:20;background:#000";
  document.body.appendChild(v);
  pc.ontrack = e => {
    // Colchón mínimo: jitterBufferTarget > 0 (con 0 Chrome lo toma como "sin preferencia")
    // y playoutDelayHint = 0 (no estándar; lo que usan los servicios de juego en la nube).
    try { e.receiver.jitterBufferTarget = ${JBT}; } catch (x) {}
    try { e.receiver.playoutDelayHint = ${PDH}; } catch (x) {}
    S.hints = { jbt: e.receiver.jitterBufferTarget, pdh: e.receiver.playoutDelayHint };
    const st = e.receiver.createEncodedStreams();
    st.readable.pipeThrough(new TransformStream({ transform(f, ctl) {
      const u = new Uint8Array(f.data);
      if (u.length > 8) {
        const cap = new DataView(u.buffer, u.byteOffset + u.length - 8, 8).getFloat64(0);
        S.map.set(f.getMetadata().rtpTimestamp, { cap, rx: performance.timeOrigin + performance.now(), size: u.length - 8 });
        if (S.map.size > 300) S.map.delete(S.map.keys().next().value);
        f.data = u.slice(0, u.length - 8).buffer;
      }
      ctl.enqueue(f);
    } })).pipeTo(st.writable);
    v.srcObject = new MediaStream([e.track]);
    v.play().catch(() => {});
    const cb = (now, md) => {
      const x = S.map.get(md.rtpTimestamp);
      if (x) S.lat.push({ cap: x.cap, rx: x.rx, paint: performance.timeOrigin + now, size: x.size, proc: md.processingDuration });
      if (S.lat.length > 3000) S.lat.shift();
      v.requestVideoFrameCallback(cb);
    };
    v.requestVideoFrameCallback(cb);
  };
  return 1;
})()`);

const offer = await phone(`(async () => {
  const S = window.__rv = { cands: [] };
  const pc = S.pc = new RTCPeerConnection({ iceServers: [], encodedInsertableStreams: true });
  pc.onicecandidate = e => { if (e.candidate) S.cands.push(e.candidate.toJSON()); };
  const src = EJS_emulator.canvas.captureStream(60).getVideoTracks()[0];
  await src.applyConstraints({ width: { max: 640 }, height: { max: 480 } }).catch(() => {});
  S.track = src;
  const sender = pc.addTrack(src, new MediaStream([src]));
  const tr = pc.getTransceivers()[0];
  tr.setCodecPreferences(RTCRtpSender.getCapabilities("video").codecs.filter(c => /vp8/i.test(c.mimeType)));
  const st = sender.createEncodedStreams();
  st.readable.pipeThrough(new TransformStream({ transform(f, ctl) {
    // hora de captura aproximada: cuando sale del codificador (más el tiempo de codificar, que va aparte en el total)
    const u = new Uint8Array(f.data), out = new Uint8Array(u.length + 8);
    out.set(u); new DataView(out.buffer).setFloat64(u.length, performance.timeOrigin + performance.now());
    f.data = out.buffer; ctl.enqueue(f);
  } })).pipeTo(st.writable);
  const off = await pc.createOffer();
  off.sdp = off.sdp.replace(/(a=fmtp:\\d+ [^\\r\\n]*)/g, "$1;x-google-start-bitrate=${KBPS};x-google-min-bitrate=${Math.round(KBPS / 2)}");
  await pc.setLocalDescription(off);
  const p = sender.getParameters(); p.encodings = [{ maxBitrate: ${KBPS * 1000}, maxFramerate: 30 }]; p.degradationPreference = "maintain-framerate";
  await sender.setParameters(p).catch(() => {});
  S.sender = sender;
  return pc.localDescription.toJSON();
})()`);
const answer = await tv(`(async () => { const pc = __rv.pc; await pc.setRemoteDescription(${JSON.stringify(offer)}); await pc.setLocalDescription(await pc.createAnswer()); return pc.localDescription.toJSON(); })()`);
await phone(`__rv.pc.setRemoteDescription(${JSON.stringify(answer)}).then(() => 1)`);
const sp = new Set(), st2 = new Set();
for (let k = 0; k < 8; k++) {
  for (const x of await phone(`__rv.cands`)) if (!sp.has(x.candidate)) { sp.add(x.candidate); await tv(`__rv.pc.addIceCandidate(${JSON.stringify(x)}).then(() => 1, e => String(e))`); }
  for (const x of await tv(`__rv.cands`)) if (!st2.has(x.candidate)) { st2.add(x.candidate); await phone(`__rv.pc.addIceCandidate(${JSON.stringify(x)}).then(() => 1, e => String(e))`); }
  await sleep(500);
}
log("estado tele:", JSON.stringify(await tv(`__rv.state`)));
log(`midiendo ${SECS} s… (mueve la cámara en el juego)`);
// Desglose del receptor de la tele (ms por imagen): colchón, decodificación, proceso total.
const INB = `(async () => { let o = null; (await __rv.pc.getStats()).forEach(r => { if (r.type === "inbound-rtp" && r.kind === "video") o = r; }); return o && { jb: o.jitterBufferDelay, jbN: o.jitterBufferEmittedCount, jbT: o.jitterBufferTargetDelay, dec: o.totalDecodeTime, decN: o.framesDecoded, proc: o.totalProcessingDelay, drop: o.framesDropped, nack: o.nackCount, lost: o.packetsLost, freezes: o.freezeCount, impl: o.decoderImplementation }; })()`;
const i0 = await tv(INB);
await sleep(SECS * 1000);
const i1 = await tv(INB);
if (i0 && i1) {
  const d = k => i1[k] - i0[k], n = d("jbN") || 1, nd = d("decN") || 1;
  log("tele por imagen:", JSON.stringify({ jitterBufferMs: Math.round(d("jb") / n * 1000), jbTargetMs: Math.round(d("jbT") / n * 1000), decodeMs: Math.round(d("dec") / nd * 1000 * 10) / 10, processingMs: Math.round(d("proc") / n * 1000), dropped: d("drop"), nacks: d("nack"), lost: d("lost"), freezes: d("freezes"), decoder: i1.impl }));
}
const off = best.off;
const res = await tv(`(() => {
  const L = __rv.lat.slice(-${SECS * 40}).map(x => ({ total: x.paint - (x.cap + ${off}), net: x.rx - (x.cap + ${off}), tvToPaint: x.paint - x.rx, size: x.size, proc: x.proc }));
  const q = (a, p) => { const v = a.slice().sort((x, y) => x - y); return Math.round(v[Math.min(v.length - 1, Math.floor(v.length * p))]); };
  const g = a => a.length ? { n: a.length, net: [q(a.map(x => x.net), .5), q(a.map(x => x.net), .9)], tvToPaint: [q(a.map(x => x.tvToPaint), .5), q(a.map(x => x.tvToPaint), .9)], total: [q(a.map(x => x.total), .5), q(a.map(x => x.total), .9)], max: Math.round(Math.max(...a.map(x => x.total))), kb: Math.round(a.reduce((s, x) => s + x.size, 0) / a.length / 102.4) / 10 } : null;
  const v = __rv.v, qq = v.getVideoPlaybackQuality();
  const ib = __rv.inbound || {};
  return { hints: __rv.hints, all: g(L), big: g(L.filter(x => x.size > 6000)), mid: g(L.filter(x => x.size > 2000 && x.size <= 6000)), res: [v.videoWidth, v.videoHeight], dropped: qq.droppedVideoFrames, total: qq.totalVideoFrames };
})()`);
log("resultado:", JSON.stringify(res));
const ps = await phone(`(async () => { let o = {}; (await __rv.pc.getStats()).forEach(r => { if (r.type === "outbound-rtp") o = { fps: r.framesPerSecond, w: r.frameWidth, h: r.frameHeight, kbps: Math.round(r.targetBitrate / 1000), enc: r.encoderImplementation, encMs: Math.round(r.totalEncodeTime / r.framesEncoded * 1000 * 10) / 10, qlim: r.qualityLimitationReason }; }); return o; })()`);
log("móvil envía:", JSON.stringify(ps));
await phone(`(__rv.pc.close(), __rv.track.stop(), 1)`);
await tv(`(__rv.pc.close(), __rv.v.remove(), 1)`);
ws.close(); c.close();
