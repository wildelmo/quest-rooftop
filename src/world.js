// src/world.js — CHUCK CITY environment.
// Sunny low-poly town: gradient sky dome, sun + hemisphere light, fog,
// instanced city blocks, roads, park, parked cars, hills, drifting clouds,
// and a detailed cozy player rooftop. Registers all colliders with physics.
//
// Contract (ARCHITECTURE.md):
//   createWorld(ctx) -> { update(dt, t), rackAnchors, scoreboardAnchor, facingBuilding }
//   facingBuilding.origin is the WORLD-SPACE CENTER of pane (col 0, row 0)
//   (bottom-left); pane(i,j) center = origin + right*i*(w+gapX) + up*j*(h+gapY).

import * as THREE from 'three';
import {
  ROOF_Y, BUILDING_HALF_W, BUILDING_HALF_D,
  STREET_NEAR_Z, STREET_FAR_Z, STREET_CENTER_Z,
  FACING_BUILDING, PARK,
} from './constants.js';

// ---------- defensive constant fallbacks (other modules may be stubs) ------
const ROOF = (typeof ROOF_Y === 'number') ? ROOF_Y : 24;
const BHW = (typeof BUILDING_HALF_W === 'number') ? BUILDING_HALF_W : 9;
const BHD = (typeof BUILDING_HALF_D === 'number') ? BUILDING_HALF_D : 7;
const FB = (FACING_BUILDING && typeof FACING_BUILDING.z === 'number')
  ? FACING_BUILDING : { x: 0, halfW: 14, z: -38, halfD: 11, height: 30 };
const PK = (PARK && typeof PARK.x === 'number')
  ? PARK : { x: -38, z: -17, halfW: 16, halfD: 12 };

// ---------- module-scope temps (zero per-frame allocation) ------------------
const _v1 = new THREE.Vector3();
const _c1 = new THREE.Color();
const _m4 = new THREE.Matrix4();
const _q1 = new THREE.Quaternion();
const _e1 = new THREE.Euler();
const _s1 = new THREE.Vector3();

// ---------- tiny seeded rng --------------------------------------------------
function makeRng(seed) {
  let s = seed >>> 0;
  return function () {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- geometry merger (static vertex-colored batches) -----------------
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
function pushCyl(m, rt, rb, h, seg, color, x, y, z, rx, ry) {
  pushGeom(m, new THREE.CylinderGeometry(rt, rb, h, seg), color, x, y, z, ry || 0, rx || 0);
}
function pushCone(m, r, h, seg, color, x, y, z) {
  pushGeom(m, new THREE.ConeGeometry(r, h, seg), color, x, y, z, 0, 0);
}

function buildMerged(m, material) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(m.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(m.nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(m.col, 3));
  return new THREE.Mesh(g, material);
}

// ---------- shared window texture for the instanced city --------------------
function makeWindowTexture() {
  try {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 128;
    const g = c.getContext('2d');
    // roof strip (v 0.875..1  == canvas y 0..16): plain
    g.fillStyle = '#d8d4c9'; g.fillRect(0, 0, 128, 16);
    // wall (white so instanceColor tints it)
    g.fillStyle = '#ffffff'; g.fillRect(0, 16, 128, 112);
    // storefront band at street level
    g.fillStyle = '#6f6455'; g.fillRect(0, 112, 128, 16);
    g.fillStyle = '#cfe2e8';
    for (let i = 0; i < 6; i++) g.fillRect(6 + i * 21, 115, 13, 9);
    // window grid: 8 cols x 10 rows
    const rnd = makeRng(1234);
    for (let j = 0; j < 10; j++) {
      for (let i = 0; i < 8; i++) {
        const r = rnd();
        g.fillStyle = r < 0.16 ? '#ffe3a3' : (r < 0.3 ? '#5d7690' : '#3d4f63');
        g.fillRect(5 + i * 16, 21 + j * 9, 9, 5);
      }
    }
    const tex = new THREE.CanvasTexture(c);
    if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 2;
    return tex;
  } catch (e) { return null; }
}

// Unit box, base at y=0, side faces map wall region, top/bottom map roof patch.
function makeBuildingGeometry() {
  const g = new THREE.BoxGeometry(1, 1, 1);
  const uv = g.attributes.uv;
  // BoxGeometry vert order: +x(0-3) -x(4-7) +y(8-11) -y(12-15) +z(16-19) -z(20-23)
  for (let i = 0; i < 24; i++) {
    if (i >= 8 && i < 16) {           // top & bottom -> plain roof patch
      uv.setXY(i, 0.25 + (i % 2) * 0.05, 0.93 + (i % 3 === 0 ? 0.02 : 0));
    } else {                          // sides: v 0..0.86 == wall region
      uv.setY(i, uv.getY(i) * 0.86);
    }
  }
  g.translate(0, 0.5, 0);
  return g;
}

// ---------- createWorld ------------------------------------------------------
export function createWorld(ctx) {
  ctx = ctx || {};
  const scene = (ctx.scene && ctx.scene.add) ? ctx.scene : new THREE.Group();
  const phys = ctx.physics;
  const rnd = makeRng(20260712);

  function addC(c) {
    try { if (phys && typeof phys.addCollider === 'function') phys.addCollider(c); }
    catch (e) { /* stub-safe */ }
  }
  function addAABB(x0, y0, z0, x1, y1, z1, surface, name) {
    addC({
      type: 'aabb',
      min: new THREE.Vector3(x0, y0, z0),
      max: new THREE.Vector3(x1, y1, z1),
      surface, name,
    });
  }

  // ======================= SKY / LIGHT / FOG ================================
  const HORIZON = 0xf3e2c2, ZENITH = 0x3f86d2;
  if (scene.isScene) scene.fog = new THREE.Fog(HORIZON, 90, 640);

  {
    const skyGeo = new THREE.SphereGeometry(820, 24, 12);
    const pos = skyGeo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const cz = new THREE.Color(ZENITH), ch = new THREE.Color(HORIZON);
    for (let i = 0; i < pos.count; i++) {
      const t = Math.pow(Math.max(0, pos.getY(i) / 820), 0.62);
      _c1.copy(ch).lerp(cz, t);
      colors[i * 3] = _c1.r; colors[i * 3 + 1] = _c1.g; colors[i * 3 + 2] = _c1.b;
    }
    skyGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const sky = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false,
    }));
    sky.frustumCulled = false;
    sky.renderOrder = -10;
    scene.add(sky);
    // visible sun disc
    const sunDisc = new THREE.Mesh(
      new THREE.CircleGeometry(34, 20),
      new THREE.MeshBasicMaterial({ color: 0xfff7dc, fog: false }));
    sunDisc.position.set(310, 560, 420);
    sunDisc.lookAt(0, 0, 0);
    scene.add(sunDisc);
  }

  const sun = new THREE.DirectionalLight(0xfff1d0, 2.6);
  sun.position.set(45, 80, 60);
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0xbfdcf0, 0xd9c69c, 1.5));

  // ======================= MATERIALS ========================================
  const staticMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const treeMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const carMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const cloudMat = new THREE.MeshLambertMaterial({
    color: 0xffffff, emissive: 0x9aa4ad, flatShading: true,
  });
  const windowTex = makeWindowTexture();
  const bldgMat = windowTex
    ? new THREE.MeshLambertMaterial({ map: windowTex })
    : new THREE.MeshLambertMaterial({ color: 0xcfc4ae });

  const S = newMerger(); // one big static vertex-colored batch

  // ======================= GROUND / ROADS / PARK ============================
  pushBox(S, 900, 0.1, 900, 0x9fae86, 0, -0.07, 0);            // outskirts
  pushBox(S, 250, 0.09, 250, 0xb5afa1, 8, -0.045, -25);        // city ground
  // main street (along X, z -24.5..-9.5 asphalt) and cross street (along Z)
  pushBox(S, 118, 0.09, 15, 0x53575e, 37, 0.0, -17);           // main asphalt
  pushBox(S, 8, 0.076, 86, 0x53575e, -15, 0.0, 16);            // cross asphalt
  // sidewalks
  pushBox(S, 107, 0.28, 2.5, 0xc9c2b2, 42.5, 0, -8.25);        // north (our side)
  pushBox(S, 118, 0.28, 2.5, 0xc9c2b2, 37, 0, -25.75);         // south (facing side)
  pushBox(S, 2, 0.28, 86, 0xc9c2b2, -10, 0, 16);               // cross east
  pushBox(S, 3, 0.28, 86, 0xc9c2b2, -20.5, 0, 16);             // cross west (park promenade)
  // dashed center lines
  for (let x = -16; x <= 92; x += 5) pushBox(S, 1.8, 0.03, 0.18, 0xe9e4d4, x, 0.052, -17);
  for (let z = -22; z <= 56; z += 5) pushBox(S, 0.18, 0.03, 1.8, 0xe9e4d4, -15, 0.048, z);
  addC({ type: 'plane', y: 0, surface: 'street', name: 'street' });
  addAABB(-11, -1, -9.5, 96, 0.14, -7, 'street', 'sidewalk-n');
  addAABB(-22, -1, -27, 96, 0.14, -24.5, 'street', 'sidewalk-s');

  // park
  const px0 = PK.x - PK.halfW, px1 = PK.x + PK.halfW;
  const pz0 = PK.z - PK.halfD, pz1 = PK.z + PK.halfD;
  pushBox(S, PK.halfW * 2, 0.24, PK.halfD * 2, 0x6dae5c, PK.x, 0, PK.z); // grass
  pushBox(S, 6, 0.26, 2.4, 0xccba92, px1 - 3, 0.01, PK.z);              // path stub
  addAABB(px0, -1, pz0, px1, 0.12, pz1, 'grass', 'park');

  // street lamps
  const lampSpots = [[-4, -8.4], [16, -8.4], [36, -8.4], [4, -25.6], [26, -25.6], [48, -25.6]];
  for (let i = 0; i < lampSpots.length; i++) {
    const lx = lampSpots[i][0], lz = lampSpots[i][1];
    pushCyl(S, 0.06, 0.1, 4.4, 6, 0x2d463c, lx, 2.2, lz);
    pushBox(S, 0.9, 0.1, 0.12, 0x2d463c, lx + 0.4, 4.4, lz);
    pushBox(S, 0.34, 0.16, 0.3, 0xffedb8, lx + 0.8, 4.32, lz);
  }

  // ======================= HILLS RING =======================================
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2 + rnd() * 0.25;
    const r = 320 + rnd() * 110;
    const hr = 60 + rnd() * 90, hh = 26 + rnd() * 48;
    _c1.set(0x7fa072).lerp(new THREE.Color(0x8ba4b5), rnd() * 0.7);
    pushCone(S, hr, hh, 7, _c1.getHex(), Math.cos(a) * r, hh * 0.5 - 4, Math.sin(a) * r);
  }

  // ======================= INSTANCED CITY ===================================
  const specs = [];
  const reserved = [ // [x0,x1,z0,z1] expanded keep-out rects
    [-11, 11, -9, 9],                                     // player building
    [FB.x - FB.halfW - 2, FB.x + FB.halfW + 2, FB.z - FB.halfD - 2, FB.z + FB.halfD + 2],
    [px0 - 2, px1 + 2, pz0 - 2, pz1 + 2],                 // park
    [-24, 98, -29, -5],                                   // main street
    [-24, -7, -29, 61],                                   // cross street
  ];
  function clear(x0, x1, z0, z1) {
    for (let i = 0; i < reserved.length; i++) {
      const r = reserved[i];
      if (x0 < r[1] && x1 > r[0] && z0 < r[3] && z1 > r[2]) return false;
    }
    return true;
  }
  const palette = [0xe8d5b0, 0xd9825f, 0xa8c8d8, 0xf2e6c8, 0xb5c9a3, 0xc96f5a, 0xcfd2d6, 0xd8b98a];
  for (let gx = -96; gx <= 96; gx += 24) {
    for (let gz = -108; gz <= 60; gz += 24) {
      const x = gx + (rnd() - 0.5) * 6, z = gz + (rnd() - 0.5) * 6;
      const hw = 5 + rnd() * 3, hd = 5 + rnd() * 3;
      if (!clear(x - hw, x + hw, z - hd, z + hd)) continue;
      const dist = Math.sqrt(x * x + z * z);
      let h = 8 + rnd() * 14 + Math.min(dist * 0.06, 9);
      if (z < -60 || z > 30) h += rnd() * 6; // taller skyline further out
      specs.push({ x, z, hw, hd, h, color: palette[(rnd() * palette.length) | 0] });
    }
  }
  const cityMesh = new THREE.InstancedMesh(makeBuildingGeometry(), bldgMat, specs.length);
  cityMesh.frustumCulled = false;
  _q1.identity();
  for (let i = 0; i < specs.length; i++) {
    const b = specs[i];
    _v1.set(b.x, 0, b.z); _s1.set(b.hw * 2, b.h, b.hd * 2);
    _m4.compose(_v1, _q1, _s1);
    cityMesh.setMatrixAt(i, _m4);
    _c1.set(b.color).multiplyScalar(0.92 + rnd() * 0.14);
    cityMesh.setColorAt(i, _c1);
    addAABB(b.x - b.hw, 0, b.z - b.hd, b.x + b.hw, b.h, b.z + b.hd, 'roof');
  }
  scene.add(cityMesh);

  // ======================= FACING BUILDING (hero, flat +Z facade) ===========
  const facadeZ = FB.z + FB.halfD;
  pushBox(S, FB.halfW * 2, FB.height, FB.halfD * 2, 0xb9cbd8, FB.x, FB.height / 2, FB.z);
  // window bands on side faces only (facade & back stay flat)
  for (let k = 0; k < 10; k++) {
    const y = 2.5 + k * 2.8;
    pushBox(S, 0.1, 1.2, FB.halfD * 2 - 4, 0x46586e, FB.x - FB.halfW - 0.04, y, FB.z);
    pushBox(S, 0.1, 1.2, FB.halfD * 2 - 4, 0x46586e, FB.x + FB.halfW + 0.04, y, FB.z);
  }
  // dark inset panel behind the breakable-window grid (reads as interior)
  pushBox(S, 18.6, 15.4, 0.06, 0x232e3b, FB.x, 11.0, facadeZ + 0.01);
  // roof rim + slab
  const fw = FB.halfW, fd = FB.halfD, fh = FB.height;
  pushBox(S, fw * 2, 0.12, fd * 2, 0x9fb0bd, FB.x, fh + 0.02, FB.z);
  pushBox(S, fw * 2, 0.7, 0.4, 0xa8b9c6, FB.x, fh + 0.35, FB.z - fd + 0.2);
  pushBox(S, fw * 2, 0.7, 0.4, 0xa8b9c6, FB.x, fh + 0.35, FB.z + fd - 0.2);
  pushBox(S, 0.4, 0.7, fd * 2 - 0.8, 0xa8b9c6, FB.x - fw + 0.2, fh + 0.35, FB.z);
  pushBox(S, 0.4, 0.7, fd * 2 - 0.8, 0xa8b9c6, FB.x + fw - 0.2, fh + 0.35, FB.z);
  addAABB(FB.x - fw, 0, FB.z - fd, FB.x + fw, fh, FB.z + fd, 'roof', 'facing-building');
  addAABB(FB.x - fw, fh, FB.z - fd, FB.x + fw, fh + 0.7, FB.z - fd + 0.4, 'roof');
  addAABB(FB.x - fw, fh, FB.z + fd - 0.4, FB.x + fw, fh + 0.7, FB.z + fd, 'roof');
  addAABB(FB.x - fw, fh, FB.z - fd, FB.x - fw + 0.4, fh + 0.7, FB.z + fd, 'roof');
  addAABB(FB.x + fw - 0.4, fh, FB.z - fd, FB.x + fw, fh + 0.7, FB.z + fd, 'roof');

  // exported breakable-window grid (origin = CENTER of bottom-left pane)
  const gridW = 1.6, gridH = 1.2, gridGapX = 1.0, gridGapY = 1.4, gridCols = 7, gridRows = 6;
  const facingBuilding = {
    origin: new THREE.Vector3(
      FB.x - ((gridCols - 1) * (gridW + gridGapX)) / 2,
      4.0 + gridH / 2,
      facadeZ + 0.05),
    right: new THREE.Vector3(1, 0, 0),
    up: new THREE.Vector3(0, 1, 0),
    cols: gridCols, rows: gridRows,
    w: gridW, h: gridH, gapX: gridGapX, gapY: gridGapY,
  };

  // ======================= PLAYER BUILDING + ROOFTOP ========================
  pushBox(S, BHW * 2, ROOF - 0.1, BHD * 2, 0xe6d3b4, 0, (ROOF - 0.1) / 2, 0);
  pushBox(S, BHW * 2 + 0.2, 3, BHD * 2 + 0.2, 0x8a7a66, 0, 1.5, 0); // plinth
  for (let k = 0; k < 7; k++) { // window bands
    const y = 5.2 + k * 2.7;
    pushBox(S, BHW * 2 - 2.5, 1.1, 0.1, 0x46586e, 0, y, -BHD - 0.04);
    pushBox(S, BHW * 2 - 2.5, 1.1, 0.1, 0x46586e, 0, y, BHD + 0.04);
    pushBox(S, 0.1, 1.1, BHD * 2 - 2.5, 0x46586e, -BHW - 0.04, y, 0);
    pushBox(S, 0.1, 1.1, BHD * 2 - 2.5, 0x46586e, BHW + 0.04, y, 0);
  }
  pushBox(S, BHW * 2 - 0.1, 0.14, BHD * 2 - 0.1, 0x9aa09b, 0, ROOF - 0.07, 0); // deck
  addAABB(-BHW, 0, -BHD, BHW, ROOF, BHD, 'roof', 'player-building');

  // parapet (0.9 m) with lower 0.45 m notch at the throwing edge (x -2.5..2.5)
  const P_IN = 0.4, CAP = 0xe9ddc1, WALL = 0xcdb99b;
  function parapet(x0, x1, z0, z1, h) {
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    pushBox(S, x1 - x0, h, z1 - z0, WALL, cx, ROOF + h / 2, cz);
    pushBox(S, x1 - x0 + 0.08, 0.09, z1 - z0 + 0.08, CAP, cx, ROOF + h + 0.045, cz);
    addAABB(x0, ROOF - 0.1, z0, x1, ROOF + h + 0.09, z1, 'roof');
  }
  parapet(-BHW, -2.5, -BHD, -BHD + P_IN, 0.9);          // front left
  parapet(-2.5, 2.5, -BHD, -BHD + P_IN, 0.45);          // NOTCH (throwing edge)
  parapet(2.5, BHW, -BHD, -BHD + P_IN, 0.9);            // front right
  parapet(-BHW, BHW, BHD - P_IN, BHD, 0.9);             // back
  parapet(-BHW, -BHW + P_IN, -BHD + P_IN, BHD - P_IN, 0.9); // left
  parapet(BHW - P_IN, BHW, -BHD + P_IN, BHD - P_IN, 0.9);   // right

  // AC units (metal — they clang)
  pushBox(S, 1.7, 1.1, 1.3, 0xcdd5d9, 5.6, ROOF + 0.55, 3.4);
  pushCyl(S, 0.5, 0.5, 0.08, 10, 0x39424a, 5.6, ROOF + 1.12, 3.4);
  pushBox(S, 2.1, 1.35, 1.5, 0xbcc6cc, -6.2, ROOF + 0.67, 4.4);
  pushCyl(S, 0.6, 0.6, 0.08, 10, 0x39424a, -6.2, ROOF + 1.36, 4.4);
  addAABB(4.75, ROOF, 2.75, 6.45, ROOF + 1.16, 4.05, 'metal', 'ac-1');
  addAABB(-7.25, ROOF, 3.65, -5.15, ROOF + 1.4, 5.15, 'metal', 'ac-2');

  // vents + pipes + hatch
  const vents = [[-3.5, 5.6], [1.5, 5.8], [7.2, 0.5]];
  for (let i = 0; i < vents.length; i++) {
    pushCyl(S, 0.16, 0.16, 0.75, 7, 0xaab3b8, vents[i][0], ROOF + 0.37, vents[i][1]);
    pushCyl(S, 0.34, 0.24, 0.2, 7, 0x8d979d, vents[i][0], ROOF + 0.82, vents[i][1]);
  }
  pushCyl(S, 0.09, 0.09, 12, 6, 0x9c8b74, 0, ROOF + 0.34, 6.35, Math.PI / 2, Math.PI / 2);
  pushCyl(S, 0.09, 0.09, 0.7, 6, 0x9c8b74, -6, ROOF + 0.16, 6.35);
  pushBox(S, 1.3, 0.5, 1.3, 0xb8a888, -7.6, ROOF + 0.25, 0.5); // roof hatch
  pushBox(S, 1.34, 0.08, 1.34, 0x8d7d5f, -7.6, ROOF + 0.52, 0.5);

  // wooden object rack table (z -4.5..-2.7 — beside the throwing notch so a
  // VR player spawning at z≈-5 with a small guardian can reach the objects)
  const TW = 0x9c6b3d, TW2 = 0x7d5430;
  const RACK_Z = -3.6;
  pushBox(S, 4.6, 0.09, 1.8, TW, 0, ROOF + 0.875, RACK_Z);        // top (surface ~ +0.92)
  pushBox(S, 4.4, 0.06, 1.6, TW2, 0, ROOF + 0.42, RACK_Z);        // shelf
  const legs = [[-2.15, RACK_Z - 0.75], [2.15, RACK_Z - 0.75], [-2.15, RACK_Z + 0.75], [2.15, RACK_Z + 0.75]];
  for (let i = 0; i < legs.length; i++) {
    pushBox(S, 0.13, 0.85, 0.13, TW2, legs[i][0], ROOF + 0.425, legs[i][1]);
  }
  addAABB(-2.3, ROOF, RACK_Z - 0.9, 2.3, ROOF + 0.92, RACK_Z + 0.9, 'roof', 'rack-table');

  // rack anchors: 2 rows x 7, front row toward spawn, y = ROOF + 0.95
  const rackAnchors = [];
  for (let r = 0; r < 2; r++) {
    for (let i = 0; i < 7; i++) {
      rackAnchors.push(new THREE.Vector3(-1.95 + i * 0.65, ROOF + 0.95, r === 0 ? RACK_Z - 0.4 : RACK_Z + 0.4));
    }
  }

  // scoreboard pole (left of throwing edge) + anchor facing spawn
  pushCyl(S, 0.06, 0.09, 2.7, 7, 0x4a5560, -6.2, ROOF + 1.35, -6.1);
  const scoreboardAnchor = new THREE.Object3D();
  scoreboardAnchor.position.set(-6.2, ROOF + 2.85, -6.1);
  scoreboardAnchor.lookAt(0, ROOF + 1.6, 0); // +Z toward player spawn
  scene.add(scoreboardAnchor);

  // flag pole (front-right corner) — cloth built separately, animated by wind
  const FLAG_X = 8.3, FLAG_Z = -6.2;
  pushCyl(S, 0.045, 0.07, 3.6, 7, 0x5b666f, FLAG_X, ROOF + 1.8, FLAG_Z);
  pushGeom(S, new THREE.SphereGeometry(0.09, 8, 6), 0xf0c443, FLAG_X, ROOF + 3.64, FLAG_Z, 0, 0);

  // ======================= PARKED CARS ======================================
  const carM = newMerger();
  pushBox(carM, 3.6, 0.6, 1.6, 0xffffff, 0, 0.58, 0);
  pushBox(carM, 1.9, 0.52, 1.42, 0x2c3440, -0.25, 1.06, 0);
  pushBox(carM, 0.5, 0.18, 1.5, 0xd9dde0, 1.72, 0.5, 0);
  const wheelSpots = [[-1.2, 0.78], [1.2, 0.78], [-1.2, -0.78], [1.2, -0.78]];
  for (let i = 0; i < wheelSpots.length; i++) {
    pushCyl(carM, 0.3, 0.3, 0.22, 8, 0x20242a,
      wheelSpots[i][0], 0.3, wheelSpots[i][1], Math.PI / 2, 0);
  }
  const carGeo = buildMerged(carM, null).geometry;
  const carColors = [0xe05a4e, 0x4e7fb8, 0xe8c25a, 0x67a06b, 0xd8d8d8, 0x8a6fb5, 0xd97f3f];
  const carList = [
    { x: -6, z: -10.6, ry: 0 }, { x: 2, z: -10.6, ry: 0 }, { x: 18, z: -10.6, ry: Math.PI },
    { x: 40, z: -10.6, ry: 0 }, { x: 56, z: -10.6, ry: Math.PI },
    { x: 8, z: -23.4, ry: Math.PI }, { x: 26, z: -23.4, ry: Math.PI },
    { x: 46, z: -23.4, ry: 0 }, { x: 64, z: -23.4, ry: Math.PI },
    { x: -12.1, z: 8, ry: Math.PI / 2 }, { x: -12.1, z: 24, ry: -Math.PI / 2 },
  ];
  const cars = new THREE.InstancedMesh(carGeo, carMat, carList.length);
  cars.frustumCulled = false;
  for (let i = 0; i < carList.length; i++) {
    const cdef = carList[i];
    _e1.set(0, cdef.ry, 0); _q1.setFromEuler(_e1);
    _v1.set(cdef.x, 0, cdef.z); _s1.set(1, 1, 1);
    _m4.compose(_v1, _q1, _s1);
    cars.setMatrixAt(i, _m4);
    cars.setColorAt(i, _c1.set(carColors[i % carColors.length]));
    const along = Math.abs(Math.sin(cdef.ry)) > 0.5; // rotated -> long axis on Z
    const hx = along ? 0.95 : 2.05, hz = along ? 2.05 : 0.95;
    addAABB(cdef.x - hx, 0, cdef.z - hz, cdef.x + hx, 1.34, cdef.z + hz, 'metal', 'car');
  }
  scene.add(cars);

  // ======================= TREES ============================================
  const treeM = newMerger();
  pushCyl(treeM, 0.11, 0.17, 1.0, 5, 0x7a5a3a, 0, 0.5, 0);
  pushCone(treeM, 1.0, 1.25, 6, 0x4d9a4f, 0, 1.55, 0);
  pushCone(treeM, 0.72, 1.05, 6, 0x5cb35c, 0, 2.35, 0);
  const treeGeo = buildMerged(treeM, null).geometry;
  const treeSpots = [];
  let guard = 0;
  while (treeSpots.length < 16 && guard++ < 200) { // park trees (leave hoop area open)
    const tx = px0 + 2 + rnd() * (PK.halfW * 2 - 4);
    const tz = pz0 + 2 + rnd() * (PK.halfD * 2 - 4);
    const dxh = tx - (px1 - 6), dzh = tz - PK.z;
    if (dxh * dxh + dzh * dzh < 30) continue; // hoop clearing near park east
    treeSpots.push([tx, 0.1, tz]);
  }
  const streetTrees = [[8, -8.6], [28, -8.6], [48, -8.6], [66, -8.6],
    [-2, -25.4], [18, -25.4], [38, -25.4], [58, -25.4]];
  for (let i = 0; i < streetTrees.length; i++) treeSpots.push([streetTrees[i][0], 0.12, streetTrees[i][1]]);
  const trees = new THREE.InstancedMesh(treeGeo, treeMat, treeSpots.length);
  trees.frustumCulled = false;
  for (let i = 0; i < treeSpots.length; i++) {
    const sc = 0.85 + rnd() * 0.7;
    _e1.set(0, rnd() * Math.PI * 2, 0); _q1.setFromEuler(_e1);
    _v1.set(treeSpots[i][0], treeSpots[i][1], treeSpots[i][2]);
    _s1.set(sc, sc * (0.9 + rnd() * 0.35), sc);
    _m4.compose(_v1, _q1, _s1);
    trees.setMatrixAt(i, _m4);
    trees.setColorAt(i, _c1.setHSL(0.31 + rnd() * 0.05, 0.45, 0.42 + rnd() * 0.14));
  }
  scene.add(trees);

  // ======================= CLOUDS (drifting, merged, group-rotated) =========
  const cloudGroup = new THREE.Group();
  {
    const cm = newMerger();
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + rnd();
      const r = 130 + rnd() * 130, cy = 58 + rnd() * 30;
      const cx = Math.cos(a) * r, czp = Math.sin(a) * r;
      const blobs = 3 + ((rnd() * 3) | 0);
      for (let b = 0; b < blobs; b++) {
        const g = new THREE.IcosahedronGeometry(4.5 + rnd() * 5.5, 0);
        g.scale(1.6, 0.55, 1.1);
        pushGeom(cm, g, 0xffffff,
          cx + (b - blobs / 2) * 6.5, cy + (rnd() - 0.5) * 2.5, czp + (rnd() - 0.5) * 5, 0, 0);
      }
    }
    const clouds = buildMerged(cm, cloudMat);
    clouds.frustumCulled = false;
    cloudGroup.add(clouds);
  }
  scene.add(cloudGroup);

  // ======================= WIND FLAG (animated cloth) =======================
  const flagGroup = new THREE.Group();
  flagGroup.position.set(FLAG_X, ROOF + 3.28, FLAG_Z);
  const flagGeo = new THREE.PlaneGeometry(1.4, 0.85, 7, 3);
  flagGeo.translate(0.7, 0, 0); // pole edge at local x=0
  {
    const fpos = flagGeo.attributes.position;
    const fcol = new Float32Array(fpos.count * 3);
    for (let i = 0; i < fpos.count; i++) {
      _c1.set(Math.abs(fpos.getY(i)) < 0.16 ? 0xf6ecd8 : 0xf2703c);
      fcol[i * 3] = _c1.r; fcol[i * 3 + 1] = _c1.g; fcol[i * 3 + 2] = _c1.b;
    }
    flagGeo.setAttribute('color', new THREE.BufferAttribute(fcol, 3));
  }
  const flagBase = flagGeo.attributes.position.array.slice();
  const flag = new THREE.Mesh(flagGeo, new THREE.MeshLambertMaterial({
    vertexColors: true, side: THREE.DoubleSide,
  }));
  flag.frustumCulled = false;
  flagGroup.add(flag);
  scene.add(flagGroup);

  // add the big static batch last
  const staticMesh = buildMerged(S, staticMat);
  staticMesh.frustumCulled = false;
  scene.add(staticMesh);

  // ======================= UPDATE ==========================================
  let time = 0;
  let flagYaw = 0;
  const flagPos = flagGeo.attributes.position;

  function update(dt) {
    const d = (typeof dt === 'number' && isFinite(dt)) ? Math.max(0, dt) : 0;
    time += d;

    cloudGroup.rotation.y += d * 0.004; // lazy drift

    // wind (defensive: ctx.wind may be missing/garbage)
    let wx = 0.6, wz = 0.2;
    const w = ctx.wind;
    if (w && isFinite(w.x) && isFinite(w.z)) { wx = w.x; wz = w.z; }
    const wSpeed = Math.sqrt(wx * wx + wz * wz);
    if (wSpeed > 0.001) {
      const target = Math.atan2(-wz, wx);
      let diff = target - flagYaw;
      diff = ((diff + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
      flagYaw += diff * Math.min(1, d * 2.5);
      flagGroup.rotation.y = flagYaw;
    }

    // cloth wave: amplitude/frequency scale with wind, free end waves most
    const amp = 0.045 + Math.min(wSpeed, 3) * 0.06;
    const freq = 5 + Math.min(wSpeed, 3) * 2.2;
    const droop = Math.max(0, 1 - wSpeed / 1.5) * 0.28;
    const arr = flagPos.array;
    for (let i = 0; i < arr.length; i += 3) {
      const bx = flagBase[i], by = flagBase[i + 1];
      const f = bx / 1.4;
      arr[i] = bx;
      arr[i + 1] = by - droop * f * f + Math.sin(bx * 3.1 + time * freq * 0.7) * 0.03 * f;
      arr[i + 2] = Math.sin(bx * 4.6 - time * freq) * amp * f;
    }
    flagPos.needsUpdate = true;
  }

  return { update, rackAnchors, scoreboardAnchor, facingBuilding };
}
