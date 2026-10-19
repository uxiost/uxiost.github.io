// Transporte de mensajes de la sesión de Chromecast, del lado de la tele.
// Solo funciona si esta página es la principal del receptor (DashCast en modo
// "página completa"); dentro de un iframe el Chromecast no le da acceso.
//
// El marco de receptor (CAF) lo arranca un script en el <head> de screen.html lo
// antes posible; aquí se recogen sus mensajes. Escuchamos en los espacios de
// nombres de los receptores públicos que usa el móvil (DashCast, URL Cast): son
// los que la sesión ya tiene dados de alta, así que el móvil puede escribir en
// ellos sin registrar nada.

export async function castReceiverTransport() {
  const early = window.__castEarly;
  if (!early) throw new Error("sin receptor CAF");
  if (!early.ctx && !early.err) await new Promise(resolve => { early.onReady = resolve; setTimeout(resolve, 20000); });
  if (!early.ctx) throw new Error(early.err || "CAF no arrancó");
  const ctx = early.ctx;
  const listeners = [];
  let sender = null, ns = null;
  const deliver = (n, ev) => {
    sender = ev.senderId;
    ns = n;
    let data = ev.data;
    if (typeof data === "string") { try { data = JSON.parse(data); } catch (e) { return; } }
    for (const l of listeners) l(data);
  };
  return {
    send(obj) {
      if (!sender) return;
      try { ctx.sendCustomMessage(ns, sender, obj); } catch (e) { /* emisor desconectado */ }
    },
    onMessage(cb) {
      listeners.push(cb);
      if (listeners.length === 1) {
        // Lo que llegó mientras cargaba la página, y a partir de ahora, directo.
        const pending = early.queue.splice(0, early.queue.length);
        early.onMessage = deliver;
        for (const { ns: n, ev } of pending) deliver(n, ev);
      }
    },
  };
}
