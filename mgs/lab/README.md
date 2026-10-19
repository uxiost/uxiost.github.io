# Laboratorio automático de envío a la tele

Reproduce la tele LG del Chromecast integrado (sin canales de datos WebRTC, solo VP8, sin GPU y con la CPU 6× más lenta que este equipo, medida con la prueba de `test.html`) y mide el envío móvil → tele sin nadie delante.

```bash
cd mgs-web && python3 -m http.server 8765 &
node lab/tvlab.mjs http://localhost:8765/ 45          # móvil simulado con hora en la imagen
TV_CPU=14 node lab/tvlab.mjs http://localhost:8765/ 75 # tele mucho más lenta: la calidad automática debe adaptarse
PHONE_CPU=4 node lab/tvlab.mjs http://localhost:8765/  # móvil sobrecargado (emulador + calor)
Q="lines=720&kbps=4000" node lab/tvlab.mjs ...         # probar una variante fija
node lab/applab.mjs http://localhost:8765/ juego.zip   # app completa con emulador + mando que se conecta a mitad
```

`tvlab.mjs` comprueba (y sale con error si falla):

| Medida | Umbral |
|---|---|
| fps que pinta la tele (requestVideoFrameCallback) | ≥ 25 |
| retraso real p95 (hora codificada en la imagen y leída en la tele) | ≤ 200 ms |
| tirones de más de 200 ms | ≤ 1 |
| el sonido sale por el reproductor multimedia (MSE) de la tele | pico > 0.1 |
| recuperación tras congelar la página del móvil 6 s | ≤ 8 s |
| el mando de la tele llega al móvil por el vídeo de vuelta | sí |

El flujo `.github/workflows/mgs-lab.yml` lo ejecuta en cada cambio de `mgs-web/`.
