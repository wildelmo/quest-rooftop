// src/interaction.js — CHUCK CITY grab/throw interaction.
//
// XR: two controllers (trigger OR grip grabs within GRAB_RADIUS, release
// throws). Release velocity via weighted-least-squares fit over a ring
// buffer of the last ~130ms of controller world transforms sampled with
// REAL (unscaled) time; angular velocity from quaternion finite differences;
// ×THROW_BOOST hero-arm plus ω×r "whip" contribution. Haptics: hover 0.1,
// grab 0.4, release 0.6, distant rumble on big target-hit of own throw.
// Right-stick snap turn (30°, debounced, pivots around the head).
//
// Desktop fallback (only when no XR session): pointer-lock mouse look,
// 1-9/0 + wheel select from ctx.objects.catalog (DOM chip), hold LMB to
// charge 0.3→18 m/s over 1.1s (DOM power bar), release to throw from camera.
//
// Contract: ARCHITECTURE.md — createInteraction(ctx) returns { update }.

import * as THREE from 'three';
import { GRAB_RADIUS, THROW_BOOST, ROOF_Y } from './constants.js';

// ---------- hoisted temporaries (zero per-frame allocations) ----------
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();

// ---------- tuning ----------
const SAMPLE_COUNT = 16;       // ring buffer size (> frames in window)
const SAMPLE_WINDOW = 0.13;    // seconds of history used for the fit
const WEIGHT_TAU = 0.045;      // exp weight time constant (recent >> old)
const SNAP_ANGLE = Math.PI / 6; // 30 degrees
const SNAP_ON = 0.7;
const SNAP_OFF = 0.35;
const MAX_THROW_SPEED = 30;    // m/s safety clamp (after boost)
const MAX_SPIN = 50;           // rad/s safety clamp
const CHARGE_MIN = 0.3;
const CHARGE_MAX = 18;
const CHARGE_TIME = 1.1;
const MOUSE_SENS = 0.0022;
const PITCH_LIMIT = 1.45;
// Spawn offsets: a typical guardian is ~2x2m and there is no locomotion, so
// VR must start close enough that the parapet notch is one step away and the
// rack table (world.js puts it just behind this spot) is within arm's reach.
const VR_SPAWN_Z = -5.0;
const DESKTOP_SPAWN_Z = -6.6;

export function createInteraction(ctx) {
  ctx = ctx || {};
  const renderer = ctx.renderer;
  const events = ctx.events;
  const playerRig = ctx.playerRig;
  const camera = ctx.camera;

  let realT = 0; // real (unscaled) time accumulator, fed by rawDt

  function emit(name, payload) {
    try { if (events && events.emit) events.emit(name, payload); } catch (e) {}
  }
  function playSound(name, opts) {
    try { if (ctx.audio && ctx.audio.play) ctx.audio.play(name, opts); } catch (e) {}
  }
  function grabbables() {
    try {
      if (ctx.objects && typeof ctx.objects.grabbables === 'function') {
        const list = ctx.objects.grabbables();
        if (Array.isArray(list)) return list;
      }
    } catch (e) {}
    return EMPTY;
  }
  const EMPTY = [];

  function pulse(hand, intensity, ms) {
    try {
      const gp = hand && hand.inputSource && hand.inputSource.gamepad;
      const act = gp && gp.hapticActuators && gp.hapticActuators[0];
      if (act && act.pulse) act.pulse(intensity, ms);
    } catch (e) {}
  }

  // =====================================================================
  // XR hands
  // =====================================================================
  function makeHintMesh() {
    let geo;
    try {
      geo = THREE.CapsuleGeometry
        ? new THREE.CapsuleGeometry(0.016, 0.07, 3, 8)
        : new THREE.CylinderGeometry(0.016, 0.02, 0.09, 8);
    } catch (e) {
      geo = new THREE.SphereGeometry(0.03, 8, 6);
    }
    const mat = new THREE.MeshLambertMaterial({ color: 0xe8e2d6, emissive: 0x1a1a22 });
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -0.55;          // roughly along a held controller
    m.position.set(0, 0, 0.02);
    m.visible = false;
    m.frustumCulled = false;
    return m;
  }

  function makeHand(index) {
    const hand = {
      index,
      controller: null,
      grip: null,
      hint: null,
      inputSource: null,
      connected: false,
      handedness: index === 0 ? 'left' : 'right',
      selectOn: false,
      squeezeOn: false,
      held: null,
      hoverBody: null,
      offPos: new THREE.Vector3(),
      offQuat: new THREE.Quaternion(),
      // ring buffer of controller world transform samples
      samples: null,
      sampleHead: 0,
      sampleN: 0,
      snapLatched: false,
      lastThrown: null,
      lastThrownT: -1e9,
    };
    hand.samples = [];
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      hand.samples.push({ pos: new THREE.Vector3(), quat: new THREE.Quaternion(), t: -1e9 });
    }
    try {
      if (renderer && renderer.xr && renderer.xr.getController) {
        hand.controller = renderer.xr.getController(index);
        hand.grip = renderer.xr.getControllerGrip ? renderer.xr.getControllerGrip(index) : null;
        if (playerRig) {
          if (hand.controller) playerRig.add(hand.controller);
          if (hand.grip) playerRig.add(hand.grip);
        }
        hand.hint = makeHintMesh();
        (hand.grip || hand.controller).add(hand.hint);

        const c = hand.controller;
        c.addEventListener('connected', (e) => {
          hand.connected = true;
          hand.inputSource = e && e.data ? e.data : null;
          if (hand.inputSource && hand.inputSource.handedness &&
              hand.inputSource.handedness !== 'none') {
            hand.handedness = hand.inputSource.handedness;
          }
        });
        c.addEventListener('disconnected', () => {
          hand.connected = false;
          hand.inputSource = null;
          hand.selectOn = false;
          hand.squeezeOn = false;
          if (hand.held) releaseHand(hand); // don't strand a held object
        });
        c.addEventListener('selectstart', () => { hand.selectOn = true; onPress(hand); });
        c.addEventListener('squeezestart', () => { hand.squeezeOn = true; onPress(hand); });
        c.addEventListener('selectend', () => { hand.selectOn = false; onUnpress(hand); });
        c.addEventListener('squeezeend', () => { hand.squeezeOn = false; onUnpress(hand); });
      }
    } catch (e) { /* XR unavailable; desktop still works */ }
    return hand;
  }

  function onPress(hand) {
    if (!ctx.isXR || hand.held) return;
    tryGrab(hand);
  }
  function onUnpress(hand) {
    if (hand.held && !hand.selectOn && !hand.squeezeOn) releaseHand(hand);
  }

  // nearest grabbable body within reach of the controller; null if none
  function findNearest(hand) {
    if (!hand.controller) return null;
    hand.controller.getWorldPosition(_v1);
    const list = grabbables();
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (!b || !b.mesh || b.alive === false) continue;
      if (b.held && b !== hand.held) {
        // racked bodies are kinematic (held=true) but grabbable; skip only
        // ones actually in a hand
        if (b === hands[0].held || b === hands[1].held) continue;
      }
      const r = GRAB_RADIUS + (typeof b.radius === 'number' ? b.radius * 0.5 : 0);
      const d = b.mesh.position.distanceToSquared(_v1);
      if (d < r * r && d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  function tryGrab(hand) {
    const body = findNearest(hand);
    if (!body || !body.mesh) return;
    body.held = true;
    hand.held = body;
    hand.hoverBody = null;
    // capture grip offsets so the object doesn't teleport into the palm
    hand.controller.getWorldPosition(_v1);
    hand.controller.getWorldQuaternion(_q1);
    _q2.copy(_q1).invert();
    hand.offQuat.copy(_q2).multiply(body.mesh.quaternion);
    hand.offPos.copy(body.mesh.position).sub(_v1).applyQuaternion(_q2);
    if (body.velocity) body.velocity.set(0, 0, 0);
    if (body.angularVelocity) body.angularVelocity.set(0, 0, 0);
    pulse(hand, 0.4, 40);
    playSound('grab', { position: body.mesh.position });
    emit('grab', { body, hand: hand.handedness });
  }

  // weighted-least-squares linear velocity of the controller over the window
  function estimateLinearVelocity(hand, out) {
    out.set(0, 0, 0);
    const tMin = realT - SAMPLE_WINDOW;
    let sw = 0, st = 0, sx = 0, sy = 0, sz = 0;
    let stt = 0, stx = 0, sty = 0, stz = 0, n = 0;
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const s = hand.samples[i];
      if (s.t < tMin) continue;
      const t = s.t - realT;                 // relative time (precision)
      const w = Math.exp(t / WEIGHT_TAU);    // recent samples weigh more
      sw += w; st += w * t; stt += w * t * t;
      sx += w * s.pos.x; sy += w * s.pos.y; sz += w * s.pos.z;
      stx += w * t * s.pos.x; sty += w * t * s.pos.y; stz += w * t * s.pos.z;
      n++;
    }
    if (n < 2 || sw <= 0) return;
    const den = stt - (st * st) / sw;
    if (den < 1e-8) return;
    out.set(
      (stx - (st * sx) / sw) / den,
      (sty - (st * sy) / sw) / den,
      (stz - (st * sz) / sw) / den
    );
  }

  // weighted average of quaternion finite differences
  function estimateAngularVelocity(hand, out) {
    out.set(0, 0, 0);
    const tMin = realT - SAMPLE_WINDOW;
    let sw = 0;
    // walk ring in chronological order: oldest slot is sampleHead
    for (let k = 0; k < SAMPLE_COUNT - 1; k++) {
      const a = hand.samples[(hand.sampleHead + k) % SAMPLE_COUNT];
      const b = hand.samples[(hand.sampleHead + k + 1) % SAMPLE_COUNT];
      if (a.t < tMin || b.t < tMin) continue;
      const dt = b.t - a.t;
      if (dt <= 1e-5) continue;
      _q1.copy(a.quat).invert();
      _q2.copy(b.quat).multiply(_q1); // delta rotation in world space
      if (_q2.w < 0) { _q2.x = -_q2.x; _q2.y = -_q2.y; _q2.z = -_q2.z; _q2.w = -_q2.w; }
      const s = Math.sqrt(Math.max(0, 1 - _q2.w * _q2.w));
      if (s < 1e-5) continue;
      const angle = 2 * Math.acos(Math.min(1, _q2.w));
      const scale = angle / (s * dt);
      const w = Math.exp((b.t - realT) / WEIGHT_TAU);
      out.x += _q2.x * scale * w;
      out.y += _q2.y * scale * w;
      out.z += _q2.z * scale * w;
      sw += w;
    }
    if (sw > 0) out.multiplyScalar(1 / sw);
    if (out.lengthSq() > MAX_SPIN * MAX_SPIN) out.setLength(MAX_SPIN);
  }

  function releaseHand(hand) {
    const body = hand.held;
    hand.held = null;
    if (!body) return;
    estimateLinearVelocity(hand, _v2);        // controller velocity
    estimateAngularVelocity(hand, _v3);       // controller angular velocity
    _v2.multiplyScalar(THROW_BOOST);
    // whip: object is offset from the controller; add ω × r
    if (body.mesh && hand.controller) {
      hand.controller.getWorldPosition(_v1);
      _v4.copy(body.mesh.position).sub(_v1);
      _v1.crossVectors(_v3, _v4);
      _v2.add(_v1);
    }
    if (_v2.lengthSq() > MAX_THROW_SPEED * MAX_THROW_SPEED) _v2.setLength(MAX_THROW_SPEED);
    const speed = _v2.length();
    body.held = false;
    if (body.velocity) body.velocity.copy(_v2);
    if (body.angularVelocity) body.angularVelocity.copy(_v3);
    hand.lastThrown = body;
    hand.lastThrownT = realT;
    pulse(hand, 0.6, 60);
    playSound('throw', { position: body.mesh ? body.mesh.position : undefined });
    playSound('whoosh', {
      position: body.mesh ? body.mesh.position : undefined,
      intensity: Math.min(1.4, 0.25 + speed / 14),
    });
    emit('throw', { body, speed });
  }

  const hands = [makeHand(0), makeHand(1)];

  function updateHandXR(hand) {
    if (!hand.controller) return;
    // sample world transform with REAL time
    hand.controller.getWorldPosition(_v1);
    hand.controller.getWorldQuaternion(_q1);
    const s = hand.samples[hand.sampleHead];
    s.pos.copy(_v1);
    s.quat.copy(_q1);
    s.t = realT;
    hand.sampleHead = (hand.sampleHead + 1) % SAMPLE_COUNT;
    if (hand.sampleN < SAMPLE_COUNT) hand.sampleN++;

    if (hand.held) {
      const mesh = hand.held.mesh;
      if (!mesh || hand.held.alive === false) {
        hand.held = null; // body despawned/destroyed while held
      } else {
        mesh.quaternion.copy(_q1).multiply(hand.offQuat);
        mesh.position.copy(hand.offPos).applyQuaternion(_q1).add(_v1);
      }
    } else {
      // hover tick (edge-triggered)
      const near = findNearest(hand);
      if (near && near !== hand.hoverBody) pulse(hand, 0.1, 18);
      hand.hoverBody = near;
    }

    if (hand.hint) {
      hand.hint.visible = !!(ctx.isXR && hand.connected && !hand.held);
      const sc = hand.hoverBody ? 1.35 : 1;
      hand.hint.scale.set(sc, sc, sc);
    }

    // snap turn: right thumbstick x (xr-standard axes[2], fallback axes[0])
    if (hand.handedness === 'right' && hand.inputSource && hand.inputSource.gamepad) {
      const axes = hand.inputSource.gamepad.axes;
      let x = 0;
      if (axes && axes.length > 2) x = axes[2] || 0;
      if (axes && Math.abs(x) < 0.01 && axes.length > 0) x = axes[0] || 0;
      if (!hand.snapLatched && Math.abs(x) > SNAP_ON) {
        hand.snapLatched = true;
        snapTurn(x > 0 ? -SNAP_ANGLE : SNAP_ANGLE);
      } else if (hand.snapLatched && Math.abs(x) < SNAP_OFF) {
        hand.snapLatched = false;
      }
    }
  }

  function invalidateSamples(hand) {
    hand.sampleN = 0;
    for (let i = 0; i < SAMPLE_COUNT; i++) hand.samples[i].t = -1e9;
  }

  function snapTurn(angle) {
    if (!playerRig || !camera) return;
    // pivot around the head so the player doesn't swing through space
    camera.getWorldPosition(_v1);
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const dx = playerRig.position.x - _v1.x;
    const dz = playerRig.position.z - _v1.z;
    playerRig.position.x = _v1.x + dx * cos + dz * sin;
    playerRig.position.z = _v1.z - dx * sin + dz * cos;
    playerRig.rotateY(angle);
    // The rig teleported both controllers in a single frame; stale world-space
    // samples would fit that step as a huge velocity if the player releases
    // right after turning. Restart the estimators from scratch.
    invalidateSamples(hands[0]);
    invalidateSamples(hands[1]);
  }

  // distant rumble when a big hit lands from one of our thrown objects
  if (events && events.on) {
    events.on('target-hit', (p) => {
      try {
        if (!p || !p.body) return;
        const pts = typeof p.points === 'number' ? p.points : 0;
        if (pts < 150) return;
        for (let i = 0; i < 2; i++) {
          const h = hands[i];
          if (h.lastThrown === p.body && realT - h.lastThrownT < 10) {
            pulse(h, Math.min(0.7, 0.2 + pts / 1000), 90);
          }
        }
      } catch (e) {}
    });
    // heavy landings (anvil/bowling slamming bare street) shake the throwing
    // hand even when no target was hit — the "screen-free shake" payoff
    events.on('impact', (hit) => {
      try {
        if (!hit || !hit.body) return;
        const sp = typeof hit.speed === 'number' ? hit.speed : 0;
        if (sp <= 10) return;
        for (let i = 0; i < 2; i++) {
          const h = hands[i];
          if (h.lastThrown === hit.body && realT - h.lastThrownT < 10) {
            const mass = typeof hit.body.mass === 'number' ? hit.body.mass : 1;
            pulse(h, Math.min(0.8, 0.15 + mass * 0.03), 120);
          }
        }
      } catch (e) {}
    });
  }

  // =====================================================================
  // Desktop fallback
  // =====================================================================
  let desktopMode = false;
  let selIdx = 0;
  let charging = false;
  let chargeStart = 0;
  let pitch = 0;
  let chip = null, barWrap = null, barFill = null;
  let lastFillPct = -1;
  const canvas = renderer && renderer.domElement ? renderer.domElement : null;

  function catalogList() {
    try {
      const c = ctx.objects && ctx.objects.catalog;
      if (Array.isArray(c)) return c;
    } catch (e) {}
    return EMPTY;
  }

  function ensureDom() {
    if (chip || typeof document === 'undefined') return;
    chip = document.createElement('div');
    chip.style.cssText =
      'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);' +
      'padding:7px 16px;border-radius:999px;background:rgba(10,12,24,.62);' +
      'color:#fff;font:600 14px/1.2 system-ui,sans-serif;letter-spacing:.4px;' +
      'pointer-events:none;user-select:none;z-index:30;white-space:nowrap;' +
      'box-shadow:0 2px 10px rgba(0,0,0,.35);display:none;';
    document.body.appendChild(chip);

    barWrap = document.createElement('div');
    barWrap.style.cssText =
      'position:fixed;left:50%;bottom:58px;transform:translateX(-50%);' +
      'width:180px;height:7px;border-radius:4px;background:rgba(255,255,255,.18);' +
      'pointer-events:none;z-index:30;display:none;overflow:hidden;';
    barFill = document.createElement('div');
    barFill.style.cssText =
      'height:100%;width:0%;border-radius:4px;' +
      'background:linear-gradient(90deg,#7dd3fc,#f97316);';
    barWrap.appendChild(barFill);
    document.body.appendChild(barWrap);
  }

  function updateChip() {
    if (!chip) return;
    const cat = catalogList();
    if (!cat.length) { chip.textContent = 'no objects'; return; }
    selIdx = ((selIdx % cat.length) + cat.length) % cat.length;
    const entry = cat[selIdx];
    chip.textContent = (entry && (entry.label || entry.id)) || ('object ' + (selIdx + 1));
  }

  function desktopActive() {
    return desktopMode && !ctx.isXR;
  }
  function isLocked() {
    return typeof document !== 'undefined' && canvas &&
      document.pointerLockElement === canvas;
  }

  function chargePower() {
    const t = Math.min(1, Math.max(0, (realT - chargeStart) / CHARGE_TIME));
    return CHARGE_MIN + t * (CHARGE_MAX - CHARGE_MIN);
  }

  function desktopThrow() {
    const cat = catalogList();
    if (!cat.length || !camera) return;
    selIdx = ((selIdx % cat.length) + cat.length) % cat.length;
    const entry = cat[selIdx];
    if (!entry) return;
    const speed = chargePower();
    camera.getWorldDirection(_v1);            // forward
    camera.getWorldPosition(_v2);
    _v3.copy(_v2).addScaledVector(_v1, 0.5);  // spawn point
    let body = null;
    try {
      if (ctx.objects && typeof ctx.objects.spawnAt === 'function') {
        body = ctx.objects.spawnAt(entry.id, _v3);
      }
    } catch (e) {}
    if (!body) return;
    emit('grab', { body, hand: 'mouse' });
    _v4.copy(_v1).multiplyScalar(speed);
    _v4.y += speed * 0.06;                    // slight up-bias
    if (body.velocity) body.velocity.copy(_v4);
    if (body.angularVelocity) {
      // gentle forward tumble around the camera-right axis
      // (_v3 was handed to spawnAt and must not be reused here)
      _v2.set(0, 1, 0);
      _v5.crossVectors(_v1, _v2).normalize();
      body.angularVelocity.copy(_v5).multiplyScalar(-speed * 0.35);
    }
    body.held = false;
    playSound('throw', { position: body.mesh ? body.mesh.position : undefined });
    playSound('whoosh', {
      position: body.mesh ? body.mesh.position : undefined,
      intensity: Math.min(1.4, 0.25 + speed / 14),
    });
    emit('throw', { body, speed });
  }

  // Deterministic spawn per mode. Desktop stands the rig at the parapet notch
  // (no locomotion; the fixed camera must see over the edge). VR spawns one
  // step from the notch with the rack table within reach, and the pose is
  // reset on every XR session start so a desktop session (rig at the notch,
  // mouse-look yaw on the rig) can't leak into a later 'Re-enter VR'.
  function placeRig(z) {
    try {
      if (playerRig && playerRig.position) {
        playerRig.position.set(0, ROOF_Y, z);
        playerRig.rotation.set(0, 0, 0);
      }
    } catch (e) {}
  }

  if (events && events.on) {
    events.on('game-start', (p) => {
      try {
        if (p && p.mode === 'desktop') {
          desktopMode = true;
          placeRig(DESKTOP_SPAWN_Z);
          ensureDom();
          if (chip) chip.style.display = 'block';
          updateChip();
        } else if (p && p.mode === 'vr') {
          placeRig(VR_SPAWN_Z);
        }
      } catch (e) {}
    });
  }

  try {
    if (renderer && renderer.xr && renderer.xr.addEventListener) {
      renderer.xr.addEventListener('sessionstart', () => { placeRig(VR_SPAWN_Z); });
    }
  } catch (e) {}

  if (canvas && typeof document !== 'undefined') {
    canvas.addEventListener('click', () => {
      if (!desktopActive() || isLocked()) return;
      try { canvas.requestPointerLock(); } catch (e) {}
    });
    document.addEventListener('pointerlockchange', () => {
      if (!isLocked() && charging) {
        charging = false;
        if (barWrap) barWrap.style.display = 'none';
      }
    });
    document.addEventListener('mousemove', (e) => {
      if (!desktopActive() || !isLocked() || !playerRig || !camera) return;
      const mx = e.movementX || 0, my = e.movementY || 0;
      playerRig.rotation.y -= mx * MOUSE_SENS;
      pitch -= my * MOUSE_SENS;
      pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
      camera.rotation.x = pitch;
    });
    document.addEventListener('mousedown', (e) => {
      if (!desktopActive() || e.button !== 0) return;
      // 'click' (which grabs pointer lock) only fires AFTER mouseup, so a
      // charge must be allowed to start unlocked — otherwise the very first
      // press can never throw. Grab the lock here as well.
      if (!isLocked()) { try { canvas.requestPointerLock(); } catch (err) {} }
      charging = true;
      chargeStart = realT;
      lastFillPct = -1;
      if (barWrap) barWrap.style.display = 'block';
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button !== 0 || !charging) return;
      charging = false;
      if (barWrap) barWrap.style.display = 'none';
      if (desktopActive()) desktopThrow();
    });
    document.addEventListener('wheel', (e) => {
      if (!desktopActive() || !isLocked()) return;
      selIdx += (e.deltaY || 0) > 0 ? 1 : -1;
      updateChip();
    });
    document.addEventListener('keydown', (e) => {
      if (!desktopActive()) return;
      const k = e.key;
      if (k >= '1' && k <= '9') { selIdx = k.charCodeAt(0) - 49; updateChip(); }
      else if (k === '0') { selIdx = 9; updateChip(); }
    });
  }

  // =====================================================================
  // per-frame update
  // =====================================================================
  function update(dt, elapsed, rawDt) {
    realT += (typeof rawDt === 'number' && rawDt >= 0) ? rawDt : (dt || 0);

    if (ctx.isXR) {
      if (charging) { // XR session started mid-charge: abandon it
        charging = false;
        if (barWrap) barWrap.style.display = 'none';
      }
      updateHandXR(hands[0]);
      updateHandXR(hands[1]);
    } else {
      if (hands[0].hint) hands[0].hint.visible = false;
      if (hands[1].hint) hands[1].hint.visible = false;
      if (charging && barFill) {
        const pct = Math.round(
          100 * Math.min(1, (realT - chargeStart) / CHARGE_TIME));
        if (pct !== lastFillPct) {
          lastFillPct = pct;
          barFill.style.width = pct + '%';
        }
      }
      // late catalog: chip said "no objects" before objects.js filled in
      if (desktopMode && chip && chip.textContent === 'no objects' &&
          catalogList().length) {
        updateChip();
      }
    }
  }

  return { update };
}
