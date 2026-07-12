# Architecture & Module Contracts

Static ES-module site. No build step. `three` resolves via import map to
`./vendor/three.module.js`. `package.json` has `"type": "module"` so
`node --check src/x.js` parses files as ESM (syntax check only).

## Boot order (src/main.js)

```js
ctx = { scene, camera, renderer, clock, events, wind: Vector3,
        timeScale: 1, playerRig: Group, isXR: false }
ctx.events   = tiny emitter: on(name, fn), off(name, fn), emit(name, payload)
ctx.audio    = createAudio(ctx)        // src/audio.js
ctx.effects  = createEffects(ctx)      // src/effects.js
ctx.physics  = createPhysics(ctx)      // src/physics.js
ctx.world    = createWorld(ctx)        // src/world.js  (registers colliders)
ctx.targets  = createTargets(ctx)      // src/targets.js (needs world)
ctx.objects  = createObjects(ctx)      // src/objects.js (needs world.rackAnchors)
ctx.interaction = createInteraction(ctx) // src/interaction.js
ctx.ui       = createUI(ctx)           // src/ui.js
```

Every factory returns an object that MUST include `update(dt, elapsed)`;
main.js calls them each frame in the order above with `dt` already scaled by
`ctx.timeScale` (real dt also passed as third arg for UI/slow-mo bookkeeping:
`update(dt, elapsed, rawDt)`).

Coordinate system: player rooftop top surface is `y = ROOF_Y = 24` (8 floors
× 3m). Street level `y = 0`. Player rig stands at origin `(0, ROOF_Y, 0)`,
facing **-Z** which is the "over the edge" direction (parapet at `z ≈ -7`).
Constants in `src/constants.js` — the single shared-values file.

## Events (ctx.events)

| name | payload |
|---|---|
| `grab` | `{ body, hand }` (hand: 'left'\|'right'\|'mouse') |
| `throw` | `{ body, speed }` |
| `impact` | `{ body, position, speed, surface, normal }` emitted by physics on every collision |
| `target-hit` | `{ name, points, position, body }` emitted by targets.js |
| `score` | `{ points, label, position, combo, total }` emitted by targets.js scoring |
| `slowmo` | `{ duration }` — effects.js owns ctx.timeScale easing |
| `object-destroyed` | `{ body, position }` (splatted/shattered objects) |

## src/physics.js — createPhysics(ctx)

```js
{
  bodies: [],                       // live bodies
  addBody(body), removeBody(body),
  addCollider(c), removeCollider(c),
  update(dt),
  groundHeightAt(x, z),             // highest collider top under point (roofs/street)
}
```

**Body** (plain object, created by objects.js via `physics.makeBody(opts)`):
```js
{ mesh, velocity: V3, angularVelocity: V3, mass, radius,   // bounding sphere
  drag,               // 0..1-ish linear drag coefficient
  restitution,        // 0..1 bounce
  aero: null | { type: 'glider'|'frisbee'|'balloon'|'rocket'|'umbrella', ...tuning },
  windFactor,         // 0..1 how much wind pushes it
  held: false, alive: true,
  onImpact(hit) => 'destroy'|'keep'|undefined,   // set by objects.js
  data: {}            // free per-object state (e.g. rocket fuel)
}
```
Integration: semi-implicit Euler. Gravity `-9.8 * mass-independent`. Aero:
- `glider`: lift ⊥ to velocity scaled by speed², aligns nose to velocity,
  gentle bank-turn from roll; caps sink rate → long dreamy glides.
- `frisbee`: lift while `angularVelocity.length()` high, lateral curve.
- `balloon`: high drag, strong `windFactor`, low terminal velocity.
- `rocket`: after `data.igniteDelay`, thrust along mesh forward for `data.burn` s.
- `umbrella`: terminal velocity clamp ~1.5 m/s + sinusoidal sway once `data.open`.

**Colliders**: `{ type: 'aabb', min: V3, max: V3, surface, restitution?, name? }`
or `{ type: 'plane', y, surface }` (street). Sphere-vs-AABB resolution, slide +
bounce, emits `impact` once per contact (rate-limited per body, 60ms).
`surface` ∈ `street|roof|metal|water|glass|trampoline|awning|grass`.
Trampoline surface forces restitution ≥ 1.15 upward. Water: kill velocity,
emit impact, body sinks & despawns. Bodies despawn (alive=false, objects.js
watches) when `speed < 0.3` for 2s, or y < -5, or 30s lifetime.

## src/world.js — createWorld(ctx)

Builds sky (gradient dome), sun + hemisphere light, fog, low-poly city
(instanced boxes w/ vertex-color windows), roads, park, trees, parked cars,
distant hills, drifting clouds, the player rooftop (parapet, AC units, vents,
object rack table, wind flag animated by ctx.wind). Registers all building
AABBs + street plane with physics. Returns:
```js
{ update(dt, t), rackAnchors: [Vector3 × ~14],       // world-space slots on the rack
  scoreboardAnchor: Object3D,                        // where ui mounts scoreboard
  facingBuilding: { windowGrid... } // geometry info targets.js uses for breakable windows
}
```
`facingBuilding`: `{ origin: V3, right: V3, up: V3, cols, rows, w, h, gapX, gapY }`
describing the window grid on the building across the street (facing +Z toward
player) so targets.js can place breakable panes exactly on it. World builds
that building's facade WITHOUT window insets on that face (plain wall);
targets.js adds the panes.

## src/objects.js — createObjects(ctx)

Catalog of ~14 throwables. Procedural low-poly meshes (BufferGeometry
primitives, vertex colors / flat MeshLambertMaterial). Each catalog entry:
```js
{ id, label, build(): Mesh, mass, radius, drag, restitution, windFactor,
  aero, onThrow(body), onImpact(body, hit) /* splat/shatter/squeak hooks →
  calls ctx.effects + ctx.audio, may return 'destroy' */ }
```
Manages rack: one instance per rackAnchor, respawns 3s after its slot empties
(pop-scale animation). Exposes:
```js
{ update(dt,t), grabbables(): Body[],   // bodies currently on rack or in flight
  spawnAt(id, position): Body,          // used by desktop mode
  catalog }
```
Rack items are physics-inert (held=true style kinematic) until grabbed/thrown.

## src/interaction.js — createInteraction(ctx)

XR controllers (grip squeeze OR trigger to grab within 0.28m, release throws)
with velocity estimator: ring buffer of (pos, quat, time) over last 120ms,
weighted least-squares linear velocity + finite-difference angular velocity,
throw boost ×1.25. Haptic pulses (hover 0.1, grab 0.4, release 0.6). Snap
turn on right stick (30°, rotates playerRig). Desktop fallback when no XR:
pointer-lock mouse look, keys 1–9/scroll select catalog item, hold LMB charges
power (0.3→18 m/s), release throws from camera. Listens for big `target-hit`
of own thrown body → distant haptic rumble.

## src/targets.js — createTargets(ctx)

Places targets (positions derived from constants + world layout), registers
their colliders/onHit volumes, runs moving truck + pigeons, breakable window
panes on `world.facingBuilding` grid, scoring: combo (6s window, ×1..×5),
flight-distance bonus, emits `score` + `target-hit` + `slowmo` (for points ≥
300). Tracks total score (`.score`). Windows respawn after 20s.

## src/effects.js — createEffects(ctx)

Pooled particle bursts: `dust(pos, scale)`, `splash(pos, scale)`,
`chunks(pos, color, n)`, `glass(pos)`, `confetti(pos)`, `splatDecal(pos,
normal, color, r)` (fading circle decals, pooled, max 40), `popup(text, pos,
color?)` canvas-sprite score text floating up, blob shadow helper for held
objects. Owns slow-mo: on `slowmo` event ease `ctx.timeScale` → 0.3 and back
over duration (uses rawDt). All particles one instanced mesh per pool type.

## src/audio.js — createAudio(ctx)

Lazy AudioContext (first user gesture). Master compressor. All sounds
synthesized (osc + noise buffers + filters). API:
```js
{ update(dt,t), play(name, { position?, intensity? = 1 }),
  startAmbience(), resume() }
```
Sound names used by other modules: `whoosh, thud, clang, splat, splash,
shatter, bounce, squeak, ding, ring, pop, grab, throw, combo, fanfare,
rocket, whistle`. Distance → lowpass + gain falloff + delay-based echo for
street-level impacts (they're ~24m below). Falling-whistle loop for
anvil (objects.js triggers via `play('whistle', {position})` per second).
Wind + light city ambience loops.

## src/ui.js — createUI(ctx)

DOM start overlay: title, "Enter VR" (requestSession `immersive-vr`, optional
features `local-floor`), "Play on Desktop" button, controls hint; hides on
start, calls `audio.resume()`. In-world: scoreboard billboard mounted at
`world.scoreboardAnchor` (canvas texture: score, combo meter, last label),
updates on `score` events. Shows end-of-session nothing — it's a sandbox.

## Rules for all modules

- Import three as `import * as THREE from 'three'`.
- No external network fetches, no asset files, everything procedural.
- Reuse temp vectors; zero per-frame allocations in update loops.
- Guard everything: a module must not throw if another emits an unexpected
  payload. Wrap event handlers defensively.
- Keep each file self-contained; only shared file is `src/constants.js`.
