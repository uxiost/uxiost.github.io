// Mínimo "muxer" de MP4 fragmentado para Media Source Extensions.
//
// Un segmento de inicio por pista (ftyp + moov) y luego fragmentos moof + mdat.
// Vídeo: H.264 ('avc1' + avcC de WebCodecs) o VP9 ('vp09' + vpcC).
// Audio: AAC ('mp4a' + esds) u Opus ('Opus' + dOps).
// Es lo que consume el reproductor por hardware de una tele (como YouTube o
// Netflix), en vez de decodificar y componer el vídeo por software.

const enc = new TextEncoder();

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function u8(v) { return Uint8Array.of(v & 255); }
function u16(v) { return Uint8Array.of((v >> 8) & 255, v & 255); }
function u32(v) { return Uint8Array.of((v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255); }
function u64(v) {
  const hi = Math.floor(v / 2 ** 32), lo = v >>> 0;
  return concat([u32(hi), u32(lo)]);
}
function str(s) { return enc.encode(s); }
function zeros(n) { return new Uint8Array(n); }

function box(type, ...payload) {
  const body = concat(payload.map(p => (p instanceof Uint8Array ? p : new Uint8Array(p))));
  return concat([u32(8 + body.length), str(type), body]);
}
function fullbox(type, version, flags, ...payload) {
  return box(type, u8(version), Uint8Array.of((flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...payload);
}

const MATRIX = concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);

// track: { id, kind: "video"|"audio", codec: "avc1"|"vp09"|"mp4a"|"opus", timescale,
//          width, height, description (Uint8Array, de WebCodecs), vp9 {profile, level, bitDepth},
//          sampleRate, channels }
export function initSegment(track) {
  const ftyp = box("ftyp", str("isom"), u32(0x200), str("isom"), str("iso6"), str("mp41"));
  const isVideo = track.kind === "video";
  const mvhd = fullbox("mvhd", 0, 0, u32(0), u32(0), u32(1000), u32(0), u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(track.id + 1));
  const tkhd = fullbox("tkhd", 0, 3, u32(0), u32(0), u32(track.id), u32(0), u32(0), zeros(8), u16(0), u16(0),
    u16(isVideo ? 0 : 0x0100), u16(0), MATRIX, u32((track.width || 0) << 16), u32((track.height || 0) << 16));
  const mdhd = fullbox("mdhd", 0, 0, u32(0), u32(0), u32(track.timescale), u32(0), u16(0x55c4), u16(0));
  const hdlr = fullbox("hdlr", 0, 0, u32(0), str(isVideo ? "vide" : "soun"), zeros(12), str(isVideo ? "Video\0" : "Sound\0"));
  const xmhd = isVideo ? fullbox("vmhd", 0, 1, zeros(8)) : fullbox("smhd", 0, 0, zeros(4));
  const dinf = box("dinf", fullbox("dref", 0, 0, u32(1), fullbox("url ", 0, 1)));
  const stbl = box("stbl",
    fullbox("stsd", 0, 0, u32(1), sampleEntry(track)),
    fullbox("stts", 0, 0, u32(0)),
    fullbox("stsc", 0, 0, u32(0)),
    fullbox("stsz", 0, 0, u32(0), u32(0)),
    fullbox("stco", 0, 0, u32(0)));
  const trak = box("trak", tkhd, box("mdia", mdhd, hdlr, box("minf", xmhd, dinf, stbl)));
  const mvex = box("mvex", fullbox("trex", 0, 0, u32(track.id), u32(1), u32(0), u32(0), u32(0)));
  return concat([ftyp, box("moov", mvhd, trak, mvex)]);
}

function visualEntry(type, track, ...children) {
  return box(type, zeros(6), u16(1), zeros(16), u16(track.width), u16(track.height),
    u32(0x00480000), u32(0x00480000), u32(0), u16(1), zeros(32), u16(0x0018), u16(0xffff), ...children);
}

function audioEntry(type, track, ...children) {
  return box(type, zeros(6), u16(1), zeros(8), u16(track.channels), u16(16), u16(0), u16(0),
    u32((track.sampleRate << 16) >>> 0), ...children);
}

function descriptor(tag, ...payload) {
  const body = concat(payload);
  return concat([u8(tag), u8(body.length), body]); // tamaños < 128 bytes
}

function sampleEntry(t) {
  switch (t.codec) {
    case "avc1":
      return visualEntry("avc1", t, box("avcC", t.description));
    case "vp09": {
      const v = t.vp9 || { profile: 0, level: 10, bitDepth: 8 };
      return visualEntry("vp09", t, fullbox("vpcC", 1, 0, u8(v.profile), u8(v.level),
        u8((v.bitDepth << 4) | (1 << 1) | 0), u8(1), u8(1), u8(1), u16(0)));
    }
    case "mp4a": {
      const asc = t.description;
      const esds = fullbox("esds", 0, 0, descriptor(0x03, u16(1), u8(0),
        descriptor(0x04, u8(0x40), u8(0x15), Uint8Array.of(0, 0, 0), u32(0), u32(0), descriptor(0x05, asc)),
        descriptor(0x06, u8(2))));
      return audioEntry("mp4a", t, esds);
    }
    case "opus": {
      const dOps = box("dOps", u8(0), u8(t.channels), u16(312), u32(t.sampleRate), u16(0), u8(0));
      return audioEntry("Opus", t, dOps);
    }
    default:
      throw new Error("códec no soportado: " + t.codec);
  }
}

// samples: [{ data: Uint8Array, duration (en timescale), key: bool }]
export function fragment(track, seq, baseTime, samples) {
  const flags = 0x000001 | 0x000100 | 0x000200 | 0x000400; // offset, duración, tamaño, marcas
  const entries = samples.map(s => concat([u32(s.duration), u32(s.data.length), u32(s.key ? 0x02000000 : 0x01010000)]));
  const build = dataOffset => {
    const trun = fullbox("trun", 0, flags, u32(samples.length), u32(dataOffset), ...entries);
    const traf = box("traf",
      fullbox("tfhd", 0, 0x020000, u32(track.id)),
      fullbox("tfdt", 1, 0, u64(baseTime)),
      trun);
    return box("moof", fullbox("mfhd", 0, 0, u32(seq)), traf);
  };
  const moofLen = build(0).length;
  const moof = build(moofLen + 8);
  const mdat = box("mdat", concat(samples.map(s => s.data)));
  return concat([moof, mdat]);
}

export function mimeFor(track) {
  switch (track.codec) {
    case "avc1": return `video/mp4; codecs="${track.codecString || "avc1.42E01F"}"`;
    case "vp09": return `video/mp4; codecs="${track.codecString || "vp09.00.10.08"}"`;
    case "mp4a": return 'audio/mp4; codecs="mp4a.40.2"';
    case "opus": return 'audio/mp4; codecs="opus"';
  }
  return "";
}

// Base64 para mandar binario por mensajes de texto (Cast solo admite texto).
export function toB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
