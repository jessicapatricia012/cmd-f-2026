// Gesture handler
// Handles: MediaPipe Hands integration, gesture detection, webcam feed
//
// ARCHITECTURE NOTE: This file runs in the page's MAIN world, not the extension's
// isolated content-script world, because MediaPipe loads WebAssembly via CDN script
// tags that are blocked in the isolated world.
//
// Load from content.js like this:
//   const s = document.createElement('script');
//   s.src = chrome.runtime.getURL('content/gesture-handler.js');
//   document.head.appendChild(s);
//
// This module then dispatches CustomEvents on `document` that content.js can
// listen to with document.addEventListener(...):
//
//   gesture:cursor         { x, y }          — index fingertip position (screen px)
//   gesture:click          { x, y }          — quick pinch (index + middle)
//   gesture:dragstart      { x, y }          — pinch held and moved past threshold
//   gesture:drag           { x, y, dx, dy }  — pinch drag in progress (absolute + delta)
//   gesture:dragend        { x, y }          — pinch drag released
//   gesture:scroll         { dx, dy }        — two-finger flick; positive dy = scroll down
//   gesture:zoom           { direction }     — 'in' (palm open) | 'out' (fist close)
//   gesture:tabswitch:start {}               — double-pinch detected, entering tab mode
//   gesture:tabswitch:drag { dx }            — horizontal drag from pinch origin (px)
//   gesture:tabswitch:end  { dx }            — released; dx > 0 = right, dx < 0 = left
//   gesture:navigate       { direction }     — 'back' | 'forward' (open-palm swipe)
//   gesture:none           {}               — no hand visible in frame

(function () {
  "use strict";

  // Guard against duplicate injection (e.g. background re-injects on re-load)
  if (window.__AFK_INJECTED) return;
  window.__AFK_INJECTED = true;

  // ---------------------------------------------------------------------------
  // MediaPipe hand landmark indices
  // ---------------------------------------------------------------------------
  const LM = {
    WRIST: 0,
    THUMB_CMC: 1,
    THUMB_MCP: 2,
    THUMB_IP: 3,
    THUMB_TIP: 4,
    INDEX_MCP: 5,
    INDEX_PIP: 6,
    INDEX_DIP: 7,
    INDEX_TIP: 8,
    MIDDLE_MCP: 9,
    MIDDLE_PIP: 10,
    MIDDLE_DIP: 11,
    MIDDLE_TIP: 12,
    RING_MCP: 13,
    RING_PIP: 14,
    RING_DIP: 15,
    RING_TIP: 16,
    PINKY_MCP: 17,
    PINKY_PIP: 18,
    PINKY_DIP: 19,
    PINKY_TIP: 20,
  };

  // ---------------------------------------------------------------------------
  // Tuning constants — adjust these to taste
  // ---------------------------------------------------------------------------
  const CFG = {
    // Pinch: normalized distance between thumb tip and index tip
    PINCH_THRESHOLD: 0.08,

    // Click: max pinch duration (ms) before it becomes a drag instead
    CLICK_MAX_MS: 350,

    // Double-pinch (tab switch): max gap between two pinches (ms)
    DOUBLE_PINCH_GAP_MS: 500,

    // Drag: minimum movement (screen px) before drag is recognized
    DRAG_MIN_PX: 20,

    // Scroll: minimum two-finger velocity (normalized units / ms) to emit events
    SCROLL_VELOCITY_THRESHOLD: 0.004,
    // Multiplier converting velocity → scroll px
    SCROLL_SCALE: 900,
    // History window for velocity averaging
    SCROLL_HISTORY_LEN: 8,

    // Swipe (back/forward): minimum wrist velocity (normalized units / ms)
    SWIPE_VELOCITY_THRESHOLD: 0.005,
    // Sliding window duration (ms) used to compute swipe velocity
    SWIPE_WINDOW_MS: 450,
    // Horizontal component must exceed vertical * this factor (directionality guard)
    SWIPE_DIRECTIONALITY: 1.8,
    // Cooldown after a swipe fires (ms)
    SWIPE_COOLDOWN_MS: 900,

    // Zoom cooldown after each zoom event (ms)
    ZOOM_COOLDOWN_MS: 750,

    // Webcam capture resolution
    VIDEO_W: 640,
    VIDEO_H: 480,
  };

  // ---------------------------------------------------------------------------
  // GestureHandler class
  // ---------------------------------------------------------------------------
  class GestureHandler {
    constructor() {
      this._hands = null;
      this._video = null;
      this._rafId = null;
      this._running = false;

      // Mutable gesture state — centralised so detectors can read each other's state
      this._s = {
        // --- Pinch / click / drag ---
        pinching: false,
        pinchStartMs: 0,
        pinchStartPx: null, // { x, y } screen px where pinch started
        lastPinchEndMs: 0,
        dragging: false,

        // --- Tab switch (double-pinch + horizontal drag) ---
        tabSwitching: false,
        tabSwitchOriginPx: null,

        // --- Palm / fist (zoom + swipe) ---
        palmOpen: false,
        palmHistory: [], // [{ x, y, t }] wrist positions for swipe velocity
        swipeCooldown: false,

        // --- Zoom ---
        zoomCooldown: false,

        // --- Two-finger scroll ---
        scrollMode: false,
        scrollHistory: [], // [{ x, y, t }] midpoint of index+middle tips

        // --- Gesture mutual-exclusion timestamps ---
        lastZoomMs: 0,  // when zoom last fired; suppresses pinch + swipe after zoom
      };
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /** Initialise: loads MediaPipe, sets up video element, starts camera. */
    async init() {
      console.log('[AFK] Starting init...');
      await this._loadMediaPipe();
      console.log('[AFK] MediaPipe loaded, setting up video...');
      this._setupVideo();
      this._setupHands();
      console.log('[AFK] Requesting webcam...');
      await this._startCamera();
      console.log('[AFK] Camera started.');
    }

    /** Stop detection and release the webcam stream. */
    stop() {
      this._running = false;
      if (this._rafId) cancelAnimationFrame(this._rafId);
      this._video?.srcObject?.getTracks().forEach((t) => t.stop());
    }

    /** Show or hide the small webcam preview overlay. */
    showPreview(visible) {
      if (this._video) {
        this._video.style.display = visible ? "block" : "none";
      }
    }

    // -------------------------------------------------------------------------
    // Initialisation helpers
    // -------------------------------------------------------------------------

    _loadMediaPipe() {
      // Happy path: background already injected hands.js from local assets — skip loading.
      if (window.Hands) return Promise.resolve();

      // Load from extension's local assets (web_accessible_resources).
      return new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = chrome.runtime.getURL("assets/mediapipe/hands.js");
        script.onload = resolve;
        script.onerror = () =>
          reject(new Error("[GestureHandler] Failed to load MediaPipe Hands"));
        document.head.appendChild(script);
      });
    }

    _setupVideo() {
      this._video = document.createElement("video");
      Object.assign(this._video.style, {
        position: "fixed",
        bottom: "12px",
        right: "12px",
        width: "160px",
        height: "120px",
        zIndex: "2147483647",
        borderRadius: "8px",
        opacity: "0.75",
        pointerEvents: "none",
        display: "none", // hidden by default; call showPreview(true) to reveal
        transform: "scaleX(-1)", // mirror so it looks natural (selfie view)
        objectFit: "cover",
      });
      this._video.setAttribute("playsinline", "");
      this._video.muted = true;
      document.body.appendChild(this._video);
    }

    _setupHands() {
      // Prefer local extension assets (set by background before injection);
      // fall back to CDN if running without background injection.
      const baseUrl = window.__AFK_MEDIAPIPE_URL || chrome.runtime.getURL("assets/mediapipe");
      this._hands = new window.Hands({
        locateFile: (file) => `${baseUrl}/${file}`,
      });

      this._hands.setOptions({
        maxNumHands: 1,
        modelComplexity: 1,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });

      this._hands.onResults((r) => this._onResults(r));
    }

    async _startCamera() {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: CFG.VIDEO_W },
          height: { ideal: CFG.VIDEO_H },
          facingMode: "user",
          frameRate: { ideal: 30 },
        },
        audio: false,
      });

      this._video.srcObject = stream;
      await this._video.play();
      this._running = true;
      this._loop();
    }

    _loop() {
      if (!this._running) return;
      this._hands
        .send({ image: this._video })
        .catch((err) => console.warn('[AFK] hands.send error:', err))
        .finally(() => {
          this._rafId = requestAnimationFrame(() => this._loop());
        });
    }

    // -------------------------------------------------------------------------
    // Core results handler
    // -------------------------------------------------------------------------

    _onResults(results) {
      if (!this._resultsLogged) {
        this._resultsLogged = true;
        console.log('[AFK] onResults firing — hands visible:', results.multiHandLandmarks?.length ?? 0);
      }
      if (!results.multiHandLandmarks?.length) {
        this._onNoHand();
        return;
      }

      const lm = results.multiHandLandmarks[0];
      const now = Date.now();

      // Convenience references
      const indexTip = lm[LM.INDEX_TIP];
      const indexPip = lm[LM.INDEX_PIP];
      const middleTip = lm[LM.MIDDLE_TIP];
      const middlePip = lm[LM.MIDDLE_PIP];
      const ringTip = lm[LM.RING_TIP];
      const ringPip = lm[LM.RING_PIP];
      const pinkyTip = lm[LM.PINKY_TIP];
      const pinkyPip = lm[LM.PINKY_PIP];
      const wrist = lm[LM.WRIST];

      // Finger extension: tip y < pip y means finger is pointing upward
      // (MediaPipe y=0 is top of frame)
      const indexUp = indexTip.y < indexPip.y;
      const middleUp = middleTip.y < middlePip.y;
      const ringUp = ringTip.y < ringPip.y;
      const pinkyUp = pinkyTip.y < pinkyPip.y;

      const palmOpen = indexUp && middleUp && ringUp && pinkyUp;
      const isFist = !indexUp && !middleUp && !ringUp && !pinkyUp;

      // Pinch: thumb tip close to index tip (natural pinch gesture).
      // IMPORTANT: suppress pinch entirely while the palm is open — this prevents
      // the zoom gesture (open/close palm) from accidentally registering as a
      // pinch and triggering click or tab-switch.
      const thumbTip = lm[LM.THUMB_TIP];
      const pinchDist = this._dist(thumbTip, indexTip);
      const isPinching = pinchDist < CFG.PINCH_THRESHOLD && !palmOpen;

      // --- Cursor tracking: index fingertip, mirrored to screen coords ---
      const cursorPx = this._toScreen(indexTip);
      this._emit("gesture:cursor", cursorPx);

      // --- Gesture detectors (order matters: pinch runs before scroll so scroll
      //     can correctly gate on !isPinching) ---
      this._detectPinch(isPinching, thumbTip, indexTip, now);
      this._detectScroll(
        indexUp,
        middleUp,
        isPinching,
        indexTip,
        middleTip,
        now,
      );
      this._detectZoom(palmOpen, isFist);
      this._detectSwipe(palmOpen, wrist, now);

      // Update palm state AFTER detectors that compare against the previous frame
      this._s.palmOpen = palmOpen;
    }

    _onNoHand() {
      const s = this._s;
      if (s.pinching) {
        s.pinching = false;
        s.dragging = false;
        s.tabSwitching = false;
      }
      s.scrollMode = false;
      s.scrollHistory = [];
      s.palmHistory = [];
      this._emit("gesture:none", {});
    }

    // -------------------------------------------------------------------------
    // Gesture detectors
    // -------------------------------------------------------------------------

    /**
     * Pinch detector — handles click, select-and-drag, and tab-switch.
     *
     * Click:          quick pinch + release (≤ CLICK_MAX_MS, minimal movement)
     * Drag:           pinch held and moved ≥ DRAG_MIN_PX
     * Tab switch:     second pinch within DOUBLE_PINCH_GAP_MS of the last
     *                 release, then held while dragging horizontally
     */
    _detectPinch(isPinching, thumbTip, indexTip, now) {
      const s = this._s;

      // Action point: midpoint of thumb and index tips, in screen px, mirrored
      const mid = {
        x: (1 - (thumbTip.x + indexTip.x) / 2) * window.innerWidth,
        y: ((thumbTip.y + indexTip.y) / 2) * window.innerHeight,
      };

      // --- PINCH START ---
      if (isPinching && !s.pinching) {
        // Suppress new pinch for 1 s after zoom fired — prevents palm-close
        // from being misread as a pinch immediately after a zoom gesture.
        if (now - s.lastZoomMs < 1000) return;

        s.pinching = true;
        s.pinchStartMs = now;
        s.pinchStartPx = { ...mid };
        s.dragging = false;

        // Double-pinch → enter tab-switch mode
        if (now - s.lastPinchEndMs < CFG.DOUBLE_PINCH_GAP_MS) {
          s.tabSwitching = true;
          s.tabSwitchOriginPx = { ...mid };
          this._emit("gesture:tabswitch:start", {});
        }
      }

      // --- PINCH HELD ---
      if (isPinching && s.pinching) {
        if (s.tabSwitching) {
          const dx = mid.x - s.tabSwitchOriginPx.x;
          this._emit("gesture:tabswitch:drag", { dx });
        } else {
          const dx = mid.x - s.pinchStartPx.x;
          const dy = mid.y - s.pinchStartPx.y;
          const moved = Math.hypot(dx, dy);

          if (!s.dragging && moved >= CFG.DRAG_MIN_PX) {
            s.dragging = true;
            this._emit("gesture:dragstart", { ...s.pinchStartPx });
          } else if (s.dragging) {
            this._emit("gesture:drag", { x: mid.x, y: mid.y, dx, dy });
          }
        }
      }

      // --- PINCH RELEASE ---
      if (!isPinching && s.pinching) {
        const duration = now - s.pinchStartMs;

        if (s.tabSwitching) {
          const dx = mid.x - s.tabSwitchOriginPx.x;
          this._emit("gesture:tabswitch:end", { dx });
          s.tabSwitching = false;
        } else if (s.dragging) {
          this._emit("gesture:dragend", { x: mid.x, y: mid.y });
        } else if (duration <= CFG.CLICK_MAX_MS) {
          this._emit("gesture:click", { ...s.pinchStartPx });
        }

        s.lastPinchEndMs = now;
        s.pinching = false;
        s.dragging = false;
      }
    }

    /**
     * Scroll detector — index + middle fingers extended and not pinching.
     *
     * Tracks the midpoint velocity of the two fingertips over a rolling window
     * and emits scroll deltas proportional to that velocity (flick-style:
     * faster movement → larger delta).
     *
     * dx > 0: scroll right   dy > 0: scroll down
     */
    _detectScroll(indexUp, middleUp, isPinching, indexTip, middleTip, now) {
      const s = this._s;

      if (!indexUp || !middleUp || isPinching) {
        s.scrollMode = false;
        s.scrollHistory = [];
        return;
      }

      s.scrollMode = true;
      s.scrollHistory.push({
        x: (indexTip.x + middleTip.x) / 2,
        y: (indexTip.y + middleTip.y) / 2,
        t: now,
      });
      if (s.scrollHistory.length > CFG.SCROLL_HISTORY_LEN)
        s.scrollHistory.shift();
      if (s.scrollHistory.length < 4) return;

      const old = s.scrollHistory[0];
      const cur = s.scrollHistory[s.scrollHistory.length - 1];
      const dt = cur.t - old.t;
      if (dt <= 0) return;

      const vx = (cur.x - old.x) / dt;
      const vy = (cur.y - old.y) / dt;

      if (
        Math.abs(vx) < CFG.SCROLL_VELOCITY_THRESHOLD &&
        Math.abs(vy) < CFG.SCROLL_VELOCITY_THRESHOLD
      )
        return;

      // MediaPipe x=0 is LEFT of frame; mirrored feed means camera-left = screen-right,
      // so negate vx to align scroll direction with perceived finger motion.
      this._emit("gesture:scroll", {
        dx: -vx * CFG.SCROLL_SCALE,
        dy: vy * CFG.SCROLL_SCALE,
      });
    }

    /**
     * Zoom detector — palm open/close.
     *
     * Zoom in:  transition from any state → open palm (all four fingers extended)
     * Zoom out: transition from open palm → closed fist
     *
     * A cooldown prevents repeated firing.
     */
    _detectZoom(palmOpen, isFist) {
      const s = this._s;
      // Don't zoom while/after a swipe — swipe and zoom share the "palm open" state
      if (s.zoomCooldown || s.swipeCooldown) return;

      const wasOpen = s.palmOpen;

      if (!wasOpen && palmOpen) {
        this._emit("gesture:zoom", { direction: "in" });
        s.zoomCooldown = true;
        s.lastZoomMs = Date.now();
        setTimeout(() => { s.zoomCooldown = false; }, CFG.ZOOM_COOLDOWN_MS);
      } else if (wasOpen && isFist) {
        this._emit("gesture:zoom", { direction: "out" });
        s.zoomCooldown = true;
        s.lastZoomMs = Date.now();
        setTimeout(() => { s.zoomCooldown = false; }, CFG.ZOOM_COOLDOWN_MS);
      }
    }

    /**
     * Back/Forward detector — open palm swiped left or right.
     *
     * Uses wrist position over a short sliding time window to compute
     * horizontal velocity. Camera is mirrored:
     *   wrist moving right in camera space (vx > 0) → user moves hand LEFT → "back"
     *   wrist moving left  in camera space (vx < 0) → user moves hand RIGHT → "forward"
     */
    _detectSwipe(palmOpen, wrist, now) {
      const s = this._s;

      if (!palmOpen) {
        s.palmHistory = [];
        return;
      }
      // Don't swipe during/after zoom — they share the palm-open state
      if (s.swipeCooldown || s.zoomCooldown) return;

      s.palmHistory.push({ x: wrist.x, y: wrist.y, t: now });

      // Prune entries outside the measurement window
      const cutoff = now - CFG.SWIPE_WINDOW_MS;
      while (s.palmHistory.length && s.palmHistory[0].t < cutoff) {
        s.palmHistory.shift();
      }
      if (s.palmHistory.length < 5) return;

      const first = s.palmHistory[0];
      const last = s.palmHistory[s.palmHistory.length - 1];
      const dt = last.t - first.t;
      if (dt <= 0) return;

      const dx = last.x - first.x;
      const dy = last.y - first.y;
      const vx = dx / dt;

      if (Math.abs(vx) < CFG.SWIPE_VELOCITY_THRESHOLD) return;
      if (Math.abs(dx) < Math.abs(dy) * CFG.SWIPE_DIRECTIONALITY) return; // reject diagonal motion

      const direction = vx > 0 ? "back" : "forward";
      this._emit("gesture:navigate", { direction });

      s.swipeCooldown = true;
      s.palmHistory = [];
      setTimeout(() => {
        s.swipeCooldown = false;
      }, CFG.SWIPE_COOLDOWN_MS);
    }

    // -------------------------------------------------------------------------
    // Utility helpers
    // -------------------------------------------------------------------------

    /** Euclidean distance between two normalised landmarks (x, y only). */
    _dist(a, b) {
      return Math.hypot(a.x - b.x, a.y - b.y);
    }

    /**
     * Convert a normalised MediaPipe landmark { x, y } to screen px.
     * x=0 in MediaPipe is the LEFT edge of the camera frame; because the video
     * is displayed mirrored (selfie view), that maps to the RIGHT of the screen,
     * so we flip: screenX = (1 - lm.x) * innerWidth.
     */
    _toScreen(lm) {
      return {
        x: (1 - lm.x) * window.innerWidth,
        y: lm.y * window.innerHeight,
      };
    }

    /** Dispatch a CustomEvent on document for content.js to receive. */
    _emit(type, detail) {
      document.dispatchEvent(new CustomEvent(type, { detail, bubbles: false }));
    }
  }

  // Auto-start — runs as soon as the browser injects this script
  const _afkHandler = new GestureHandler();
  _afkHandler.init()
    .then(() => _afkHandler.showPreview(true))
    .catch(err => {
      console.error('[AFK] GestureHandler failed to start:', err);
      // Show a visible error banner so it's obvious something went wrong
      const banner = document.createElement('div');
      Object.assign(banner.style, {
        position: 'fixed', bottom: '12px', right: '12px', zIndex: '2147483647',
        background: 'rgba(220,38,38,0.92)', color: '#fff', padding: '8px 12px',
        borderRadius: '8px', fontFamily: 'system-ui,sans-serif', fontSize: '12px',
        maxWidth: '260px', lineHeight: '1.4', pointerEvents: 'none',
      });
      banner.textContent = `[AFK] Failed to start: ${err.message}`;
      document.body.appendChild(banner);
      setTimeout(() => banner.remove(), 8000);
    });

})();
