// Cliente mínimo del protocolo de Chromecast (CASTV2) para hablar con la tele de
// verdad desde un ordenador de la misma red, sin SDK ni dependencias.
//
// El Chromecast escucha en TLS :8009 (certificado propio). Cada mensaje va con 4
// bytes de longitud (big endian) y un CastMessage en protobuf:
//   1 protocol_version (0)  2 source_id  3 destination_id  4 namespace
//   5 payload_type (0 texto, 1 binario)  6 payload_utf8  7 payload_binary
//
//   const c = await connectCast("192.168.1.131");
//   const app = await c.launch("84912283");           // DashCast
//   c.on("urn:x-cast:com.madmod.dashcast", m => ...);
//   c.send("urn:x-cast:com.madmod.dashcast", app.transportId, { url, force: true });

import tls from "tls";

export const NS = {
  conn: "urn:x-cast:com.google.cast.tp.connection",
  beat: "urn:x-cast:com.google.cast.tp.heartbeat",
  recv: "urn:x-cast:com.google.cast.receiver",
  dashcast: "urn:x-cast:com.madmod.dashcast",
};

// ---- protobuf (solo lo que usa CastMessage)
const varint = n => { const b = []; while (n > 127) { b.push((n & 127) | 128); n >>>= 7; } b.push(n); return Buffer.from(b); };
const field = (no, wire, body) => Buffer.concat([varint((no << 3) | wire), body]);
const str = (no, s) => { const b = Buffer.from(s, "utf8"); return field(no, 2, Buffer.concat([varint(b.length), b])); };

export function encode({ src, dst, ns, data }) {
  const body = Buffer.concat([field(1, 0, varint(0)), str(2, src), str(3, dst), str(4, ns), field(5, 0, varint(0)), str(6, data)]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  return Buffer.concat([len, body]);
}

function decode(buf) {
  const out = {};
  let o = 0;
  const rv = () => { let n = 0, s = 0, b; do { b = buf[o++]; n |= (b & 127) << s; s += 7; } while (b & 128); return n >>> 0; };
  while (o < buf.length) {
    const tag = rv(), no = tag >> 3, wire = tag & 7;
    if (wire === 0) { out[no] = rv(); continue; }
    const len = rv();
    out[no] = buf.subarray(o, o + len);
    o += len;
  }
  return { src: String(out[2] || ""), dst: String(out[3] || ""), ns: String(out[4] || ""), data: out[6] ? out[6].toString("utf8") : null };
}

export async function connectCast(host, { port = 8009, src = "sender-mac", log = () => {} } = {}) {
  const sock = tls.connect({ host, port, rejectUnauthorized: false });
  await new Promise((res, rej) => { sock.once("secureConnect", res); sock.once("error", rej); });
  const listeners = [];
  let rest = Buffer.alloc(0), reqId = 1;
  const waiting = new Map();
  const c = {
    sock, src, closed: false, bytesOut: 0, msgsOut: 0,
    // Escribe un mensaje; devuelve true si cabe en el búfer del socket.
    send(ns, dst, obj, from = src) {
      const data = typeof obj === "string" ? obj : JSON.stringify(obj);
      const frame = encode({ src: from, dst, ns, data });
      c.bytesOut += frame.length; c.msgsOut++;
      return sock.write(frame);
    },
    on(ns, cb) { listeners.push({ ns, cb }); },
    off(cb) { const i = listeners.findIndex(l => l.cb === cb); if (i >= 0) listeners.splice(i, 1); },
    // Petición con requestId y espera de la respuesta.
    request(ns, dst, obj, ms = 10000) {
      const id = reqId++;
      c.send(ns, dst, { ...obj, requestId: id });
      return new Promise((res, rej) => {
        waiting.set(id, res);
        setTimeout(() => { if (waiting.delete(id)) rej(new Error(`sin respuesta a ${obj.type}`)); }, ms);
      });
    },
    connect(dst) { c.send(NS.conn, dst, { type: "CONNECT", origin: {}, userAgent: "mgs-lab", senderInfo: { sdkType: 2, version: "15.605.1.3", browserVersion: "44.0.2403.30", platform: 4, systemVersion: "Macintosh; Intel Mac OS X10_10_3", connectionType: 1 } }); },
    status: () => c.request(NS.recv, "receiver-0", { type: "GET_STATUS" }).then(r => r.status),
    // Abre una app receptora (o se une si ya está abierta) y conecta con ella.
    async launch(appId, { fresh = false } = {}) {
      let st = await c.status();
      let app = (st.applications || []).find(a => a.appId === appId);
      // LAUNCH de la app que ya está abierta no la reinicia: pararla antes.
      if (app && fresh) { await c.stop(app.sessionId).catch(() => {}); app = null; }
      if (!app) {
        const r = await c.request(NS.recv, "receiver-0", { type: "LAUNCH", appId }, 20000);
        app = (r.status.applications || []).find(a => a.appId === appId);
        if (!app) throw new Error("no se abrió " + appId + ": " + JSON.stringify(r));
      }
      c.connect(app.transportId);
      return app;
    },
    stop: sessionId => c.request(NS.recv, "receiver-0", { type: "STOP", sessionId }),
    close() { c.closed = true; clearInterval(beat); sock.destroy(); },
  };
  sock.on("data", chunk => {
    rest = Buffer.concat([rest, chunk]);
    while (rest.length >= 4) {
      const len = rest.readUInt32BE(0);
      if (rest.length < 4 + len) break;
      const m = decode(rest.subarray(4, 4 + len));
      rest = rest.subarray(4 + len);
      let obj = m.data;
      try { obj = JSON.parse(m.data); } catch (e) { /* texto */ }
      if (m.ns === NS.beat && obj && obj.type === "PING") { c.send(NS.beat, m.src, { type: "PONG" }, m.dst); continue; }
      if (obj && obj.requestId && waiting.has(obj.requestId)) { const res = waiting.get(obj.requestId); waiting.delete(obj.requestId); res(obj); }
      log("<", m.ns, m.src, typeof obj === "object" ? JSON.stringify(obj).slice(0, 300) : obj);
      for (const l of listeners.slice()) if (l.ns === m.ns || l.ns === "*") l.cb(obj, m);
    }
  });
  sock.on("close", () => { c.closed = true; clearInterval(beat); for (const l of listeners.slice()) if (l.ns === "close") l.cb(); });
  sock.on("error", e => log("socket", String(e)));
  c.connect("receiver-0");
  const beat = setInterval(() => c.send(NS.beat, "receiver-0", { type: "PING" }), 5000);
  return c;
}
