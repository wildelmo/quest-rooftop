// src/objects.js — CHUCK CITY throwable catalog + rack management.
//
// Contract (ARCHITECTURE.md): createObjects(ctx) ->
//   { update(dt, t), grabbables(): Body[], spawnAt(id, position): Body, catalog }
//
// 17 throwables, each a single-draw-call procedural vertex-colored mesh
// (shared cached geometry per type). Rack: one instance per world.rackAnchor
// (a line-up along the front sill), kinematic (held=true) with idle bob/spin;
// respawns 3s after leaving the rack with a pop-in scale animation + 'pop'
// sound. Personality hooks:
// splats (melon/egg/water balloon), duck squeaks, anvil falling whistle,
// alarm-clock ring loop, rocket ignition, umbrella pop-open.
//
// This module emits nothing itself except 'object-destroyed' from inside
// impact hooks; physics owns 'impact' events.

import * as THREE from 'three';
import { ROOF_Y } from './constants.js';

// ---------------- tuning ----------------
const RESPAWN_DELAY = 3;
const POP_TIME = 0.32;

// ---------------- hoisted temporaries (zero per-frame allocations) --------
const _up = new THREE.Vector3(0, 1, 0);
const _v1 = new THREE.Vector3();
const _c1 = new THREE.Color();
const _sndOpts = { position: null, intensity: 1 };

// ---------------- shared materials ----------------
const MAT = new THREE.MeshLambertMaterial({ vertexColors: true });
const MAT_DS = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
const MAT_FLAME = new THREE.MeshBasicMaterial({ vertexColors: true });
const MAT_PLAIN = new THREE.MeshLambertMaterial({ color: 0xcccccc });

// ---------------- easing ----------------
function backOut(x) {
  const c1 = 1.70158, c3 = c1 + 1, t = x - 1;
  return 1 + c3 * t * t * t + c1 * t * t;
}

// ---------------- geometry merger (build-time only) ----------------
function newM() { return { pos: [], nrm: [], col: [] }; }

// color: hex number OR fn(x, y, z, THREE.Color) evaluated on PRE-transform
// local coordinates (so stripes/seams are computed in the part's own frame).
function part(m, geom, color, px, py, pz, o) {
  let g = geom.index ? geom.toNonIndexed() : geom;
  if (g !== geom) geom.dispose();
  const pos = g.attributes.position;
  const count = pos.count;
  const cols = new Float32Array(count * 3);
  if (typeof color === 'function') {
    for (let i = 0; i < count; i++) {
      color(pos.getX(i), pos.getY(i), pos.getZ(i), _c1);
      cols[i * 3] = _c1.r; cols[i * 3 + 1] = _c1.g; cols[i * 3 + 2] = _c1.b;
    }
  } else {
    _c1.set(color);
    for (let i = 0; i < count; i++) {
      cols[i * 3] = _c1.r; cols[i * 3 + 1] = _c1.g; cols[i * 3 + 2] = _c1.b;
    }
  }
  if (o) {
    if (o.sx !== undefined) g.scale(o.sx, o.sy !== undefined ? o.sy : o.sx, o.sz !== undefined ? o.sz : o.sx);
    if (o.rx) g.rotateX(o.rx);
    if (o.rz) g.rotateZ(o.rz);
    if (o.ry) g.rotateY(o.ry);
  }
  g.translate(px || 0, py || 0, pz || 0);
  const p = g.attributes.position.array, n = g.attributes.normal.array;
  for (let i = 0; i < p.length; i++) { m.pos.push(p[i]); m.nrm.push(n[i]); }
  for (let i = 0; i < cols.length; i++) m.col.push(cols[i]);
  g.dispose();
}

// Double-sided flat triangle (for the paper airplane's folds).
function tri(m, a, b, c, color) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l; ny /= l; nz /= l;
  _c1.set(color);
  m.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  for (let i = 0; i < 3; i++) { m.nrm.push(nx, ny, nz); m.col.push(_c1.r, _c1.g, _c1.b); }
  m.pos.push(a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2]);
  for (let i = 0; i < 3; i++) { m.nrm.push(-nx, -ny, -nz); m.col.push(_c1.r, _c1.g, _c1.b); }
}

function buildGeo(m) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(m.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(m.nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(m.col, 3));
  return g;
}

// ---------------- geometry builders (nose = -Z where flight cares) --------
const GEO = {};
function getGeo(id, maker) {
  let g = GEO[id];
  if (!g) { try { g = maker(); } catch (e) { g = new THREE.BoxGeometry(0.1, 0.1, 0.1); } GEO[id] = g; }
  return g;
}

function geoPaper() {
  const m = newM();
  const N = [0, 0.006, -0.17];          // nose
  const L = [-0.125, 0.052, 0.13];      // left wingtip
  const R = [0.125, 0.052, 0.13];       // right wingtip
  const C = [0, 0.014, 0.13];           // spine tail
  const K = [0, -0.052, 0.115];         // keel bottom
  tri(m, N, L, C, 0xfafaf5);            // left wing
  tri(m, N, C, R, 0xefefe6);            // right wing (slightly shaded fold)
  tri(m, N, K, C, 0xdededf);            // keel
  return buildGeo(m);
}

function geoBaseball() {
  const m = newM();
  part(m, new THREE.SphereGeometry(0.052, 12, 9), (x, y, z, c) => {
    const u = Math.atan2(z, x);
    c.set(Math.abs(y - 0.027 * Math.sin(2 * u)) < 0.016 ? 0xc23b2e : 0xf4efe3);
  }, 0, 0, 0);
  return buildGeo(m);
}

function geoBasketball() {
  const m = newM();
  part(m, new THREE.SphereGeometry(0.12, 14, 10), (x, y, z, c) => {
    const seam = Math.abs(x) < 0.013 || Math.abs(y) < 0.013 || Math.abs(z) < 0.013;
    c.set(seam ? 0x4b3527 : 0xe0782f);
  }, 0, 0, 0);
  return buildGeo(m);
}

function geoBowling() {
  const m = newM();
  const spots = [[0.24, 0.94, 0.24], [-0.2, 0.95, 0.22], [0.04, 0.93, -0.36]];
  part(m, new THREE.SphereGeometry(0.115, 14, 10), (x, y, z, c) => {
    const inv = 1 / 0.115;
    const vx = x * inv, vy = y * inv, vz = z * inv;
    for (let i = 0; i < 3; i++) {
      const s = spots[i], sl = Math.hypot(s[0], s[1], s[2]);
      if ((vx * s[0] + vy * s[1] + vz * s[2]) / sl > 0.965) { c.set(0x17142e); return; }
    }
    c.set(0x453c8a).multiplyScalar(0.9 + 0.18 * Math.abs(Math.sin(x * 90 + z * 70)));
  }, 0, 0, 0);
  return buildGeo(m);
}

function geoAnvil() {
  const m = newM();
  const IRON = 0x454b52, LITE = 0x5d656e;
  part(m, new THREE.BoxGeometry(0.24, 0.05, 0.16), IRON, 0, -0.1, 0);
  part(m, new THREE.BoxGeometry(0.13, 0.09, 0.1), IRON, 0, -0.035, 0);
  part(m, new THREE.BoxGeometry(0.3, 0.095, 0.115), IRON, 0.01, 0.032, 0);
  part(m, new THREE.BoxGeometry(0.3, 0.014, 0.115), LITE, 0.01, 0.086, 0); // face
  part(m, new THREE.ConeGeometry(0.05, 0.15, 6), IRON, 0.225, 0.032, 0, { rz: -Math.PI / 2 });
  return buildGeo(m);
}

function geoMelon() {
  const m = newM();
  part(m, new THREE.SphereGeometry(0.16, 14, 10), (x, y, z, c) => {
    const a = Math.atan2(z, y); // stripes run pole-to-pole along long (X) axis
    c.set(Math.sin(a * 8) > 0.15 ? 0x1e7a3a : 0x59b968);
  }, 0, 0, 0, { sx: 1.28, sy: 1, sz: 1 });
  return buildGeo(m);
}

function geoWaterBalloon() {
  const m = newM();
  part(m, new THREE.SphereGeometry(0.095, 12, 9), (x, y, z, c) => {
    c.set(0x4fa8e8);
    c.offsetHSL(0, 0, Math.max(-0.1, y * 1.2)); // lighter top, wet sheen
  }, 0, -0.01, 0, { sx: 1, sy: 1.14, sz: 1 });
  part(m, new THREE.CylinderGeometry(0.013, 0.02, 0.025, 7), 0x3a86c2, 0, 0.105, 0);
  return buildGeo(m);
}

function geoFrisbee() {
  const m = newM();
  part(m, new THREE.CylinderGeometry(0.148, 0.157, 0.032, 16), (x, y, z, c) => {
    const r = Math.hypot(x, z);
    if (y > 0.012 && r < 0.06) c.set(0xf6efdd);
    else if (r > 0.142) c.set(0xc2443e);
    else c.set(0xe8564e);
  }, 0, 0, 0);
  return buildGeo(m);
}

function geoDuck() {
  const m = newM();
  const YEL = 0xf6c433;
  part(m, new THREE.SphereGeometry(0.095, 12, 9), YEL, 0, 0, 0.01, { sx: 1.05, sy: 0.85, sz: 1.25 });
  part(m, new THREE.ConeGeometry(0.045, 0.08, 7), YEL, 0, 0.055, 0.115, { rx: -1.1 }); // tail
  part(m, new THREE.SphereGeometry(0.058, 10, 8), YEL, 0, 0.1, -0.072);
  part(m, new THREE.ConeGeometry(0.023, 0.055, 7), 0xf08a24, 0, 0.093, -0.132, { rx: -Math.PI / 2 });
  part(m, new THREE.SphereGeometry(0.0095, 6, 5), 0x2b2b33, 0.033, 0.117, -0.104);
  part(m, new THREE.SphereGeometry(0.0095, 6, 5), 0x2b2b33, -0.033, 0.117, -0.104);
  return buildGeo(m);
}

function geoRocket() {
  const m = newM();
  part(m, new THREE.CylinderGeometry(0.034, 0.038, 0.2, 10), 0xf3efe4, 0, 0.01, 0);
  part(m, new THREE.ConeGeometry(0.037, 0.095, 10), 0xd8493c, 0, 0.157, 0);
  part(m, new THREE.CylinderGeometry(0.02, 0.03, 0.032, 8), 0x4a4a52, 0, -0.104, 0);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    part(m, new THREE.BoxGeometry(0.062, 0.075, 0.01), 0xd8493c,
      Math.cos(a) * 0.05, -0.075, Math.sin(a) * 0.05, { ry: -a });
  }
  part(m, new THREE.SphereGeometry(0.014, 6, 5), 0x8fc7e8, 0, 0.075, -0.03); // porthole
  const g = buildGeo(m);
  g.rotateX(-Math.PI / 2); // nose -> -Z (physics forward)
  return g;
}

function geoRocketFlame() {
  const m = newM();
  part(m, new THREE.ConeGeometry(0.032, 0.15, 8), 0xff9a3d, 0, -0.01, 0);
  part(m, new THREE.ConeGeometry(0.017, 0.1, 8), 0xffe08a, 0, -0.026, 0);
  const g = buildGeo(m);
  g.rotateX(Math.PI / 2);       // apex -> +Z (exhaust points backward)
  g.translate(0, 0, 0.185);
  return g;
}

function geoUmbrellaHandle() {
  const m = newM();
  part(m, new THREE.CylinderGeometry(0.012, 0.012, 0.52, 7), 0x7a5230, 0, 0, 0);
  part(m, new THREE.SphereGeometry(0.022, 7, 6), 0x5e3d22, 0, -0.27, 0); // knob
  part(m, new THREE.CylinderGeometry(0.008, 0.008, 0.09, 6), 0x565660, 0, 0.3, 0); // ferrule
  return buildGeo(m);
}

function geoUmbrellaCanopy() {
  const m = newM();
  part(m, new THREE.ConeGeometry(0.34, 0.16, 8, 1, true), (x, y, z, c) => {
    const seg = Math.floor(((Math.atan2(z, x) + Math.PI) / (Math.PI * 2)) * 8);
    c.set((seg % 2) ? 0xe0544a : 0xf4efe4);
  }, 0, 0, 0);
  return buildGeo(m);
}

function geoClock() {
  const m = newM();
  part(m, new THREE.CylinderGeometry(0.085, 0.085, 0.055, 14), (x, y, z, c) => {
    if (Math.abs(y) > 0.026) {                 // faces
      const r = Math.hypot(x, z);
      if (r < 0.014) c.set(0x2b2b33);          // center pin
      else if (r < 0.066) c.set(0xf5f2e8);     // dial
      else c.set(0xd6544a);
    } else c.set(0xd6544a);                    // shell
  }, 0, 0, 0, { rx: Math.PI / 2 });            // face toward ±Z
  part(m, new THREE.SphereGeometry(0.028, 8, 6), 0xc9cfd6, 0.052, 0.085, 0);
  part(m, new THREE.SphereGeometry(0.028, 8, 6), 0xc9cfd6, -0.052, 0.085, 0);
  part(m, new THREE.BoxGeometry(0.018, 0.032, 0.018), 0x8b929c, 0, 0.092, 0); // hammer
  part(m, new THREE.CylinderGeometry(0.008, 0.011, 0.035, 6), 0x8b929c, 0.05, -0.095, 0);
  part(m, new THREE.CylinderGeometry(0.008, 0.011, 0.035, 6), 0x8b929c, -0.05, -0.095, 0);
  return buildGeo(m);
}

function geoBeachBall() {
  const m = newM();
  const PAL = [0xf2f0ea, 0xe05348, 0xf3c545, 0x4f8fd0, 0xf2f0ea, 0x58b06a];
  part(m, new THREE.SphereGeometry(0.19, 14, 10), (x, y, z, c) => {
    if (Math.abs(y) > 0.178) { c.set(0xf2f0ea); return; } // polar caps
    const seg = Math.floor(((Math.atan2(z, x) + Math.PI) / (Math.PI * 2)) * 6);
    c.set(PAL[seg % 6]);
  }, 0, 0, 0);
  return buildGeo(m);
}

function geoEgg() {
  const m = newM();
  part(m, new THREE.SphereGeometry(0.055, 11, 9), (x, y, z, c) => {
    c.set(Math.random() < 0.05 ? 0xd3a468 : 0xf7ecd9);
  }, 0, 0, 0, { sx: 1, sy: 1.32, sz: 1 });
  return buildGeo(m);
}

function geoPropPlane() {
  const m = newM();
  const BALSA = 0xead9b0, RED = 0xd8493c;
  // fuselage stick (nose at -Z) + nose block for the prop bearing
  part(m, new THREE.BoxGeometry(0.022, 0.03, 0.36), BALSA, 0, 0, -0.01);
  part(m, new THREE.BoxGeometry(0.034, 0.04, 0.035), RED, 0, 0, -0.185);
  // main wing: two halves with a little dihedral
  part(m, new THREE.BoxGeometry(0.21, 0.008, 0.085), (x, y, z, c) => {
    c.set(x < -0.075 ? RED : BALSA);
  }, -0.103, 0.028, -0.05, { rz: 0.12 });
  part(m, new THREE.BoxGeometry(0.21, 0.008, 0.085), (x, y, z, c) => {
    c.set(x > 0.075 ? RED : BALSA);
  }, 0.103, 0.028, -0.05, { rz: -0.12 });
  // tail plane + fin
  part(m, new THREE.BoxGeometry(0.15, 0.006, 0.05), BALSA, 0, 0.008, 0.145);
  part(m, new THREE.BoxGeometry(0.006, 0.06, 0.055), RED, 0, 0.04, 0.15);
  // rubber band under the stick
  part(m, new THREE.CylinderGeometry(0.006, 0.006, 0.3, 5), 0x8a6a4a, 0, -0.02, -0.02, { rx: Math.PI / 2 });
  return buildGeo(m);
}

function geoPropBlades() {
  const m = newM();
  part(m, new THREE.BoxGeometry(0.015, 0.15, 0.008), 0xd8493c, 0, 0, 0);
  part(m, new THREE.BoxGeometry(0.15, 0.015, 0.008), 0xd8493c, 0, 0, 0);
  part(m, new THREE.SphereGeometry(0.012, 6, 5), 0x3a3a42, 0, 0, -0.005);
  return buildGeo(m);
}

function geoSaucer() {
  const m = newM();
  // hull: squashed sphere, silver, with a ring of alternating lights
  part(m, new THREE.SphereGeometry(0.13, 16, 10), (x, y, z, c) => {
    if (Math.abs(y) < 0.028 && Math.hypot(x, z) > 0.11) {
      const seg = Math.floor(((Math.atan2(z, x) + Math.PI) / (Math.PI * 2)) * 12);
      c.set((seg % 2) ? 0xffd24a : 0x62e0d8); // rim lights
    } else {
      c.set(y > 0.04 ? 0xd4dde4 : 0xb4bec8);
    }
  }, 0, 0, 0, { sx: 1, sy: 0.34, sz: 1 });
  // glass dome + tiny pilot
  part(m, new THREE.SphereGeometry(0.052, 10, 7), 0x8fd6c9, 0, 0.036, 0, { sy: 0.9 });
  part(m, new THREE.SphereGeometry(0.02, 6, 5), 0x69d84f, 0, 0.052, 0);
  // three landing bumps
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.5;
    part(m, new THREE.SphereGeometry(0.016, 6, 5), 0x8a929c,
      Math.cos(a) * 0.07, -0.038, Math.sin(a) * 0.07);
  }
  return buildGeo(m);
}

function geoSaucerGlow() {
  const m = newM();
  part(m, new THREE.CylinderGeometry(0.075, 0.05, 0.035, 12, 1, true), 0x9fffe8, 0, -0.055, 0);
  return buildGeo(m);
}

function geoFighter() {
  const m = newM();
  const HULL = 0xd8dde4, DARK = 0x4a5560, ACC = 0x69d84f;
  // fuselage (nose at -Z) + cockpit
  part(m, new THREE.BoxGeometry(0.05, 0.042, 0.2), HULL, 0, 0, 0.01);
  part(m, new THREE.ConeGeometry(0.028, 0.09, 6), HULL, 0, 0, -0.13, { rx: -Math.PI / 2 });
  part(m, new THREE.SphereGeometry(0.026, 8, 6), 0x2b3a4a, 0, 0.03, -0.03, { sz: 1.6 });
  // swept wings with glowing tips
  part(m, new THREE.BoxGeometry(0.115, 0.008, 0.085), (x, y, z, c) => {
    c.set(x < -0.045 ? ACC : HULL);
  }, -0.078, -0.006, 0.045, { ry: -0.45 });
  part(m, new THREE.BoxGeometry(0.115, 0.008, 0.085), (x, y, z, c) => {
    c.set(x > 0.045 ? ACC : HULL);
  }, 0.078, -0.006, 0.045, { ry: 0.45 });
  // twin engine cans at the tail
  part(m, new THREE.CylinderGeometry(0.016, 0.02, 0.06, 7), DARK, -0.028, 0, 0.115, { rx: Math.PI / 2 });
  part(m, new THREE.CylinderGeometry(0.016, 0.02, 0.06, 7), DARK, 0.028, 0, 0.115, { rx: Math.PI / 2 });
  part(m, new THREE.BoxGeometry(0.006, 0.05, 0.06), ACC, 0, 0.035, 0.1); // fin
  return buildGeo(m);
}

function geoFighterFlame() {
  const m = newM();
  part(m, new THREE.ConeGeometry(0.017, 0.1, 7), 0x7fe8ff, -0.028, -0.01, 0);
  part(m, new THREE.ConeGeometry(0.017, 0.1, 7), 0x7fe8ff, 0.028, -0.01, 0);
  part(m, new THREE.ConeGeometry(0.009, 0.07, 7), 0xffffff, -0.028, -0.02, 0);
  part(m, new THREE.ConeGeometry(0.009, 0.07, 7), 0xffffff, 0.028, -0.02, 0);
  const g = buildGeo(m);
  g.rotateX(Math.PI / 2);       // apex -> +Z (exhaust points backward)
  g.translate(0, 0, 0.19);
  return g;
}

const ROCKET_RACK_Q = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));

// =====================================================================
export function createObjects(ctx) {
  ctx = ctx || {};
  const scene = (ctx.scene && typeof ctx.scene.add === 'function') ? ctx.scene : new THREE.Group();
  const events = ctx.events;
  let now = 0;

  // ---------- defensive helpers ----------
  function play(name, position, intensity) {
    const a = ctx.audio;
    if (!a || typeof a.play !== 'function') return;
    _sndOpts.position = position || null;
    _sndOpts.intensity = intensity === undefined ? 1 : intensity;
    try { a.play(name, _sndOpts); } catch (e) { /* stub-safe */ }
  }
  function fx(name, a, b, c, d) {
    const e = ctx.effects;
    if (!e || typeof e[name] !== 'function') return;
    try { e[name](a, b, c, d); } catch (err) { /* stub-safe */ }
  }
  function emitDestroyed(body) {
    try {
      if (events && typeof events.emit === 'function' && body && body.mesh) {
        events.emit('object-destroyed', { body, position: body.mesh.position.clone() });
      }
    } catch (e) { /* stub-safe */ }
  }
  function hitSpeed(hit) { return (hit && typeof hit.speed === 'number' && isFinite(hit.speed)) ? hit.speed : 0; }
  function hitPos(body, hit) {
    if (hit && hit.position && hit.position.isVector3) return hit.position;
    return (body && body.mesh) ? body.mesh.position : null;
  }

  // Shared splat: chunks + splash + decal + splat sound, then destroy.
  function splat(body, hit, minSpeed, chunkColor, chunkN, splashScale, decalColor, decalR) {
    if (hit && hit.surface === 'water') return undefined; // physics owns pool splashes
    const sp = hitSpeed(hit);
    if (sp < minSpeed) return undefined;
    const pos = hitPos(body, hit);
    if (pos) {
      if (chunkN > 0) fx('chunks', pos, chunkColor, chunkN);
      if (splashScale > 0) fx('splash', pos, splashScale);
      fx('splatDecal', pos, (hit && hit.normal && hit.normal.isVector3) ? hit.normal : _up, decalColor, decalR);
    }
    play('splat', pos, Math.min(1.6, 0.5 + sp / 9));
    if (body.mesh) body.mesh.visible = false;
    emitDestroyed(body);
    return 'destroy';
  }

  // ---------- catalog ----------
  const catalog = [
    {
      id: 'paper', label: 'Paper Airplane',
      mass: 0.02, radius: 0.09, drag: 0.02, restitution: 0.05, windFactor: 0.35,
      aero: { type: 'glider' }, lift: 0.07,
      build() { return new THREE.Mesh(getGeo('paper', geoPaper), MAT_DS); },
    },
    {
      id: 'baseball', label: 'Baseball',
      mass: 0.15, radius: 0.052, drag: 0.004, restitution: 0.42, windFactor: 0.01,
      aero: null, lift: 0.055,
      build() { return new THREE.Mesh(getGeo('baseball', geoBaseball), MAT); },
    },
    {
      id: 'basketball', label: 'Basketball',
      mass: 0.62, radius: 0.12, drag: 0.02, restitution: 0.85, windFactor: 0.06,
      aero: null, lift: 0.12,
      build() { return new THREE.Mesh(getGeo('basketball', geoBasketball), MAT); },
      onImpact(body, hit) {
        const sp = hitSpeed(hit);
        if (sp > 1 && hit && hit.surface !== 'water') {
          play('bounce', hitPos(body, hit), Math.min(1, 0.3 + sp / 9));
        }
      },
    },
    {
      id: 'bowling', label: 'Bowling Ball',
      mass: 6, radius: 0.115, drag: 0.001, restitution: 0.1, windFactor: 0,
      aero: null, lift: 0.12,
      build() { return new THREE.Mesh(getGeo('bowling', geoBowling), MAT); },
      onImpact(body, hit) {
        const sp = hitSpeed(hit);
        if (hit && hit.surface === 'water') return;
        const pos = hitPos(body, hit);
        if (sp > 5) { fx('dust', pos, Math.min(2.2, 0.9 + sp / 12)); play('thud', pos, Math.min(1.6, 0.7 + sp / 14)); }
        else if (sp > 1.5) { fx('dust', pos, 0.5); play('thud', pos, 0.45); }
      },
    },
    {
      id: 'anvil', label: 'Anvil',
      mass: 22, radius: 0.15, drag: 0, restitution: 0.05, windFactor: 0,
      aero: null, lift: 0.13,
      build() { return new THREE.Mesh(getGeo('anvil', geoAnvil), MAT); },
      onThrow(body) { body.data._wh = 0; },
      onImpact(body, hit) {
        const sp = hitSpeed(hit);
        if (hit && hit.surface === 'water') return;
        const pos = hitPos(body, hit);
        if (sp > 5) {
          fx('dust', pos, Math.min(3, 1.4 + sp / 9)); // huge dust ring
          play('thud', pos, Math.min(2, 0.9 + sp / 11)); // deep thud
        } else if (sp > 1.2) { fx('dust', pos, 0.8); play('thud', pos, 0.6); }
        if (body.data) body.data._wh = 0;
      },
      fly(b, dt) {
        const d = b.data, v = b.velocity;
        if (!d || !v) return;
        if (v.y < -8) { // whistles while falling fast
          d._wh = (d._wh === undefined ? 0 : d._wh) - dt;
          if (d._wh <= 0) {
            play('whistle', b.mesh.position, Math.min(1.4, -v.y / 18));
            d._wh = 0.95;
          }
        } else d._wh = 0;
      },
    },
    {
      id: 'watermelon', label: 'Watermelon',
      mass: 4, radius: 0.17, drag: 0.004, restitution: 0.15, windFactor: 0.02,
      aero: null, lift: 0.14,
      build() { return new THREE.Mesh(getGeo('melon', geoMelon), MAT); },
      onImpact(body, hit) {
        return splat(body, hit, 2.4, 0xe0574f, 14, 0.5, 0xc94a42, 0.75);
      },
    },
    {
      id: 'waterballoon', label: 'Water Balloon',
      mass: 0.35, radius: 0.1, drag: 0.06, restitution: 0.3, windFactor: 0.2,
      aero: null, lift: 0.11,
      build() { return new THREE.Mesh(getGeo('wballoon', geoWaterBalloon), MAT); },
      onImpact(body, hit) {
        const r = splat(body, hit, 1.0, 0x9fd4f2, 6, 1.3, 0x5fb3e8, 0.9);
        if (r === 'destroy') play('splash', hitPos(body, hit), 1);
        return r;
      },
      fly(b) { // wobbles in flight
        const w = 0.09 * Math.sin(now * 13 + (b._seed || 0));
        b.mesh.scale.set(1 + w, 1 - w * 0.9, 1 + w);
      },
    },
    {
      id: 'frisbee', label: 'Frisbee',
      mass: 0.18, radius: 0.15, drag: 0.005, restitution: 0.35, windFactor: 0.12,
      aero: { type: 'frisbee' }, lift: 0.05,
      build() { return new THREE.Mesh(getGeo('frisbee', geoFrisbee), MAT); },
      onThrow(body) { // guarantee flight-worthy spin (desktop throws too)
        const w = body.angularVelocity;
        if (w && w.isVector3 && w.lengthSq() < 36 && body.mesh) {
          _v1.set(0, 1, 0).applyQuaternion(body.mesh.quaternion);
          w.copy(_v1).multiplyScalar(10);
        }
      },
    },
    {
      id: 'duck', label: 'Rubber Duck',
      mass: 0.15, radius: 0.11, drag: 0.03, restitution: 0.62, windFactor: 0.15,
      aero: null, lift: 0.08,
      build() { return new THREE.Mesh(getGeo('duck', geoDuck), MAT); },
      onImpact(body, hit) { // squeaks + erratic hop every bounce
        if (hit && hit.surface === 'water') return;
        const sp = hitSpeed(hit);
        if (sp <= 0.6) return;
        play('squeak', hitPos(body, hit), Math.min(1.2, 0.35 + sp / 7));
        const v = body.velocity, w = body.angularVelocity;
        if (v && v.isVector3) {
          const k = Math.min(2.5, sp * 0.22);
          v.x += (Math.random() - 0.5) * k;
          v.z += (Math.random() - 0.5) * k;
        }
        if (w && w.isVector3) {
          w.x += (Math.random() - 0.5) * 8;
          w.y += (Math.random() - 0.5) * 8;
          w.z += (Math.random() - 0.5) * 8;
        }
      },
    },
    {
      id: 'rocket', label: 'Toy Rocket',
      mass: 0.4, radius: 0.1, drag: 0.01, restitution: 0.25, windFactor: 0.04,
      aero: { type: 'rocket' }, lift: 0.14, rackQuat: ROCKET_RACK_Q,
      build() {
        const mesh = new THREE.Mesh(getGeo('rocket', geoRocket), MAT);
        const flame = new THREE.Mesh(getGeo('rocketFlame', geoRocketFlame), MAT_FLAME);
        flame.visible = false;
        mesh.add(flame);
        mesh.userData.flame = flame;
        return mesh;
      },
      onThrow(body) {
        const d = body.data;
        d.igniteDelay = 0.5;
        d.burn = 1.6;
        d._ign = false;
        d._smk = 0;
      },
      onImpact(body, hit) {
        const d = body.data;
        const sp = hitSpeed(hit);
        if (d && d.burning && sp > 6) { // hard crash snuffs the engine
          d.burn = 0;
          fx('dust', hitPos(body, hit), 0.8);
          play('thud', hitPos(body, hit), 0.8);
        }
      },
      fly(b, dt) {
        const d = b.data;
        if (!d) return;
        const flame = b.mesh.userData && b.mesh.userData.flame;
        if (d.burning) { // physics raises data.burning after igniteDelay
          if (!d._ign) { d._ign = true; play('rocket', b.mesh.position, 1); }
          if (flame) {
            flame.visible = true;
            const f = 0.85 + 0.35 * Math.sin(now * 43 + (b._seed || 0));
            flame.scale.set(f, f, 0.8 + 0.5 * Math.abs(Math.sin(now * 31)));
          }
          d._smk = (d._smk || 0) - dt;
          if (d._smk <= 0) { fx('dust', b.mesh.position, 0.28); d._smk = 0.13; }
        } else if (flame && flame.visible) flame.visible = false;
      },
    },
    {
      id: 'propplane', label: 'Prop Glider',
      mass: 0.05, radius: 0.12, drag: 0.02, restitution: 0.08, windFactor: 0.25,
      aero: { type: 'prop' }, lift: 0.07,
      build() {
        const mesh = new THREE.Mesh(getGeo('propplane', geoPropPlane), MAT);
        const prop = new THREE.Mesh(getGeo('propBlades', geoPropBlades), MAT);
        prop.position.set(0, 0, -0.21);
        mesh.add(prop);
        mesh.userData.prop = prop;
        return mesh;
      },
      fly(b, dt) {
        const prop = b.mesh.userData && b.mesh.userData.prop;
        if (!prop) return;
        // full-speed blur while the band unwinds, lazy windmill after
        prop.rotation.z += (b.data && b.data.burning ? 55 : 7) * dt;
      },
    },
    {
      id: 'ufo', label: 'Flying Saucer',
      mass: 0.3, radius: 0.13, drag: 0.008, restitution: 0.5, windFactor: 0.05,
      aero: { type: 'ufo' }, lift: 0.1,
      build() {
        const mesh = new THREE.Mesh(getGeo('saucer', geoSaucer), MAT);
        const glow = new THREE.Mesh(getGeo('saucerGlow', geoSaucerGlow), MAT_FLAME);
        glow.visible = false;
        mesh.add(glow);
        mesh.userData.glow = glow;
        return mesh;
      },
      onImpact(body, hit) {
        const sp = hitSpeed(hit);
        if (sp > 1.5 && hit && hit.surface !== 'water') {
          play('clang', hitPos(body, hit), Math.min(1.1, 0.3 + sp / 10));
        }
      },
      fly(b, dt) {
        const d = b.data;
        const glow = b.mesh.userData && b.mesh.userData.glow;
        if (d && d.burning) {
          // powered: constant eerie spin + pulsing underglow
          b.mesh.rotateY(9 * dt);
          if (glow) {
            glow.visible = true;
            const s = 0.85 + 0.3 * Math.abs(Math.sin(now * 11 + (b._seed || 0)));
            glow.scale.set(s, 1, s);
          }
          d._hum = (d._hum === undefined ? 0 : d._hum) - dt;
          if (d._hum <= 0) { play('ring', b.mesh.position, 0.16); d._hum = 0.5; }
        } else if (glow && glow.visible) glow.visible = false;
      },
    },
    {
      id: 'fighter', label: 'Mini Starfighter',
      mass: 0.25, radius: 0.09, drag: 0.01, restitution: 0.3, windFactor: 0.04,
      aero: { type: 'rocket' }, lift: 0.09,
      build() {
        const mesh = new THREE.Mesh(getGeo('fighter', geoFighter), MAT);
        const flame = new THREE.Mesh(getGeo('fighterFlame', geoFighterFlame), MAT_FLAME);
        flame.visible = false;
        mesh.add(flame);
        mesh.userData.flame = flame;
        return mesh;
      },
      onThrow(body) {
        const d = body.data;
        d.igniteDelay = 0.25; // engines light almost immediately
        d.burn = 2.4;
        d.thrust = 13;        // gentler than the toy rocket: strafing run, not launch
        d._ign = false;
        d._smk = 0;
      },
      onImpact(body, hit) {
        const d = body.data;
        const sp = hitSpeed(hit);
        if (d && d.burning && sp > 6) { // hard crash flames out
          d.burn = 0;
          fx('dust', hitPos(body, hit), 0.6);
          play('clang', hitPos(body, hit), 0.7);
        }
      },
      fly(b, dt) {
        const d = b.data;
        if (!d) return;
        const flame = b.mesh.userData && b.mesh.userData.flame;
        if (d.burning) {
          if (!d._ign) { d._ign = true; play('rocket', b.mesh.position, 0.7); }
          if (flame) {
            flame.visible = true;
            const f = 0.8 + 0.3 * Math.sin(now * 47 + (b._seed || 0));
            flame.scale.set(f, f, 0.85 + 0.4 * Math.abs(Math.sin(now * 33)));
          }
        } else if (flame && flame.visible) flame.visible = false;
      },
    },
    {
      id: 'umbrella', label: 'Umbrella',
      mass: 0.9, radius: 0.2, drag: 0.05, restitution: 0.15, windFactor: 0.5,
      aero: { type: 'umbrella' }, lift: 0.29,
      build() {
        const mesh = new THREE.Mesh(getGeo('umbHandle', geoUmbrellaHandle), MAT);
        const canopy = new THREE.Mesh(getGeo('umbCanopy', geoUmbrellaCanopy), MAT_DS);
        canopy.position.y = 0.21;
        canopy.scale.set(0.22, 1.1, 0.22); // folded
        mesh.add(canopy);
        mesh.userData.canopy = canopy;
        return mesh;
      },
      onThrow(body) {
        const d = body.data;
        d.open = false;       // physics umbrella aero waits for this flag
        d._ot = 0;
        d._anim = undefined;
        const can = body.mesh && body.mesh.userData && body.mesh.userData.canopy;
        if (can) can.scale.set(0.22, 1.1, 0.22);
      },
      fly(b, dt) {
        const d = b.data;
        if (!d) return;
        const can = b.mesh.userData && b.mesh.userData.canopy;
        if (!d.open) {
          d._ot = (d._ot || 0) + dt;
          if (d._ot >= 0.6) { d.open = true; d._anim = 0; play('pop', b.mesh.position, 1.1); }
        } else if (can && d._anim !== undefined && d._anim < 1) {
          d._anim = Math.min(1, d._anim + dt / 0.3);
          const e = backOut(d._anim);       // pops open with overshoot
          const s = 0.22 + 0.78 * e;
          can.scale.set(s, 1.1 - 0.1 * e, s);
        }
      },
    },
    {
      id: 'alarmclock', label: 'Alarm Clock',
      mass: 0.6, radius: 0.1, drag: 0.01, restitution: 0.12, windFactor: 0.03,
      aero: null, lift: 0.11,
      build() { return new THREE.Mesh(getGeo('clock', geoClock), MAT); },
      onThrow(body) { body.data.ringing = true; body.data._rt = 0; },
      onImpact(body, hit) { // stops dead on first impact
        const d = body.data;
        if (d && d.ringing) {
          d.ringing = false;
          if (body.mesh) body.mesh.scale.set(1, 1, 1);
          play('clang', hitPos(body, hit), Math.min(1.3, 0.5 + hitSpeed(hit) / 8));
          if (body.velocity && body.velocity.isVector3) body.velocity.multiplyScalar(0.25);
        }
      },
      fly(b, dt) {
        const d = b.data;
        if (!d || !d.ringing) return;
        d._rt = (d._rt || 0) - dt; // ring loop the whole way down
        if (d._rt <= 0) { play('ring', b.mesh.position, 1); d._rt = 0.42; }
        const s = 1 + 0.05 * Math.sin(now * 46); // frantic shiver
        b.mesh.scale.set(s, s, s);
      },
    },
    {
      id: 'beachball', label: 'Beach Ball',
      mass: 0.06, radius: 0.19, drag: 0.55, restitution: 0.75, windFactor: 1,
      aero: { type: 'balloon', buoyancy: 0.5, terminal: 3.2, windGain: 2.2, couple: 0.8, bob: 0.25 },
      lift: 0.19,
      build() { return new THREE.Mesh(getGeo('beach', geoBeachBall), MAT); },
      onImpact(body, hit) {
        const sp = hitSpeed(hit);
        if (sp > 1 && hit && hit.surface !== 'water') play('bounce', hitPos(body, hit), 0.4);
      },
    },
    {
      id: 'egg', label: 'Egg',
      mass: 0.06, radius: 0.06, drag: 0.02, restitution: 0.08, windFactor: 0.12,
      aero: null, lift: 0.075,
      build() { return new THREE.Mesh(getGeo('egg', geoEgg), MAT); },
      onImpact(body, hit) {
        return splat(body, hit, 1.1, 0xf3d963, 6, 0, 0xecc84f, 0.35);
      },
    },
  ];
  const byId = {};
  for (let i = 0; i < catalog.length; i++) byId[catalog[i].id] = catalog[i];

  // ---------- body factory ----------
  function makeBodyFor(entry) {
    let mesh;
    try { mesh = entry.build(); } catch (e) { mesh = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), MAT_PLAIN); }
    const opts = {
      mesh,
      mass: entry.mass, radius: entry.radius, drag: entry.drag,
      restitution: entry.restitution, windFactor: entry.windFactor,
      aero: entry.aero ? Object.assign({}, entry.aero) : null,
      held: true,
    };
    let body = null;
    const ph = ctx.physics;
    if (ph && typeof ph.makeBody === 'function') {
      try { body = ph.makeBody(opts); } catch (e) { body = null; }
    }
    if (!body) { // physics stub fallback: minimal contract-shaped body
      body = {
        mesh,
        velocity: new THREE.Vector3(), angularVelocity: new THREE.Vector3(),
        mass: opts.mass, radius: opts.radius, drag: opts.drag,
        restitution: opts.restitution, aero: opts.aero, windFactor: opts.windFactor,
        held: true, alive: true, onImpact: null, data: {},
        _seed: Math.random() * Math.PI * 2,
      };
    }
    if (!body.data) body.data = {};
    body.data.entry = entry;
    body.data.entryId = entry.id;
    if (typeof entry.onImpact === 'function') {
      body.onImpact = function (hit) {
        try { return entry.onImpact(body, hit); } catch (e) { return undefined; }
      };
    }
    try { if (ph && typeof ph.addBody === 'function') ph.addBody(body); } catch (e) { /* stub-safe */ }
    try { scene.add(mesh); } catch (e) { /* stub-safe */ }
    return body;
  }

  function removeMeshOf(body) {
    try {
      if (body && body.mesh && body.mesh.parent) body.mesh.parent.remove(body.mesh);
    } catch (e) { /* stub-safe */ }
  }

  // ---------- rack ----------
  const anchors = [];
  try {
    const ra = ctx.world && ctx.world.rackAnchors;
    if (ra && ra.length) {
      for (let i = 0; i < ra.length; i++) {
        const a = ra[i];
        if (a && isFinite(a.x) && isFinite(a.y) && isFinite(a.z)) anchors.push(a);
      }
    }
  } catch (e) { /* stub-safe */ }
  if (!anchors.length) { // world stub fallback: mirror the real sill layout
    const ry = ((typeof ROOF_Y === 'number') ? ROOF_Y : 24) + 0.78;
    for (let i = 0; i < 17; i++) {
      anchors.push(new THREE.Vector3(-6 + i * 0.75, ry, -6.89));
    }
  }

  // One line-up along the sill: flyers dead center where you spawn,
  // heavy comedy toward the ends.
  const ORDER = ['anvil', 'bowling', 'watermelon', 'alarmclock', 'duck', 'baseball',
    'egg', 'paper', 'propplane', 'ufo', 'fighter', 'frisbee', 'basketball',
    'waterballoon', 'rocket', 'umbrella', 'beachball'];
  const slots = [];
  for (let i = 0; i < anchors.length; i++) {
    slots.push({
      anchor: anchors[i],
      entry: byId[ORDER[i % ORDER.length]],
      body: null,
      timer: 0.12 + i * 0.07, // cascading pop-in at boot
      popT: 1,
      phase: i * 1.71,
    });
  }

  const flying = [];
  const grabList = [];

  function addFlying(b) {
    if (b && flying.indexOf(b) === -1) flying.push(b);
  }

  function freeSlotOf(body) {
    for (let i = 0; i < slots.length; i++) {
      if (slots[i].body === body) {
        slots[i].body = null;
        slots[i].timer = RESPAWN_DELAY;
        return;
      }
    }
  }

  function spawnRacked(slot) {
    if (!slot.entry) return;
    const body = makeBodyFor(slot.entry);
    body.held = true;
    body.data.racked = true;
    if (body.velocity && body.velocity.isVector3) body.velocity.set(0, 0, 0);
    if (body.angularVelocity && body.angularVelocity.isVector3) body.angularVelocity.set(0, 0, 0);
    if (body.mesh) {
      body.mesh.position.set(slot.anchor.x, slot.anchor.y + slot.entry.lift, slot.anchor.z);
      body.mesh.scale.set(0.02, 0.02, 0.02);
    }
    slot.body = body;
    slot.popT = 0;
    play('pop', body.mesh ? body.mesh.position : null, 0.8);
  }

  // ---------- event wiring ----------
  if (events && typeof events.on === 'function') {
    events.on('grab', (p) => {
      try {
        const b = p && p.body;
        if (!b || !b.data || b.data.entry === undefined) return;
        if (b.data.racked) {
          b.data.racked = false;
          if (b.mesh) b.mesh.scale.set(1, 1, 1); // cancel mid-pop scale
          freeSlotOf(b);
          addFlying(b);
        }
      } catch (e) { /* defensive */ }
    });
    events.on('throw', (p) => {
      try {
        const b = p && p.body;
        if (!b || !b.data || !b.data.entry) return;
        if (b.data.racked) { // thrown straight off the rack (desktop paths)
          b.data.racked = false;
          if (b.mesh) b.mesh.scale.set(1, 1, 1);
          freeSlotOf(b);
        }
        addFlying(b);
        const entry = b.data.entry;
        if (typeof entry.onThrow === 'function') entry.onThrow(b);
      } catch (e) { /* defensive */ }
    });
  }

  // ---------- api ----------
  function grabbables() {
    grabList.length = 0;
    for (let i = 0; i < slots.length; i++) {
      const b = slots[i].body;
      if (b && b.alive !== false && b.mesh) grabList.push(b);
    }
    for (let i = 0; i < flying.length; i++) {
      const b = flying[i];
      if (b && b.alive !== false && b.mesh && !b.held && !(b.data && b.data.inWater)) grabList.push(b);
    }
    return grabList;
  }

  function spawnAt(id, position) {
    const entry = byId[id];
    if (!entry) return null;
    const body = makeBodyFor(entry);
    body.data.racked = false;
    if (body.mesh && position) {
      const mp = body.mesh.position;
      if (position.isVector3) mp.copy(position);
      else if (typeof position.x === 'number') {
        mp.set(position.x, position.y || 0, position.z || 0);
      }
    }
    addFlying(body);
    return body;
  }

  // ---------- update ----------
  function update(dt) {
    const d = (typeof dt === 'number' && isFinite(dt) && dt > 0) ? dt : 0;
    now += d;

    // rack slots
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const b = slot.body;
      if (b) {
        if (b.alive === false || !b.mesh) {           // destroyed on the rack somehow
          removeMeshOf(b);
          slot.body = null;
          slot.timer = RESPAWN_DELAY;
        } else if (!b.data || b.data.racked !== true || b.held !== true) {
          // left the rack without a grab event we saw — release + respawn timer
          if (b.data) b.data.racked = false;
          slot.body = null;
          slot.timer = RESPAWN_DELAY;
          addFlying(b);
        } else {
          // pop-in scale
          if (slot.popT < 1) {
            slot.popT = Math.min(1, slot.popT + d / POP_TIME);
            const s = Math.max(0.02, backOut(slot.popT));
            b.mesh.scale.set(s, s, s);
          } else if (b.mesh.scale.x !== 1) {
            b.mesh.scale.set(1, 1, 1);
          }
          // idle bob + lazy spin (kinematic while racked)
          b.mesh.position.set(
            slot.anchor.x,
            slot.anchor.y + slot.entry.lift + Math.sin(now * 2.1 + slot.phase) * 0.02,
            slot.anchor.z);
          b.mesh.quaternion.setFromAxisAngle(_up, slot.phase + now * 0.7);
          if (slot.entry.rackQuat) b.mesh.quaternion.multiply(slot.entry.rackQuat);
        }
      } else {
        slot.timer -= d;
        if (slot.timer <= 0) {
          try { spawnRacked(slot); } catch (e) { slot.timer = RESPAWN_DELAY; }
        }
      }
    }

    // flight bodies: cleanup + per-object behaviors
    for (let i = flying.length - 1; i >= 0; i--) {
      const b = flying[i];
      if (!b || b.alive === false || !b.mesh) {
        if (b) removeMeshOf(b);
        flying.splice(i, 1);
        continue;
      }
      if (b.held) continue; // hand (or rack) is driving it
      // airspeed-tied whoosh: fast flyers keep making flight noise past the
      // release burst (audio.js throttles 'whoosh' + applies distance falloff)
      const v = b.velocity;
      if (v && v.isVector3 && b.data) {
        const sp2 = v.lengthSq();
        if (sp2 > 64) { // > 8 m/s
          b.data._wt = (b.data._wt === undefined ? 0 : b.data._wt) - d;
          if (b.data._wt <= 0) {
            play('whoosh', b.mesh.position, Math.min(1.2, Math.sqrt(sp2) / 20));
            b.data._wt = 0.25;
          }
        } else b.data._wt = 0;
      }
      const entry = b.data && b.data.entry;
      if (entry && typeof entry.fly === 'function') {
        try { entry.fly(b, d); } catch (e) { /* defensive */ }
      }
    }
  }

  return { update, grabbables, spawnAt, catalog };
}
