// src/ui.js — CHUCK CITY start overlay + in-world scoreboard + desktop score chip.
//
// Contract (ARCHITECTURE.md):
//   createUI(ctx) -> { update(dt, elapsed, rawDt) }
//   - Wires #btn-vr / #btn-desktop, hides #overlay on start, resumes audio,
//     emits 'game-start' { mode: 'vr' | 'desktop' }.
//   - In-world scoreboard billboard at ctx.world.scoreboardAnchor (canvas
//     texture), redrawn ONLY on 'score' events, flash pulse in update().
//   - Desktop DOM score chip top-right (hidden in VR).

import * as THREE from 'three';
import { ROOF_Y } from './constants.js';

// ---------------------------------------------------------------------------
// Palette (matches the title screen: dark navy panel, amber gradient accents)
// ---------------------------------------------------------------------------
const COL_PANEL_TOP = '#1c2536';
const COL_PANEL_BOT = '#10151f';
const COL_AMBER = '#ffb03d';
const COL_AMBER_HI = '#ffd76a';
const COL_TEXT = '#eef3ff';
const COL_DIM = '#8fa0bf';
const FONT = "'Segoe UI', system-ui, sans-serif";

const BOARD_W = 512, BOARD_H = 256;
const PANEL_W = 1.7, PANEL_H = 0.85; // meters (2:1 like the canvas)
const MAX_PIPS = 5;

// Hoisted temps (zero per-frame allocations)
const _v = new THREE.Vector3();

export function createUI(ctx) {
  ctx = ctx || {};
  const events = ctx.events;
  const on = (name, fn) => { try { events && events.on && events.on(name, fn); } catch (e) {} };
  const emit = (name, payload) => { try { events && events.emit && events.emit(name, payload); } catch (e) {} };

  // -------------------------------------------------------------------------
  // Scoreboard state (mirrors 'score' payloads; defensive defaults)
  // -------------------------------------------------------------------------
  let total = 0;
  let combo = 1;
  let lastLabel = '';
  let lastPoints = 0;
  let flash = 0;        // 0..1 emissive/scale pulse, decays in update()
  let chipPop = 0;      // 0..1 DOM chip pop timer
  let lastChipScale = 1; // last transform actually written to the DOM
  let started = false;

  // -------------------------------------------------------------------------
  // DOM: start overlay buttons
  // -------------------------------------------------------------------------
  const overlay = document.getElementById('overlay');
  const btnVR = document.getElementById('btn-vr');
  const btnDesktop = document.getElementById('btn-desktop');

  function hideOverlay() { if (overlay) overlay.classList.add('hidden'); }
  function showOverlay() { if (overlay) overlay.classList.remove('hidden'); }

  function wakeAudio() {
    const a = ctx.audio;
    try { a && a.resume && a.resume(); } catch (e) {}
    try { a && a.startAmbience && a.startAmbience(); } catch (e) {}
  }

  function startGame(mode) {
    started = true;
    hideOverlay();
    wakeAudio();
    emit('game-start', { mode });
  }

  // --- VR button -------------------------------------------------------------
  let vrSupported = false;
  function disableVR(label) {
    if (!btnVR) return;
    btnVR.disabled = true;
    btnVR.textContent = label || 'VR not available here';
  }

  if (btnVR) {
    if (navigator.xr && navigator.xr.isSessionSupported) {
      try {
        navigator.xr.isSessionSupported('immersive-vr').then((ok) => {
          vrSupported = !!ok;
          if (!vrSupported) disableVR('VR not available here');
        }).catch(() => disableVR('VR not available here'));
      } catch (e) { disableVR('VR not available here'); }
    } else {
      disableVR('VR not available here');
    }

    btnVR.addEventListener('click', () => {
      if (!vrSupported || !navigator.xr || !navigator.xr.requestSession) return;
      btnVR.disabled = true;
      btnVR.textContent = 'Starting…';
      navigator.xr.requestSession('immersive-vr', {
        optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
      }).then((session) => {
        try {
          if (ctx.renderer && ctx.renderer.xr && ctx.renderer.xr.setSession) {
            ctx.renderer.xr.setSession(session);
          }
        } catch (e) { console.error('[ui] setSession', e); }
        if (chip) chip.style.display = 'none';
        startGame('vr');
        btnVR.disabled = false;
        btnVR.textContent = 'Re-enter VR';
      }).catch((err) => {
        console.warn('[ui] requestSession failed', err);
        btnVR.disabled = false;
        btnVR.textContent = 'Enter VR';
      });
    });
  }

  // --- Desktop button ----------------------------------------------------------
  if (btnDesktop) {
    btnDesktop.addEventListener('click', () => {
      if (chip) { chip.style.display = 'block'; updateChip(); }
      startGame('desktop');
    });
  }

  // --- Re-show overlay when the XR session ends -------------------------------
  try {
    if (ctx.renderer && ctx.renderer.xr && ctx.renderer.xr.addEventListener) {
      ctx.renderer.xr.addEventListener('sessionend', () => {
        showOverlay();
        if (chip) chip.style.display = 'none';
      });
    }
  } catch (e) {}

  // -------------------------------------------------------------------------
  // Desktop score chip (top-right), styled to match the title screen
  // -------------------------------------------------------------------------
  let chip = null, chipScore = null, chipCombo = null;
  try {
    chip = document.createElement('div');
    chip.id = 'score-chip';
    chip.style.cssText =
      'position:fixed;top:14px;right:16px;z-index:15;display:none;' +
      'padding:10px 18px 12px;border-radius:14px;text-align:right;' +
      'background:linear-gradient(180deg,rgba(28,37,54,.92),rgba(16,21,31,.92));' +
      'border:1px solid rgba(255,176,61,.45);' +
      'box-shadow:0 4px 18px rgba(0,0,0,.35);' +
      'font-family:' + FONT + ';color:' + COL_TEXT + ';user-select:none;' +
      'pointer-events:none;will-change:transform;';
    const label = document.createElement('div');
    label.textContent = 'SCORE';
    label.style.cssText =
      'font:700 11px/1 ' + FONT + ';letter-spacing:.22em;color:' + COL_AMBER + ';opacity:.9;';
    chipScore = document.createElement('div');
    chipScore.textContent = '0';
    chipScore.style.cssText =
      'font:900 30px/1.15 ' + FONT + ';font-style:italic;' +
      'background:linear-gradient(180deg,' + COL_AMBER_HI + ',' + COL_AMBER + ');' +
      '-webkit-background-clip:text;background-clip:text;color:transparent;';
    chipCombo = document.createElement('div');
    chipCombo.textContent = '';
    chipCombo.style.cssText = 'font:700 12px/1.3 ' + FONT + ';color:' + COL_DIM + ';min-height:14px;';
    chip.appendChild(label);
    chip.appendChild(chipScore);
    chip.appendChild(chipCombo);
    document.body.appendChild(chip);
  } catch (e) { chip = null; }

  function updateChip() {
    if (!chipScore) return;
    chipScore.textContent = fmt(total);
    if (chipCombo) {
      chipCombo.textContent = combo >= 2 ? ('COMBO ×' + combo + (lastLabel ? ' · ' + lastLabel : '')) : (lastLabel || '');
      chipCombo.style.color = combo >= 2 ? COL_AMBER : COL_DIM;
    }
  }

  function fmt(n) {
    n = Math.floor(n);
    let s = String(n), out = '';
    while (s.length > 3) { out = ',' + s.slice(-3) + out; s = s.slice(0, -3); }
    return s + out;
  }

  // -------------------------------------------------------------------------
  // In-world scoreboard: 512x256 canvas texture on a framed panel
  // -------------------------------------------------------------------------
  let boardGroup = null, board2d = null, boardTex = null, glowMat = null, faceMat = null;

  try {
    const canvas = document.createElement('canvas');
    canvas.width = BOARD_W; canvas.height = BOARD_H;
    board2d = canvas.getContext('2d');

    boardTex = new THREE.CanvasTexture(canvas);
    if ('colorSpace' in boardTex) boardTex.colorSpace = THREE.SRGBColorSpace;
    boardTex.minFilter = THREE.LinearFilter;
    boardTex.magFilter = THREE.LinearFilter;
    boardTex.generateMipmaps = false;

    boardGroup = new THREE.Group();

    // Dark backing slab (visible from behind / edges)
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(PANEL_W + 0.1, PANEL_H + 0.1, 0.05),
      new THREE.MeshLambertMaterial({ color: 0x1a2230 })
    );
    boardGroup.add(slab);

    // Amber glow halo behind the slab — the "emissive flash" on score
    glowMat = new THREE.MeshBasicMaterial({
      color: 0xffb03d, transparent: true, opacity: 0.0, depthWrite: false,
    });
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W + 0.34, PANEL_H + 0.34), glowMat);
    glow.position.z = -0.03;
    boardGroup.add(glow);

    // Canvas face (unlit so it reads crisply at any sun angle)
    faceMat = new THREE.MeshBasicMaterial({ map: boardTex, toneMapped: false });
    const face = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W, PANEL_H), faceMat);
    face.position.z = 0.028;
    boardGroup.add(face);

    // Mount: prefer world anchor, else fall back near the parapet edge
    const anchor = ctx.world && ctx.world.scoreboardAnchor;
    if (anchor && anchor.isObject3D) {
      anchor.add(boardGroup);
    } else if (ctx.scene && ctx.scene.add) {
      boardGroup.position.set(-6, ROOF_Y + 2.5, -6.5);
      _v.set(0, ROOF_Y + 1.6, 0);
      boardGroup.lookAt(_v);
      ctx.scene.add(boardGroup);
    }

    drawBoard();
  } catch (e) {
    console.warn('[ui] scoreboard init failed', e);
    boardGroup = null;
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  // Redraws the canvas. Called once at init + on 'score' events (coalesced
  // in update() to at most one redraw per 100ms).
  function drawBoard() {
    const c = board2d;
    if (!c) return;
    c.clearRect(0, 0, BOARD_W, BOARD_H);

    // Panel
    const g = c.createLinearGradient(0, 0, 0, BOARD_H);
    g.addColorStop(0, COL_PANEL_TOP);
    g.addColorStop(1, COL_PANEL_BOT);
    roundRect(c, 5, 5, BOARD_W - 10, BOARD_H - 10, 24);
    c.fillStyle = g;
    c.fill();
    c.lineWidth = 4;
    c.strokeStyle = COL_AMBER;
    c.stroke();

    // Header
    c.textBaseline = 'alphabetic';
    c.textAlign = 'left';
    c.fillStyle = COL_AMBER;
    c.font = '700 24px ' + FONT;
    c.fillText('S C O R E', 34, 48);

    // Combo tag, top-right
    c.textAlign = 'right';
    if (combo >= 2) {
      c.fillStyle = COL_AMBER_HI;
      c.font = 'italic 900 30px ' + FONT;
      c.fillText('×' + combo, BOARD_W - 34, 50);
    } else {
      c.fillStyle = COL_DIM;
      c.font = '700 18px ' + FONT;
      c.fillText('CHUCK CITY', BOARD_W - 34, 46);
    }

    // Big score — glow faked with offset translucent passes (canvas
    // shadowBlur is far too expensive to re-raster during combo chains)
    c.textAlign = 'center';
    c.font = 'italic 900 92px ' + FONT;
    const scoreTxt = fmt(total);
    c.fillStyle = 'rgba(255,170,60,0.22)';
    c.fillText(scoreTxt, BOARD_W / 2 - 3, 148);
    c.fillText(scoreTxt, BOARD_W / 2 + 3, 148);
    c.fillText(scoreTxt, BOARD_W / 2, 145);
    c.fillText(scoreTxt, BOARD_W / 2, 151);
    const grad = c.createLinearGradient(0, 62, 0, 150);
    grad.addColorStop(0, COL_AMBER_HI);
    grad.addColorStop(1, COL_AMBER);
    c.fillStyle = grad;
    c.fillText(scoreTxt, BOARD_W / 2, 148);

    // Combo pips (bottom-left)
    const pipY = 200, pipR = 9, pipGap = 30, pipX0 = 46;
    const lit = Math.max(0, Math.min(MAX_PIPS, (combo | 0)));
    for (let i = 0; i < MAX_PIPS; i++) {
      if (i < lit) {
        // glow halo without shadowBlur: translucent disc under the pip
        c.beginPath();
        c.arc(pipX0 + i * pipGap, pipY, pipR + 4, 0, Math.PI * 2);
        c.fillStyle = 'rgba(255,176,61,0.3)';
        c.fill();
        c.beginPath();
        c.arc(pipX0 + i * pipGap, pipY, pipR, 0, Math.PI * 2);
        c.fillStyle = COL_AMBER;
        c.fill();
      } else {
        c.beginPath();
        c.arc(pipX0 + i * pipGap, pipY, pipR, 0, Math.PI * 2);
        c.fillStyle = 'rgba(143,160,191,0.22)';
        c.fill();
      }
    }

    // Last hit label (bottom-right)
    c.textAlign = 'right';
    if (lastLabel || lastPoints) {
      c.fillStyle = COL_TEXT;
      c.font = 'italic 800 27px ' + FONT;
      const txt = (lastLabel ? lastLabel + '  ' : '') + (lastPoints ? '+' + fmt(lastPoints) : '');
      c.fillText(txt, BOARD_W - 34, 210);
    } else {
      c.fillStyle = COL_DIM;
      c.font = '600 20px ' + FONT;
      c.fillText('throw something!', BOARD_W - 34, 208);
    }

    if (boardTex) boardTex.needsUpdate = true;
  }

  // -------------------------------------------------------------------------
  // Score events → mark board dirty (redraw coalesced to <=1 per 100ms in
  // update(), so combo chains don't re-raster + re-upload every hit), kick
  // the flash pulse.
  // -------------------------------------------------------------------------
  let boardDirty = false;
  let boardCool = 0;

  on('score', (p) => {
    try {
      if (p && typeof p === 'object') {
        if (typeof p.total === 'number' && isFinite(p.total)) total = p.total;
        else if (typeof p.points === 'number' && isFinite(p.points)) total += p.points;
        combo = (typeof p.combo === 'number' && isFinite(p.combo)) ? Math.max(1, p.combo | 0) : 1;
        lastPoints = (typeof p.points === 'number' && isFinite(p.points)) ? p.points : 0;
        lastLabel = (typeof p.label === 'string') ? p.label : '';
      }
      flash = 1;
      chipPop = 1;
      boardDirty = true;
    } catch (e) { console.warn('[ui] score handler', e); }
  });

  // -------------------------------------------------------------------------
  // update — flash/pop decay only (no canvas redraws, no allocations)
  // -------------------------------------------------------------------------
  function update(dt, elapsed, rawDt) {
    const step = (typeof rawDt === 'number' && isFinite(rawDt)) ? rawDt
      : ((typeof dt === 'number' && isFinite(dt)) ? dt : 0.016);

    if (boardCool > 0) boardCool -= step;
    if (boardDirty && boardCool <= 0) {
      boardDirty = false;
      boardCool = 0.1;
      try { drawBoard(); updateChip(); } catch (e) { /* defensive */ }
    }

    if (flash > 0.001) {
      flash = Math.max(0, flash - step * 2.6);
      if (glowMat) glowMat.opacity = flash * 0.85;
      if (boardGroup) {
        const s = 1 + flash * flash * 0.07;
        boardGroup.scale.set(s, s, s);
      }
    } else if (flash !== 0) {
      flash = 0;
      if (glowMat) glowMat.opacity = 0;
      if (boardGroup) boardGroup.scale.set(1, 1, 1);
    }

    if (chipPop > 0.001) {
      chipPop = Math.max(0, chipPop - step * 4);
      if (chip && chip.style.display !== 'none') {
        // quantize so the DOM (compositor work) is only touched on change
        const cs = Math.round((1 + chipPop * chipPop * 0.12) * 100) / 100;
        if (cs !== lastChipScale) {
          lastChipScale = cs;
          chip.style.transform = 'scale(' + cs + ')';
          chip.style.transformOrigin = 'top right';
        }
      }
    } else if (chipPop !== 0) {
      chipPop = 0;
      lastChipScale = 1;
      if (chip) chip.style.transform = 'scale(1)';
    }
  }

  return {
    update,
    get score() { return total; },
    get started() { return started; },
  };
}
