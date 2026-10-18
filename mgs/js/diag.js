// Diagnóstico remoto: la tele (y el móvil) mandan sus errores a un canal
// privado de ntfy.sh para poder ver qué falla sin hacer fotos a la pantalla.
// Solo se envía: tipo de navegador, funciones disponibles y mensajes de error.

const TOPIC = "mgsweb-dbg-7ae1cc668aec";
const log = [];
let sent = 0;

export function remember(...args) {
  const line = args.map(a => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === "object" ? safe(a) : String(a))).join(" ");
  log.push(line.slice(0, 300));
  if (log.length > 30) log.shift();
}

function safe(o) {
  try { return JSON.stringify(o).slice(0, 300); } catch (e) { return String(o); }
}

export function report(role, stage, data = {}) {
  if (sent++ > 40) return; // no inundar el canal
  const body = JSON.stringify({ role, stage, t: new Date().toISOString(), ...data, log: log.slice(-12) });
  fetch(`https://ntfy.sh/${TOPIC}`, { method: "POST", body: body.slice(0, 3900) }).catch(() => {});
}

// Pruebas de WebRTC dentro de este mismo dispositivo: canal de datos y vídeo.
export async function selfTest() {
  const out = {
    ua: navigator.userAgent,
    rtc: typeof RTCPeerConnection,
    dc: typeof RTCDataChannel,
    wasm: typeof WebAssembly,
    vdec: typeof VideoDecoder,
    mse: typeof MediaSource,
  };
  try {
    const caps = RTCRtpReceiver.getCapabilities && RTCRtpReceiver.getCapabilities("video");
    out.vcodecs = caps ? [...new Set(caps.codecs.map(c => c.mimeType.split("/")[1]))].join(",") : "?";
  } catch (e) { out.vcodecs = "err " + e.message; }
  try {
    const gl = document.createElement("canvas").getContext("webgl2") || document.createElement("canvas").getContext("webgl");
    const dbg = gl && gl.getExtension("WEBGL_debug_renderer_info");
    out.gl = gl ? (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "sí") : "no";
  } catch (e) { out.gl = "err"; }
  try {
    const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
    out.freeMB = est ? Math.round((est.quota - est.usage) / 1048576) : "?";
  } catch (e) { out.freeMB = "err"; }
  // Mismo bucle que test.html: ~120 ms en un móvil de gama media.
  const t0 = performance.now();
  let x = 1, acc = 0;
  for (let i = 0; i < 30_000_000; i++) { x = (x * 1103515245 + 12345) | 0; acc ^= x >>> 7; }
  out.benchMs = Math.round(performance.now() - t0) + (acc === 0.5 ? "" : "");
  out.gamepadApi = typeof navigator.getGamepads;
  out.loopData = await loop(false).catch(e => "FAIL " + e.name + ": " + e.message);
  out.loopVideo = await loop(true).catch(e => "FAIL " + e.name + ": " + e.message);
  return out;
}

async function loop(video) {
  const a = new RTCPeerConnection(), b = new RTCPeerConnection();
  const cands = { a: [], b: [] };
  const kind = c => { const p = c.candidate.split(" "); return p[7] + (String(p[4]).endsWith(".local") ? "-mdns" : ""); };
  a.onicecandidate = e => { if (e.candidate) { cands.a.push(kind(e.candidate)); b.addIceCandidate(e.candidate).catch(err => remember("loop addIce", err)); } };
  b.onicecandidate = e => { if (e.candidate) { cands.b.push(kind(e.candidate)); a.addIceCandidate(e.candidate).catch(err => remember("loop addIce", err)); } };
  let done;
  const ok = new Promise((res, rej) => { done = res; setTimeout(() => rej(new Error("timeout 8s")), 8000); });
  ok.catch(() => {}); // si falla antes, que el temporizador no deje un error suelto
  if (video) {
    const c = document.createElement("canvas");
    c.width = 320; c.height = 240;
    const g = c.getContext("2d");
    const iv = setInterval(() => { g.fillStyle = `hsl(${Date.now() % 360},80%,50%)`; g.fillRect(0, 0, 320, 240); }, 33);
    c.captureStream(30).getTracks().forEach(t => a.addTrack(t));
    b.ontrack = e => {
      const v = document.createElement("video");
      v.muted = true; v.srcObject = e.streams[0] || new MediaStream([e.track]);
      v.play().catch(() => {});
      const chk = setInterval(() => { if (v.videoWidth) { clearInterval(chk); clearInterval(iv); done(`ok ${v.videoWidth}x${v.videoHeight}`); } }, 200);
    };
  } else {
    const ch = a.createDataChannel("t");
    ch.onopen = () => ch.send("ping");
    b.ondatachannel = e => { e.channel.onmessage = m => done("ok " + m.data); };
  }
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription);
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription);
  try {
    return (await ok) + ` cand a:${cands.a.join("/")} b:${cands.b.join("/")}`;
  } finally {
    a.close(); b.close();
  }
}
