// Codifica imágenes (WebP) para el modo img, en su propio hilo: así el hilo del
// emisor queda libre para el audio (si codificaba él, el audio llegaba a ráfagas y
// sonaba a trozos) y con dos de estos se usan dos núcleos del móvil.
//   entra: { id, frame (VideoFrame, transferido), w, h, q, type, stamp }
//   sale:  { id, buf (ArrayBuffer, transferido) } o { id, err }

import { stampTime } from "./stamp.js?v=78";

let cv = null, g = null;
onmessage = async e => {
  const { id, frame, w, h, q, type, stamp } = e.data;
  try {
    if (!cv || cv.width !== w || cv.height !== h) {
      cv = new OffscreenCanvas(w, h);
      g = cv.getContext("2d");
    }
    // El lienzo del emulador puede ser enorme (2520×1890 en el Pixel): reducir con
    // promedio de calidad, no tomando un píxel de cada 8.
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    g.drawImage(frame, 0, 0, w, h);
    frame.close();
    if (stamp) stampTime(g, w, h);
    const blob = await cv.convertToBlob({ type, quality: q });
    const buf = await blob.arrayBuffer();
    postMessage({ id, buf }, [buf]);
  } catch (err) {
    try { frame.close(); } catch (x) { /* ya cerrada */ }
    postMessage({ id, err: String(err) });
  }
};
