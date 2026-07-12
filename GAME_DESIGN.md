# CHUCK CITY — Rooftop Physics Playground (WebXR / Meta Quest)

**One-liner:** You're on the roof of the tallest building in a sunny low-poly
town, next to a rack of ridiculous objects. Throw them off. Everything falls,
flies, bounces, splats, or shatters exactly the way your inner 8-year-old
hopes it will. Score points by hitting targets in the streets below.

## Why it's fun

The core loop is *anticipation → flight → payoff*:

1. **Anticipation** — you pick an object off the rack. Each one telegraphs its
   personality (an anvil feels absurd next to a paper airplane).
2. **Flight** — every object has hand-tuned aerodynamics. Watching a paper
   airplane carve a long lazy arc over the street is the game.
3. **Payoff** — every landing is celebrated: splats, glass, dust rings,
   distant thuds with echo, score popups, combo streaks, and a moment of
   slow-motion when you nail a great shot.

No locomotion (you stand on one rooftop) → zero motion sickness, instant
onboarding, pure throwing skill.

## Setting

Midday, warm sun, a small stylized city (low-poly, vertex-colored, no
textures). You stand on an 8-story rooftop with a parapet you can lean over.
Below: streets with moving cars, a park with a basketball hoop, dumpsters,
awnings, a trampoline, a rooftop pool across the street, and a wall of
breakable windows on the office building opposite. A flag on your roof shows
the wind.

## The rack — throwable objects

Each object has a distinct physics personality:

| Object | Personality |
|---|---|
| Paper airplane | Generates lift, glides for blocks, banks with release angle |
| Baseball | Dense and fast — the precision tool, breaks windows |
| Basketball | Bouncy, made for the hoop and the trampoline |
| Bowling ball | Heavy. Drops like judgment. Dust ring + deep thud |
| Anvil | Comedy ultra-heavy. Whistles as it falls. Screen-free shake via haptics |
| Watermelon | Explodes into chunks and juice on impact |
| Water balloon | Wobbles in flight, big splash decal |
| Frisbee | Spin-stabilized glide, curves beautifully |
| Rubber duck | Erratic bounces, squeaks on every hit |
| Toy rocket | Half a second after release, the engine lights |
| Umbrella | Pops open and drifts down at 1.5 m/s, swaying |
| Alarm clock | Rings the whole way down, stops dead on impact |
| Beach ball | Nearly floats, pushed around by the wind |
| Egg | The most fragile thing. Perfect splat |

Objects respawn on the rack a few seconds after being thrown, with a little
pop animation. You can dual-wield.

## Targets & scoring

- **Dumpster** (open lid) — "TRASH!" +150
- **Basketball hoop** in the park — +300, ball must pass down through the ring
- **Rooftop pool** across the street — +200 and a huge splash
- **Moving delivery truck** with an open bed — +500, it's moving, lead your shot
- **Bullseye** painted on the intersection — up to +250 by ring
- **Trampoline** — objects bounce back up toward you; catch one mid-air: +1000 "BOOMERANG!"
- **Breakable windows** on the office building — +100 each, they respawn
- **Pigeons** — scatter dramatically (never harmed), +50 "FLOCK OFF!"

**Combos:** hits within 6 seconds of each other build a multiplier (×2, ×3…).
**Slow-mo:** shots worth ≥300 trigger ~1.2s of 30% time so you can savor it.
**Skill bonus:** +1 point per meter of flight distance.

## Feel (the important part)

- **Throw fidelity:** release velocity from a weighted fit over the last ~90ms
  of controller motion, plus angular velocity, plus a subtle 1.25× "hero arm"
  boost so throws feel mighty, not feeble.
- **Haptics:** tick on hover, thump on grab, kick on release, and a distant
  rumble when your object lands a big hit.
- **Audio:** 100% procedurally synthesized WebAudio (no asset files):
  whoosh tied to airspeed, doppler-ish pitch, distant impacts get echo/delay,
  glass shatter, splats, duck squeaks, clock ringing, wind ambience.
- **Particles:** dust rings, water droplets, melon chunks, glass shards,
  confetti on combo milestones.
- **Score popups** float up from the impact point in 3D.

## Quest performance budget

72 fps target: instanced/merged city geometry, vertex colors (no textures
except canvas-generated ones), one directional light + hemisphere, fog to hide
LOD, max ~24 live projectiles with pooling, no realtime shadows except a
blob under held objects, `renderer.xr.setFoveation(1)`.

## Controls

- **VR (Quest):** grip or trigger to grab, swing and release to throw.
  Right stick snap-turn. That's the whole tutorial.
- **Desktop fallback (for quick testing/sharing):** mouse-look, scroll or keys
  1–9 to pick an object, hold and release left mouse to throw with power.

## Tech

Three.js (vendored), custom lightweight physics (gravity, drag, per-object
aerodynamics, sphere-vs-AABB colliders, surface types), ES modules, no build
step, deployed as a static site to GitHub Pages via Actions.
