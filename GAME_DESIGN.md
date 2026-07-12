# CHUCK CITY — Rooftop Physics Playground (WebXR / Meta Quest)

**One-liner:** You're on the roof of the tallest building in a sunny low-poly
town. The front sill is lined with ridiculous objects. Throw them off.
Everything falls, flies, bounces, splats, or shatters exactly the way your
inner 8-year-old hopes it will. It's a sandbox, not a game — no score, just
a city below that reacts to whatever you chuck at it.

## Why it's fun

The core loop is *anticipation → flight → payoff*:

1. **Anticipation** — you pick an object off the sill. Each one telegraphs its
   personality (an anvil feels absurd next to a paper airplane). Pass it
   between hands to line up the perfect grip.
2. **Flight** — every object has hand-tuned aerodynamics. Watching a paper
   airplane carve a long lazy arc over the street is the game.
3. **Payoff** — every landing is celebrated: splats, glass, dust rings,
   distant thuds with echo, celebration labels ("SWISH!"), and a moment of
   slow-motion when you nail a great shot.

Locomotion is rooftop-bounded (the roof is the play area, you can never walk
off the edge): left-stick smooth move, snap turn, and a teleport arc on the
right stick. Desktop gets WASD.

## Setting

Midday, warm sun, a small stylized city (low-poly, vertex-colored, no
textures). You stand on an 8-story rooftop. The whole throwing edge is a
thin, waist-high sill — easy to lean over, easy to toss across — and the
objects live right on it, lined up and packed close. Below: streets with a
delivery truck, a park with a basketball hoop, a dumpster, a trampoline, a
rooftop pool across the street, and a wall of breakable windows on the
office building opposite. A flag on your roof shows the wind.

## The sill — throwable objects

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
| Prop glider | Rubber-band prop: powered climb-out, then a long dreamy glide |
| Flying saucer | Anti-gravity for ~7s: hovers, weaves, survives wall bounces |
| Mini starfighter | Engines light instantly — a fast, flat strafing run |
| Umbrella | Pops open and drifts down at 1.5 m/s, swaying |
| Alarm clock | Rings the whole way down, stops dead on impact |
| Beach ball | Nearly floats, pushed around by the wind |
| Egg | The most fragile thing. Perfect splat |

Objects respawn on the sill a few seconds after being thrown, with a little
pop animation. You can dual-wield, and grabbing an object out of your other
hand transfers it — pick up with the left, orient it, re-grip with the
right, throw.

## Targets (no score — just reactions)

- **Dumpster** (open lid) — "TRASH!"
- **Basketball hoop** in the park — "SWISH!" if it drops through the ring
- **Rooftop pool** across the street — "SPLASHDOWN!" and a huge splash
- **Moving delivery truck** with an open bed — "SPECIAL DELIVERY!"
- **Bullseye** painted on the intersection
- **Trampoline** — objects bounce back up toward you; catch one mid-air: "BOOMERANG!"
- **Breakable windows** on the office building — they respawn after a while
- **Pigeons** — scatter dramatically (never harmed), "FLOCK OFF!"

Great shots still trigger confetti and ~1.2s of slow-motion so you can savor
them — there's just no scoreboard keeping receipts.

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
  confetti on the big moments.
- **Celebration labels** float up from the impact point in 3D.

## Quest performance budget

72 fps target: instanced/merged city geometry, vertex colors (no textures
except canvas-generated ones), one directional light + hemisphere, fog to hide
LOD, max ~24 live projectiles with pooling, no realtime shadows except a
blob under held objects, `renderer.xr.setFoveation(1)`.

## Controls

- **VR (Quest):** grip or trigger to grab, swing and release to throw.
  Grab from your other hand to pass an object between hands. Left stick
  moves (head-relative, roof-bounded), right stick snap-turns, push the
  right stick forward to aim a teleport arc and release to blink there.
- **Desktop fallback (for quick testing/sharing):** mouse-look, WASD to
  walk, scroll or keys 1–9 to pick an object, hold and release left mouse
  to throw with power.

## Tech

Three.js (vendored), custom lightweight physics (gravity, drag, per-object
aerodynamics, sphere-vs-AABB colliders, surface types), ES modules, no build
step, deployed as a static site to GitHub Pages via Actions.
