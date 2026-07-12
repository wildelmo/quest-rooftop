// src/targets.js — CHUCK CITY targets & scoring.
// Dumpster, basketball hoop, rooftop pool, intersection bullseye, trampoline
// (BOOMERANG catches), looping delivery truck with an open bed, breakable
// windows on world.facingBuilding, and a flock of skittish pigeons.
// Scoring engine: combo x1..x5 inside COMBO_WINDOW, +1/m flight-distance
// bonus, emits 'score' / 'target-hit' / 'slowmo' (points >= SLOWMO_THRESHOLD).
//
// Contract (ARCHITECTURE.md): createTargets(ctx) -> { update(dt, t, rawDt), score }

import * as THREE from 'three';
import {
  ROOF_Y, BUILDING_HALF_D, STREET_CENTER_Z, FACING_BUILDING, PARK,
  COMBO_WINDOW, SLOWMO_THRESHOLD,
} from './constants.js';

// ---------- defensive constant fallbacks (other modules may be stubs) --------
const ROOF = (typeof ROOF_Y === 'number') ? ROOF_Y : 24;
const BHD = (typeof BUILDING_HALF_D === 'number') ? BUILDING_HALF_D : 7;
const SCZ = (typeof STREET_CENTER_Z === 'number') ? STREET_CENTER_Z : -17;
const FB = (FACING_BUILDING && typeof FACING_BUILDING.z === 'number')
  ? FACING_BUILDING : { x: 0, halfW: 14, z: -38, halfD: 11, height: 30 };
const PKV = (PARK && typeof PARK.x === 'number')
  ? PARK : { x: -38, z: -17, halfW: 16, halfD: 12 };
const COMBO_W = (typeof COMBO_WINDOW === 'number') ? COMBO_WINDOW : 6;
const SLOWMO_AT = (typeof SLOWMO_THRESHOLD === 'number') ? SLOWMO_THRESHOLD : 300;

// ---------- module-scope temps (zero per-frame allocations) ------------------
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _q1 = new THREE.Quaternion();
const _e1 = new THREE.Euler();
const _s1 = new THREE.Vector3();
const _c1 = new THREE.Color();

// ---------- tiny static-geometry merger (vertex colors, one draw call) -------
function newMerger() { return { pos: [], nrm: [], col: [] }; }

function pushGeom(m, geom, color, x, y, z, ry, rx) {
  let g = geom.index ? geom.toNonIndexed() : geom;
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  const p = g.attributes.position.array;
  const n = g.attributes.normal.array;
  _c1.set(color);
  for (let i = 0; i < p.length; i += 3) {
    m.pos.push(p[i], p[i + 1], p[i + 2]);
    m.nrm.push(n[i], n[i + 1], n[i + 2]);
    m.col.push(_c1.r, _c1.g, _c1.b);
  }
  if (g !== geom) g.dispose();
  geom.dispose();
}
function pushBox(m, w, h, d, color, x, y, z, ry) {
  pushGeom(m, new THREE.BoxGeometry(w, h, d), color, x, y, z, ry || 0, 0);
}
function pushCyl(m, rt, rb, h, seg, color, x, y, z, rx) {
  pushGeom(m, new THREE.CylinderGeometry(rt, rb, h, seg), color, x, y, z, 0, rx || 0);
}
function buildMerged(m, material) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(m.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(m.nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(m.col, 3));
  return new THREE.Mesh(g, material);
}

// =============================================================================
export function createTargets(ctx) {
  ctx = ctx || {};
  const scene = (ctx.scene && ctx.scene.add) ? ctx.scene : new THREE.Group();
  const phys = ctx.physics || {};
  const events = ctx.events;

  // ---------- guarded plumbing ----------
  function on(name, fn) { try { if (events && events.on) events.on(name, fn); } catch (e) {} }
  function emit(name, p) { try { if (events && events.emit) events.emit(name, p); } catch (e) {} }
  function fx(name, a, b, c) {
    try {
      const f = ctx.effects && ctx.effects[name];
      if (typeof f === 'function') f.call(ctx.effects, a, b, c);
    } catch (e) {}
  }
  function snd(name, opts) {
    try { if (ctx.audio && typeof ctx.audio.play === 'function') ctx.audio.play(name, opts); } catch (e) {}
  }
  function addCollider(c) {
    try { if (typeof phys.addCollider === 'function') phys.addCollider(c); } catch (e) {}
    return c;
  }
  function removeCollider(c) {
    try { if (typeof phys.removeCollider === 'function') phys.removeCollider(c); } catch (e) {}
  }
  function aabb(x0, y0, z0, x1, y1, z1, surface, name) {
    return addCollider({
      type: 'aabb',
      min: new THREE.Vector3(x0, y0, z0),
      max: new THREE.Vector3(x1, y1, z1),
      surface, name,
    });
  }

  // =========================================================================
  // SCORING ENGINE
  // =========================================================================
  let total = 0;
  let combo = 0;
  let lastScoreT = -1e9;
  let now = 0; // game-time clock (dt-accumulated, so slow-mo stretches combos)
  let headX = 0, headY = ROOF + 1.6, headZ = 0; // freshest player-head estimate

  // Flight trackers: one per thrown body. Pooled, swap-removed, Map-indexed.
  const trackers = [];
  const trackerPool = [];
  const trackerByBody = new Map();

  function trackThrow(body) {
    if (!body || !body.mesh || !body.mesh.position) return;
    let t = trackerByBody.get(body);
    if (!t) {
      t = trackerPool.pop() || {
        body: null, tx: 0, ty: 0, tz: 0, px: 0, py: 0, pz: 0,
        trash: false, swish: false, splash: false, delivered: false,
        bullseye: false, tramp: false, boom: false, flock: false, dead: false,
      };
      trackers.push(t);
      trackerByBody.set(body, t);
    }
    const p = body.mesh.position;
    t.body = body;
    t.tx = p.x; t.ty = p.y; t.tz = p.z;
    t.px = p.x; t.py = p.y; t.pz = p.z;
    t.trash = t.swish = t.splash = t.delivered = false;
    t.bullseye = t.tramp = t.boom = t.flock = t.dead = false;
  }

  function releaseTracker(i) {
    const t = trackers[i];
    if (!t) return;
    trackerByBody.delete(t.body);
    t.body = null;
    trackers[i] = trackers[trackers.length - 1];
    trackers.pop();
    trackerPool.push(t);
  }

  // Awards are event-rate (a few per second at most), so a fresh Vector3 per
  // score event is fine — the hot per-frame paths allocate nothing.
  function award(name, label, base, x, y, z, body, color) {
    if (!isFinite(base) || !isFinite(x + y + z)) return 0;
    const t = body ? trackerByBody.get(body) : null;
    let distBonus = 0;
    if (t) {
      const dx = x - t.tx, dy = y - t.ty, dz = z - t.tz;
      distBonus = Math.floor(Math.sqrt(dx * dx + dy * dy + dz * dz));
      if (!isFinite(distBonus) || distBonus < 0) distBonus = 0;
    }
    combo = (now - lastScoreT <= COMBO_W) ? Math.min(5, combo + 1) : 1;
    lastScoreT = now;
    const points = Math.round(base * combo + distBonus);
    total += points;

    const pos = new THREE.Vector3(x, y, z);
    emit('target-hit', { name, points, position: pos, body: body || null });
    emit('score', { points, label, position: pos, combo, total });
    if (points >= SLOWMO_AT) emit('slowmo', { duration: 1.2 });

    // Presentation (popup + confetti) is owned by effects.js's 'score'
    // listener — rendering it here too doubled every popup/burst.
    snd('ding', { position: pos, intensity: Math.min(1.5, 0.5 + points / 400) });
    if (combo >= 2) snd('combo', { position: pos, intensity: 0.4 + combo * 0.15 });
    if (points >= 800) snd('fanfare', { position: pos });
    return points;
  }

  // =========================================================================
  // STATIC TARGET GEOMETRY (single merged vertex-colored mesh)
  // =========================================================================
  const S = newMerger();

  // ---------------- DUMPSTER (curb parking lane, east of the notch) ---------
  const DX = 10, DZ = -10.6, D_RIM = 1.32;
  {
    const G1 = 0x3e7d4c, G2 = 0x336a40, DK = 0x1c241c;
    pushBox(S, 2.4, 0.2, 1.4, G2, DX, 0.18, DZ);                 // floor slab
    pushBox(S, 2.4, 1.14, 0.1, G1, DX, 0.75, DZ - 0.65);         // front wall
    pushBox(S, 2.4, 1.14, 0.1, G1, DX, 0.75, DZ + 0.65);         // back wall
    pushBox(S, 0.1, 1.14, 1.4, G2, DX - 1.15, 0.75, DZ);         // left wall
    pushBox(S, 0.1, 1.14, 1.4, G2, DX + 1.15, 0.75, DZ);         // right wall
    pushBox(S, 2.16, 0.03, 1.14, DK, DX, 0.3, DZ);               // dark interior
    pushBox(S, 2.44, 0.24, 0.05, 0x8fce7a, DX, 0.92, DZ - 0.69); // stripe
    // lids flung open, leaning back over the rear wall
    pushGeom(S, new THREE.BoxGeometry(1.12, 0.05, 0.78), 0x2f5c38, DX - 0.6, 1.5, DZ + 0.98, 0, -2.15);
    pushGeom(S, new THREE.BoxGeometry(1.12, 0.05, 0.78), 0x2f5c38, DX + 0.6, 1.5, DZ + 0.98, 0, -2.15);
    for (let i = 0; i < 4; i++) { // stubby wheels
      pushCyl(S, 0.09, 0.09, 0.08, 6, 0x22262a,
        DX + (i < 2 ? -0.95 : 0.95), 0.09, DZ + (i % 2 ? 0.5 : -0.5), Math.PI / 2);
    }
    aabb(DX - 1.2, 0, DZ - 0.7, DX + 1.2, 0.3, DZ + 0.7, 'metal', 'dumpster-floor');
    aabb(DX - 1.2, 0, DZ - 0.7, DX + 1.2, D_RIM, DZ - 0.5, 'metal', 'dumpster-wall');
    aabb(DX - 1.2, 0, DZ + 0.5, DX + 1.2, D_RIM, DZ + 0.7, 'metal', 'dumpster-wall');
    aabb(DX - 1.2, 0, DZ - 0.7, DX - 1.0, D_RIM, DZ + 0.7, 'metal', 'dumpster-wall');
    aabb(DX + 1.0, 0, DZ - 0.7, DX + 1.2, D_RIM, DZ + 0.7, 'metal', 'dumpster-wall');
  }

  // ---------------- BASKETBALL HOOP (park clearing) --------------------------
  const HX = PKV.x + PKV.halfW - 6, HZ = PKV.z; // (-28, -17): world's tree-free spot
  const RIM_X = HX + 0.06, RIM_Y = 3.05, RIM_Z = HZ, RIM_R = 0.42;
  {
    const gy = 0.12; // park grass top
    pushCyl(S, 0.07, 0.1, 3.9, 7, 0x3c4753, HX - 1.35, gy + 1.95, HZ);
    pushBox(S, 1.0, 0.08, 0.08, 0x3c4753, HX - 0.85, 3.62, HZ);       // arm
    pushBox(S, 0.08, 1.0, 1.5, 0xf2f3ee, HX - 0.4, 3.4, HZ);          // backboard
    pushBox(S, 0.03, 0.5, 0.7, 0xd8452e, HX - 0.35, 3.22, HZ);        // red square
    pushGeom(S, new THREE.TorusGeometry(RIM_R, 0.038, 6, 16), 0xe06c2a,
      RIM_X, RIM_Y, RIM_Z, 0, Math.PI / 2);                           // rim
    pushGeom(S, new THREE.CylinderGeometry(0.4, 0.22, 0.5, 8, 1, true), 0xf5f5f0,
      RIM_X, RIM_Y - 0.29, RIM_Z, 0, 0);                              // net
    pushBox(S, 1.4, 0.06, 1.4, 0xb8b09a, HX - 1.35, gy + 0.03, HZ);   // base pad
    aabb(HX - 1.44, 0, HZ - 0.09, HX - 1.26, 3.7, HZ + 0.09, 'metal', 'hoop-pole');
    aabb(HX - 0.44, 2.9, HZ - 0.75, HX - 0.36, 3.9, HZ + 0.75, 'metal', 'backboard');
    // four tiny rim blocks so near-misses clang out instead of ghosting through
    aabb(RIM_X + 0.4, RIM_Y - 0.05, RIM_Z - 0.06, RIM_X + 0.52, RIM_Y + 0.05, RIM_Z + 0.06, 'metal', 'rim');
    aabb(RIM_X - 0.52, RIM_Y - 0.05, RIM_Z - 0.06, RIM_X - 0.4, RIM_Y + 0.05, RIM_Z + 0.06, 'metal', 'rim');
    aabb(RIM_X - 0.06, RIM_Y - 0.05, RIM_Z + 0.4, RIM_X + 0.06, RIM_Y + 0.05, RIM_Z + 0.52, 'metal', 'rim');
    aabb(RIM_X - 0.06, RIM_Y - 0.05, RIM_Z - 0.52, RIM_X + 0.06, RIM_Y + 0.05, RIM_Z - 0.4, 'metal', 'rim');
  }

  // ---------------- BULLSEYE (main street x cross street intersection) -------
  const BX = -15, BZ = SCZ, B_R1 = 1.0, B_R2 = 2.1, B_R3 = 3.2;
  {
    const y = 0.06; // just above the asphalt paint
    pushGeom(S, new THREE.CircleGeometry(B_R1, 24), 0xd23b2f, BX, y, BZ, 0, -Math.PI / 2);
    pushGeom(S, new THREE.RingGeometry(B_R1, B_R2, 28), 0xf2ead2, BX, y, BZ, 0, -Math.PI / 2);
    pushGeom(S, new THREE.RingGeometry(B_R2, B_R3, 32), 0xc94b3a, BX, y, BZ, 0, -Math.PI / 2);
    pushGeom(S, new THREE.RingGeometry(B_R3, B_R3 + 0.18, 32), 0xf2ead2, BX, y, BZ, 0, -Math.PI / 2);
  }

  // ---------------- TRAMPOLINE (sidewalk under the throwing notch) -----------
  const TRX = -0.6, TRZ = -BHD - 1.2; // (-0.6, -8.2): bounces return to the parapet
  let trampSquash = 0;
  let trampFabric = null;
  {
    const legs = [[-0.85, -0.85], [0.85, -0.85], [-0.85, 0.85], [0.85, 0.85]];
    for (let i = 0; i < legs.length; i++) {
      pushCyl(S, 0.05, 0.06, 0.78, 6, 0x39424c, TRX + legs[i][0], 0.53, TRZ + legs[i][1]);
    }
    pushGeom(S, new THREE.TorusGeometry(1.25, 0.08, 6, 18), 0x44639c,
      TRX, 0.95, TRZ, 0, Math.PI / 2);                                  // frame
    pushGeom(S, new THREE.RingGeometry(0.98, 1.32, 18), 0x5b8ce0,
      TRX, 0.99, TRZ, 0, -Math.PI / 2);                                 // pad ring
    trampFabric = new THREE.Mesh(
      new THREE.CircleGeometry(1.02, 18).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: 0x27355a }));
    trampFabric.position.set(TRX, 0.965, TRZ);
    scene.add(trampFabric);
    aabb(TRX - 1.25, 0, TRZ - 1.25, TRX + 1.25, 0.95, TRZ + 1.25, 'trampoline', 'trampoline');
  }

  // ---------------- ROOFTOP POOL (neighbor building across the street) -------
  // Adaptive: find the real building roof near (26, -38.5) among the colliders
  // world already registered; if world changed and nothing stands there, build
  // our own little podium tower so the target always exists.
  let poolCX = 26, poolCZ = -38.5, poolRoofY = 12, poolSurfY = 0;
  {
    const list = Array.isArray(phys.colliders) ? phys.colliders : [];
    const PXQ = 26, PZQ = -38.5;
    let found = null;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c || c.type !== 'aabb' || !c.min || !c.max || c.surface !== 'roof') continue;
      if (PXQ < c.min.x || PXQ > c.max.x || PZQ < c.min.z || PZQ > c.max.z) continue;
      if (c.min.y > 1) continue;                                  // grounded buildings only
      if (c.max.y < 6 || c.max.y > ROOF - 3) continue;            // player must see the water
      if (c.max.x - c.min.x < 8.6 || c.max.z - c.min.z < 6.8) continue;
      if (!found || c.max.y > found.max.y) found = c;
    }
    if (found) {
      poolRoofY = found.max.y;
      poolCX = Math.max(found.min.x + 4.2, Math.min(found.max.x - 4.2, PXQ));
      poolCZ = Math.min(found.max.z - 3.4, Math.max(found.min.z + 3.2, PZQ + 3));
    } else {
      // fallback podium building
      pushBox(S, 10, 12, 9, 0xc9b8a0, poolCX, 6, poolCZ);
      for (let k = 0; k < 4; k++) {
        pushBox(S, 8, 0.9, 0.1, 0x46586e, poolCX, 2.2 + k * 2.6, poolCZ + 4.55);
      }
      aabb(poolCX - 5, 0, poolCZ - 4.5, poolCX + 5, 12, poolCZ + 4.5, 'roof', 'pool-building');
    }
    const py = poolRoofY;
    poolSurfY = py + 0.72;
    pushBox(S, 8.2, 0.18, 6.2, 0xded6c2, poolCX, py + 0.09, poolCZ);   // deck
    pushBox(S, 7.16, 0.62, 0.28, 0xece6d4, poolCX, py + 0.49, poolCZ - 2.44);
    pushBox(S, 7.16, 0.62, 0.28, 0xece6d4, poolCX, py + 0.49, poolCZ + 2.44);
    pushBox(S, 0.28, 0.62, 4.6, 0xece6d4, poolCX - 3.44, py + 0.49, poolCZ);
    pushBox(S, 0.28, 0.62, 4.6, 0xece6d4, poolCX + 3.44, py + 0.49, poolCZ);
    // diving board, pedestal, beach umbrella (payoff staging)
    pushBox(S, 0.3, 0.5, 0.3, 0xb8b0a0, poolCX + 2.0, py + 0.43, poolCZ + 2.75);
    pushBox(S, 0.36, 0.06, 1.5, 0xe8c25a, poolCX + 2.0, py + 0.71, poolCZ + 2.1);
    pushCyl(S, 0.03, 0.04, 1.9, 6, 0x8a7a66, poolCX - 3.8, py + 0.95, poolCZ - 2.0);
    pushGeom(S, new THREE.ConeGeometry(0.95, 0.5, 8), 0xe86a5c, poolCX - 3.8, py + 2.0, poolCZ - 2.0, 0, 0);
    // water: separate mesh so it can be emissive blue
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(6.6, 4.6).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: 0x36a6dc, emissive: 0x14486b, emissiveIntensity: 0.7 }));
    water.position.set(poolCX, poolSurfY, poolCZ);
    scene.add(water);
    aabb(poolCX - 4.1, py, poolCZ - 3.1, poolCX + 4.1, py + 0.18, poolCZ + 3.1, 'roof', 'pool-deck');
    aabb(poolCX - 3.58, py + 0.18, poolCZ - 2.58, poolCX + 3.58, py + 0.8, poolCZ - 2.3, 'metal', 'pool-wall');
    aabb(poolCX - 3.58, py + 0.18, poolCZ + 2.3, poolCX + 3.58, py + 0.8, poolCZ + 2.58, 'metal', 'pool-wall');
    aabb(poolCX - 3.58, py + 0.18, poolCZ - 2.58, poolCX - 3.3, py + 0.8, poolCZ + 2.58, 'metal', 'pool-wall');
    aabb(poolCX + 3.3, py + 0.18, poolCZ - 2.58, poolCX + 3.58, py + 0.8, poolCZ + 2.58, 'metal', 'pool-wall');
    aabb(poolCX - 3.3, py, poolCZ - 2.3, poolCX + 3.3, poolSurfY, poolCZ + 2.3, 'water', 'pool');
  }

  // =========================================================================
  // DELIVERY TRUCK (kinematic loop on the main street, ~35 s incl. pause)
  // =========================================================================
  const T_Z1 = SCZ + 3.75, T_Z2 = SCZ - 3.75;   // near / far lane centers
  const T_XMIN = -8, T_XMAX = 56, T_R = 3.75;   // stadium loop (clears the bullseye)
  const T_L1 = T_XMAX - T_XMIN;                 // straight length (64 m)
  const T_ARC = Math.PI * T_R;
  const T_LOOP = 2 * T_L1 + 2 * T_ARC;          // ~151.6 m
  const T_CRUISE = 5.0;                         // ~30.3 s driving + 4.7 s pause = ~35 s
  const T_PAUSE_S = T_XMAX - 4;                 // pause when x reaches 4, right below the notch
  let truckS = 26, truckV = T_CRUISE, truckPauseT = 0, truckPausedLap = false;
  let truckX = 0, truckZ = 0, truckDX = -1, truckDZ = 0, truckYaw = Math.PI;
  const truck = new THREE.Group();
  const truckColliders = [];
  // local-frame collider boxes: [ox, oz, halfX, halfZ, y0, y1]
  const TRUCK_BOXES = [
    [1.7, 0, 0.95, 0.95, 0, 2.35],      // cab
    [-0.85, 0, 1.55, 0.9, 0, 1.12],     // chassis + bed floor
    [0.65, 0, 0.07, 0.9, 1.12, 1.66],   // bed front wall
    [-2.35, 0, 0.07, 0.9, 1.12, 1.66],  // bed rear wall
    [-0.85, 0.86, 1.55, 0.07, 1.12, 1.66],
    [-0.85, -0.86, 1.55, 0.07, 1.12, 1.66],
  ];
  {
    const T = newMerger();
    pushBox(T, 4.6, 0.3, 1.8, 0x3a3f46, 0, 0.62, 0);              // chassis
    pushBox(T, 1.5, 1.5, 1.9, 0xd8563e, 1.7, 1.55, 0);            // cab
    pushBox(T, 0.9, 0.3, 1.86, 0xf2e6c8, 1.7, 2.14, 0);           // cab band
    pushBox(T, 0.1, 0.55, 1.55, 0xbfe0ea, 2.42, 1.85, 0);         // windshield
    pushBox(T, 0.12, 0.45, 1.6, 0x2c3138, 2.44, 0.95, 0);         // grille
    pushBox(T, 0.1, 0.16, 0.3, 0xffe9a8, 2.44, 1.25, 0.62);       // headlights
    pushBox(T, 0.1, 0.16, 0.3, 0xffe9a8, 2.44, 1.25, -0.62);
    pushBox(T, 3.1, 0.14, 1.8, 0x8f7a55, -0.85, 1.05, 0);         // bed floor
    pushBox(T, 0.1, 0.52, 1.8, 0xb08c46, 0.65, 1.38, 0);          // bed walls
    pushBox(T, 0.1, 0.52, 1.8, 0xb08c46, -2.35, 1.38, 0);
    pushBox(T, 3.1, 0.52, 0.1, 0xb08c46, -0.85, 1.38, 0.86);
    pushBox(T, 3.1, 0.52, 0.1, 0xb08c46, -0.85, 1.38, -0.86);
    const wheels = [[-1.55, 0.95], [1.55, 0.95], [-1.55, -0.95], [1.55, -0.95]];
    for (let i = 0; i < wheels.length; i++) {
      pushCyl(T, 0.4, 0.4, 0.28, 8, 0x22262b, wheels[i][0], 0.4, wheels[i][1], Math.PI / 2);
    }
    truck.add(buildMerged(T, new THREE.MeshLambertMaterial({ vertexColors: true })));
    scene.add(truck);
    for (let i = 0; i < TRUCK_BOXES.length; i++) {
      truckColliders.push(aabb(0, -10, 0, 0.1, -9.9, 0.1, 'metal', 'truck'));
    }
  }

  function truckPathAt(s) { // writes truckX/Z + truckDX/DZ
    s = ((s % T_LOOP) + T_LOOP) % T_LOOP;
    if (s < T_L1) {                        // near lane, heading west (-X)
      truckX = T_XMAX - s; truckZ = T_Z1; truckDX = -1; truckDZ = 0;
    } else if (s < T_L1 + T_ARC) {         // west U-turn
      const a = (s - T_L1) / T_R;
      truckX = T_XMIN - Math.sin(a) * T_R;
      truckZ = SCZ + Math.cos(a) * T_R;
      truckDX = -Math.cos(a); truckDZ = -Math.sin(a);
    } else if (s < 2 * T_L1 + T_ARC) {     // far lane, heading east (+X)
      truckX = T_XMIN + (s - T_L1 - T_ARC); truckZ = T_Z2; truckDX = 1; truckDZ = 0;
    } else {                               // east U-turn
      const a = (s - 2 * T_L1 - T_ARC) / T_R;
      truckX = T_XMAX + Math.sin(a) * T_R;
      truckZ = SCZ - Math.cos(a) * T_R;
      truckDX = Math.cos(a); truckDZ = Math.sin(a);
    }
  }

  function updateTruck(dt) {
    const wasS = truckS;
    const target = truckPauseT > 0 ? 0 : T_CRUISE;
    truckV += (target - truckV) * Math.min(1, 2.5 * dt);
    if (truckPauseT > 0) truckPauseT -= dt;
    truckS += truckV * dt;
    if (truckS >= T_LOOP) { truckS -= T_LOOP; truckPausedLap = false; }
    if (!truckPausedLap && wasS < T_PAUSE_S && truckS >= T_PAUSE_S) {
      truckPausedLap = true;
      truckPauseT = 4.7; // curbside delivery stop right in front of the player
    }
    truckPathAt(truckS);
    truckYaw = Math.atan2(-truckDZ, truckDX);
    truck.position.set(truckX, 0, truckZ);
    truck.rotation.y = truckYaw;
    // slide the AABB colliders along (conservative, yaw-blended extents)
    const c = Math.cos(truckYaw), s = Math.sin(truckYaw);
    const ac = Math.abs(c), as = Math.abs(s);
    for (let i = 0; i < TRUCK_BOXES.length; i++) {
      const B = TRUCK_BOXES[i], col = truckColliders[i];
      if (!col || !col.min || !col.max) continue;
      const wx = truckX + B[0] * c + B[1] * s;
      const wz = truckZ - B[0] * s + B[1] * c;
      const hx = ac * B[2] + as * B[3];
      const hz = as * B[2] + ac * B[3];
      col.min.set(wx - hx, B[4], wz - hz);
      col.max.set(wx + hx, B[5], wz + hz);
    }
  }

  // body position -> truck local frame; true if inside the open bed
  function inTruckBed(p) {
    const dx = p.x - truckX, dz = p.z - truckZ;
    const c = Math.cos(truckYaw), s = Math.sin(truckYaw);
    const lx = dx * c - dz * s;
    const lz = dx * s + dz * c;
    return lx > -2.28 && lx < 0.58 && lz > -0.8 && lz < 0.8 &&
           p.y > 1.02 && p.y < 1.95;
  }

  // =========================================================================
  // BREAKABLE WINDOWS (on world.facingBuilding grid)
  // =========================================================================
  const wgSrc = (ctx.world && ctx.world.facingBuilding) ? ctx.world.facingBuilding : null;
  const grid = {
    origin: (wgSrc && wgSrc.origin && wgSrc.origin.isVector3)
      ? wgSrc.origin.clone()
      : new THREE.Vector3(FB.x - 7.8, 4.6, FB.z + FB.halfD + 0.05),
    right: (wgSrc && wgSrc.right && wgSrc.right.isVector3 && wgSrc.right.lengthSq() > 0)
      ? wgSrc.right.clone().normalize() : new THREE.Vector3(1, 0, 0),
    up: (wgSrc && wgSrc.up && wgSrc.up.isVector3 && wgSrc.up.lengthSq() > 0)
      ? wgSrc.up.clone().normalize() : new THREE.Vector3(0, 1, 0),
    cols: (wgSrc && wgSrc.cols > 0) ? wgSrc.cols : 7,
    rows: (wgSrc && wgSrc.rows > 0) ? wgSrc.rows : 6,
    w: (wgSrc && wgSrc.w > 0) ? wgSrc.w : 1.6,
    h: (wgSrc && wgSrc.h > 0) ? wgSrc.h : 1.2,
    gapX: (wgSrc && typeof wgSrc.gapX === 'number') ? wgSrc.gapX : 1.0,
    gapY: (wgSrc && typeof wgSrc.gapY === 'number') ? wgSrc.gapY : 1.4,
  };
  const gridNormal = new THREE.Vector3().crossVectors(grid.right, grid.up).normalize();
  const stepX = grid.w + grid.gapX, stepY = grid.h + grid.gapY;
  const WINDOW_RESPAWN = 20;
  const panes = [];
  let paneMesh = null;
  {
    const n = Math.max(1, grid.cols * grid.rows);
    paneMesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(grid.w, grid.h),
      new THREE.MeshLambertMaterial({
        color: 0x9fd4ee, emissive: 0x3a6c88, emissiveIntensity: 0.55,
      }), n);
    paneMesh.frustumCulled = false;
    _m4.makeBasis(grid.right, grid.up, gridNormal);
    const paneQuat = new THREE.Quaternion().setFromRotationMatrix(_m4);
    _s1.set(1, 1, 1);
    for (let j = 0; j < grid.rows; j++) {
      for (let i = 0; i < grid.cols; i++) {
        const idx = j * grid.cols + i;
        _v1.copy(grid.origin)
          .addScaledVector(grid.right, i * stepX)
          .addScaledVector(grid.up, j * stepY);
        _m4.compose(_v1, paneQuat, _s1);
        paneMesh.setMatrixAt(idx, _m4);
        // thin AABB collider (exact for the contract's axis-aligned facade)
        const hx = Math.abs(grid.right.x) * grid.w / 2 + Math.abs(grid.up.x) * grid.h / 2 + Math.abs(gridNormal.x) * 0.08;
        const hy = Math.abs(grid.right.y) * grid.w / 2 + Math.abs(grid.up.y) * grid.h / 2 + Math.abs(gridNormal.y) * 0.08;
        const hz = Math.abs(grid.right.z) * grid.w / 2 + Math.abs(grid.up.z) * grid.h / 2 + Math.abs(gridNormal.z) * 0.08;
        const col = aabb(_v1.x - hx, _v1.y - hy, _v1.z - hz,
          _v1.x + hx, _v1.y + hy, _v1.z + hz, 'glass', 'window');
        panes.push({
          x: _v1.x, y: _v1.y, z: _v1.z, quat: paneQuat,
          state: 0, timer: 0, collider: col, idx, // state: 0 intact, 1 broken, 2 regrowing
        });
      }
    }
    scene.add(paneMesh);
  }

  function setPaneScale(pane, s) {
    _v1.set(pane.x, pane.y, pane.z);
    _s1.set(s, s, s);
    _m4.compose(_v1, pane.quat, _s1);
    paneMesh.setMatrixAt(pane.idx, _m4);
    paneMesh.instanceMatrix.needsUpdate = true;
  }

  function breakPane(pane, hit) {
    pane.state = 1;
    pane.timer = WINDOW_RESPAWN;
    setPaneScale(pane, 0.0001);
    removeCollider(pane.collider); // deactivate while broken
    fx('glass', hit.position);
    snd('shatter', { position: hit.position, intensity: Math.min(1.4, 0.6 + hit.speed / 18) });
    // let the projectile punch THROUGH instead of bouncing off the shards
    try {
      const b = hit.body, nrm = hit.normal;
      if (b && b.velocity && nrm && isFinite(nrm.x + nrm.y + nrm.z)) {
        const vn = b.velocity.x * nrm.x + b.velocity.y * nrm.y + b.velocity.z * nrm.z;
        if (vn > 0) {
          b.velocity.x -= nrm.x * vn * 1.8;
          b.velocity.y -= nrm.y * vn * 1.8;
          b.velocity.z -= nrm.z * vn * 1.8;
        }
      }
    } catch (e) {}
  }

  function onGlassImpact(hit) {
    if (!(hit.speed > 6)) return; // soft hits bounce off
    _v2.set(hit.position.x, hit.position.y, hit.position.z).sub(grid.origin);
    const u = _v2.dot(grid.right), v = _v2.dot(grid.up);
    const i = Math.round(u / stepX), j = Math.round(v / stepY);
    if (i < 0 || i >= grid.cols || j < 0 || j >= grid.rows) return;
    if (Math.abs(u - i * stepX) > grid.w / 2 + 0.3) return;
    if (Math.abs(v - j * stepY) > grid.h / 2 + 0.3) return;
    const pane = panes[j * grid.cols + i];
    if (!pane || pane.state !== 0) return;
    breakPane(pane, hit);
    if (hit.body && trackerByBody.has(hit.body)) {
      award('window', 'PANE & SIMPLE', 100,
        hit.position.x, hit.position.y, hit.position.z, hit.body, '#bfe6ff');
    }
  }

  function updateWindows(dt) {
    for (let k = 0; k < panes.length; k++) {
      const pane = panes[k];
      if (pane.state === 1) {            // broken, waiting to respawn
        pane.timer -= dt;
        if (pane.timer <= 0) {
          pane.state = 2;
          pane.timer = 0;
        }
      } else if (pane.state === 2) {     // regrow pop
        pane.timer += dt * 3.3;
        if (pane.timer >= 1) {
          pane.state = 0;
          setPaneScale(pane, 1);
          addCollider(pane.collider);    // reactivate only once fully visible
        } else {
          const t = pane.timer;
          setPaneScale(pane, Math.max(0.0001, t * (1.7 - 0.7 * t))); // slight overshoot
        }
      }
    }
  }

  // =========================================================================
  // PIGEONS (5 instanced, pecking on the street centerline)
  // =========================================================================
  const FLOCK_X = 8, FLOCK_Z = SCZ, FLOCK_Y = 0.13;
  const BIRDS = 5;
  const birdHome = [[0, 0], [1.1, 0.5], [-0.9, 0.8], [0.45, -1.1], [-1.25, -0.55]];
  const birdPhase = [0.7, 2.9, 4.1, 1.6, 5.3];
  const birdDir = [];
  for (let i = 0; i < BIRDS; i++) birdDir.push({ x: 1, z: 0 });
  let flockState = 'idle'; // idle | fleeing | gone | returning
  let flockT = 0;
  const FLEE_DUR = 2.4, RETURN_AT = 15;
  let birdMesh = null;
  {
    const B = newMerger();
    pushGeom(B, new THREE.SphereGeometry(0.09, 6, 5).scale(1.55, 1, 1), 0x8f98a3, 0, 0.1, 0, 0, 0);
    pushGeom(B, new THREE.SphereGeometry(0.05, 6, 5), 0x5d6670, 0.13, 0.18, 0, 0, 0);
    pushGeom(B, new THREE.SphereGeometry(0.028, 5, 4), 0x4f8f6d, 0.08, 0.14, 0, 0, 0); // iridescent neck
    pushGeom(B, new THREE.ConeGeometry(0.018, 0.06, 5).rotateZ(-Math.PI / 2), 0xe0a13e, 0.2, 0.18, 0, 0, 0);
    pushBox(B, 0.12, 0.02, 0.07, 0x6b747e, -0.15, 0.12, 0);            // tail
    pushBox(B, 0.11, 0.015, 0.09, 0x79828c, 0.01, 0.15, 0.07);         // wings
    pushBox(B, 0.11, 0.015, 0.09, 0x79828c, 0.01, 0.15, -0.07);
    birdMesh = new THREE.InstancedMesh(
      buildMerged(B, null).geometry,
      new THREE.MeshLambertMaterial({ vertexColors: true }), BIRDS);
    birdMesh.frustumCulled = false;
    scene.add(birdMesh);
  }

  function startFlee(ix, iz) {
    flockState = 'fleeing';
    flockT = 0;
    for (let i = 0; i < BIRDS; i++) {
      let dx = (FLOCK_X + birdHome[i][0]) - ix;
      let dz = (FLOCK_Z + birdHome[i][1]) - iz;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > 0.01) { dx /= d; dz /= d; } else { dx = Math.cos(i * 1.9); dz = Math.sin(i * 1.9); }
      const spread = (i - (BIRDS - 1) / 2) * 0.3;                 // fan out
      const cs = Math.cos(spread), sn = Math.sin(spread);
      birdDir[i].x = dx * cs - dz * sn;
      birdDir[i].z = dx * sn + dz * cs;
    }
    snd('pop', { position: _v1.set(ix, 1, iz), intensity: 0.7 });
  }

  function poseBird(i, x, y, z, yaw, pitch, roll, scale) {
    _e1.set(pitch, yaw, roll, 'YXZ');
    _q1.setFromEuler(_e1);
    _v1.set(x, y, z);
    _s1.set(scale, scale, scale);
    _m4.compose(_v1, _q1, _s1);
    birdMesh.setMatrixAt(i, _m4);
  }

  function parkBirdsHidden() { // one-time pose for the static 'gone' state
    for (let i = 0; i < BIRDS; i++) {
      poseBird(i, FLOCK_X + birdHome[i][0], -10, FLOCK_Z + birdHome[i][1], 0, 0, 0, 0.001);
    }
    birdMesh.instanceMatrix.needsUpdate = true;
  }

  function updatePigeons(dt) {
    flockT += dt;
    if (flockState === 'gone') {           // parked hidden: no matrix churn
      if (flockT >= RETURN_AT) { flockState = 'returning'; flockT = 0; }
      else return;
    }
    for (let i = 0; i < BIRDS; i++) {
      const hx = FLOCK_X + birdHome[i][0], hz = FLOCK_Z + birdHome[i][1];
      const ph = birdPhase[i];
      if (flockState === 'idle') {
        const peck = Math.max(0, Math.sin(now * 2.1 + ph * 9)) * 0.55;
        const hopS = Math.sin(now * 2.7 + ph * 5);
        const hop = hopS > 0.93 ? (hopS - 0.93) * 1.4 : 0;
        const yaw = Math.sin(now * 0.33 + ph) * 1.4 + ph;
        poseBird(i, hx, FLOCK_Y + hop, hz, yaw, peck, 0, 1);
      } else { // fleeing | returning
        let t = Math.min(1, flockT / FLEE_DUR);
        if (flockState === 'returning') t = 1 - t;                // reverse the arc
        const e = t * t * (3 - 2 * t);
        const dist = (16 + i * 2.5) * e;
        const x = hx + birdDir[i].x * dist;
        const z = hz + birdDir[i].z * dist;
        const y = FLOCK_Y + 11 * Math.sin(Math.min(1, t * 1.15) * Math.PI * 0.5);
        const yaw = Math.atan2(-birdDir[i].z, birdDir[i].x) + (flockState === 'returning' ? Math.PI : 0);
        const roll = Math.sin(now * 26 + ph * 3) * 0.55;          // flap-flap
        const sc = t > 0.85 ? Math.max(0.001, 1 - (t - 0.85) / 0.15) : 1;
        poseBird(i, x, y, z, yaw, -0.2, roll, sc);
      }
    }
    birdMesh.instanceMatrix.needsUpdate = true;
    if (flockState === 'fleeing' && flockT >= FLEE_DUR) { flockState = 'gone'; parkBirdsHidden(); }
    else if (flockState === 'returning' && flockT >= FLEE_DUR) flockState = 'idle';
  }

  // ---------------- finalize the merged static batch ------------------------
  const staticMesh = buildMerged(S, new THREE.MeshLambertMaterial({ vertexColors: true }));
  staticMesh.frustumCulled = false;
  scene.add(staticMesh);

  // =========================================================================
  // EVENTS
  // =========================================================================
  on('throw', (p) => {
    try { if (p && p.body) trackThrow(p.body); } catch (e) {}
  });

  on('grab', (p) => {
    try {
      const t = p && p.body ? trackerByBody.get(p.body) : null;
      if (t) t.dead = true; // flight over (caught, or plucked off the rack)
    } catch (e) {}
  });

  on('impact', (hit) => {
    try {
      if (!hit || !hit.position ||
          !isFinite(hit.position.x + hit.position.y + hit.position.z)) return;
      const pos = hit.position;
      const surface = hit.surface;
      const body = hit.body || null;
      const t = body ? trackerByBody.get(body) : null;

      if (surface === 'glass') { onGlassImpact(hit); return; }

      if (surface === 'trampoline') {
        if (Math.abs(pos.x - TRX) < 1.7 && Math.abs(pos.z - TRZ) < 1.7) {
          trampSquash = 1;
          if (t) t.tramp = true; // armed for a BOOMERANG catch
          // "return to sender": nudge the bounce back toward the parapet so
          // the arc sails up past the player's face instead of dead vertical
          if (body && body.velocity && body.velocity.isVector3 && body.velocity.y > 3) {
            const aimX = Math.max(-2.5, Math.min(2.5, headX));
            const aimZ = -BHD + 0.25; // just inside the throwing notch
            body.velocity.x += Math.max(-2.2, Math.min(2.2, (aimX - pos.x) * 0.85));
            // Gentle z drift only: the trampoline sits 1.2 m from the player
            // building face (z=-7, wall up to y=24). A stronger nudge makes
            // the ball cross the facade plane below the roofline, slam the
            // wall and reflect away — BOOMERANG must clear the parapet first.
            body.velocity.z += Math.max(-0.9, Math.min(0.9, (aimZ - pos.z) * 0.3));
          }
        }
        return;
      }

      if (surface === 'water') {
        if (Math.abs(pos.x - poolCX) < 3.6 && Math.abs(pos.z - poolCZ) < 2.6 &&
            Math.abs(pos.y - poolSurfY) < 1.6) {
          fx('splash', pos, 1.6);
          snd('splash', { position: pos, intensity: 1.2 });
          if (t && !t.splash) {
            t.splash = true;
            award('pool', 'SPLASHDOWN!', 200, pos.x, poolSurfY + 0.1, pos.z, body, '#7fd4ff');
          }
        }
        return;
      }

      // bullseye painted on the intersection asphalt (street plane impacts)
      if (t && !t.bullseye && surface === 'street' && pos.y < 1.2 && hit.speed > 1) {
        const dx = pos.x - BX, dz = pos.z - BZ;
        const d2 = dx * dx + dz * dz;
        if (d2 <= B_R3 * B_R3) {
          t.bullseye = true;
          if (d2 <= B_R1 * B_R1) {
            award('bullseye', 'BULLSEYE!', 250, pos.x, pos.y, pos.z, body, '#ff6a5e');
          } else if (d2 <= B_R2 * B_R2) {
            award('bullseye', 'INNER RING!', 150, pos.x, pos.y, pos.z, body, '#ffb36a');
          } else {
            award('bullseye', 'ON TARGET!', 75, pos.x, pos.y, pos.z, body, '#ffd76a');
          }
        }
      }

      // pigeons: any thrown body landing within 3 m sends the flock off
      if (t && flockState === 'idle' && pos.y < 2.5) {
        for (let i = 0; i < BIRDS; i++) {
          const bx = FLOCK_X + birdHome[i][0] - pos.x;
          const bz = FLOCK_Z + birdHome[i][1] - pos.z;
          if (bx * bx + bz * bz <= 9) {
            startFlee(pos.x, pos.z);
            if (!t.flock) {
              t.flock = true;
              award('pigeons', 'FLOCK OFF!', 50, FLOCK_X, 1.2, FLOCK_Z, body, '#d8e6f2');
            }
            break;
          }
        }
      }
    } catch (e) { /* never throw on odd payloads */ }
  });

  // =========================================================================
  // UPDATE
  // =========================================================================
  function update(dt) {
    if (!isFinite(dt) || dt <= 0) dt = 0;
    dt = Math.min(dt, 0.1);
    now += dt;

    updateTruck(dt);
    updateWindows(dt);
    updatePigeons(dt);

    // trampoline fabric squash & recover
    if (trampSquash > 0 && trampFabric) {
      trampSquash = Math.max(0, trampSquash - dt * 4.5);
      trampFabric.position.y = 0.965 - 0.22 * Math.sin(trampSquash * Math.PI);
    }

    // player head (for boomerang catches) — camera if present, else the rig
    let headOK = false;
    try {
      if (ctx.camera && ctx.camera.getWorldPosition) {
        ctx.camera.getWorldPosition(_v3);
        headOK = isFinite(_v3.x + _v3.y + _v3.z);
      }
      if (!headOK && ctx.playerRig && ctx.playerRig.position) {
        _v3.copy(ctx.playerRig.position);
        _v3.y += 1.5;
        headOK = true;
      }
    } catch (e) { headOK = false; }
    if (headOK) { headX = _v3.x; headY = _v3.y; headZ = _v3.z; }

    // per-flight target checks
    for (let i = trackers.length - 1; i >= 0; i--) {
      const t = trackers[i];
      const b = t.body;
      if (t.dead || !b || b.alive === false || b.held || !b.mesh || !b.mesh.position) {
        releaseTracker(i);
        continue;
      }
      const p = b.mesh.position;
      if (!isFinite(p.x + p.y + p.z)) { releaseTracker(i); continue; }

      // dumpster catch (inside the open top, below the rim)
      if (!t.trash &&
          Math.abs(p.x - DX) < 0.98 && Math.abs(p.z - DZ) < 0.48 &&
          p.y > 0.32 && p.y < 1.2) {
        t.trash = true;
        award('dumpster', 'TRASH!', 150, DX, 1.5, DZ, b, '#9be07f');
        fx('dust', p, 0.7);
      }

      // moving truck bed catch
      if (!t.delivered && inTruckBed(p)) {
        t.delivered = true;
        award('truck', 'SPECIAL DELIVERY!', 500, p.x, p.y + 0.6, p.z, b, '#ffc46a');
        fx('dust', p, 0.8);
      }

      // hoop: ball-ish body crossing the rim plane downward, inside the ring
      if (!t.swish && (b.radius === undefined || b.radius <= 0.34) &&
          t.py > RIM_Y && p.y <= RIM_Y) {
        const denom = t.py - p.y;
        const k = denom > 1e-6 ? (t.py - RIM_Y) / denom : 0;
        const cx = t.px + (p.x - t.px) * k - RIM_X;
        const cz = t.pz + (p.z - t.pz) * k - RIM_Z;
        if (cx * cx + cz * cz <= RIM_R * RIM_R) {
          t.swish = true;
          award('hoop', 'SWISH!', 300, RIM_X, RIM_Y, RIM_Z, b, '#ff9d5c');
        }
      }

      // boomerang: trampolined body sails back within reach above the roof
      if (t.tramp && !t.boom && headOK && p.y > ROOF) {
        const dx = p.x - _v3.x, dy = p.y - _v3.y, dz = p.z - _v3.z;
        if (dx * dx + dy * dy + dz * dz <= 1.44) {
          t.boom = true;
          award('trampoline', 'BOOMERANG!', 1000, p.x, p.y, p.z, b, '#ffef7a');
        }
      }

      t.px = p.x; t.py = p.y; t.pz = p.z;
    }
  }

  const api = { update };
  Object.defineProperty(api, 'score', {
    get() { return total; },
    enumerable: true,
  });
  return api;
}
