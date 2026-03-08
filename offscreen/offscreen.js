// Offscreen document — runs at chrome-extension:// origin, so the page's CSP
// never applies here.  MediaPipe WASM compiles without restriction.
//
// Emits gesture results to the service worker via chrome.runtime.sendMessage.
// The service worker relays them to the active tab's content script.
"use strict";

// ---------------------------------------------------------------------------
// MediaPipe hand landmark indices
// ---------------------------------------------------------------------------
const LM = {
  WRIST: 0,
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
// Tuning constants
// ---------------------------------------------------------------------------
const CFG = {
  ENABLE_SCROLL: true,
  ENABLE_CLICK: false,
  ENABLE_DRAG: false,
  ENABLE_TAB_SWITCH: true,
  ENABLE_SWIPE: false,
  TAB_PINCH_THRESHOLD: 0.08,
  TAB_HOLD_SWITCH_MS: 420,
  TAB_HOLD_MIN_NORM: 0.06,
  TAB_HOLD_COOLDOWN_MS: 900,
  TAB_SWITCH_BLOCK_AFTER_SCROLL_MS: 450,
  CLAP_DISTANCE_THRESHOLD: 0.14,
  CLAP_RELEASE_DISTANCE_THRESHOLD: 0.24,
  CLAP_PRIME_DISTANCE_THRESHOLD: 0.36,
  CLAP_TRANSITION_MAX_MS: 900,
  CLAP_COOLDOWN_MS: 1400,
  FINGER_CLUSTER_THRESHOLD: 0.21,
  FINGER_CLUSTER_RELEASE_THRESHOLD: 0.26,
  THUMB_PINCH_THRESHOLD: 0.24,
  THUMB_PINCH_RELEASE_THRESHOLD: 0.29,
  CLICK_MAX_MS: 700,
  CLICK_COOLDOWN_MS: 500,
  DOUBLE_PINCH_GAP_MS: 500,
  DRAG_MIN_NORM: 0.012,
  TAB_SWITCH_ARM_NORM: 0.03,
  TAB_SWITCH_MIN_NORM: 0.08,
  SCROLL_VELOCITY_THRESHOLD: 0.35,
  SCROLL_SCALE: 320,
  SCROLL_SMOOTHING: 0.22,
  SCROLL_MAX_STEP_PX: 90,
  SCROLL_DEADZONE_PX: 1.5,
  TAB_PINCH_THRESHOLD: 0.08, // index↔middle closeness for tab-switch pinch
  TAB_HOLD_SWITCH_MS: 420, // hold pinch before tab-switch can fire
  TAB_HOLD_MIN_NORM: 0.06, // horizontal pinch movement needed (~6% width)
  TAB_HOLD_COOLDOWN_MS: 900, // avoid repeat switches while held
  TAB_SWITCH_BLOCK_AFTER_SCROLL_MS: 800, // don't enter tab-switch right after scroll
  NEW_TAB_FIST_HOLD_MS: 600,
  NEW_TAB_LOSS_GRACE_MS: 220,
  NEW_TAB_COOLDOWN_MS: 1800,
  CLAP_DISTANCE_THRESHOLD: 0.18, // wrist-to-wrist distance to count as clap
  CLAP_RELEASE_DISTANCE_THRESHOLD: 0.28, // rearm clap after hands separate
  CLAP_PRIME_DISTANCE_THRESHOLD: 0.3, // hands must first be clearly apart
  CLAP_TRANSITION_MAX_MS: 1300, // clap must happen shortly after priming
  CLAP_COOLDOWN_MS: 1000,
  FINGER_CLUSTER_THRESHOLD: 0.21, // index↔middle closeness for 3-finger pinch
  FINGER_CLUSTER_RELEASE_THRESHOLD: 0.26, // hysteresis: must open wider to end pinch
  THUMB_PINCH_THRESHOLD: 0.24, // thumb↔index and thumb↔middle closeness
  THUMB_PINCH_RELEASE_THRESHOLD: 0.29, // hysteresis: must open wider to end pinch
  CLICK_MAX_MS: 700, // max pinch duration for a click
  CLICK_COOLDOWN_MS: 500, // minimum gap between click events
  DOUBLE_PINCH_GAP_MS: 500, // max gap between pinches for tab-switch
  DRAG_MIN_NORM: 0.012, // ~20 px at 1600-wide screen, in normalised units
  TAB_SWITCH_ARM_NORM: 0.03, // second pinch must move horizontally before tab mode starts
  TAB_SWITCH_MIN_NORM: 0.08, // require explicit horizontal drag (~8% screen width)
  REFRESH_THUMBS_UP_HOLD_MS: 500, // hold thumbs-up to refresh
  REFRESH_COOLDOWN_MS: 1600,
  SCROLL_VELOCITY_THRESHOLD: 0.35, // normalised units / second
  SCROLL_SCALE: 320, // px per event per unit velocity
  SCROLL_SMOOTHING: 0.22, // low-pass filter (0-1), lower = smoother
  SCROLL_MAX_STEP_PX: 90, // clamp per event to avoid jumps
  SCROLL_DEADZONE_PX: 1.5, // ignore tiny jitter
  SCROLL_HISTORY_LEN: 8,
  SWIPE_VELOCITY_THRESHOLD: 0.005,
  SWIPE_WINDOW_MS: 450,
  SWIPE_DIRECTIONALITY: 1.8,
  SWIPE_COOLDOWN_MS: 900,
  ZOOM_COOLDOWN_MS: 750,
  ZOOM_HOLD_MS: 220,
  ZOOM_BLOCK_AFTER_SCROLL_MS: 700,
  ATTENTION_CHECK_INTERVAL_MS: 220,
  ATTENTION_AWAY_STABLE_MS: 900,
  ATTENTION_LOOKING_STABLE_MS: 450,
  ATTENTION_FACE_GRACE_MS: 1200,
  ATTENTION_CENTER_X_MIN: 0.34,
  ATTENTION_CENTER_X_MAX: 0.66,
  ATTENTION_YAW_RATIO_MAX: 0.48,
};

// ---------------------------------------------------------------------------
// GestureHandler
// ---------------------------------------------------------------------------
class GestureHandler {
  constructor() {
    this._hands = null;
    this._video = document.getElementById("video");
    this._loopTimer = null;
    this._running = false;
    this._consecutiveSendFailures = 0;
    this._handsSandbox = null;
    this._handsReady = false;
    this._handsSendInFlight = false;
    this._faceMesh = null;
    this._attentionEngine = 'none';
    this._attentionTickInFlight = false;
    this._attentionLastCheckMs = 0;
    this._attentionStatusLastSentAt = new Map();
    this._attentionFatalError = null;
    this._attentionPaused = true;

    this._s = {
      pinching: false,
      pinchStartMs: 0,
      pinchStartNorm: null,
      lastPinchEndMs: 0,
      dragging: false,
      clickFiredThisPinch: false,
      lastClickMs: 0,
      tabSwitchPrimed: false,
      tabSwitchFired: false,
      lastTabSwitchMs: 0,
      tabSwitching: false,
      tabSwitchOriginNorm: null,
      newTabArmed: true,
      lastNewTabMs: 0,
      clapArmed: false,
      lastClapMs: 0,
      clapPrimedMs: 0,
      palmOpen: false,
      palmHistory: [],
      refreshPoseStartMs: 0,
      lastRefreshMs: 0,
      swipeCooldown: false,
      zoomCooldown: false,
      scrollMode: false,
      scrollHistory: [],
      scrollVx: 0,
      scrollVy: 0,
      lastZoomMs: 0,
      lastScrollMs: 0,
      palmOpenSinceMs: null,
      fistSinceMs: null,
      attentionCandidateState: null,
      attentionCandidateSinceMs: 0,
      attentionState: null,
      lastFaceSeenMs: 0,
      fistLastSeenMs: 0,
    };
  }

  async init() {
    console.log('[AFK] offscreen init…');
    this._setupAttention();
    console.log("[AFK] offscreen init…");
    this._setupHands();
    this._setupAttention();
    await this._startCamera();
    console.log("[AFK] offscreen ready");
  }

  setAttentionPaused(paused) {
    this._attentionPaused = Boolean(paused);
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  _setupHands() {
    this._handsSandbox = document.getElementById('hands-sandbox');
    if (!this._handsSandbox) {
      console.error('[AFK] Hands sandbox iframe not found');
      return;
    }

    this._handsReady = false;

    window.addEventListener('message', (event) => {
      const data = event.data;
      if (!data?.type) return;

      if (data.type === 'hands-ready') {
        this._handsReady = true;
        console.log('[AFK] MediaPipe Hands (sandboxed) ready');
      } else if (data.type === 'hands-results') {
        this._handsSendInFlight = false;
        this._consecutiveSendFailures = 0;
        this._onResults({
          multiHandLandmarks: data.landmarks || [],
          multiHandedness: data.handedness || [],
        });
      } else if (data.type === 'hands-error') {
        this._handsSendInFlight = false;
        this._consecutiveSendFailures += 1;
        console.warn('[AFK] Hands sandbox error:', data.error);
        if (this._consecutiveSendFailures >= 20) {
          this._running = false;
          console.error('[AFK] stopping gesture loop after repeated sandbox failures');
        }
      }
    });

    this._handsSandbox.addEventListener('load', () => {
      if (!this._handsReady) {
        this._handsSandbox.contentWindow.postMessage({ type: 'hands-ping' }, '*');
      }
    });
  }

  _setupAttention() {
    this._faceMeshSandbox = document.getElementById('facemesh-sandbox');
    if (!this._faceMeshSandbox) {
      this._attentionEngine = 'none';
      console.warn('[AFK] No face attention engine available — sandbox iframe missing');
      this._emit('attention:status', { state: 'unsupported', reason: 'sandbox iframe missing' });
      return;
    }

    window.addEventListener('message', (event) => {
      const data = event.data;
      if (!data?.type) return;

      if (data.type === 'facemesh-ready') {
        this._attentionEngine = 'face-mesh';
        console.log('[AFK] MediaPipe Face Mesh (sandboxed) enabled for attention auto-pause');
        this._emit('attention:status', { state: 'ready', engine: this._attentionEngine });
      } else if (data.type === 'facemesh-results') {
        this._attentionTickInFlight = false;
        this._handleAttentionFaceMeshResults(
          { multiFaceLandmarks: data.faces },
          Date.now(),
        );
      } else if (data.type === 'facemesh-error') {
        console.warn('[AFK] FaceMesh sandbox error:', data.error);
        this._attentionTickInFlight = false;
        this._attentionFatalError = data.error;
        this._attentionEngine = 'none';
        this._emit('attention:status', {
          state: 'unsupported',
          reason: `FaceMesh blocked: ${data.error}`,
        });
      }
    });

    this._attentionEngine = 'face-mesh-pending';
    console.log('[AFK] Waiting for FaceMesh sandbox to initialize…');

    this._faceMeshSandbox.addEventListener('load', () => {
      if (this._attentionEngine === 'face-mesh-pending') {
        this._faceMeshSandbox.contentWindow.postMessage({ type: 'facemesh-ping' }, '*');
      }
    });
  }

  async _startCamera() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
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

    const scheduleNext = () => {
      if (!this._running) return;
      this._tickAttention();
      this._loopTimer = setTimeout(() => this._loop(), 33);
    };

    if (!this._handsReady || !this._handsSandbox || this._handsSendInFlight) {
      scheduleNext();
      return;
    }

    this._handsSendInFlight = true;
    createImageBitmap(this._video)
      .then((bitmap) => {
        this._handsSandbox.contentWindow.postMessage(
          { type: 'hands-frame', image: bitmap },
          '*',
          [bitmap],
        );
        setTimeout(() => {
          if (this._handsSendInFlight) {
            this._handsSendInFlight = false;
          }
        }, 2000);
      })
      .catch((err) => {
        this._handsSendInFlight = false;
        console.warn('[AFK] hands frame capture error:', err);
      })
      .finally(() => scheduleNext());
  }

  // -------------------------------------------------------------------------
  // Results handler
  // -------------------------------------------------------------------------

  _onResults(results) {
    if (!results.multiHandLandmarks?.length) {
      this._onNoHand();
      return;
    }

    const allHands = results.multiHandLandmarks;
    const lm = allHands[0];
    const now = Date.now();

    this._detectClap(allHands, results.multiHandedness, now);

    const indexTip = lm[LM.INDEX_TIP],
      indexPip = lm[LM.INDEX_PIP];
    const middleTip = lm[LM.MIDDLE_TIP],
      middlePip = lm[LM.MIDDLE_PIP];
    const ringTip = lm[LM.RING_TIP],
      ringPip = lm[LM.RING_PIP];
    const pinkyTip = lm[LM.PINKY_TIP],
      pinkyPip = lm[LM.PINKY_PIP];
    const thumbTip = lm[LM.THUMB_TIP];
    const indexMcp = lm[LM.INDEX_MCP];
    const wrist = lm[LM.WRIST];

    const indexUp = indexTip.y < indexPip.y;
    const middleUp = middleTip.y < middlePip.y;
    const ringUp = ringTip.y < ringPip.y;
    const pinkyUp = pinkyTip.y < pinkyPip.y;

    const palmOpen = indexUp && middleUp && ringUp && pinkyUp;
    const isFist = !indexUp && !middleUp && !ringUp && !pinkyUp;

    const distIndexMiddle = this._dist(indexTip, middleTip);
    const distThumbIndex = this._dist(thumbTip, indexTip);
    const distThumbMiddle = this._dist(thumbTip, middleTip);
    const isScrollPosture = indexUp && middleUp;
    const clusterThreshold = this._s.pinching
      ? CFG.FINGER_CLUSTER_RELEASE_THRESHOLD
      : CFG.FINGER_CLUSTER_THRESHOLD;
    const thumbThreshold = this._s.pinching
      ? CFG.THUMB_PINCH_RELEASE_THRESHOLD
      : CFG.THUMB_PINCH_THRESHOLD;

    const isThreeFingerPinch =
      distIndexMiddle < clusterThreshold &&
      distThumbIndex < thumbThreshold &&
      distThumbMiddle < thumbThreshold;

    const isTabPose = !ringUp && !pinkyUp;
    const isTabPinch =
      distIndexMiddle < CFG.TAB_PINCH_THRESHOLD &&
      isTabPose &&
      !isScrollPosture;
    const isPinching = CFG.ENABLE_TAB_SWITCH ? isTabPinch : isThreeFingerPinch;

    this._emit('gesture:cursor', { normX: 1 - indexTip.x, normY: indexTip.y });
    // Cursor: index fingertip, mirrored (normX=0 left of screen)
    this._emit("gesture:cursor", { normX: 1 - indexTip.x, normY: indexTip.y });

    if (CFG.ENABLE_CLICK || CFG.ENABLE_DRAG || CFG.ENABLE_TAB_SWITCH) {
      this._detectPinch(isPinching, indexTip, middleTip, now);
    }
    const isThumbsUp =
      thumbTip.y < indexMcp.y && !indexUp && !middleUp && !ringUp && !pinkyUp;
    const refreshActive = this._detectRefresh(isThumbsUp, isPinching, now);
    if (CFG.ENABLE_SCROLL && !refreshActive) {
      this._detectScroll(
        indexUp,
        middleUp,
        isPinching,
        indexTip,
        middleTip,
        now,
      );
    }
    if (CFG.ENABLE_SWIPE) {
      this._detectSwipe(palmOpen, wrist, now);
    }
    const curledCount =
      Number(!indexUp) + Number(!middleUp) + Number(!ringUp) + Number(!pinkyUp);
    const isFistLike = curledCount >= 3 && !palmOpen && !isPinching;
    this._detectNewTab(isFistLike, now);

    this._s.palmOpen = palmOpen;
  }

  _onNoHand() {
    const s = this._s;
    if (s.pinching) {
      s.pinching = false;
      s.dragging = false;
      s.clickFiredThisPinch = false;
      s.tabSwitchPrimed = false;
      s.tabSwitchFired = false;
      s.tabSwitching = false;
    }
    s.scrollMode = false;
    s.scrollHistory = [];
    s.palmHistory = [];
    s.refreshPoseStartMs = 0;
    s.clapArmed = false;
    s.clapPrimedMs = 0;
    s.fistSinceMs = null;
    s.newTabArmed = true;
    this._emit("gesture:none", {});
  }

  // -------------------------------------------------------------------------
  // Gesture detectors
  // -------------------------------------------------------------------------

  _detectPinch(isPinching, indexTip, middleTip, now) {
    const s = this._s;

    const mid = {
      normX: 1 - (indexTip.x + middleTip.x) / 2,
      normY: (indexTip.y + middleTip.y) / 2,
    };

    if (isPinching && !s.pinching) {
      if (
        s.scrollMode ||
        now - s.lastScrollMs < CFG.TAB_SWITCH_BLOCK_AFTER_SCROLL_MS
      )
        return;
      s.pinching = true;
      s.pinchStartMs = now;
      s.pinchStartNorm = { ...mid };
      s.dragging = false;
      s.clickFiredThisPinch = false;
      s.tabSwitchPrimed = false;
      s.tabSwitchFired = false;

      if (CFG.ENABLE_CLICK && now - s.lastClickMs >= CFG.CLICK_COOLDOWN_MS) {
        this._emit("gesture:click", { ...s.pinchStartNorm });
        s.clickFiredThisPinch = true;
        s.lastClickMs = now;
      }

      if (CFG.ENABLE_TAB_SWITCH) {
        s.tabSwitching = true;
        s.tabSwitchOriginNorm = { ...mid };
        this._emit("gesture:tabswitch:start", {});
      }
    }

    if (isPinching && s.pinching) {
      if (CFG.ENABLE_TAB_SWITCH && s.tabSwitching) {
        const normDx = mid.normX - s.tabSwitchOriginNorm.normX;
        this._emit("gesture:tabswitch:drag", { normDx });

        if (
          !s.tabSwitchFired &&
          now - s.lastTabSwitchMs >= CFG.TAB_HOLD_COOLDOWN_MS &&
          now - s.pinchStartMs >= CFG.TAB_HOLD_SWITCH_MS &&
          Math.abs(normDx) >= CFG.TAB_HOLD_MIN_NORM
        ) {
          this._emit("gesture:tabswitch:end", { normDx });
          s.tabSwitchFired = true;
          s.lastTabSwitchMs = now;
        }
      } else if (CFG.ENABLE_DRAG) {
        const dnx = mid.normX - s.pinchStartNorm.normX;
        const dny = mid.normY - s.pinchStartNorm.normY;
        const moved = Math.hypot(dnx, dny);

        if (!s.dragging && moved >= CFG.DRAG_MIN_NORM) {
          s.dragging = true;
          this._emit("gesture:dragstart", { ...s.pinchStartNorm });
        } else if (s.dragging) {
          this._emit("gesture:drag", {
            normX: mid.normX,
            normY: mid.normY,
            normDx: dnx,
            normDy: dny,
          });
        }
      }
    }

    if (!isPinching && s.pinching) {
      const duration = now - s.pinchStartMs;

      if (CFG.ENABLE_TAB_SWITCH && s.tabSwitching) {
        s.tabSwitchPrimed = false;
        s.tabSwitching = false;
        s.tabSwitchFired = false;
      } else if (CFG.ENABLE_DRAG && s.dragging) {
        this._emit("gesture:dragend", { normX: mid.normX, normY: mid.normY });
      } else if (
        CFG.ENABLE_CLICK &&
        !s.clickFiredThisPinch &&
        duration <= CFG.CLICK_MAX_MS &&
        now - s.lastClickMs >= CFG.CLICK_COOLDOWN_MS
      ) {
        this._emit("gesture:click", { ...s.pinchStartNorm });
        s.lastClickMs = now;
      }

      s.lastPinchEndMs = now;
      s.pinching = false;
      s.dragging = false;
      s.clickFiredThisPinch = false;
    }
  }

  _detectScroll(indexUp, middleUp, isPinching, indexTip, middleTip, now) {
    const s = this._s;

    if (!indexUp || !middleUp || isPinching || s.tabSwitching) {
      s.scrollMode = false;
      s.scrollHistory = [];
      s.scrollVx = 0;
      s.scrollVy = 0;
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

    const dtSec = dt / 1000;
    const vx = (cur.x - old.x) / dtSec;
    const vy = (cur.y - old.y) / dtSec;

    if (
      Math.abs(vx) < CFG.SCROLL_VELOCITY_THRESHOLD &&
      Math.abs(vy) < CFG.SCROLL_VELOCITY_THRESHOLD
    )
      return;

    s.scrollVx += (vx - s.scrollVx) * CFG.SCROLL_SMOOTHING;
    s.scrollVy += (vy - s.scrollVy) * CFG.SCROLL_SMOOTHING;

    let dx = -s.scrollVx * CFG.SCROLL_SCALE;
    let dy = -s.scrollVy * CFG.SCROLL_SCALE;

    dx = Math.max(
      -CFG.SCROLL_MAX_STEP_PX,
      Math.min(CFG.SCROLL_MAX_STEP_PX, dx),
    );
    dy = Math.max(
      -CFG.SCROLL_MAX_STEP_PX,
      Math.min(CFG.SCROLL_MAX_STEP_PX, dy),
    );

    if (Math.abs(dx) < CFG.SCROLL_DEADZONE_PX) dx = 0;
    if (Math.abs(dy) < CFG.SCROLL_DEADZONE_PX) dy = 0;
    if (dx === 0 && dy === 0) return;

    this._emit("gesture:scroll", { dx, dy });
    s.lastScrollMs = now;
  }

  _detectSwipe(palmOpen, wrist, now) {
    const s = this._s;
    if (!palmOpen) {
      s.palmHistory = [];
      return;
    }
    if (s.swipeCooldown) return;

    s.palmHistory.push({ x: wrist.x, y: wrist.y, t: now });
    const cutoff = now - CFG.SWIPE_WINDOW_MS;
    while (s.palmHistory.length && s.palmHistory[0].t < cutoff)
      s.palmHistory.shift();
    if (s.palmHistory.length < 5) return;

    const first = s.palmHistory[0];
    const last = s.palmHistory[s.palmHistory.length - 1];
    const dt = last.t - first.t;
    if (dt <= 0) return;

    const dx = last.x - first.x;
    const dy = last.y - first.y;
    const vx = dx / dt;

    if (Math.abs(vx) < CFG.SWIPE_VELOCITY_THRESHOLD) return;
    if (Math.abs(dx) < Math.abs(dy) * CFG.SWIPE_DIRECTIONALITY) return;

    this._emit("gesture:navigate", { direction: vx > 0 ? "back" : "forward" });
    s.swipeCooldown = true;
    s.palmHistory = [];
    setTimeout(() => {
      s.swipeCooldown = false;
    }, CFG.SWIPE_COOLDOWN_MS);
  }

  _detectRefresh(isThumbsUp, isPinching, now) {
    const s = this._s;

    if (!isThumbsUp || isPinching || s.tabSwitching || s.scrollMode) {
      s.refreshPoseStartMs = 0;
      return false;
    }

    // Prevent overlap with new-tab gesture transitions.
    if (now - s.lastNewTabMs < 1000) {
      s.refreshPoseStartMs = 0;
      return false;
    }

    if (!s.refreshPoseStartMs) {
      s.refreshPoseStartMs = now;
      return true;
    }

    if (now - s.refreshPoseStartMs < CFG.REFRESH_THUMBS_UP_HOLD_MS) return true;
    if (now - s.lastRefreshMs < CFG.REFRESH_COOLDOWN_MS) return true;

    this._emit("gesture:refreshtab", {});
    s.lastRefreshMs = now;
    s.refreshPoseStartMs = 0;
    return true;
  }

  _detectClap(allHands, handedness, now) {
    const s = this._s;
    if (allHands.length < 2) return;

    const h0 = handedness?.[0]?.label;
    const h1 = handedness?.[1]?.label;
    if (!h0 || !h1 || h0 === h1) return;

    const wristA = allHands[0][LM.WRIST];
    const wristB = allHands[1][LM.WRIST];
    const d = this._dist(wristA, wristB);

    if (d > CFG.CLAP_PRIME_DISTANCE_THRESHOLD) {
      s.clapArmed = true;
      s.clapPrimedMs = now;
      return;
    }

    if (!s.clapArmed) return;
    if (now - s.clapPrimedMs > CFG.CLAP_TRANSITION_MAX_MS) {
      s.clapArmed = false;
      s.clapPrimedMs = 0;
      return;
    }

    if (d > CFG.CLAP_RELEASE_DISTANCE_THRESHOLD) {
      s.clapArmed = true;
      return;
    }

    if (d >= CFG.CLAP_DISTANCE_THRESHOLD) return;
    if (now - s.lastClapMs < CFG.CLAP_COOLDOWN_MS) return;

    this._emit("gesture:closetab", {});
    s.lastClapMs = now;
    s.clapArmed = false;
    s.clapPrimedMs = 0;
  }

  _tickAttention() {
    if (this._attentionPaused) return;
    if (this._attentionEngine === 'none' || this._attentionEngine === 'face-mesh-pending'
        || this._attentionTickInFlight || this._attentionFatalError) return;
    const now = Date.now();
    if (now - this._attentionLastCheckMs < CFG.ATTENTION_CHECK_INTERVAL_MS) return;
    this._attentionLastCheckMs = now;
    this._attentionTickInFlight = true;

    if (this._attentionEngine === 'face-mesh' && this._faceMeshSandbox) {
      this._emitAttentionStatusThrottled('mesh-send');
      createImageBitmap(this._video)
        .then((bitmap) => {
          this._faceMeshSandbox.contentWindow.postMessage(
            { type: 'facemesh-frame', image: bitmap },
            '*',
            [bitmap],
          );
          this._emitAttentionStatusThrottled('mesh-send-ok', { engine: this._attentionEngine }, 1400);
        })
        .catch((err) => {
          const reason = err?.message || String(err);
          console.warn('[AFK] FaceMesh frame capture failed:', reason);
          this._attentionFatalError = reason;
          this._attentionEngine = 'none';
          this._attentionTickInFlight = false;
          this._emit('attention:status', {
            state: 'unsupported',
            reason: `Frame capture failed: ${reason}`,
          });
        });
      return;
    }

    this._attentionTickInFlight = false;
  }

  _handleAttentionFaceMeshResults(results, now) {
    const lm = results?.multiFaceLandmarks?.[0] || null;
    this._emitAttentionStatusThrottled('mesh-results', {
      points: lm?.length || 0,
      engine: this._attentionEngine,
    }, 1200);
    const s = this._s;
    let candidate = 'away';

    if (lm && lm.length > 264) {
      s.lastFaceSeenMs = now;
      this._emit('attention:status', { state: 'face-detected' });
      const leftEyeOuter = lm[33];
      const rightEyeOuter = lm[263];
      const noseTip = lm[1];
      const gazeX =
        typeof noseTip?.x === 'number'
          ? noseTip.x
          : typeof leftEyeOuter?.x === 'number' && typeof rightEyeOuter?.x === 'number'
            ? (leftEyeOuter.x + rightEyeOuter.x) / 2
            : null;
      const gazeY =
        typeof noseTip?.y === 'number'
          ? noseTip.y
          : typeof leftEyeOuter?.y === 'number' && typeof rightEyeOuter?.y === 'number'
            ? (leftEyeOuter.y + rightEyeOuter.y) / 2
            : null;
      if (typeof gazeX === 'number' && typeof gazeY === 'number') {
        this._emit('attention:gaze', {
          normX: Math.max(0, Math.min(1, 1 - gazeX)),
          normY: Math.max(0, Math.min(1, gazeY)),
          engine: this._attentionEngine,
        });
      }
      candidate = this._isLookingAtScreenFaceMesh(lm) ? 'looking' : 'away';
    } else if (now - s.lastFaceSeenMs <= CFG.ATTENTION_FACE_GRACE_MS) {
      candidate = s.attentionState || 'looking';
      this._emit('attention:status', { state: 'face-uncertain' });
    } else {
      this._emit('attention:status', { state: 'no-face' });
    }

    this._commitAttentionCandidate(candidate, now);
  }

  _isLookingAtScreenFaceMesh(lm) {
    const leftEyeOuter = lm[33];
    const rightEyeOuter = lm[263];
    const noseTip = lm[1];
    if (!leftEyeOuter || !rightEyeOuter || !noseTip) return false;

    const eyeMidX = (leftEyeOuter.x + rightEyeOuter.x) / 2;
    const eyeSpan = Math.abs(rightEyeOuter.x - leftEyeOuter.x);
    const centered =
      eyeMidX >= CFG.ATTENTION_CENTER_X_MIN &&
      eyeMidX <= CFG.ATTENTION_CENTER_X_MAX;
    if (eyeSpan <= 0.0001) return centered;

    const yawRatio = Math.abs((noseTip.x - eyeMidX) / (eyeSpan / 2));
    return centered && yawRatio <= CFG.ATTENTION_YAW_RATIO_MAX;
  }

  _commitAttentionCandidate(candidate, now) {
    const s = this._s;
    if (candidate !== s.attentionCandidateState) {
      s.attentionCandidateState = candidate;
      s.attentionCandidateSinceMs = now;
      return;
    }

    if (s.attentionState === candidate) return;
    const stableForMs = now - s.attentionCandidateSinceMs;
    const neededMs =
      candidate === 'away'
        ? CFG.ATTENTION_AWAY_STABLE_MS
        : CFG.ATTENTION_LOOKING_STABLE_MS;
    if (stableForMs < neededMs) return;

    s.attentionState = candidate;
    this._emit(
      candidate === 'away' ? 'attention:look-away' : 'attention:look-at',
      { stableForMs },
    );
  }

  _detectNewTab(isFistLike, now) {
    const s = this._s;

    if (isFistLike && !s.scrollMode && !s.tabSwitching) {
      if (s.fistSinceMs == null) s.fistSinceMs = now;
      s.fistLastSeenMs = now;
    } else if (
      !s.fistSinceMs ||
      now - s.fistLastSeenMs > CFG.NEW_TAB_LOSS_GRACE_MS
    ) {
      s.fistSinceMs = null;
      s.fistLastSeenMs = 0;
      s.newTabArmed = true;
      return;
    }

    if (!s.newTabArmed) return;
    if (now - s.fistSinceMs < CFG.NEW_TAB_FIST_HOLD_MS) return;
    if (now - s.lastNewTabMs < CFG.NEW_TAB_COOLDOWN_MS) return;

    this._emit("gesture:newtab", {});
    s.lastNewTabMs = now;
    s.newTabArmed = false;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  _dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  _emitAttentionStatusThrottled(state, detail = {}, minIntervalMs = 900) {
    const key = String(state || '');
    const now = Date.now();
    const last = this._attentionStatusLastSentAt.get(key) || 0;
    if (now - last < minIntervalMs) return;
    this._attentionStatusLastSentAt.set(key, now);
    this._emit('attention:status', { state: key, ...detail });
  }

  _emit(type, detail) {
    chrome.runtime
      .sendMessage({ type: "gesture", event: type, detail })
      .catch(() => {});
  }
}

const handler = new GestureHandler();
handler.init().catch((err) => console.error('[AFK] offscreen failed:', err?.name, err?.message, err));

// ---------------------------------------------------------------------------
// TTS playback via dedicated worker + Web Audio API (no blob URLs)
// ---------------------------------------------------------------------------
const _ttsAudioCtx = new AudioContext();
const _ttsWorker = new Worker(chrome.runtime.getURL('offscreen/tts-worker.js'));

let _ttsActiveSrc = null;

_ttsWorker.onmessage = async (e) => {
  try {
    // Stop any currently playing TTS before starting the new one
    if (_ttsActiveSrc) {
      try { _ttsActiveSrc.stop(); } catch (_) {}
      _ttsActiveSrc = null;
    }
    if (_ttsAudioCtx.state === 'suspended') {
      await _ttsAudioCtx.resume();
    }
    const decoded = await _ttsAudioCtx.decodeAudioData(e.data.buffer);
    const src = _ttsAudioCtx.createBufferSource();
    src.buffer = decoded;
    src.connect(_ttsAudioCtx.destination);
    src.onended = () => { _ttsActiveSrc = null; };
    _ttsActiveSrc = src;
    src.start();
  } catch (err) {
    console.warn('[AFK TTS] decode/play failed:', err);
  }
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'AFK_SET_ATTENTION') {
    handler.setAttentionPaused(!msg.enabled);
  }
  if (msg.type === 'AFK_TTS' && msg.text) {
    _ttsWorker.postMessage({ text: msg.text });
  }
});
