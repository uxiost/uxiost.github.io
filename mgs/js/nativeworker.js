// Worker del emisor nativo (ver nativesender.js): recibe la configuración y los
// flujos de imágenes y audio del hilo principal, y le devuelve los mensajes para
// la tele.

import { createSender } from "./nativesender.js?v=78";

let sender = null;
onmessage = e => {
  const m = e.data;
  if (m.t === "config") sender = createSender(m.cfg, msg => postMessage(msg));
  else if (!sender) return;
  else if (m.t === "video") sender.video(m.readable);
  else if (m.t === "audio") sender.audio(m.readable);
  else sender.message(m);
};
