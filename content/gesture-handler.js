/**
 * gesture-handler.js — AFK Chrome Extension
 *
 * Gestures (PRD):
 *   Cursor        — index fingertip position (continuous)
 *   Click         — pinch index + middle (brief tap)
 *   Select & Drag — pinch index + middle, hold > 200ms, move, release
 *   Scroll        — index + middle extended, flick up/down/left/right
 *   Zoom in/out   — open palm / close fist (whole hand)
 *   Tab switch    — double pinch, hold + drag left/right, release
 *   Back/Forward  — whole palm swipe left/right (fingers extended, fast)
 */

(() => {
  if (window.__afkGestureHandler) return;
  window.__afkGestureHandler = true;

  // ── Thresholds ────────────────────────────────────────────────────────────
  const PINCH_THRESHOLD      = 0.065; // index-middle tip distance to count as pinch
  const DRAG_HOLD_MS         = 220;   // hold pinch this long → drag instead of click
  const DOUBLE_PINCH_GAP_MS  = 380;   // max gap between two pinches for double-pinch
  const FLICK_MIN_DIST       = 0.09;  // min normalized distance for a flick
  const FLICK_MAX_MS         = 380;   // flick must complete within this time
  const PALM_SWIPE_MIN_DIST  = 0.20;  // palm must travel this far for back/forward
  const PALM_SWIPE_MAX_MS    = 500;
  const ZOOM_OPEN_THRESHOLD  = 0.30;  // palm spread > this → zoom in
  const ZOOM_CLOSE_THRESHOLD = 0.12;  // palm spread < this → zoom out
  const ZOOM_COOLDOWN_MS     = 800;   // zoom fires at most once per this interval
  const GESTURE_COOLDOWN_MS  = 350;   // general cooldown between discrete gestures
  const FRAME_INTERVAL_MS    = 42;    // ~24fps for popup feed

  // ── State ─────────────────────────────────────────────────────────────────
  let enabled        = false;
  let gestureEnabled = true;
  let running        = false;
  let videoEl        = null;
  let handsModel     = null;
  let animFrame      = null;
  let lastGestureAt  = 0;
  let lastZoomAt     = 0;
  let lastFrameAt    = 0;
  let latestLandmarks = [];

  // Pinch / drag / double-pinch
  let pinching           = false;
  let pinchStart         = null;   // { time, x, y }
  let dragging           = false;
  let dragTimer          = null;
  let lastPinchEndTime   = 0;
  let doublePinchPending = false;
  let doublePinchStartX  = 0;

  // Flick (scroll)
  let flickStart = null;  // { time, x, y } — midpoint of index+middle

  // Palm swipe (back/forward)
  let palmSwipeStart = null;  // { time, x } — wrist x position

  // Zoom hysteresis — prevent rapid toggling
  let lastZoomState = null; // "open" | "closed" | null

  // Offscreen canvas for popup feed
  const offscreen = document.createElement("canvas");
  offscreen.width  = 280;
  offscreen.height = 210;
  const offCtx = offscreen.getContext("2d");

  // ── Storage sync ──────────────────────────────────────────────────────────
  chrome.storage.sync.get(["afkEnabled", "gestureEnabled"], (s) => {
    enabled        = !!s.afkEnabled;
    gestureEnabled = s.gestureEnabled !== false;
    if (enabled && gestureEnabled) start();
  });

  chrome.storage.onChanged.addListener((changes) => {
    if ("afkEnabled"     in changes) enabled        = changes.afkEnabled.newValue;
    if ("gestureEnabled" in changes) gestureEnabled = changes.gestureEnabled.newValue;
    (enabled && gestureEnabled) ? start() : stop();
  });

  // ── Start / Stop ──────────────────────────────────────────────────────────
  async function start() {
    if (running) return;
    running = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: "user" }, audio: false
      });
      videoEl = document.createElement("video");
      videoEl.srcObject = stream;
      videoEl.setAttribute("playsinline", "");
      videoEl.style.cssText = "position:fixed;opacity:0;pointer-events:none;width:1px;height:1px;top:0;left:0;z-index:-1;";
      document.body.appendChild(videoEl);
      await videoEl.play();

      emit("afk:hud", { type: "camera-active", payload: true });
      safeSend({ type: "CAMERA_STATE", payload: true });

      await loadScript("https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/hands.js");

      handsModel = new window.Hands({
        locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/${f}`
      });
      handsModel.setOptions({
        maxNumHands: 1,
        modelComplexity: 1,
        minDetectionConfidence: 0.72,
        minTrackingConfidence:  0.60,
      });
      handsModel.onResults(onResults);
      processLoop();

    } catch (err) {
      console.warn("AFK gesture-handler:", err);
      running = false;
      safeSend({ type: "CAMERA_STATE", payload: false });
    }
  }

  function stop() {
    running = false;
    cancelAnimationFrame(animFrame);
    clearTimeout(dragTimer);
    if (videoEl) {
      videoEl.srcObject?.getTracks().forEach(t => t.stop());
      videoEl.remove();
      videoEl = null;
    }
    handsModel = null;
    pinching = dragging = false;
    emit("afk:hud", { type: "camera-active", payload: false });
    safeSend({ type: "CAMERA_STATE", payload: false });
  }

  // ── Frame loop ────────────────────────────────────────────────────────────
  async function processLoop() {
    if (!running || !videoEl || !handsModel) return;
    if (videoEl.readyState >= 2) {
      await handsModel.send({ image: videoEl });
      const now = Date.now();
      if (now - lastFrameAt > FRAME_INTERVAL_MS) {
        lastFrameAt = now;
        pipeFrame();
      }
    }
    animFrame = requestAnimationFrame(processLoop);
  }

  function pipeFrame() {
    if (!videoEl) return;
    try {
      offCtx.save();
      offCtx.translate(offscreen.width, 0);
      offCtx.scale(-1, 1);
      offCtx.drawImage(videoEl, 0, 0, offscreen.width, offscreen.height);
      offCtx.restore();
      safeSend({
        type: "POPUP_FRAME",
        frame: offscreen.toDataURL("image/jpeg", 0.6),
        landmarks: latestLandmarks
      });
    } catch (_) {}
  }

  // ── MediaPipe results ─────────────────────────────────────────────────────
  function onResults(results) {
    if (!enabled || !gestureEnabled) return;
    const lms = results.multiHandLandmarks?.[0];
    latestLandmarks = lms ?? [];

    if (!lms) {
      // Hand left frame — reset all tracking
      flickStart     = null;
      palmSwipeStart = null;
      lastZoomState  = null;
      if (dragging) { dragging = false; fireRaw("drag-end"); }
      return;
    }

    const wrist      = lms[0];
    const thumbTip   = lms[4];
    const indexBase  = lms[5];
    const indexMid   = lms[6];
    const indexTip   = lms[8];
    const middleBase = lms[9];
    const middleMid  = lms[10];
    const middleTip  = lms[12];
    const ringTip    = lms[16];
    const pinkyTip   = lms[20];

    // ── 1. Cursor: index fingertip (always emit) ──────────────────────────
    emit("afk:cursor", { x: 1 - indexTip.x, y: indexTip.y }); // mirror x for natural feel

    // ── 2. Classify hand state ────────────────────────────────────────────
    const pinchDist  = dist(indexTip, middleTip);
    const isPinching = pinchDist < PINCH_THRESHOLD;

    // Finger extension checks (tip must be above middle joint)
    const indexExtended  = indexTip.y  < indexMid.y  - 0.02;
    const middleExtended = middleTip.y < middleMid.y - 0.02;
    const twoFingersUp   = indexExtended && middleExtended && !isPinching;

    // Palm open: all 5 fingertips far from wrist
    const spread = palmSpread(lms);

    // ── 3. Pinch → click / drag / double-pinch tab switch ─────────────────
    if (isPinching && !pinching) {
      // ── Pinch start ──
      pinching  = true;
      const now = Date.now();
      pinchStart = { time: now, x: 1 - indexTip.x, y: indexTip.y };

      // Check double-pinch
      if (now - lastPinchEndTime < DOUBLE_PINCH_GAP_MS) {
        doublePinchPending = true;
        doublePinchStartX  = 1 - indexTip.x;
      }

      // Start drag timer
      dragTimer = setTimeout(() => {
        if (pinching && !doublePinchPending) {
          dragging = true;
          fireRaw("drag-start");
        }
      }, DRAG_HOLD_MS);

    } else if (!isPinching && pinching) {
      // ── Pinch release ──
      pinching = false;
      clearTimeout(dragTimer);
      const holdMs  = Date.now() - (pinchStart?.time ?? 0);
      const releaseX = 1 - indexTip.x;
      lastPinchEndTime = Date.now();

      if (doublePinchPending) {
        // Tab switch: direction based on drag after double-pinch
        const dx = releaseX - doublePinchStartX;
        if (Math.abs(dx) > 0.07) {
          fire(dx > 0 ? "tab-next" : "tab-prev");
        }
        doublePinchPending = false;
      } else if (dragging) {
        dragging = false;
        fireRaw("drag-end");
      } else if (holdMs < 280) {
        fire("click");
      }
      pinchStart = null;
    }

    // ── 4. Drag: emit cursor continuously while dragging ─────────────────
    if (dragging) {
      // content.js uses the continuous afk:cursor events during drag
      // to handle mousemove — no extra event needed here
    }

    // ── 5. Two-finger flick → scroll ──────────────────────────────────────
    // Only when two fingers are up and NOT pinching
    if (twoFingersUp) {
      const midX = ((1 - indexTip.x) + (1 - middleTip.x)) / 2;
      const midY = (indexTip.y + middleTip.y) / 2;

      if (!flickStart) {
        flickStart = { time: Date.now(), x: midX, y: midY };
      } else {
        const dt = Date.now() - flickStart.time;
        const dx = midX - flickStart.x;
        const dy = midY - flickStart.y;

        if (dt > FLICK_MAX_MS) {
          // Too slow — reset origin
          flickStart = { time: Date.now(), x: midX, y: midY };
        } else if (Math.abs(dy) >= FLICK_MIN_DIST && Math.abs(dy) > Math.abs(dx) * 1.2) {
          fire(dy > 0 ? "scroll-down" : "scroll-up");
          flickStart = null;
        } else if (Math.abs(dx) >= FLICK_MIN_DIST && Math.abs(dx) > Math.abs(dy) * 1.2) {
          fire(dx > 0 ? "scroll-right" : "scroll-left");
          flickStart = null;
        }
      }
    } else {
      flickStart = null;
    }

    // ── 6. Palm open/close → zoom ─────────────────────────────────────────
    // Use hysteresis to avoid rapid toggling
    const now = Date.now();
    if (now - lastZoomAt > ZOOM_COOLDOWN_MS) {
      if (spread > ZOOM_OPEN_THRESHOLD && lastZoomState !== "open") {
        lastZoomState = "open";
        lastZoomAt = now;
        fire("zoom-in");
      } else if (spread < ZOOM_CLOSE_THRESHOLD && lastZoomState !== "closed") {
        lastZoomState = "closed";
        lastZoomAt = now;
        fire("zoom-out");
      }
    }

    // ── 7. Whole palm swipe → back / forward ─────────────────────────────
    // Requires all fingers extended (open hand), fast horizontal wrist movement
    const allFingersUp = [thumbTip, indexTip, middleTip, ringTip, pinkyTip]
      .every(tip => tip.y < wrist.y - 0.05);

    if (allFingersUp && !isPinching) {
      const wx = 1 - wrist.x; // mirror
      if (!palmSwipeStart) {
        palmSwipeStart = { time: Date.now(), x: wx };
      } else {
        const dt = Date.now() - palmSwipeStart.time;
        const dx = wx - palmSwipeStart.x;
        if (dt > PALM_SWIPE_MAX_MS) {
          palmSwipeStart = { time: Date.now(), x: wx };
        } else if (Math.abs(dx) >= PALM_SWIPE_MIN_DIST) {
          fire(dx > 0 ? "go-forward" : "go-back");
          palmSwipeStart = null;
        }
      }
    } else {
      palmSwipeStart = null;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  function palmSpread(lms) {
    return [4, 8, 12, 16, 20].reduce((s, i) => s + dist(lms[0], lms[i]), 0) / 5;
  }

  // fire: with cooldown (discrete gestures)
  function fire(action) {
    const now = Date.now();
    if (now - lastGestureAt < GESTURE_COOLDOWN_MS) return;
    lastGestureAt = now;
    fireRaw(action);
  }

  // fireRaw: no cooldown (continuous/paired events like drag-start/end)
  function fireRaw(action) {
    emit("afk:gesture", { action });
    safeSend({ type: "GESTURE_LABEL", payload: action });
  }

  function emit(name, detail) {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }

  function safeSend(msg) {
    chrome.runtime.sendMessage(msg).catch(() => {});
  }

  // ── Script loader: fetch → blob URL (bypasses page CSP) ──────────────────
  const loadedScripts = new Set();
  async function loadScript(src) {
    if (loadedScripts.has(src)) return;
    loadedScripts.add(src);
    const res     = await fetch(src);
    if (!res.ok) throw new Error(`AFK: fetch failed ${src}`);
    const blob    = new Blob([await res.text()], { type: "application/javascript" });
    const blobUrl = URL.createObjectURL(blob);
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = blobUrl;
      s.onload  = () => { URL.revokeObjectURL(blobUrl); resolve(); };
      s.onerror = () => { URL.revokeObjectURL(blobUrl); reject(); };
      document.head.appendChild(s);
    });
  }

})();