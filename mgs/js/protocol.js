// Protocolo compartido entre la consola (play.html) y el mando (pad.html).
// El mando manda instantáneas del estado de los botones como máscara de bits;
// así un mensaje perdido se corrige solo con el siguiente.

export const PEER_PREFIX = "mgsweb-";

// Índices RetroPad que usa EmulatorJS en simulateInput(). En PS1:
// B=✕, Y=□, A=○, X=△.
export const BUTTONS = {
  cross: 0,
  square: 1,
  select: 2,
  start: 3,
  up: 4,
  down: 5,
  left: 6,
  right: 7,
  circle: 8,
  triangle: 9,
  l1: 10,
  r1: 11,
  l2: 12,
  r2: 13,
  l3: 14,
  r3: 15,
};

export const BUTTON_COUNT = 16;

export function maskFromSet(pressed) {
  let m = 0;
  for (const name of pressed) {
    const i = BUTTONS[name];
    if (i !== undefined) m |= 1 << i;
  }
  return m;
}

// Mensajes (JSON):
//   mando -> consola  {t:"s", b:<mask>}            estado de botones
//   mando -> consola  {t:"cmd", c:"save"|"load"|"pause"|"disc1"|"disc2"|"reset"}
//   consola -> mando  {t:"hello", player, disc, discs:[...], running}
//   consola -> mando  {t:"toast", msg}
//   consola -> mando  {t:"rx", got, total}         progreso de envío de disco
//
// Envío del disco desde el móvil por un segundo canal "file" (serialización raw):
//   cabecera JSON en texto {name,size,slot}, luego trozos ArrayBuffer, luego "EOF".

export const FILE_CHUNK = 64 * 1024;

export function randomCode(len = 5) {
  // Sin caracteres ambiguos (0/O, 1/I/L) para poder teclearlo en la tele.
  const abc = "abcdefghjkmnpqrstuvwxyz23456789";
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => abc[b % abc.length]).join("");
}

export function formatBytes(n) {
  if (n == null) return "?";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function timeAgo(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return new Date(t).toLocaleString();
}
