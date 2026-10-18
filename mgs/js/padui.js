// Lógica táctil del mando, compartida por el mando remoto (pad.html) y por los
// controles en pantalla de la consola (play.html en el móvil).
// Dentro de `root`: un elemento .dpad (cruceta) y botones con data-btn="cross" etc.

import { maskFromSet } from "./protocol.js";

const DPAD_DEADZONE = 0.18;

export function attachTouchPad(root, onChange) {
  const pointers = new Map(); // pointerId -> {x, y, dpad}
  let mask = 0;

  function dpadDirections(dpad, x, y) {
    const r = dpad.getBoundingClientRect();
    const dx = (x - (r.left + r.width / 2)) / (r.width / 2);
    const dy = (y - (r.top + r.height / 2)) / (r.height / 2);
    if (Math.hypot(dx, dy) < DPAD_DEADZONE) return [];
    // 8 sectores de 45°: permite diagonales para moverse en el juego.
    const a = (Math.atan2(dy, dx) * 180) / Math.PI; // 0 = derecha
    const sector = Math.round(((a + 360) % 360) / 45) % 8;
    return [
      ["right"], ["right", "down"], ["down"], ["down", "left"],
      ["left"], ["left", "up"], ["up"], ["up", "right"],
    ][sector];
  }

  function recompute() {
    const pressed = new Set();
    for (const { x, y, dpad } of pointers.values()) {
      // Un dedo que empezó en la cruceta sigue controlándola aunque se salga un poco.
      if (dpad) {
        dpadDirections(dpad, x, y).forEach(d => pressed.add(d));
        continue;
      }
      const el = document.elementFromPoint(x, y);
      const b = el && el.closest("[data-btn]");
      const d = el && el.closest(".dpad");
      if (b && root.contains(b)) pressed.add(b.dataset.btn);
      else if (d && root.contains(d)) dpadDirections(d, x, y).forEach(n => pressed.add(n));
    }
    const m = maskFromSet(pressed);
    if (m === mask) return;
    const newly = m & ~mask;
    mask = m;
    render(pressed);
    onChange(m, newly);
  }

  function render(pressed) {
    root.querySelectorAll("[data-btn]").forEach(b => b.classList.toggle("on", pressed.has(b.dataset.btn)));
    root.querySelectorAll(".dpad .arr").forEach(a => {
      const dir = ["up", "down", "left", "right"].find(n => a.classList.contains(n));
      a.classList.toggle("on", pressed.has(dir));
    });
  }

  root.addEventListener("pointerdown", e => {
    if (e.target.closest("button, dialog, a, input, select, label")) return;
    e.preventDefault();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, dpad: e.target.closest(".dpad") });
    recompute();
  });
  root.addEventListener("pointermove", e => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    recompute();
  });
  const up = e => { if (pointers.delete(e.pointerId)) recompute(); };
  root.addEventListener("pointerup", up);
  root.addEventListener("pointercancel", up);
  root.addEventListener("contextmenu", e => e.preventDefault());

  return {
    get mask() { return mask; },
    releaseAll() {
      pointers.clear();
      recompute();
    },
  };
}

export const PAD_HTML = {
  dpad: `<div class="dpad" aria-label="Cruceta"><span class="arr up">▲</span><span class="arr down">▼</span><span class="arr left">◀</span><span class="arr right">▶</span></div>`,
  face: `<div class="face" aria-label="Botones">
      <div class="btn-pad fb tri" data-btn="triangle">△</div>
      <div class="btn-pad fb cir" data-btn="circle">○</div>
      <div class="btn-pad fb crs" data-btn="cross">✕</div>
      <div class="btn-pad fb sqr" data-btn="square">□</div>
    </div>`,
};
