# Laboratorio automático de envío a la tele

Reproduce la tele LG del Chromecast integrado (sin canales de datos WebRTC, solo VP8, sin GPU y con la CPU 6× más lenta que este equipo, medida con la prueba de `test.html`) y mide el envío móvil → tele sin nadie delante.

```bash
cd mgs-web && python3 -m http.server 8765 &
node lab/tvlab.mjs http://localhost:8765/ 45          # móvil simulado con hora en la imagen
TV_CPU=14 node lab/tvlab.mjs http://localhost:8765/ 75 # tele mucho más lenta: la calidad automática debe adaptarse
PHONE_CPU=4 node lab/tvlab.mjs http://localhost:8765/  # móvil sobrecargado (emulador + calor)
Q="lines=720&kbps=4000" node lab/tvlab.mjs ...         # probar una variante fija
node lab/applab.mjs http://localhost:8765/ juego.zip   # app completa con emulador + mando que se conecta a mitad
NATIVE=1 TV_CORES=0 node lab/tvlab.mjs http://localhost:8765/ 30   # envío directo: WebCodecs → fMP4 → MSE en la tele
node lab/castlab.mjs http://localhost:8765/ juego.zip              # botón «Enviar al Chromecast» con Cast simulado
CAST_BROKEN=1 node lab/castlab.mjs http://localhost:8765/ juego.zip # la tele no entrega mensajes: debe quedarse en WebRTC
```

### Envío directo (`NATIVE=1`, `castlab.mjs`)

El móvil codifica con WebCodecs y manda fragmentos MP4 por los mensajes de la
sesión de Chromecast; la tele los reproduce con Media Source Extensions (su
reproductor por hardware, como YouTube). En el laboratorio la sesión de Cast la
hace el propio script: `tvlab.mjs` pasa los mensajes entre las dos páginas y
`castlab.mjs` sustituye el SDK de Cast del móvil y el receptor CAF de la tele por
versiones simuladas, así que prueba el botón real de la app: abrir la tele a
pantalla completa, saludo, envío directo, sonido en la tele, móvil en silencio y
respaldo a WebRTC si la tele no contesta. Este Chromium no tiene H.264, así que
aquí va en VP9 + Opus; en el móvil y la tele reales se elige H.264 + AAC.

Con `NATIVE=1` conviene `TV_CORES=0`: la tele real decodifica y compone ese vídeo
por hardware, y el cgroup de CPU haría que este Chromium lo decodificara por
software con muy poca CPU (no es lo que pasa en la tele).

`tvlab.mjs` comprueba (y sale con error si falla):

| Medida | Umbral |
|---|---|
| fps que pinta la tele (requestVideoFrameCallback) | ≥ 25 |
| retraso real p95 (hora codificada en la imagen y leída en la tele) | ≤ 200 ms (envío directo: ≤ 300 ms; en CI +100 ms) |
| tirones de más de 200 ms | ≤ 1 |
| el sonido sale por el reproductor multimedia (MSE) de la tele | pico > 0.1 |
| recuperación tras congelar la página del móvil 6 s | ≤ 8 s |
| el mando de la tele llega al móvil por el vídeo de vuelta | sí |

El flujo `.github/workflows/mgs-lab.yml` lo ejecuta en cada cambio de `mgs-web/`.

Publicar y leer la telemetría: `tools/deploy.sh "mensaje"` y `tools/telemetry.sh 2h`
(ver `HANDOFF.md`).
