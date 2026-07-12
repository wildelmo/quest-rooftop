// src/audio.js — CHUCK CITY procedural audio. 100% synthesized WebAudio.
// Lazy AudioContext (created on resume(), i.e. first user gesture).
// Master chain: perSound -> master gain -> master lowpass (slow-mo dip)
//               -> DynamicsCompressor -> destination.
// Positional: distance gain falloff 1/(1+d*0.06), lowpass 18000/(1+d*0.12),
// stereo pan from camera-relative direction, single 90ms echo tap for d>15.

import * as THREE from 'three';

// ---- hoisted temps (zero per-frame allocations) -------------------------
const _camPos = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _q = new THREE.Quaternion();

const MAX_VOICES = 26;

// Per-name mix levels.
const BASE_GAIN = {
  whoosh: 0.50, thud: 0.95, clang: 0.55, splat: 0.75, splash: 0.70,
  shatter: 0.60, bounce: 0.48, squeak: 0.42, ding: 0.50, ring: 0.42,
  pop: 0.55, grab: 0.35, throw: 0.45, combo: 0.55, fanfare: 0.60,
  rocket: 0.65, whistle: 0.48, honk: 0.16, rumble: 0.20,
};

// Minimum seconds between retriggers (anti-stack; ring/whistle are looped
// by retrigger from objects.js).
const THROTTLE = {
  ring: 0.9, whistle: 0.8, whoosh: 0.05, thud: 0.045, bounce: 0.04,
  squeak: 0.07, clang: 0.05, splat: 0.05, pop: 0.04, ding: 0.05,
};

export function createAudio(ctx) {
  let ac = null;            // AudioContext
  let ready = false;
  let master = null, masterLP = null, compressor = null;
  let echoIn = null;        // street-canyon echo bus
  let noiseBuf = null, brownBuf = null;

  // slow-mo lowpass state
  let lpCur = 19000;
  let manualSlowmo = false;
  let slowmoTimer = 0;

  // ambience state
  let ambStarted = false;
  let windGain = null, windLP = null;
  let windCur = 0;
  let cityTimer = 6;

  // live voices: { nodes: [..], end }
  const voices = [];
  const lastPlayed = Object.create(null);

  // ---- init ---------------------------------------------------------
  function init() {
    if (ac) return;
    const AC = (typeof window !== 'undefined') &&
      (window.AudioContext || window.webkitAudioContext);
    if (!AC) return;
    ac = new AC();

    compressor = ac.createDynamicsCompressor();
    try {
      compressor.threshold.value = -18;
      compressor.knee.value = 22;
      compressor.ratio.value = 6;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.25;
    } catch (e) { /* older impls */ }
    compressor.connect(ac.destination);

    masterLP = ac.createBiquadFilter();
    masterLP.type = 'lowpass';
    masterLP.frequency.value = lpCur;
    masterLP.Q.value = 0.4;
    masterLP.connect(compressor);

    master = ac.createGain();
    master.gain.value = 0.9;
    master.connect(masterLP);

    // Echo bus: one 90ms tap, darkened (street canyon slap-back).
    echoIn = ac.createGain();
    echoIn.gain.value = 1;
    const dl = ac.createDelay(0.5);
    dl.delayTime.value = 0.09;
    const elp = ac.createBiquadFilter();
    elp.type = 'lowpass'; elp.frequency.value = 2200;
    const eg = ac.createGain();
    eg.gain.value = 0.32;
    echoIn.connect(dl); dl.connect(elp); elp.connect(eg); eg.connect(master);

    // Shared white noise buffer (1.5s).
    const sr = ac.sampleRate;
    noiseBuf = ac.createBuffer(1, Math.floor(sr * 1.5), sr);
    const nd = noiseBuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

    // Brown noise buffer for wind (3s, leaky integrator).
    brownBuf = ac.createBuffer(1, Math.floor(sr * 3), sr);
    const bd = brownBuf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < bd.length; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      bd[i] = last * 3.2;
    }

    ready = true;
  }

  function running() { return ready && ac && ac.state === 'running'; }
  // Slow-mo pitch: sounds triggered during slow motion play lower/slower.
  function pMul() {
    const ts = (ctx && typeof ctx.timeScale === 'number') ? ctx.timeScale : 1;
    return ts < 1 ? 0.55 + 0.45 * Math.max(0, ts) : 1;
  }

  // ---- low-level synth helpers --------------------------------------
  // tone: osc with envelope; opts { type,f0,f1,dur,when,a,g,lp,vibF,vibA,curve }
  function tone(out, o) {
    const t = o.when, pm = pMul();
    const osc = ac.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(Math.max(1, (o.f0 || 440) * pm), t);
    if (o.f1) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1 * pm), t + o.dur);
    }
    let node = osc;
    if (o.vibF) {
      const lfo = ac.createOscillator();
      lfo.frequency.value = o.vibF;
      const lg = ac.createGain();
      lg.gain.value = o.vibA || 10;
      lfo.connect(lg); lg.connect(osc.frequency);
      lfo.start(t); lfo.stop(t + o.dur + 0.03);
    }
    if (o.lp) {
      const f = ac.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = o.lp; f.Q.value = 0.7;
      node.connect(f); node = f;
    }
    const e = ac.createGain();
    e.gain.setValueAtTime(0.0001, t);
    e.gain.linearRampToValueAtTime(o.g || 0.5, t + (o.a || 0.005));
    e.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    node.connect(e); e.connect(out);
    osc.start(t); osc.stop(t + o.dur + 0.03);
    return osc;
  }

  // noise: shared-buffer noise thru filter + env;
  // opts { dur,when,type,freq,f1,q,a,g }
  function noise(out, o) {
    const t = o.when;
    const s = ac.createBufferSource();
    s.buffer = noiseBuf; s.loop = true;
    s.playbackRate.value = (0.75 + Math.random() * 0.5) * pMul();
    const f = ac.createBiquadFilter();
    f.type = o.type || 'lowpass';
    f.Q.value = o.q || 0.9;
    f.frequency.setValueAtTime(Math.max(20, o.freq || 1000), t);
    if (o.f1) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t + o.dur);
    const e = ac.createGain();
    e.gain.setValueAtTime(0.0001, t);
    e.gain.linearRampToValueAtTime(o.g || 0.5, t + (o.a || 0.004));
    e.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    s.connect(f); f.connect(e); e.connect(out);
    s.start(t, Math.random() * 1.2);
    s.stop(t + o.dur + 0.03);
    return s;
  }

  // ---- sound recipes: fn(out, intensity, when) -> total duration -----
  const RECIPES = {
    whoosh(out, i, t) {
      const dur = 0.26 + 0.16 * Math.min(1.5, i);
      const s = ac.createBufferSource();
      s.buffer = noiseBuf; s.loop = true;
      s.playbackRate.value = 0.8 + Math.random() * 0.4;
      const f = ac.createBiquadFilter();
      f.type = 'bandpass'; f.Q.value = 1.4;
      f.frequency.setValueAtTime(260, t);
      f.frequency.exponentialRampToValueAtTime(550 + 1500 * Math.min(2, i), t + dur * 0.42);
      f.frequency.exponentialRampToValueAtTime(230, t + dur);
      const e = ac.createGain();
      e.gain.setValueAtTime(0.0001, t);
      e.gain.linearRampToValueAtTime(0.55 * Math.min(1.4, i), t + dur * 0.3);
      e.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(f); f.connect(e); e.connect(out);
      s.start(t, Math.random()); s.stop(t + dur + 0.03);
      return dur;
    },

    thud(out, i, t) {
      const ii = Math.min(1.6, i);
      tone(out, { type: 'sine', f0: 82, f1: 40, dur: 0.2 + 0.06 * ii, when: t, g: 0.95 * ii, a: 0.004 });
      noise(out, { dur: 0.08, when: t, freq: 420, f1: 120, g: 0.45 * ii, q: 0.6 });
      return 0.3;
    },

    clang(out, i, t) {
      const ii = Math.min(1.4, i);
      const base = 400 + Math.random() * 180;
      const ratios = [1, 2.32, 3.61, 5.04];
      const gains = [0.22, 0.15, 0.1, 0.06];
      const durs = [0.55, 0.42, 0.3, 0.2];
      for (let k = 0; k < 4; k++) {
        tone(out, {
          type: 'square', dur: durs[k], when: t, g: gains[k] * ii, a: 0.002,
          f0: base * ratios[k] * (1 + (Math.random() - 0.5) * 0.012),
          lp: 5200,
        });
      }
      noise(out, { dur: 0.05, when: t, type: 'highpass', freq: 2500, g: 0.2 * ii });
      return 0.6;
    },

    splat(out, i, t) {
      const ii = Math.min(1.7, i);
      noise(out, { dur: 0.17, when: t, freq: 750, f1: 160, g: 0.75 * ii, q: 0.7 });
      tone(out, { type: 'sine', f0: 280, f1: 55, dur: 0.13, when: t, g: 0.5 * ii, a: 0.003 });
      return 0.22;
    },

    splash(out, i, t) {
      const ii = Math.min(1.5, i);
      noise(out, { dur: 0.55, when: t, freq: 1500, f1: 420, g: 0.6 * ii, q: 0.8, a: 0.01 });
      noise(out, { dur: 0.12, when: t, freq: 500, f1: 140, g: 0.5 * ii, q: 0.6 });
      for (let k = 0; k < 6; k++) { // sparkle droplets
        tone(out, {
          type: 'sine', f0: 1900 + Math.random() * 2600, dur: 0.035 + Math.random() * 0.04,
          when: t + 0.06 + Math.random() * 0.38, g: 0.09 * ii, a: 0.003,
        });
      }
      return 0.62;
    },

    shatter(out, i, t) {
      const ii = Math.min(1.4, i);
      noise(out, { dur: 0.1, when: t, type: 'highpass', freq: 2800, g: 0.4 * ii });
      const n = 8 + (Math.random() * 4) | 0;
      for (let k = 0; k < n; k++) {
        tone(out, {
          type: 'triangle', f0: 1700 + Math.random() * 4300,
          dur: 0.05 + Math.random() * 0.07, when: t + Math.random() * 0.22,
          g: 0.15 * ii, a: 0.002,
        });
      }
      return 0.42;
    },

    bounce(out, i, t) {
      const ii = Math.min(1.3, Math.max(0.15, i));
      const f = 150 + 380 * ii;
      tone(out, { type: 'sine', f0: f * 1.35, f1: f * 0.7, dur: 0.09, when: t, g: 0.5 * ii, a: 0.003 });
      return 0.11;
    },

    squeak(out, i, t) {
      const ii = Math.min(1.3, i);
      tone(out, { type: 'sawtooth', f0: 340, f1: 920, dur: 0.11, when: t, g: 0.3 * ii, a: 0.008, lp: 2600, vibF: 30, vibA: 25 });
      tone(out, { type: 'sawtooth', f0: 430, f1: 1180, dur: 0.1, when: t + 0.13, g: 0.28 * ii, a: 0.008, lp: 2800, vibF: 34, vibA: 30 });
      return 0.26;
    },

    ding(out, i, t) {
      const ii = Math.min(1.3, i);
      tone(out, { type: 'sine', f0: 1318, dur: 0.5, when: t, g: 0.4 * ii, a: 0.002 });
      tone(out, { type: 'sine', f0: 1318 * 2.42, dur: 0.28, when: t, g: 0.11 * ii, a: 0.002 });
      return 0.52;
    },

    ring(out, i, t) { // alarm bell: rapid AM square, ~1.2s
      const ii = Math.min(1.2, i);
      const dur = 1.2;
      const o1 = ac.createOscillator(); o1.type = 'square'; o1.frequency.value = 1060 * pMul();
      const o2 = ac.createOscillator(); o2.type = 'square'; o2.frequency.value = 1410 * pMul();
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 4200;
      const e = ac.createGain();
      e.gain.setValueAtTime(0.0001, t);
      e.gain.linearRampToValueAtTime(0.16 * ii, t + 0.015);
      e.gain.setValueAtTime(0.16 * ii, t + dur - 0.12);
      e.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      // AM hammer via square LFO
      const lfo = ac.createOscillator(); lfo.type = 'square';
      lfo.frequency.value = 23 * pMul();
      const lg = ac.createGain(); lg.gain.value = 0.14 * ii;
      lfo.connect(lg); lg.connect(e.gain);
      const g2 = ac.createGain(); g2.gain.value = 0.4;
      o1.connect(lp); o2.connect(g2); g2.connect(lp); lp.connect(e); e.connect(out);
      o1.start(t); o2.start(t); lfo.start(t);
      o1.stop(t + dur + 0.02); o2.stop(t + dur + 0.02); lfo.stop(t + dur + 0.02);
      return dur;
    },

    pop(out, i, t) {
      const ii = Math.min(1.4, i);
      tone(out, { type: 'sine', f0: 520, f1: 150, dur: 0.07, when: t, g: 0.55 * ii, a: 0.002 });
      noise(out, { dur: 0.03, when: t, type: 'bandpass', freq: 1600, q: 1.2, g: 0.25 * ii });
      return 0.09;
    },

    grab(out, i, t) { // soft tactile click
      noise(out, { dur: 0.028, when: t, type: 'bandpass', freq: 2100, q: 2, g: 0.22 });
      tone(out, { type: 'sine', f0: 320, f1: 210, dur: 0.045, when: t, g: 0.16, a: 0.002 });
      return 0.06;
    },

    throw(out, i, t) { // short punchy whoosh
      noise(out, { dur: 0.16, when: t, type: 'bandpass', freq: 480, f1: 1500, q: 1.2, g: 0.42 * Math.min(1.3, i), a: 0.006 });
      return 0.18;
    },

    combo(out, i, t) { // rising pentatonic arpeggio, longer with combo level
      const steps = Math.max(2, Math.min(6, 1 + Math.round(i)));
      const ratios = [1, 1.125, 1.25, 1.5, 1.6875, 2];
      for (let k = 0; k < steps; k++) {
        const w = t + k * 0.07;
        const f = 523 * ratios[k];
        tone(out, { type: 'triangle', f0: f, dur: 0.1, when: w, g: 0.32, a: 0.004 });
        tone(out, { type: 'square', f0: f, dur: 0.08, when: w, g: 0.07, a: 0.004, lp: 3000 });
      }
      return steps * 0.07 + 0.15;
    },

    fanfare(out, i, t) { // 3-note major triad for the big ones
      const notes = [523.25, 659.25, 783.99];
      for (let k = 0; k < 3; k++) {
        const w = t + k * 0.13;
        const dur = k === 2 ? 0.55 : 0.14;
        tone(out, { type: 'triangle', f0: notes[k], dur, when: w, g: 0.34, a: 0.005 });
        tone(out, { type: 'square', f0: notes[k], dur, when: w, g: 0.09, a: 0.005, lp: 3200 });
      }
      tone(out, { type: 'triangle', f0: 1046.5, dur: 0.55, when: t + 0.26, g: 0.16, a: 0.005 });
      return 0.95;
    },

    rocket(out, i, t) { // filtered sawtooth roar, 1.6s
      const ii = Math.min(1.3, i);
      const dur = 1.6;
      const o1 = ac.createOscillator(); o1.type = 'sawtooth';
      o1.frequency.setValueAtTime(46 * pMul(), t);
      o1.frequency.exponentialRampToValueAtTime(74 * pMul(), t + dur);
      const o2 = ac.createOscillator(); o2.type = 'sawtooth';
      o2.frequency.setValueAtTime(52 * pMul(), t);
      o2.frequency.exponentialRampToValueAtTime(81 * pMul(), t + dur);
      const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 1.1;
      f.frequency.setValueAtTime(240, t);
      f.frequency.exponentialRampToValueAtTime(950, t + dur * 0.35);
      f.frequency.exponentialRampToValueAtTime(280, t + dur);
      const e = ac.createGain();
      e.gain.setValueAtTime(0.0001, t);
      e.gain.linearRampToValueAtTime(0.5 * ii, t + 0.14);
      e.gain.setValueAtTime(0.5 * ii, t + dur - 0.45);
      e.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o1.connect(f); o2.connect(f); f.connect(e); e.connect(out);
      o1.start(t); o2.start(t); o1.stop(t + dur + 0.02); o2.stop(t + dur + 0.02);
      noise(out, { dur, when: t, freq: 900, f1: 350, g: 0.3 * ii, a: 0.12, q: 0.6 });
      return dur;
    },

    whistle(out, i, t) { // falling-bomb glissando 1400 -> 400 Hz, ~1s
      const ii = Math.min(1.4, Math.max(0.3, i));
      tone(out, { type: 'sine', f0: 1400, f1: 400, dur: 1.0, when: t, g: 0.4 * ii, a: 0.05, vibF: 9, vibA: 28 });
      tone(out, { type: 'triangle', f0: 1410, f1: 405, dur: 1.0, when: t, g: 0.1 * ii, a: 0.05 });
      return 1.02;
    },

    // ---- ambience-only internals ----
    honk(out, i, t) {
      const base = 290 + Math.random() * 130;
      const n = Math.random() < 0.35 ? 2 : 1;
      for (let k = 0; k < n; k++) {
        const w = t + k * 0.3;
        tone(out, { type: 'square', f0: base, dur: 0.16 + Math.random() * 0.14, when: w, g: 0.3, a: 0.01, lp: 900 });
        tone(out, { type: 'square', f0: base * 1.26, dur: 0.15 + Math.random() * 0.12, when: w, g: 0.22, a: 0.01, lp: 900 });
      }
      return 0.9;
    },

    rumble(out, i, t) {
      tone(out, { type: 'sine', f0: 40 + Math.random() * 22, dur: 2.4, when: t, g: 0.55, a: 0.9 });
      noise(out, { dur: 2.4, when: t, freq: 110, g: 0.25, a: 0.8, q: 0.5 });
      return 2.5;
    },
  };

  // ---- voice chain + positional routing ------------------------------
  function playAt(name, d, pan, intensity) {
    const fn = RECIPES[name];
    if (!fn) return;
    const now = ac.currentTime;
    // Voice cap FIRST: a sound rejected for lack of voices must not arm the
    // throttle, or retrigger loops (anvil whistle, alarm ring) drop out for a
    // full throttle window after a momentary voice-pool spike.
    if (voices.length >= MAX_VOICES) return;
    const th = THROTTLE[name];
    if (th !== undefined) {
      const lp0 = lastPlayed[name];
      if (lp0 !== undefined && now - lp0 < th) return;
      lastPlayed[name] = now;
    }
    const g = ac.createGain();
    g.gain.value = (BASE_GAIN[name] || 0.5) * (1 / (1 + d * 0.06));
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.max(300, 18000 / (1 + d * 0.12));
    lp.Q.value = 0.5;
    g.connect(lp);
    let tail = lp, pn = null;
    if (ac.createStereoPanner) {
      pn = ac.createStereoPanner();
      pn.pan.value = Math.max(-0.85, Math.min(0.85, pan || 0));
      lp.connect(pn); tail = pn;
    }
    tail.connect(master);
    if (d > 15) tail.connect(echoIn); // street-canyon slap echo
    const dur = fn(g, intensity, now) || 1;
    voices.push({ g, lp, pn, end: now + dur + 0.15 });
  }

  function play(name, opts) {
    try {
      if (!running() || typeof name !== 'string') return;
      let intensity = 1, d = 0, pan = 0;
      if (opts) {
        const iv = opts.intensity;
        if (typeof iv === 'number' && isFinite(iv)) {
          intensity = Math.max(0.05, Math.min(2.5, iv));
        }
        const p = opts.position;
        if (p && typeof p.x === 'number' && isFinite(p.x) && ctx && ctx.camera) {
          try {
            ctx.camera.getWorldPosition(_camPos);
            _dir.set(p.x - _camPos.x, p.y - _camPos.y, p.z - _camPos.z);
            d = _dir.length();
            if (!isFinite(d)) d = 0;
            ctx.camera.getWorldQuaternion(_q);
            _q.invert();
            _dir.applyQuaternion(_q);
            const ax = Math.abs(_dir.x), az = Math.abs(_dir.z);
            pan = (ax + az) > 0.001 ? _dir.x / (ax + az) : 0;
          } catch (e) { d = 0; pan = 0; }
        }
      }
      playAt(name, d, pan, intensity);
    } catch (e) { /* audio must never crash the game */ }
  }

  // ---- ambience -------------------------------------------------------
  function startAmbience() {
    try {
      if (ambStarted || !ready) return;
      ambStarted = true;
      // Wind: looped brown noise, slow-wandering lowpass, gain tied to ctx.wind.
      const s = ac.createBufferSource();
      s.buffer = brownBuf; s.loop = true;
      windLP = ac.createBiquadFilter();
      windLP.type = 'lowpass'; windLP.frequency.value = 380; windLP.Q.value = 0.7;
      const lfo = ac.createOscillator();
      lfo.frequency.value = 0.13;
      const lg = ac.createGain(); lg.gain.value = 130;
      lfo.connect(lg); lg.connect(windLP.frequency);
      windGain = ac.createGain(); windGain.gain.value = 0;
      s.connect(windLP); windLP.connect(windGain); windGain.connect(master);
      s.start(); lfo.start();
      cityTimer = 4 + Math.random() * 6;
    } catch (e) { ambStarted = false; }
  }

  function resume() {
    try {
      if (!ac) init();
      if (!ac) return;
      if (ac.state === 'suspended') {
        const p = ac.resume();
        if (p && p.catch) p.catch(() => {});
      }
      startAmbience();
    } catch (e) { /* no audio; game continues silent */ }
  }

  function setSlowmo(active) { manualSlowmo = !!active; }

  // Also react to the slowmo event (effects.js owns timeScale easing, but
  // this keeps the filter dip working even if effects is a stub).
  try {
    if (ctx && ctx.events && ctx.events.on) {
      ctx.events.on('slowmo', (p) => {
        const dur = (p && typeof p.duration === 'number' && isFinite(p.duration)) ? p.duration : 1.2;
        slowmoTimer = Math.max(slowmoTimer, Math.min(5, dur));
      });
    }
  } catch (e) { /* ignore */ }

  // ---- per-frame update ------------------------------------------------
  function update(dt, elapsed, rawDt) {
    if (!ready || !ac) return;
    const rdt = (typeof rawDt === 'number' && isFinite(rawDt)) ? rawDt : (dt || 0.016);
    const now = ac.currentTime;

    // sweep finished voices (disconnect so the graph stays small)
    for (let i = voices.length - 1; i >= 0; i--) {
      const v = voices[i];
      if (now >= v.end) {
        try {
          v.g.disconnect(); v.lp.disconnect();
          if (v.pn) v.pn.disconnect();
        } catch (e) { /* already gone */ }
        voices[i] = voices[voices.length - 1];
        voices.pop();
      }
    }

    // slow-mo master lowpass dip
    if (slowmoTimer > 0) slowmoTimer -= rdt;
    const ts = (ctx && typeof ctx.timeScale === 'number') ? ctx.timeScale : 1;
    const slow = manualSlowmo || slowmoTimer > 0 || ts < 0.85;
    const lpTarget = slow ? 500 : 19000;
    lpCur += (lpTarget - lpCur) * Math.min(1, rdt * 9);
    if (masterLP) masterLP.frequency.value = lpCur;

    if (!ambStarted || ac.state !== 'running') return;

    // wind gain follows ctx.wind length with gentle flutter
    let wl = 0.6;
    if (ctx && ctx.wind && typeof ctx.wind.length === 'function') {
      try { const l = ctx.wind.length(); if (isFinite(l)) wl = l; } catch (e) {}
    }
    const flutter = 0.85 + 0.1 * Math.sin(elapsed * 1.7) + 0.05 * Math.sin(elapsed * 4.3);
    const wTarget = (0.045 + Math.min(0.28, wl * 0.09)) * flutter;
    windCur += (wTarget - windCur) * Math.min(1, rdt * 2.5);
    if (windGain) windGain.gain.value = windCur;

    // sparse faint city life: distant honks & rumbles every 7-20s
    cityTimer -= rdt;
    if (cityTimer <= 0) {
      cityTimer = 7 + Math.random() * 13;
      try {
        const name = Math.random() < 0.55 ? 'honk' : 'rumble';
        // fabricate a far-away source somewhere down in the streets
        playAt(name, 24 + Math.random() * 36, (Math.random() * 2 - 1) * 0.7, 1);
      } catch (e) { /* ignore */ }
    }
  }

  return { update, play, startAmbience, resume, setSlowmo };
}
