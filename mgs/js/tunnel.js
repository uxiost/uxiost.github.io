// Túnel directo móvil → tele por WebRTC (UDP dentro de la red de casa), para los
// datos de vídeo: sin pasar por Google Play Services, en binario (sin base64) y
// con ~5-15 ms de entrega en vez de ~25-30.
//
// La tele (LG con Chromecast) no tiene canales de datos WebRTC, pero sí pistas de
// vídeo y "transformaciones de imágenes codificadas": el móvil envía una pista de
// vídeo de relleno (64×64) y, en su transformación, cambia el contenido de cada
// imagen codificada por nuestros bytes (como hace el cifrado de extremo a extremo
// de Jitsi). Se conservan los primeros bytes de la imagen VP8 original (10 en las
// claves, 3 en las demás), que el receptor necesita para reconocerla. La tele lee
// esas imágenes antes de cualquier decodificador y quita la cabecera.
//
// Señalización (oferta, respuesta y candidatos) por la sesión de Cast de siempre.
// Paquete dentro de cada imagen: "MG", u8 versión, u8 n.º de mensajes, y por cada
// mensaje: u16 largo de la cabecera JSON, JSON, u32 largo de los datos, datos.
//
// Necesita, en Android 17, que Chrome tenga el permiso "Dispositivos cercanos" /
// red local; si no, el UDP no sale y el túnel no conecta (se sigue por Cast).

const MAGIC0 = 0x4d, MAGIC1 = 0x47; // "MG"
const enc = new TextEncoder(), dec = new TextDecoder();
const keepFor = type => (type === "key" ? 10 : 3);

// Sube el caudal de arranque de WebRTC (si no, empieza a ~300 kbps y retiene los
// datos en su cola de envío hasta que su estimación sube).
const boostSdp = sdp => sdp.replace(/(a=fmtp:\d+ [^\r\n]*)/g, "$1;x-google-start-bitrate=8000;x-google-min-bitrate=4000;x-google-max-bitrate=40000")
  .replace(/(a=rtpmap:(\d+) VP8\/90000\r\n)(?![\s\S]*a=fmtp:\2 )/, "$1a=fmtp:$2 x-google-start-bitrate=8000;x-google-min-bitrate=4000;x-google-max-bitrate=40000\r\n");

function pack(items) {
  const parts = [];
  let n = 4;
  for (const { head, bytes } of items) {
    const h = enc.encode(JSON.stringify(head));
    parts.push([h, bytes]);
    n += 2 + h.length + 4 + bytes.length;
  }
  const out = new Uint8Array(n);
  const dv = new DataView(out.buffer);
  out[0] = MAGIC0; out[1] = MAGIC1; out[2] = 1; out[3] = items.length;
  let o = 4;
  for (const [h, b] of parts) {
    dv.setUint16(o, h.length); o += 2; out.set(h, o); o += h.length;
    dv.setUint32(o, b.length); o += 4; out.set(b, o); o += b.length;
  }
  return out;
}

function unpack(u8) {
  if (u8.length < 4 || u8[0] !== MAGIC0 || u8[1] !== MAGIC1) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const items = [];
  let o = 4;
  for (let i = 0; i < u8[3]; i++) {
    const hl = dv.getUint16(o); o += 2;
    const head = JSON.parse(dec.decode(u8.subarray(o, o + hl))); o += hl;
    const bl = dv.getUint32(o); o += 4;
    items.push({ head, bytes: u8.subarray(o, o + bl) }); o += bl;
  }
  return items;
}

// ---------------------------------------------------------------- móvil
// transport: la sesión de Cast ({send, onMessage}). Devuelve { ready, send(head, bytes), close, stats }.
export function openTunnelSender(transport, { timeoutMs = 8000 } = {}) {
  const st = { state: "new", frames: 0, items: 0, bytes: 0 };
  if (typeof RTCPeerConnection === "undefined" || !RTCRtpSender.prototype.createEncodedStreams) { st.state = "unsupported"; return { get ready() { return false; }, send() {}, close() {}, stats: st }; }
  const pc = new RTCPeerConnection({ iceServers: [], encodedInsertableStreams: true });
  const cv = document.createElement("canvas");
  cv.width = 64; cv.height = 64;
  const g = cv.getContext("2d");
  // Con un generador de pista, la imagen de relleno entra al codificador al momento
  // (con captureStream del lienzo se esperaba a la siguiente imagen de la pantalla:
  // ~32 ms medidos en el Pixel).
  const gen = typeof MediaStreamTrackGenerator !== "undefined" ? new MediaStreamTrackGenerator({ kind: "video" }) : null;
  const genW = gen ? gen.writable.getWriter() : null;
  const track = gen || cv.captureStream(0).getVideoTracks()[0];
  st.gen = !!gen;
  const sender = pc.addTrack(track, new MediaStream([track]));
  // Solo VP8 (lo único que recibe la tele).
  try {
    const tr = pc.getTransceivers()[0];
    const vp8 = RTCRtpSender.getCapabilities("video").codecs.filter(c => /vp8/i.test(c.mimeType));
    if (tr.setCodecPreferences && vp8.length) tr.setCodecPreferences(vp8);
  } catch (e) { /* sigue con lo que haya */ }
  const queue = [];
  const streams = sender.createEncodedStreams();
  streams.readable.pipeThrough(new TransformStream({
    transform(frame, ctl) {
      if (queue.length) {
        const items = queue.splice(0, queue.length);
        const payload = pack(items);
        const orig = new Uint8Array(frame.data);
        const keep = Math.min(keepFor(frame.type), orig.length);
        const out = new Uint8Array(keep + payload.length);
        out.set(orig.subarray(0, keep));
        out.set(payload, keep);
        frame.data = out.buffer;
        st.frames++; st.items += items.length; st.bytes += payload.length;
        // Espera en el móvil: de entregar los datos al túnel a salir codificados.
        const now = performance.timeOrigin + performance.now();
        for (const it of items) if (it.head.s) st.waitMs = Math.round(((st.waitMs || 0) * 0.9 + (now - it.head.s) * 0.1) * 10) / 10;
      }
      ctl.enqueue(frame);
    },
  })).pipeTo(streams.writable).catch(e => { st.err = String(e); });
  let flip = 0;
  const kick = () => {
    g.fillStyle = (flip ^= 1) ? "#010101" : "#020202"; g.fillRect(0, 0, 1, 1);
    if (genW) { try { genW.write(new VideoFrame(cv, { timestamp: Math.round(performance.now() * 1000) })); } catch (e) { st.err = String(e); } }
    else track.requestFrame();
  };
  // Alguna imagen de vez en cuando aunque no haya datos (mantiene vivo el flujo).
  const idle = setInterval(() => { if (!queue.length) kick(); }, 500);

  pc.onicecandidate = e => { if (e.candidate) transport.send({ t: "rtc-cand", c: e.candidate.toJSON() }); };
  pc.onconnectionstatechange = () => { st.state = pc.connectionState; };
  transport.onMessage(async m => {
    if (!m) return;
    if (m.t === "rtc-answer") { try { await pc.setRemoteDescription(m.sdp); } catch (e) { st.err = String(e); } }
    else if (m.t === "rtc-cand" && m.c) { try { await pc.addIceCandidate(m.c); } catch (e) { /* candidato que no sirve */ } }
  });
  (async () => {
    try {
      const offer = await pc.createOffer();
      offer.sdp = boostSdp(offer.sdp);
      await pc.setLocalDescription(offer);
      sender.setParameters({ ...sender.getParameters(), encodings: [{ maxBitrate: 40e6 }] }).catch(() => {});
      transport.send({ t: "rtc-offer", sdp: pc.localDescription.toJSON() });
    } catch (e) { st.err = String(e); st.state = "failed"; }
  })();
  setTimeout(() => { if (pc.connectionState !== "connected") st.timedOut = true; }, timeoutMs);
  return {
    get ready() { return pc.connectionState === "connected"; },
    stats: st,
    send(head, bytes) { queue.push({ head, bytes }); kick(); },
    close() { clearInterval(idle); try { pc.close(); } catch (e) { /* ya cerrado */ } track.stop(); },
  };
}

// ---------------------------------------------------------------- tele
// onMessage(head, bytes, at): cada mensaje que llega por el túnel.
export function tunnelReceiver(transport, onMessage) {
  const st = { state: "new", frames: 0, items: 0, bytes: 0 };
  let pc = null;
  transport.onMessage(async m => {
    if (!m) return;
    if (m.t === "rtc-offer") {
      try { if (pc) pc.close(); } catch (e) { /* nada */ }
      pc = new RTCPeerConnection({ iceServers: [], encodedInsertableStreams: true });
      pc.onicecandidate = e => { if (e.candidate) transport.send({ t: "rtc-cand", c: e.candidate.toJSON() }); };
      pc.onconnectionstatechange = () => { st.state = pc.connectionState; };
      pc.ontrack = e => {
        let streams;
        try { streams = e.receiver.createEncodedStreams(); } catch (err) { st.err = String(err); return; }
        // Sin colchón en el receptor (solo nos interesan los bytes, no se decodifica nada).
        try { e.receiver.jitterBufferTarget = 0; } catch (err) { /* no admitido */ }
        const reader = streams.readable.getReader();
        (async () => {
          for (;;) {
            const { value: frame, done } = await reader.read();
            if (done) break;
            const at = performance.timeOrigin + performance.now();
            const u8 = new Uint8Array(frame.data);
            const keep = keepFor(frame.type);
            const items = unpack(u8.subarray(Math.min(keep, u8.length)));
            if (!items) continue; // imagen de relleno
            st.frames++;
            for (const it of items) { st.items++; st.bytes += it.bytes.length; onMessage(it.head, it.bytes, at); }
          }
        })().catch(err => { st.err = String(err); });
      };
      try {
        await pc.setRemoteDescription(m.sdp);
        const ans = await pc.createAnswer();
        ans.sdp = boostSdp(ans.sdp);
        await pc.setLocalDescription(ans);
        transport.send({ t: "rtc-answer", sdp: pc.localDescription.toJSON() });
      } catch (err) { st.err = String(err); }
    } else if (m.t === "rtc-cand" && m.c && pc) {
      try { await pc.addIceCandidate(m.c); } catch (err) { /* no sirve */ }
    }
  });
  return { stats: st };
}
