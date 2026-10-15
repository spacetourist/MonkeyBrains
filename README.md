# Monkey Brains v0.1

Chimp-memory test (Kyoto / Ayumu style). Numbers 1..n flash on a 5×8 grid; the first tap hides the rest; tap in order. Levels 1–6: n = 4..9 at 2000 ms; levels 7–12: n = 9 at 1500 → 210 ms. A wrong tap fails the trial (retry).

Play: https://spacetourist.github.io/MonkeyBrains/

Art: v2 lab kit (public/assets-v2). Audio: AE's v01 pack (public/audio, src/mbaudio.js) behind `sfx()` in src/audio.ts; silent fallback. Fonts OFL (public/licenses).

`npm i && npm run dev`
