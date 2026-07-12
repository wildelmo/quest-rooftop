// src/effects.js — pooled particles, decals, score popups, slow-mo owner,
// blob shadows. One InstancedMesh per particle pool, typed-array particle
// state, zero per-frame allocations. See ARCHITECTURE.md.

import * as THREE from 'three';
import { SLOWMO_THRESHOLD } from './constants.js';

// ---------------------------------------------------------------------------
// Hoisted temps (module scope — reused everywhere, never allocated per frame).
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _c = new THREE.Color();
const _Z = new THREE.Vector3(0, 0, 1);
const _UP = new THREE.Vector3(0, 1, 0);
const _ZERO_M = new THREE.Matrix4().makeScale(0, 0, 0);

const SLOW_IN = 0.15, SLOW_OUT = 0.4, SLOW_SCALE = 0.3;
const DECAL_MAX = 40, DECAL_LIFE = 25;
const POPUP_MAX = 10, POPUP_LIFE = 1.2, POPUP_RISE = 1.5;
const SHADOW_MAX = 2;

function isV3(v) { return !!(v && v.isVector3 && isFinite(v.x) && isFinite(v.y) && isFinite(v.z)); }
function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }

// ---------------------------------------------------------------------------
export function createEffects(ctx) {
  ctx = ctx || {};
  const scene = (ctx.scene && typeof ctx.scene.add === 'function') ? ctx.scene : new THREE.Group();
  const events = ctx.events;

  function on(name, fn) {
    try { if (events && typeof events.on === 'function') events.on(name, fn); } catch (e) { /* stub-safe */ }
  }
  function setAudioSlowmo(active) {
    const a = ctx.audio;
    if (a && typeof a.setSlowmo === 'function') { try { a.setSlowmo(active); } catch (e) { /* stub-safe */ } }
  }
  function camWorld() {
    const cam = ctx.camera;
    if (cam && typeof cam.getWorldPosition === 'function') { try { cam.getWorldPosition(_camPos); return _camPos; } catch (e) {} }
    _camPos.set(0, 25.6, 0);
    return _camPos;
  }

  // =========================================================================
  // Generic particle pool: one InstancedMesh, ring-allocated slots.
  // =========================================================================
  function makePool(geo, mat, n, grav, drag, windF) {
    const mesh = new THREE.InstancedMesh(geo, mat, n);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    for (let i = 0; i < n; i++) { mesh.setMatrixAt(i, _ZERO_M); mesh.setColorAt(i, _c.setRGB(1, 1, 1)); }
    if (mesh.instanceColor) mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    scene.add(mesh);
    return {
      mesh, n, grav, drag, windF, cursor: 0, alive: 0,
      pos: new Float32Array(n * 3), vel: new Float32Array(n * 3),
      rot: new Float32Array(n * 3), spin: new Float32Array(n * 3),
      age: new Float32Array(n), ttl: new Float32Array(n), // ttl 0 = dead
      size: new Float32Array(n), flutter: 0,
    };
  }

  function spawnParticle(pool, x, y, z, vx, vy, vz, size, ttl, colR, colG, colB) {
    const i = pool.cursor;
    pool.cursor = (i + 1) % pool.n;
    if (pool.ttl[i] === 0) pool.alive++;
    const i3 = i * 3;
    pool.pos[i3] = x; pool.pos[i3 + 1] = y; pool.pos[i3 + 2] = z;
    pool.vel[i3] = vx; pool.vel[i3 + 1] = vy; pool.vel[i3 + 2] = vz;
    pool.rot[i3] = Math.random() * 6.28; pool.rot[i3 + 1] = Math.random() * 6.28; pool.rot[i3 + 2] = Math.random() * 6.28;
    pool.spin[i3] = (Math.random() - 0.5) * 10; pool.spin[i3 + 1] = (Math.random() - 0.5) * 10; pool.spin[i3 + 2] = (Math.random() - 0.5) * 10;
    pool.age[i] = 0; pool.ttl[i] = ttl; pool.size[i] = size;
    pool.mesh.setColorAt(i, _c.setRGB(colR, colG, colB));
    if (pool.mesh.instanceColor) pool.mesh.instanceColor.needsUpdate = true;
  }

  function updatePool(pool, dt, wind) {
    if (pool.alive === 0) { pool.mesh.count = 0; return; }
    const n = pool.n, pos = pool.pos, vel = pool.vel, rot = pool.rot, spin = pool.spin;
    const wx = wind ? wind.x * pool.windF : 0, wz = wind ? wind.z * pool.windF : 0;
    const dragK = Math.min(1, pool.drag * dt);
    let high = -1; // highest live slot — dead tail slots skip vertex processing
    for (let i = 0; i < n; i++) {
      const ttl = pool.ttl[i];
      if (ttl === 0) continue;
      const age = pool.age[i] + dt;
      if (age >= ttl) {
        pool.ttl[i] = 0; pool.alive--;
        pool.mesh.setMatrixAt(i, _ZERO_M);
        continue;
      }
      pool.age[i] = age;
      if (i > high) high = i;
      const i3 = i * 3;
      vel[i3 + 1] += pool.grav * dt;
      vel[i3] += wx * dt; vel[i3 + 2] += wz * dt;
      vel[i3] -= vel[i3] * dragK; vel[i3 + 1] -= vel[i3 + 1] * dragK; vel[i3 + 2] -= vel[i3 + 2] * dragK;
      if (pool.flutter) {
        vel[i3] += Math.sin(age * 9 + i * 1.7) * pool.flutter * dt;
        vel[i3 + 2] += Math.cos(age * 7.3 + i * 2.3) * pool.flutter * dt;
      }
      pos[i3] += vel[i3] * dt; pos[i3 + 1] += vel[i3 + 1] * dt; pos[i3 + 2] += vel[i3 + 2] * dt;
      rot[i3] += spin[i3] * dt; rot[i3 + 1] += spin[i3 + 1] * dt; rot[i3 + 2] += spin[i3 + 2] * dt;
      // scale-out fade: quick pop in (18%), smooth shrink to zero.
      const t = age / ttl;
      let s;
      if (t < 0.18) s = t / 0.18;
      else { const u = 1 - (t - 0.18) / 0.82; s = u * u * (3 - 2 * u); }
      s *= pool.size[i];
      _p.set(pos[i3], pos[i3 + 1], pos[i3 + 2]);
      _e.set(rot[i3], rot[i3 + 1], rot[i3 + 2]);
      _q.setFromEuler(_e);
      _s.set(s, s, s);
      _m.compose(_p, _q, _s);
      pool.mesh.setMatrixAt(i, _m);
    }
    pool.mesh.count = high + 1;
    pool.mesh.instanceMatrix.needsUpdate = true;
  }

  // ---- pool construction ---------------------------------------------------
  const dustGeo = new THREE.IcosahedronGeometry(0.13, 0);
  const dustPool = makePool(dustGeo,
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.8, depthWrite: false, fog: true }),
    64, -0.6, 1.9, 0.7); // near-weightless puffs, high drag, wind-blown

  const splashGeo = new THREE.IcosahedronGeometry(0.05, 0);
  splashGeo.scale(0.8, 1.5, 0.8); // droplet-ish
  const splashPool = makePool(splashGeo,
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.92, depthWrite: false, fog: true }),
    64, -11, 0.4, 0.15);

  const chunkGeo = new THREE.TetrahedronGeometry(0.075);
  const chunkPool = makePool(chunkGeo,
    new THREE.MeshLambertMaterial({ fog: true }),
    48, -9.8, 0.12, 0.05);

  const glassGeo = new THREE.TetrahedronGeometry(0.09);
  glassGeo.scale(1, 0.16, 1); // thin shards
  const glassPool = makePool(glassGeo,
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85, depthWrite: false, fog: true }),
    64, -9.8, 0.15, 0.1);

  const confettiGeo = new THREE.PlaneGeometry(0.055, 0.085);
  const confettiPool = makePool(confettiGeo,
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, fog: true }),
    80, -1.6, 1.4, 0.9);
  confettiPool.flutter = 2.2;

  const allPools = [dustPool, splashPool, chunkPool, glassPool, confettiPool];

  // ---- burst spawners ------------------------------------------------------
  function dust(pos, scale, tint) {
    if (!isV3(pos)) return;
    const sc = Math.max(0.15, Math.min(3.5, num(scale, 1)));
    const count = Math.min(16, (5 + sc * 4) | 0);
    let r = 0.82, g = 0.8, b = 0.76;
    if (tint !== undefined && tint !== null) { try { _c.set(tint); r = _c.r; g = _c.g; b = _c.b; } catch (e) {} }
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.6;
      const rad = (0.7 + Math.random() * 1.1) * sc;   // outward ring
      const shade = 0.85 + Math.random() * 0.25;
      spawnParticle(dustPool,
        pos.x + Math.cos(a) * 0.12 * sc, pos.y + 0.06 + Math.random() * 0.1, pos.z + Math.sin(a) * 0.12 * sc,
        Math.cos(a) * rad, 0.5 + Math.random() * 0.9 * sc, Math.sin(a) * rad,
        (0.55 + Math.random() * 0.55) * sc, 0.55 + Math.random() * 0.35 + sc * 0.12,
        Math.min(1, r * shade), Math.min(1, g * shade), Math.min(1, b * shade));
    }
  }

  function splash(pos, scale) {
    if (!isV3(pos)) return;
    const sc = Math.max(0.2, Math.min(3.5, num(scale, 1)));
    const count = Math.min(18, (8 + sc * 5) | 0);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const rad = (0.6 + Math.random() * 1.6) * sc;
      const lum = 0.55 + Math.random() * 0.35;
      _c.setHSL(0.565 + Math.random() * 0.04, 0.75, lum);
      spawnParticle(splashPool,
        pos.x, pos.y + 0.04, pos.z,
        Math.cos(a) * rad, (2.4 + Math.random() * 2.6) * sc, Math.sin(a) * rad,
        (0.7 + Math.random() * 0.6) * Math.min(1.8, sc), 0.55 + Math.random() * 0.35,
        _c.r, _c.g, _c.b);
    }
  }

  function chunks(pos, color, n) {
    if (!isV3(pos)) return;
    const count = Math.max(1, Math.min(20, num(n, 8) | 0));
    let r = 1, g = 0.35, b = 0.35;
    if (color !== undefined && color !== null) { try { _c.set(color); r = _c.r; g = _c.g; b = _c.b; } catch (e) {} }
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const rad = 1 + Math.random() * 2.4;
      const shade = 0.7 + Math.random() * 0.5;
      spawnParticle(chunkPool,
        pos.x, pos.y + 0.08, pos.z,
        Math.cos(a) * rad, 2 + Math.random() * 3.2, Math.sin(a) * rad,
        0.7 + Math.random() * 0.9, 0.7 + Math.random() * 0.5,
        Math.min(1, r * shade), Math.min(1, g * shade), Math.min(1, b * shade));
    }
  }

  function glass(pos) {
    if (!isV3(pos)) return;
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      const rad = 0.8 + Math.random() * 2.2;
      const lum = 0.78 + Math.random() * 0.22;
      spawnParticle(glassPool,
        pos.x + (Math.random() - 0.5) * 0.5, pos.y + (Math.random() - 0.5) * 0.5, pos.z + (Math.random() - 0.5) * 0.3,
        Math.cos(a) * rad, 0.5 + Math.random() * 1.5, Math.sin(a) * rad + 1.2, // bias toward player (+Z faces us at -38)
        0.8 + Math.random() * 1, 0.8 + Math.random() * 0.5,
        lum * 0.85, lum, Math.min(1, lum * 1.05));
    }
  }

  function confetti(pos) {
    if (!isV3(pos)) return;
    for (let i = 0; i < 34; i++) {
      const a = Math.random() * Math.PI * 2;
      const rad = 0.6 + Math.random() * 1.9;
      _c.setHSL(Math.random(), 0.95, 0.55 + Math.random() * 0.15);
      spawnParticle(confettiPool,
        pos.x, pos.y + 0.15, pos.z,
        Math.cos(a) * rad, 2.5 + Math.random() * 3, Math.sin(a) * rad,
        0.9 + Math.random() * 0.8, 1.3 + Math.random() * 0.9,
        _c.r, _c.g, _c.b);
    }
  }

  // =========================================================================
  // Splat decals — ONE InstancedMesh (single draw call), oldest recycled,
  // per-instance alpha fade via an instanced 'aFade' attribute, 25s life.
  // =========================================================================
  const decalGeo = new THREE.CircleGeometry(1, 12);
  const decalFade = new THREE.InstancedBufferAttribute(new Float32Array(DECAL_MAX), 1);
  decalFade.setUsage(THREE.DynamicDrawUsage);
  decalGeo.setAttribute('aFade', decalFade);
  const decalMat = new THREE.MeshBasicMaterial({
    transparent: true, depthWrite: false, fog: true,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  decalMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aFade;\nvarying float vFade;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFade = aFade;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFade;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vFade;');
  };
  const decalMesh = new THREE.InstancedMesh(decalGeo, decalMat, DECAL_MAX);
  decalMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  decalMesh.frustumCulled = false;
  decalMesh.renderOrder = 1;
  const decals = [];
  for (let i = 0; i < DECAL_MAX; i++) {
    decalMesh.setMatrixAt(i, _ZERO_M);
    decalMesh.setColorAt(i, _c.setRGB(1, 1, 1)); // creates instanceColor
    decals.push({ pos: new THREE.Vector3(), quat: new THREE.Quaternion(), age: 0, r: 1, active: false });
  }
  if (decalMesh.instanceColor) decalMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  decalMesh.count = 0;
  scene.add(decalMesh);
  let decalCursor = 0;
  let decalHigh = 0; // high-water instance count actually drawn

  function setDecalMatrix(i, d, s) {
    _s.set(s, s, 1);
    _m.compose(d.pos, d.quat, _s);
    decalMesh.setMatrixAt(i, _m);
  }

  function splatDecal(pos, normal, color, r) {
    if (!isV3(pos)) return;
    const i = decalCursor;
    const d = decals[i];
    decalCursor = (decalCursor + 1) % DECAL_MAX;
    d.active = true;
    d.age = 0;
    d.r = Math.max(0.1, Math.min(3, num(r, 0.5)));
    try { _c.set(color === undefined || color === null ? 0x883322 : color); } catch (e) { _c.set(0x883322); }
    decalMesh.setColorAt(i, _c);
    if (decalMesh.instanceColor) decalMesh.instanceColor.needsUpdate = true;
    _v1.set(0, 1, 0);
    if (isV3(normal) && normal.lengthSq() > 1e-6) _v1.copy(normal).normalize();
    const lift = 0.015 + i * 0.0006; // stagger to dodge decal-on-decal z-fighting
    d.pos.set(pos.x + _v1.x * lift, pos.y + _v1.y * lift, pos.z + _v1.z * lift);
    d.quat.setFromUnitVectors(_Z, _v1);
    _q2.setFromAxisAngle(_Z, Math.random() * Math.PI * 2);
    d.quat.multiply(_q2);
    setDecalMatrix(i, d, d.r * 0.3);
    decalFade.setX(i, 0.85);
    decalFade.needsUpdate = true;
    decalMesh.instanceMatrix.needsUpdate = true;
    if (i + 1 > decalHigh) decalHigh = i + 1;
    decalMesh.count = decalHigh;
  }

  function updateDecals(dt) {
    let any = false, matChanged = false, fadeChanged = false;
    for (let i = 0; i < DECAL_MAX; i++) {
      const d = decals[i];
      if (!d.active) continue;
      const prevAge = d.age;
      d.age += dt;
      if (d.age >= DECAL_LIFE) {
        d.active = false;
        decalMesh.setMatrixAt(i, _ZERO_M);
        matChanged = true;
        continue;
      }
      any = true;
      if (d.age < 0.15) {
        setDecalMatrix(i, d, d.r * (0.3 + 0.7 * (d.age / 0.15))); // splat pop-out
        matChanged = true;
      } else if (prevAge < 0.15) {
        setDecalMatrix(i, d, d.r); // settle exactly on full size once
        matChanged = true;
      }
      const t = d.age / DECAL_LIFE;
      decalFade.setX(i, 0.85 * (1 - t * t));
      fadeChanged = true;
    }
    if (!any) decalHigh = 0;
    decalMesh.count = decalHigh;
    if (matChanged) decalMesh.instanceMatrix.needsUpdate = true;
    if (fadeChanged) decalFade.needsUpdate = true;
  }

  // =========================================================================
  // Popups — pooled canvas-texture sprites; readable from the roof.
  // =========================================================================
  const popups = [];
  for (let i = 0; i < POPUP_MAX; i++) {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 64; // small: quarter the mid-gameplay upload
    const c2d = canvas.getContext('2d');
    const tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = 1;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, fog: false });
    const spr = new THREE.Sprite(mat);
    spr.visible = false;
    spr.renderOrder = 999;
    scene.add(spr);
    popups.push({ spr, mat, tex, c2d, age: 0, big: false, baseY: 0, active: false });
  }
  let popupCursor = 0;

  function drawPopupText(pu, text, cssColor) {
    const c2d = pu.c2d;
    c2d.clearRect(0, 0, 256, 64);
    let fs = 42;
    c2d.font = '900 ' + fs + 'px system-ui, Arial, sans-serif';
    const w = c2d.measureText(text).width;
    if (w > 236) { fs = Math.max(15, (236 / w) * 42) | 0; c2d.font = '900 ' + fs + 'px system-ui, Arial, sans-serif'; }
    c2d.textAlign = 'center';
    c2d.textBaseline = 'middle';
    c2d.lineJoin = 'round';
    c2d.lineWidth = 7;
    c2d.strokeStyle = 'rgba(10,10,20,0.95)';
    c2d.strokeText(text, 128, 33);
    c2d.fillStyle = cssColor;
    c2d.fillText(text, 128, 33);
    pu.tex.needsUpdate = true;
  }

  function popup(text, pos, color, big) {
    if (!isV3(pos)) return;
    let str;
    try { str = String(text == null ? '' : text); } catch (e) { str = ''; }
    if (!str) return;
    const pu = popups[popupCursor];
    popupCursor = (popupCursor + 1) % POPUP_MAX;
    let css = '#ffffff';
    if (color !== undefined && color !== null) { try { _c.set(color); css = '#' + _c.getHexString(); } catch (e) {} }
    try { drawPopupText(pu, str, css); } catch (e) { /* canvas hiccup — skip */ return; }
    pu.active = true;
    pu.age = 0;
    pu.big = !!big;
    pu.baseY = pos.y + 0.35;
    pu.spr.position.set(pos.x, pu.baseY, pos.z);
    pu.mat.opacity = 1;
    pu.spr.visible = true;
    // scale set every frame from camera distance
  }

  function updatePopups(dt) {
    let anyActive = false;
    for (let i = 0; i < POPUP_MAX; i++) { if (popups[i].active) { anyActive = true; break; } }
    if (!anyActive) return;
    const cam = camWorld();
    for (let i = 0; i < POPUP_MAX; i++) {
      const pu = popups[i];
      if (!pu.active) continue;
      pu.age += dt;
      const t = pu.age / POPUP_LIFE;
      if (t >= 1) { pu.active = false; pu.spr.visible = false; continue; }
      const easeOut = 1 - (1 - t) * (1 - t) * (1 - t);
      pu.spr.position.y = pu.baseY + POPUP_RISE * easeOut;
      pu.mat.opacity = t > 0.65 ? 1 - (t - 0.65) / 0.35 : 1;
      // constant angular size: readable from ROOF_Y down to street targets.
      const dist = _v1.set(pu.spr.position.x - cam.x, pu.spr.position.y - cam.y, pu.spr.position.z - cam.z).length();
      const h = Math.max(0.28, dist * 0.042) * (pu.big ? 1.6 : 1);
      pu.spr.scale.set(h * 4, h, 1);
    }
  }

  // =========================================================================
  // Slow-mo owner — eases ctx.timeScale on 'slowmo', uses rawDt.
  // =========================================================================
  let slowPhase = 0; // 0 idle, 1 easing in, 2 hold, 3 easing out
  let slowT = 0, slowHold = 0, slowFrom = 1;

  on('slowmo', (p) => {
    const d = num(p && p.duration, 1.2);
    const hold = Math.max(0.1, d - SLOW_IN - SLOW_OUT);
    if (slowPhase === 1 || slowPhase === 2) {
      // already dipping/held — just extend the hold
      slowHold = Math.max(slowPhase === 2 ? slowHold - slowT : slowHold, hold);
      if (slowPhase === 2) slowT = 0;
    } else {
      // idle or easing out: dip again from wherever timeScale currently is
      slowFrom = num(ctx.timeScale, 1);
      slowPhase = 1; slowT = 0; slowHold = hold;
      setAudioSlowmo(true);
    }
  });

  function updateSlowmo(rawDt) {
    if (slowPhase === 0) return;
    slowT += rawDt;
    if (slowPhase === 1) {
      const t = Math.min(1, slowT / SLOW_IN);
      ctx.timeScale = slowFrom + (SLOW_SCALE - slowFrom) * (1 - (1 - t) * (1 - t)); // ease-out into slow
      if (t >= 1) { slowPhase = 2; slowT = 0; }
    } else if (slowPhase === 2) {
      ctx.timeScale = SLOW_SCALE;
      if (slowT >= slowHold) { slowPhase = 3; slowT = 0; }
    } else if (slowPhase === 3) {
      const t = Math.min(1, slowT / SLOW_OUT);
      const k = t * t * (3 - 2 * t); // smoothstep back out
      ctx.timeScale = SLOW_SCALE + (1 - SLOW_SCALE) * k;
      if (t >= 1) { ctx.timeScale = 1; slowPhase = 0; setAudioSlowmo(false); }
    }
  }

  // =========================================================================
  // Blob shadows under held bodies (max 2).
  // =========================================================================
  const shadowGeo = new THREE.CircleGeometry(1, 14);
  shadowGeo.rotateX(-Math.PI / 2);
  const shadows = [];
  for (let i = 0; i < SHADOW_MAX; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false, fog: false,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    const mesh = new THREE.Mesh(shadowGeo, mat);
    mesh.visible = false;
    mesh.renderOrder = 2;
    scene.add(mesh);
    shadows.push({ mesh, mat });
  }
  const heldBodies = [];

  on('grab', (p) => {
    const body = p && p.body;
    if (!body || !body.mesh) return;
    if (heldBodies.indexOf(body) === -1) {
      if (heldBodies.length >= SHADOW_MAX) heldBodies.shift();
      heldBodies.push(body);
    }
  });

  function updateShadows() {
    // prune released / dead bodies
    for (let i = heldBodies.length - 1; i >= 0; i--) {
      const b = heldBodies[i];
      if (!b || b.held !== true || b.alive === false || !b.mesh || (b.data && b.data.racked === true)) {
        heldBodies.splice(i, 1);
      }
    }
    const phys = ctx.physics;
    const gha = (phys && typeof phys.groundHeightAt === 'function') ? phys : null;
    for (let i = 0; i < SHADOW_MAX; i++) {
      const sh = shadows[i];
      const b = heldBodies[i];
      if (!b || !gha) { sh.mesh.visible = false; continue; }
      const mp = b.mesh.position;
      let gy;
      try { gy = gha.groundHeightAt(mp.x, mp.z); } catch (e) { gy = null; }
      if (typeof gy !== 'number' || !isFinite(gy)) { sh.mesh.visible = false; continue; }
      const h = mp.y - gy;
      if (h < 0 || h > 12) { sh.mesh.visible = false; continue; }
      const r = Math.max(0.05, num(b.radius, 0.1)) * (1.4 + h * 0.16);
      sh.mesh.position.set(mp.x, gy + 0.012, mp.z);
      sh.mesh.scale.set(r, 1, r);
      sh.mat.opacity = Math.max(0.06, 0.34 / (1 + h * 0.35));
      sh.mesh.visible = true;
    }
  }

  // =========================================================================
  // Auto feedback on every impact (works even while objects.js is a stub).
  // =========================================================================
  on('impact', (hit) => {
    if (!hit) return;
    const speed = num(hit.speed, 0);
    const pos = isV3(hit.position) ? hit.position : (hit.body && hit.body.mesh ? hit.body.mesh.position : null);
    if (!isV3(pos)) return;
    const surface = typeof hit.surface === 'string' ? hit.surface : 'street';
    if (surface === 'water') {
      if (speed > 0.6) splash(pos, Math.min(2.6, 0.6 + speed / 7));
      return;
    }
    if (speed < 1.6) return; // rolling/rest contacts stay quiet
    // Distant impacts get bigger dust so they read from 24m up.
    const cam = camWorld();
    const dist = _v2.set(pos.x - cam.x, pos.y - cam.y, pos.z - cam.z).length();
    const distBoost = Math.min(2.2, Math.max(1, dist / 13));
    let sc = Math.min(2.4, 0.35 + speed / 9) * distBoost;
    let tint = null;
    if (surface === 'grass') tint = 0x9bc57a;
    else if (surface === 'metal' || surface === 'trampoline') sc *= 0.55;
    else if (surface === 'glass') sc *= 0.4;
    else if (surface === 'awning') { sc *= 0.6; tint = 0xd9c9a8; }
    dust(pos, sc, tint);
    // Generic landing audio for bodies without their own impact hook
    // (baseball/frisbee/paper): audio.js adds distance lowpass + >15m echo,
    // and per-name throttling prevents stacking.
    if (speed > 4 && (!hit.body || typeof hit.body.onImpact !== 'function')) {
      const a = ctx.audio;
      if (a && typeof a.play === 'function') {
        try {
          a.play(surface === 'metal' ? 'clang' : 'thud',
            { position: pos, intensity: Math.min(1.2, speed / 14) });
        } catch (e) { /* stub-safe */ }
      }
    }
  });

  // Celebration popups + confetti. It's a sandbox, not a game: show the
  // label ("SWISH!", "BOOMERANG!"), never numbers — points only rank how
  // big the celebration gets.
  on('score', (p) => {
    if (!p) return;
    const pos = isV3(p.position) ? p.position : null;
    if (!pos) return;
    const points = num(p.points, 0);
    const combo = num(p.combo, 1);
    const text = (typeof p.label === 'string' && p.label) ? p.label : '';
    if (!text) return;
    const big = points >= SLOWMO_THRESHOLD;
    const color = big ? 0xffb03a : (points >= 150 ? 0xffe066 : 0xffffff);
    popup(text, pos, color, big);
    if (big) confetti(pos);
    if (combo >= 3) confetti(pos);
  });

  // =========================================================================
  const api = {
    dust, splash, chunks, glass, confetti, splatDecal, popup,
    update(dt, elapsed, rawDt) {
      const d = num(dt, 0);
      const rd = num(rawDt, d);
      const wind = (ctx.wind && ctx.wind.isVector3) ? ctx.wind : null;
      for (let i = 0; i < allPools.length; i++) updatePool(allPools[i], d, wind);
      updateDecals(d);
      updatePopups(d);
      updateSlowmo(rd);
      updateShadows();
    },
  };
  return api;
}
