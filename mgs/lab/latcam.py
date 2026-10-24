#!/usr/bin/env python3
# Retraso de cristal a cristal: la cámara del Mac mira la tele, que muestra el juego
# con la hora del móvil en la franja de arriba (play.html?stamp, ver js/stamp.js).
#
#   python3 lab/latcam.py snap foto.png            # una foto, para marcar dónde está la franja
#   python3 lab/latcam.py run x0 y0 x1 y1 [segs]   # mide: (x0,y0) centro del 1er bloque guía,
#                                                  # (x1,y1) centro del último bit, en la foto
#
# El reloj del móvil y el del Mac pueden diferir: se mide por adb (OFFSET_MS para fijarlo a mano).
# La cámara añade su propio retraso (~1-2 imágenes): el resultado es una cota superior.

import subprocess, sys, time

W, H = 1280, 720
BITS, COLS = 24, 26
CAM = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-framerate", "30",
       "-video_size", f"{W}x{H}", "-i", "0"]


def phone_offset_ms():
    # Reloj del móvil menos reloj del Mac (ms), con la ida y vuelta de adb descontada.
    best = None
    for _ in range(5):
        t0 = time.time() * 1000
        out = subprocess.run(["adb", "shell", "date +%s%3N"], capture_output=True, text=True).stdout.strip()
        t1 = time.time() * 1000
        if not out.isdigit():
            continue
        rtt = t1 - t0
        off = int(out) - (t0 + t1) / 2
        if best is None or rtt < best[0]:
            best = (rtt, off)
    return best[1] if best else 0.0


def snap(path):
    subprocess.run(CAM + ["-frames:v", "1", "-y", path], check=True)
    print("foto:", path)


def run(x0, y0, x1, y1, secs):
    import os
    off = float(os.environ["OFFSET_MS"]) if "OFFSET_MS" in os.environ else phone_offset_ms()
    print(f"reloj del móvil - Mac: {off:+.0f} ms")
    p = subprocess.Popen(CAM + ["-pix_fmt", "gray", "-f", "rawvideo", "-"], stdout=subprocess.PIPE)
    size = W * H
    lats, end = [], time.time() + secs
    pts = [(x0 + (x1 - x0) * i / (COLS - 1), y0 + (y1 - y0) * i / (COLS - 1)) for i in range(COLS)]

    def lum(f, x, y):
        # media de 3×3 píxeles
        s = 0
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                s += f[(int(y) + dy) * W + int(x) + dx]
        return s / 9

    while time.time() < end:
        f = p.stdout.read(size)
        if len(f) < size:
            break
        now = time.time() * 1000
        v = [lum(f, x, y) for x, y in pts]
        white, black = v[0], v[1]
        if white - black < 40:
            continue
        mid = (white + black) / 2
        val = 0
        for b in v[2:]:
            val = (val << 1) | (1 if b > mid else 0)
        d = (now + off) % (1 << BITS) - val
        if d < 0:
            d += 1 << BITS
        if d < 5000:
            lats.append(d)
    p.kill()
    if not lats:
        print("no se pudo leer la franja (¿coordenadas? ¿play.html?stamp?)")
        return
    lats.sort()
    q = lambda f: lats[min(len(lats) - 1, int(len(lats) * f))]
    print(f"{len(lats)} lecturas · retraso p10 {q(0.1):.0f} · mediana {q(0.5):.0f} · p90 {q(0.9):.0f} ms (incluye el de la cámara)")


if __name__ == "__main__":
    if sys.argv[1] == "snap":
        snap(sys.argv[2])
    else:
        x0, y0, x1, y1 = map(float, sys.argv[2:6])
        run(x0, y0, x1, y1, float(sys.argv[6]) if len(sys.argv) > 6 else 20)
