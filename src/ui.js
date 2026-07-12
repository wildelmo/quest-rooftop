// src/ui.js — CHUCK CITY start overlay.
//
// Contract (ARCHITECTURE.md):
//   createUI(ctx) -> { update(dt, elapsed, rawDt) }
//   - Wires #btn-vr / #btn-desktop, hides #overlay on start, resumes audio,
//     emits 'game-start' { mode: 'vr' | 'desktop' }.
//
// It's a sandbox: no scoreboard, no score chip — the city below is the UI.

export function createUI(ctx) {
  ctx = ctx || {};
  const events = ctx.events;
  const emit = (name, payload) => { try { events && events.emit && events.emit(name, payload); } catch (e) {} };

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
    btnDesktop.addEventListener('click', () => startGame('desktop'));
  }

  // --- Re-show overlay when the XR session ends -------------------------------
  try {
    if (ctx.renderer && ctx.renderer.xr && ctx.renderer.xr.addEventListener) {
      ctx.renderer.xr.addEventListener('sessionend', showOverlay);
    }
  } catch (e) {}

  return {
    update() {},
    get started() { return started; },
  };
}
