# CHUCK CITY 🏙️🎯

**A rooftop physics playground for Meta Quest (WebXR).**

You're on the roof of the tallest building in a sunny low-poly town, next to a
rack of ridiculous objects — paper airplanes, bowling balls, anvils,
watermelons, rubber ducks, toy rockets. Throw them off. Hit the dumpsters,
the hoop, the moving truck, the windows across the street. Rack up combos.

▶ **Play:** https://wildelmo.github.io/quest-rooftop/

- **Quest (VR):** open the link in the Quest browser, tap *Enter VR*.
  Grip to grab, swing and release to throw. Right stick snap-turns.
- **Desktop:** click to look around, `1–9`/scroll to pick an object,
  hold and release the left mouse button to throw.

No build step, no assets, no dependencies at runtime — one vendored copy of
Three.js, procedural everything (geometry, sounds, particles).

- [Game design](GAME_DESIGN.md)
- [Architecture & module contracts](ARCHITECTURE.md)

## Run locally

```sh
python3 -m http.server 8080
# open http://localhost:8080
```
