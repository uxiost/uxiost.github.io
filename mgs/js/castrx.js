// Transporte de mensajes de la sesión de Chromecast, del lado de la tele.
// Solo funciona si esta página es la principal del receptor (DashCast en modo
// "página completa"); dentro de un iframe el Chromecast no le da acceso.
//
// Escuchamos en los espacios de nombres de los receptores públicos que usa el
// móvil (DashCast, URL Cast): son los que la sesión ya tiene dados de alta, así
// que el móvil puede escribir en ellos sin registrar nada.

const NAMESPACES = ["urn:x-cast:com.madmod.dashcast", "urn:x-cast:com.url.cast"];

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("no carga " + src));
    document.head.appendChild(s);
  });
}

export async function castReceiverTransport() {
  await loadScript("https://www.gstatic.com/cast/sdk/libs/caf_receiver/v3/cast_receiver_framework.js");
  const ctx = cast.framework.CastReceiverContext.getInstance();
  const listeners = [];
  let sender = null, ns = NAMESPACES[0];
  for (const n of NAMESPACES) {
    ctx.addCustomMessageListener(n, ev => {
      sender = ev.senderId;
      ns = n;
      let data = ev.data;
      if (typeof data === "string") { try { data = JSON.parse(data); } catch (e) { return; } }
      for (const l of listeners) l(data);
    });
  }
  const opts = new cast.framework.CastReceiverOptions();
  opts.disableIdleTimeout = true;   // sin reproductor de Cast: que no se cierre por inactividad
  opts.skipPlayersLoad = true;      // no cargar los reproductores de CAF: usamos los nuestros
  opts.maxInactivity = 3600;
  opts.customNamespaces = Object.fromEntries(NAMESPACES.map(n => [n, cast.framework.system.MessageType.JSON]));
  ctx.start(opts);
  return {
    send(obj) {
      if (!sender) return;
      try { ctx.sendCustomMessage(ns, sender, obj); } catch (e) { /* emisor desconectado */ }
    },
    onMessage(cb) { listeners.push(cb); },
  };
}
