import * as THREE from 'three';
import { ROOF_Y } from './constants.js';
import { createAudio } from './audio.js';
import { createEffects } from './effects.js';
import { createPhysics } from './physics.js';
import { createWorld } from './world.js';
import { createTargets } from './targets.js';
import { createObjects } from './objects.js';
import { createInteraction } from './interaction.js';
import { createUI } from './ui.js';

function createEmitter() {
  const map = new Map();
  return {
    on(name, fn) { (map.get(name) || map.set(name, []).get(name)).push(fn); },
    off(name, fn) {
      const arr = map.get(name);
      if (arr) { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); }
    },
    emit(name, payload) {
      const arr = map.get(name);
      if (!arr) return;
      for (let i = 0; i < arr.length; i++) {
        try { arr[i](payload); } catch (e) { console.error(`[event:${name}]`, e); }
      }
    },
  };
}

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.xr.enabled = true;
renderer.xr.setFoveation(1);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 900);

// Player rig: camera parents to this; stands on the roof at origin, facing -Z.
const playerRig = new THREE.Group();
playerRig.position.set(0, ROOF_Y, 0);
playerRig.add(camera);
camera.position.set(0, 1.6, 0); // desktop eye height; XR overrides via local-floor
scene.add(playerRig);

const ctx = {
  scene, camera, renderer,
  clock: new THREE.Clock(),
  events: createEmitter(),
  wind: new THREE.Vector3(0.6, 0, 0.2),
  timeScale: 1,
  playerRig,
  isXR: false,
};

ctx.audio = createAudio(ctx);
ctx.effects = createEffects(ctx);
ctx.physics = createPhysics(ctx);
ctx.world = createWorld(ctx);
ctx.targets = createTargets(ctx);
ctx.objects = createObjects(ctx);
ctx.interaction = createInteraction(ctx);
ctx.ui = createUI(ctx);

const systems = [
  ctx.audio, ctx.effects, ctx.physics, ctx.world,
  ctx.targets, ctx.objects, ctx.interaction, ctx.ui,
];

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

renderer.xr.addEventListener('sessionstart', () => { ctx.isXR = true; });
renderer.xr.addEventListener('sessionend', () => { ctx.isXR = false; });

let elapsed = 0;
renderer.setAnimationLoop(() => {
  const rawDt = Math.min(ctx.clock.getDelta(), 0.05);
  const dt = rawDt * ctx.timeScale;
  elapsed += dt;
  for (let i = 0; i < systems.length; i++) {
    const s = systems[i];
    if (s && s.update) {
      try { s.update(dt, elapsed, rawDt); } catch (e) { console.error('[system]', e); }
    }
  }
  renderer.render(scene, camera);
});

// Expose for debugging in the browser console.
window.__CHUCK = ctx;
