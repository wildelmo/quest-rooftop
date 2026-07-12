// src/physics.js — CHUCK CITY bespoke physics.
// Semi-implicit Euler, per-object aerodynamics (glider / frisbee / balloon /
// rocket / umbrella), sphere-vs-AABB + sphere-vs-plane collisions with
// restitution + tangential friction, surface behaviors (trampoline, water),
// rate-limited impact events, despawn bookkeeping, MAX_BODIES cap.
//
// Contract: ARCHITECTURE.md — createPhysics(ctx) returns
// { bodies, makeBody, addBody, removeBody, addCollider, removeCollider,
//   update(dt), groundHeightAt(x, z) }.

import * as THREE from 'three';
import {
  GRAVITY, MAX_BODIES, BODY_LIFETIME, KILL_Y, STREET_Y,
} from './constants.js';

// ---------- hoisted temporaries (zero per-frame allocations) ----------
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();
const _zero = new THREE.Vector3(0, 0, 0);

// Pooled impact payloads (rate limiting keeps in-flight count tiny; ring of
// 16 so handlers that defer a frame still see valid data).
const HIT_POOL = [];
for (let i = 0; i < 16; i++) {
  HIT_POOL.push({
    body: null,
    position: new THREE.Vector3(),
    speed: 0,
    surface: 'street',
    normal: new THREE.Vector3(0, 1, 0),
  });
}

// Tangential friction per surface (higher = grippier).
const FRICTION = {
  street: 0.75, roof: 0.75, metal: 0.45, glass: 0.35,
  grass: 1.15, awning: 0.9, trampoline: 0.25, water: 0,
};

// Aero tuning defaults, merged under whatever objects.js passes in.
const AERO_DEFAULTS = {
  // Long dreamy glides: while gliding, gravity is replaced by a relaxation of
  // vertical speed toward -sink while horizontal speed relaxes toward cruise.
  // From a 24m rooftop: ~14-18s aloft at ~3.3-4.5 m/s => 30-60m carries.
  glider: {
    minSpeed: 2.2,     // below this it stalls (gravity takes over)
    cruise: 3.2,       // horizontal airspeed it settles into
    cruiseRate: 0.55,  // 1/s relaxation toward cruise
    sink: 1.9,         // steady sink rate m/s
    riseRelax: 0.9,    // 1/s while still climbing (floaty apex)
    glideRelax: 2.4,   // 1/s in normal descent band
    flareRelax: 3.4,   // 1/s pull-up when falling faster than sink
    turnRate: 0.9,     // rad/s of yaw per rad of bank
    bankDecay: 0.12,   // 1/s bank washout -> lazy widening circles
    align: 7,          // how fast the nose slews onto the velocity vector
  },
  frisbee: {
    lift: 0.92,        // fraction of gravity cancelled at full spin + speed
    liftSpeed: 6,      // airspeed for full lift
    curve: 1.7,        // m/s^2 lateral acceleration at full spin
    spinDecay: 0.19,   // 1/s spin bleed -> late-flight fade and drop
    fullSpin: 10,      // rad/s counted as "full" spin
    airDrag: 0.14,     // extra 1/s horizontal bleed
    align: 5,
    tilt: 0.35,        // visual bank into the curve
  },
  balloon: {
    buoyancy: 0.82,    // fraction of gravity cancelled
    terminal: 1.8,     // max fall speed m/s
    couple: 0.9,       // 1/s coupling of horizontal velocity to the wind
    windGain: 3.0,     // wind vector -> target drift velocity multiplier
    bob: 0.35,         // vertical bobbing accel amplitude
  },
  rocket: {
    thrust: 18,        // m/s^2 (data.thrust overrides)
    align: 2.6,        // weathercock rate: nose eases toward velocity
    wobble: 0.28,      // thrust-vector wiggle, rad
  },
  umbrella: {
    terminal: 1.5,     // contract: ~1.5 m/s descent once open
    swayAmp: 0.85,     // horizontal sway accel amplitude
    hDrag: 1.1,        // 1/s horizontal damping (it's a parachute)
    tilt: 0.22,        // visual pendulum tilt
    align: 3.5,
  },
  // Rubber-band prop glider: a powered climb-out while the band unwinds,
  // then it settles into the same dreamy glide model as the paper airplane.
  prop: {
    thrust: 5.5,       // m/s^2 along the nose while the band unwinds
    burnTime: 3.2,     // seconds of prop power
    climb: 1.4,        // vertical speed it eases toward while powered
    maxSpeed: 9,       // powered-phase speed cap (keeps it toy-like)
    // glide phase (same knobs as 'glider')
    minSpeed: 2.0, cruise: 4.0, cruiseRate: 0.5, sink: 1.7,
    riseRelax: 0.8, glideRelax: 2.2, flareRelax: 3.2,
    turnRate: 0.7, bankDecay: 0.15, align: 6,
  },
  // Toy flying saucer: cancels gravity, weaves side to side at cruise speed
  // until the charge runs out, then drops ballistically. Bounces don't kill
  // the power — a saucer that clips a wall and flies on is the joke.
  ufo: {
    hoverTime: 7,      // seconds of anti-gravity
    sink: 0.5,         // gentle descent while powered
    cruise: 5.0,       // horizontal speed it maintains
    couple: 0.8,       // 1/s relaxation toward cruise
    wobbleAmp: 2.0,    // lateral weave accel m/s^2
    wobbleHz: 2.1,
    bob: 0.9,          // vertical bob accel amplitude
    tilt: 0.3,         // visual bank into the weave
    align: 4,
  },
};

export function createPhysics(ctx) {
  const bodies = [];
  const colliders = [];
  let simTime = 0;
  let hitIdx = 0;
  const events = ctx && ctx.events;

  // ---------------- body factory ----------------
  function makeBody(opts) {
    const o = opts || {};
    let aero = null;
    if (o.aero && o.aero.type) {
      aero = Object.assign({}, AERO_DEFAULTS[o.aero.type] || {}, o.aero);
    }
    return {
      mesh: o.mesh || null,
      velocity: (o.velocity && o.velocity.isVector3) ? o.velocity : new THREE.Vector3(),
      angularVelocity: (o.angularVelocity && o.angularVelocity.isVector3) ? o.angularVelocity : new THREE.Vector3(),
      mass: o.mass !== undefined ? o.mass : 1,
      radius: o.radius !== undefined ? o.radius : 0.12,
      drag: o.drag !== undefined ? o.drag : 0.02,
      restitution: o.restitution !== undefined ? o.restitution : 0.35,
      aero,
      windFactor: o.windFactor !== undefined ? o.windFactor : 0.15,
      held: !!o.held,
      alive: true,
      onImpact: typeof o.onImpact === 'function' ? o.onImpact : null,
      data: o.data || {},
      // internal bookkeeping
      _age: 0, _slow: 0, _lastHit: -1e9, _water: -1,
      _ground: false, _oriented: false,
      _seed: Math.random() * Math.PI * 2,
    };
  }

  function ensureInternals(b) {
    if (b._age === undefined) b._age = 0;
    if (b._slow === undefined) b._slow = 0;
    if (b._lastHit === undefined) b._lastHit = -1e9;
    if (b._water === undefined) b._water = -1;
    if (b._seed === undefined) b._seed = Math.random() * Math.PI * 2;
    if (!b.data) b.data = {};
    if (!b.velocity || !b.velocity.isVector3) b.velocity = new THREE.Vector3();
    if (!b.angularVelocity || !b.angularVelocity.isVector3) b.angularVelocity = new THREE.Vector3();
    if (b.radius === undefined) b.radius = 0.12;
    if (b.restitution === undefined) b.restitution = 0.35;
    if (b.drag === undefined) b.drag = 0.02;
    if (b.windFactor === undefined) b.windFactor = 0.15;
    if (b.alive === undefined) b.alive = true;
  }

  function addBody(b) {
    if (!b || bodies.indexOf(b) !== -1) return b;
    ensureInternals(b);
    // Cap counts LIVE (non-held) bodies only — the ~14 kinematic racked
    // bodies must not eat the projectile budget or trigger evictions of
    // mid-flight objects on every rack respawn. Despawn oldest non-held
    // (bodies[] is insertion-ordered).
    let live = 0;
    for (let i = 0; i < bodies.length; i++) { if (!bodies[i].held) live++; }
    while (live >= MAX_BODIES) {
      let oldest = null;
      for (let i = 0; i < bodies.length; i++) {
        if (!bodies[i].held) { oldest = bodies[i]; break; }
      }
      if (!oldest) break; // everything is held; give up gracefully
      oldest.alive = false;
      removeBody(oldest);
      live--;
    }
    bodies.push(b);
    return b;
  }

  function removeBody(b) {
    const i = bodies.indexOf(b);
    if (i !== -1) bodies.splice(i, 1);
  }

  function addCollider(c) {
    if (c && colliders.indexOf(c) === -1) colliders.push(c);
    return c;
  }

  function removeCollider(c) {
    const i = colliders.indexOf(c);
    if (i !== -1) colliders.splice(i, 1);
  }

  // ---------------- queries ----------------
  function groundHeightAt(x, z) {
    if (!isFinite(x) || !isFinite(z)) return STREET_Y;
    let best = -Infinity;
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      if (!c) continue;
      if (c.type === 'plane') {
        const y = (c.y !== undefined) ? c.y : STREET_Y;
        if (y > best) best = y;
      } else if (c.type === 'aabb' && c.min && c.max) {
        if (x >= c.min.x && x <= c.max.x && z >= c.min.z && z <= c.max.z) {
          if (c.max.y > best) best = c.max.y;
        }
      }
    }
    return best === -Infinity ? STREET_Y : best;
  }

  // ---------------- impact events ----------------
  function emitImpact(body, surface, nx, ny, nz, speed, force) {
    if (!force && simTime - body._lastHit < 0.06) return;
    body._lastHit = simTime;
    const hit = HIT_POOL[hitIdx = (hitIdx + 1) & 15];
    hit.body = body;
    hit.surface = surface;
    hit.speed = speed;
    hit.position.copy(body.mesh.position);
    hit.normal.set(nx, ny, nz);
    try {
      if (events && events.emit) events.emit('impact', hit);
    } catch (e) { /* never let a listener kill the sim */ }
    let r;
    try {
      if (typeof body.onImpact === 'function') r = body.onImpact(hit);
    } catch (e) { /* defensive */ }
    if (r === 'destroy') body.alive = false;
  }

  // ---------------- collision resolution ----------------
  // Push out along (nx,ny,nz) by pen, then bounce/rest with friction.
  function resolve(body, nx, ny, nz, pen, c, sdt) {
    const p = body.mesh.position;
    const v = body.velocity;
    p.x += nx * pen; p.y += ny * pen; p.z += nz * pen;

    const surface = (c && c.surface) || 'street';
    const vn = v.x * nx + v.y * ny + v.z * nz;
    if (vn >= 0) return; // separating; positional fix was enough

    const impactSpeed = v.length();

    if (surface === 'water') {
      // Swallow: emit splash impact, kill velocity, sink + despawn after 1s.
      emitImpact(body, 'water', nx, ny, nz, impactSpeed, true);
      v.x *= 0.08; v.z *= 0.08;
      v.y = Math.min(v.y * 0.05, -0.4);
      body.angularVelocity.multiplyScalar(0.25);
      body._water = 0;
      body.data.inWater = true;
      return;
    }

    let e = body.restitution;
    if (c && c.restitution !== undefined) e = Math.max(e, c.restitution);
    const trampoline = surface === 'trampoline';
    if (trampoline) e = Math.max(e, 1.15);

    let outN = -vn * e;
    if (trampoline) outN = Math.max(outN, 2.2); // even lazy drops get returned

    // Strip the normal component.
    v.x -= vn * nx; v.y -= vn * ny; v.z -= vn * nz;

    const mu = FRICTION[surface] !== undefined ? FRICTION[surface] : 0.7;
    const bounce = trampoline || outN > 0.55;

    if (bounce) {
      // One-shot tangential scrub, then restore the reflected normal speed.
      const f = Math.max(0, 1 - mu * 0.3);
      v.x *= f; v.y *= f; v.z *= f;
      v.x += nx * outN; v.y += ny * outN; v.z += nz * outN;
      // Impacts scramble spin a little.
      body.angularVelocity.multiplyScalar(0.85);
    } else {
      // Resting contact: continuous friction + rolling.
      const f = Math.exp(-mu * 5 * sdt);
      v.x *= f; v.y *= f; v.z *= f;
      if (ny > 0.5) {
        body._ground = true;
        // Roll without slipping: omega -> (n x v) / r  (believable tumble).
        const invR = 1 / Math.max(0.03, body.radius);
        const tx = (ny * v.z - nz * v.y) * invR;
        const ty = (nz * v.x - nx * v.z) * invR;
        const tz = (nx * v.y - ny * v.x) * invR;
        const w = body.angularVelocity;
        const k = Math.min(1, 9 * sdt);
        w.x += (tx - w.x) * k;
        w.y += (ty - w.y) * k;
        w.z += (tz - w.z) * k;
      }
    }

    if (impactSpeed > 0.5 || trampoline) {
      emitImpact(body, surface, nx, ny, nz, impactSpeed, false);
    }
  }

  function collide(body, sdt) {
    const p = body.mesh.position;
    const r = body.radius;
    // Iterate BACKWARD: impact handlers may removeCollider() the collider
    // being hit (breaking window panes splice colliders[]); a forward walk
    // would silently skip the collider that shifts into the vacated slot.
    for (let i = colliders.length - 1; i >= 0; i--) {
      const c = colliders[i];
      if (!c) continue;
      if (body._water >= 0 || !body.alive) return;

      if (c.type === 'plane') {
        const py = (c.y !== undefined) ? c.y : STREET_Y;
        const pen = py - (p.y - r);
        if (pen > 0) resolve(body, 0, 1, 0, pen, c, sdt);
      } else if (c.type === 'aabb' && c.min && c.max) {
        const min = c.min, max = c.max;
        // Cheap reject.
        if (p.x + r < min.x || p.x - r > max.x ||
            p.y + r < min.y || p.y - r > max.y ||
            p.z + r < min.z || p.z - r > max.z) continue;
        // Closest point on box.
        const cx = p.x < min.x ? min.x : (p.x > max.x ? max.x : p.x);
        const cy = p.y < min.y ? min.y : (p.y > max.y ? max.y : p.y);
        const cz = p.z < min.z ? min.z : (p.z > max.z ? max.z : p.z);
        const dx = p.x - cx, dy = p.y - cy, dz = p.z - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r * r) continue;
        if (d2 > 1e-9) {
          const dist = Math.sqrt(d2);
          const inv = 1 / dist;
          resolve(body, dx * inv, dy * inv, dz * inv, r - dist, c, sdt);
        } else {
          // Center inside the box: exit through the nearest face.
          let pen = (p.x - min.x) + r, nx = -1, ny = 0, nz = 0;
          let d = (max.x - p.x) + r;
          if (d < pen) { pen = d; nx = 1; ny = 0; nz = 0; }
          d = (p.y - min.y) + r;
          if (d < pen) { pen = d; nx = 0; ny = -1; nz = 0; }
          d = (max.y - p.y) + r;
          if (d < pen) { pen = d; nx = 0; ny = 1; nz = 0; }
          d = (p.z - min.z) + r;
          if (d < pen) { pen = d; nx = 0; ny = 0; nz = -1; }
          d = (max.z - p.z) + r;
          if (d < pen) { pen = d; nx = 0; ny = 0; nz = 1; }
          resolve(body, nx, ny, nz, pen, c, sdt);
        }
      }
    }
  }

  // ---------------- orientation helpers ----------------
  // Slew the mesh so its -Z (nose) tracks `dir`, rolled by `roll` about it.
  function orientAlong(body, dir, roll, rate, dt) {
    if (!body.mesh) return;
    _v3.copy(dir);
    if (_v3.lengthSq() < 1e-6) return;
    _v3.normalize();
    _v4.set(0, 1, 0);
    if (roll) {
      _q2.setFromAxisAngle(_v3, roll);
      _v4.applyQuaternion(_q2);
    }
    if (Math.abs(_v3.y) > 0.98) _v4.set(0, 0, 1); // degenerate up guard
    _m1.lookAt(_zero, _v3, _v4); // -Z of resulting basis points along dir
    _q1.setFromRotationMatrix(_m1);
    body.mesh.quaternion.slerp(_q1, Math.min(1, rate * dt));
    body._oriented = true;
  }

  function integrateAngular(body, dt) {
    const w = body.angularVelocity;
    if (w.lengthSq() < 1e-8) return;
    const q = body.mesh.quaternion;
    _q1.set(w.x, w.y, w.z, 0).multiply(q); // world-space omega
    q.x += _q1.x * 0.5 * dt;
    q.y += _q1.y * 0.5 * dt;
    q.z += _q1.z * 0.5 * dt;
    q.w += _q1.w * 0.5 * dt;
    q.normalize();
  }

  // ---------------- aerodynamics ----------------
  function aeroGlider(body, a, sdt) {
    const v = body.velocity, d = body.data;
    const speed = v.length();
    if (d._bank === undefined) {
      // Bank captured from release roll: mesh right axis dip + wrist spin.
      _v1.set(1, 0, 0).applyQuaternion(body.mesh.quaternion);
      let bank = Math.asin(Math.max(-1, Math.min(1, _v1.y)));
      _v2.set(0, 0, -1).applyQuaternion(body.mesh.quaternion);
      bank += Math.max(-0.5, Math.min(0.5, body.angularVelocity.dot(_v2) * 0.1));
      d._bank = Math.max(-0.9, Math.min(0.9, bank));
    }
    if (speed <= a.minSpeed) return; // stalled: plain gravity this substep

    // Horizontal speed relaxes toward cruise (dive bleeds off, lobs pick up).
    const hs = Math.sqrt(v.x * v.x + v.z * v.z);
    if (hs > 0.001) {
      const k = 1 + ((a.cruise - hs) / hs) * Math.min(1, a.cruiseRate * sdt);
      v.x *= k; v.z *= k;
    }
    // Vertical speed relaxes toward -sink (this replaces gravity => dreamy).
    const sink = a.sink + Math.max(0, a.cruise - hs) * 0.5;
    const rate = v.y > 0 ? a.riseRelax : (v.y > -sink ? a.glideRelax : a.flareRelax);
    v.y += (-sink - v.y) * Math.min(1, rate * sdt);

    // Bank-driven turn: positive bank = left wing... turns left. Washout.
    d._bank *= Math.max(0, 1 - a.bankDecay * sdt);
    const yaw = (d._bank * a.turnRate + Math.sin(simTime * 0.7 + body._seed) * 0.04) * sdt;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const nx = cy * v.x + sy * v.z;
    const nz = -sy * v.x + cy * v.z;
    v.x = nx; v.z = nz;

    orientAlong(body, v, -d._bank, a.align, sdt);
  }

  function aeroFrisbee(body, a, sdt) {
    const v = body.velocity, d = body.data;
    if (d._spin === undefined) {
      d._spin = body.angularVelocity.length();
      _v1.set(0, 1, 0).applyQuaternion(body.mesh.quaternion);
      d._spinSign = body.angularVelocity.dot(_v1) >= 0 ? 1 : -1;
    }
    d._spin *= Math.max(0, 1 - a.spinDecay * sdt);
    const speed = v.length();
    if (speed < 0.5) return;
    const spinFrac = Math.min(1, d._spin / a.fullSpin);
    const hs = Math.sqrt(v.x * v.x + v.z * v.z);
    if (hs > 0.3) {
      // Spin-stabilized lift cancels most of gravity while spin lasts.
      v.y += (-GRAVITY) * a.lift * spinFrac * Math.min(1, hs / a.liftSpeed) * sdt;
      // Lateral curve.
      const inv = 1 / hs;
      const sx = -v.z * inv, sz = v.x * inv; // horizontal right of travel
      const cAcc = a.curve * spinFrac * d._spinSign;
      v.x += sx * cAcc * sdt;
      v.z += sz * cAcc * sdt;
      // Aero bleed.
      const f = Math.max(0, 1 - a.airDrag * sdt);
      v.x *= f; v.z *= f;
      // Disc banks into the curve; keeps visibly spinning about its axis.
      _v2.set(sx * a.tilt * spinFrac * d._spinSign, 1, sz * a.tilt * spinFrac * d._spinSign).normalize();
      _v1.set(0, 1, 0);
      _q1.setFromUnitVectors(_v1, _v2);
      body.mesh.quaternion.slerp(_q1, Math.min(1, a.align * sdt));
      body.mesh.rotateY(d._spin * d._spinSign * sdt);
      body._oriented = true;
    }
  }

  function aeroBalloon(body, a, sdt) {
    const v = body.velocity, wind = (ctx && ctx.wind) || _zero;
    // Buoyancy cancels most of gravity; wind owns the horizontal motion.
    v.y += (-GRAVITY) * a.buoyancy * sdt;
    v.y += Math.sin(simTime * 1.3 + body._seed) * a.bob * sdt;
    if (v.y < -a.terminal) v.y = -a.terminal;
    const wf = body.windFactor !== undefined ? body.windFactor : 1;
    const k = Math.min(1, a.couple * sdt);
    v.x += (wind.x * a.windGain * wf - v.x) * k;
    v.z += (wind.z * a.windGain * wf - v.z) * k;
  }

  function aeroRocket(body, a, sdt) {
    const v = body.velocity, d = body.data;
    d._t = (d._t || 0) + sdt;
    const delay = d.igniteDelay !== undefined ? d.igniteDelay : 0.5;
    const burn = d.burn !== undefined ? d.burn : 1.6;
    const thrust = d.thrust !== undefined ? d.thrust : a.thrust;
    if (d._t >= delay && d._t <= delay + burn && body.mesh) {
      d.burning = true;
      if (d.forward && d.forward.isVector3 && d.forward.lengthSq() > 1e-6) {
        _v1.copy(d.forward).normalize();
      } else {
        _v1.set(0, 0, -1).applyQuaternion(body.mesh.quaternion);
      }
      // Thrust-vector wiggle so it carves a lively, slightly drunk line.
      const wob = a.wobble * Math.sin(simTime * 21 + body._seed);
      _v2.set(0, 1, 0).cross(_v1);
      if (_v2.lengthSq() < 1e-6) _v2.set(1, 0, 0);
      _v2.normalize();
      _q2.setFromAxisAngle(_v2, wob);
      _v1.applyQuaternion(_q2);
      v.addScaledVector(_v1, thrust * sdt);
      // Weathercock: nose eases onto the velocity vector -> big arcs.
      if (v.lengthSq() > 1) orientAlong(body, v, 0, a.align, sdt);
    } else if (d.burning) {
      d.burning = false; // burnout: tumbles ballistically from here
    }
  }

  function aeroProp(body, a, sdt) {
    const v = body.velocity, d = body.data;
    d._t = (d._t || 0) + sdt;
    if (d._t <= a.burnTime) {
      // Powered: thrust along the nose, ease into a gentle climb.
      d.burning = true;
      _v1.set(0, 0, -1).applyQuaternion(body.mesh.quaternion);
      v.addScaledVector(_v1, a.thrust * sdt);
      v.y += (a.climb - v.y) * Math.min(1, 1.1 * sdt);
      const sp = v.length();
      if (sp > a.maxSpeed) v.multiplyScalar(a.maxSpeed / sp);
      if (v.lengthSq() > 0.25) {
        // lazy S-curve wander while under power
        const roll = Math.sin(simTime * 1.9 + body._seed) * 0.22;
        orientAlong(body, v, roll, a.align, sdt);
      }
    } else {
      if (d.burning) d.burning = false; // band unwound: pure glider from here
      aeroGlider(body, a, sdt);
    }
  }

  function aeroUfo(body, a, sdt) {
    const v = body.velocity, d = body.data;
    d._t = (d._t || 0) + sdt;
    if (d._t > a.hoverTime) {
      if (d.burning) d.burning = false; // charge spent: gravity wins
      return;
    }
    d.burning = true;
    v.y -= GRAVITY * sdt;                                // cancel gravity
    v.y += (-a.sink - v.y) * Math.min(1, 2.0 * sdt);     // ease to gentle sink
    const ph = simTime * a.wobbleHz + body._seed;
    v.y += Math.sin(ph * 1.7) * a.bob * sdt;             // hover bob
    const hs = Math.sqrt(v.x * v.x + v.z * v.z);
    if (hs > 0.05) {
      // hold cruise speed along the current heading
      const k = 1 + ((a.cruise - hs) / hs) * Math.min(1, a.couple * sdt);
      v.x *= k; v.z *= k;
      // playful lateral weave
      const inv = 1 / hs;
      const sx = -v.z * inv, sz = v.x * inv;             // right of travel
      const acc = Math.sin(ph) * a.wobbleAmp;
      v.x += sx * acc * sdt;
      v.z += sz * acc * sdt;
      // saucer stays level, banking into the weave; spin is objects.js's job
      _v2.set(sx * a.tilt * Math.sin(ph), 1, sz * a.tilt * Math.sin(ph)).normalize();
      _v1.set(0, 1, 0);
      _q1.setFromUnitVectors(_v1, _v2);
      if (body.mesh) {
        body.mesh.quaternion.slerp(_q1, Math.min(1, a.align * sdt));
        body._oriented = true;
      }
    }
  }

  function aeroUmbrella(body, a, sdt) {
    const v = body.velocity, d = body.data;
    d._t = (d._t || 0) + sdt;
    const open = d.open === true || (d.open === undefined && d._t > 0.35);
    if (!open) return;
    // Terminal velocity clamp (contract: ~1.5 m/s).
    if (v.y < -a.terminal) v.y = -a.terminal;
    // Sway: gentle wandering pendulum drift.
    const ph = simTime + body._seed;
    const ax = Math.sin(ph * 1.7) * a.swayAmp;
    const az = Math.cos(ph * 1.3) * a.swayAmp;
    v.x += ax * sdt;
    v.z += az * sdt;
    const f = Math.max(0, 1 - a.hDrag * sdt);
    v.x *= f; v.z *= f;
    // Canopy tilts opposite the sway like a real pendulum.
    _v2.set(-ax * a.tilt, 1, -az * a.tilt).normalize();
    _v1.set(0, 1, 0);
    _q1.setFromUnitVectors(_v1, _v2);
    if (body.mesh) {
      body.mesh.quaternion.slerp(_q1, Math.min(1, a.align * sdt));
      body._oriented = true;
    }
  }

  // ---------------- main update ----------------
  function update(dt) {
    if (!isFinite(dt) || dt <= 0) return;
    simTime += dt;
    const wind = (ctx && ctx.wind && ctx.wind.isVector3) ? ctx.wind : _zero;

    for (let bi = bodies.length - 1; bi >= 0; bi--) {
      const body = bodies[bi];
      if (!body || !body.mesh || body.alive === false) {
        if (body) body.alive = false;
        bodies.splice(bi, 1);
        continue;
      }
      if (body.held) {
        body._slow = 0;
        body._water = -1;
        continue; // interaction module drives held/racked bodies
      }

      const p = body.mesh.position;
      const v = body.velocity;

      // Lifetime.
      body._age += dt;
      if (body._age > BODY_LIFETIME) {
        body.alive = false;
        bodies.splice(bi, 1);
        continue;
      }

      // Water sink phase: no collisions, slide under, despawn after 1s.
      if (body._water >= 0) {
        body._water += dt;
        p.x += v.x * dt; p.z += v.z * dt;
        p.y += Math.max(v.y, -0.8) * dt;
        v.multiplyScalar(Math.max(0, 1 - 2.5 * dt));
        integrateAngular(body, dt * 0.3);
        if (body._water > 1) {
          body.alive = false;
          bodies.splice(bi, 1);
        }
        continue;
      }

      body._ground = false;
      body._oriented = false;

      // Substep fast movers so they can't tunnel through parapets/awnings.
      const travel = v.length() * dt;
      const minR = Math.max(0.05, body.radius * 0.8);
      const steps = travel > minR ? Math.min(6, Math.ceil(travel / minR)) : 1;
      const sdt = dt / steps;
      const aero = body.aero;

      for (let s = 0; s < steps && body.alive && body._water < 0; s++) {
        // Gravity — except a glider (or prop glider) at flying speed, whose
        // aero model owns the vertical axis (that's what makes glides dreamy).
        const gliding = aero && (aero.type === 'glider' || aero.type === 'prop') &&
          v.lengthSq() > (aero.minSpeed || 2.2) * (aero.minSpeed || 2.2);
        if (!gliding) v.y += GRAVITY * sdt;

        // Wind (balloon handles its own coupling).
        if ((!aero || aero.type !== 'balloon') && body.windFactor) {
          const wp = body.windFactor * 1.6 * sdt;
          v.x += wind.x * wp; v.y += wind.y * wp; v.z += wind.z * wp;
        }

        // Aerodynamics.
        if (aero) {
          try {
            switch (aero.type) {
              case 'glider': aeroGlider(body, aero, sdt); break;
              case 'frisbee': aeroFrisbee(body, aero, sdt); break;
              case 'balloon': aeroBalloon(body, aero, sdt); break;
              case 'rocket': aeroRocket(body, aero, sdt); break;
              case 'umbrella': aeroUmbrella(body, aero, sdt); break;
              case 'prop': aeroProp(body, aero, sdt); break;
              case 'ufo': aeroUfo(body, aero, sdt); break;
            }
          } catch (e) { /* bad tuning data must not kill the sim */ }
        }

        // Linear drag.
        if (body.drag) v.multiplyScalar(Math.max(0, 1 - body.drag * sdt));

        // Integrate position (semi-implicit: velocity already updated).
        p.x += v.x * sdt; p.y += v.y * sdt; p.z += v.z * sdt;

        // Collide + respond.
        collide(body, sdt);
      }
      if (!body.alive) { bodies.splice(bi, 1); continue; }
      if (body._water >= 0) continue; // splashed down mid-substep

      // NaN guard: a poisoned body despawns rather than poisoning the frame.
      if (!isFinite(p.x + p.y + p.z + v.x + v.y + v.z)) {
        body.alive = false;
        bodies.splice(bi, 1);
        continue;
      }

      // Rolling resistance on ground.
      if (body._ground) {
        const f = Math.max(0, 1 - 0.4 * dt);
        v.x *= f; v.z *= f;
      }

      // Spin: integrate unless an aero model already posed the mesh.
      if (!body._oriented) integrateAngular(body, dt);
      let wDamp = 0.12;
      if (aero) {
        if (aero.type === 'glider' || aero.type === 'umbrella' || aero.type === 'prop') wDamp = 2.5;
        else if (aero.type === 'rocket' && body.data.burning) wDamp = 3;
        else if (aero.type === 'balloon') wDamp = 0.8;
        else if (aero.type === 'frisbee') wDamp = 0.35;
        else if (aero.type === 'ufo') wDamp = 2.0;
      }
      body.angularVelocity.multiplyScalar(Math.max(0, 1 - wDamp * dt));

      // Despawn rules.
      if (p.y < KILL_Y) {
        body.alive = false;
        bodies.splice(bi, 1);
        continue;
      }
      if (v.lengthSq() < 0.09) {
        body._slow += dt;
        if (body._slow > 2) {
          body.alive = false;
          bodies.splice(bi, 1);
          continue;
        }
      } else {
        body._slow = 0;
      }
    }
  }

  // Fresh-flight resets so re-thrown (caught) objects re-tune their aero.
  if (events && events.on) {
    events.on('throw', (payload) => {
      try {
        const b = payload && payload.body;
        if (!b) return;
        b.held = false;
        b._age = 0; b._slow = 0; b._water = -1;
        if (b.data) {
          b.data._t = 0;
          b.data._bank = undefined;
          b.data._spin = undefined;
          b.data.burning = false;
          b.data.inWater = false;
        }
      } catch (e) { /* defensive */ }
    });
    events.on('grab', (payload) => {
      try {
        const b = payload && payload.body;
        if (b) { b._slow = 0; b._water = -1; }
      } catch (e) { /* defensive */ }
    });
  }

  return {
    bodies,
    colliders,
    makeBody,
    addBody,
    removeBody,
    addCollider,
    removeCollider,
    update,
    groundHeightAt,
  };
}
