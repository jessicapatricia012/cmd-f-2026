// Content script — injected into every page
// Glue layer: connects gesture + voice + HUD modules to background actions.

const CHANNEL = {
  GET_STATE: "AFK_GET_STATE",
  SET_STATE: "AFK_SET_STATE",
  COMMAND: "AFK_COMMAND",
  STATE_UPDATED: "AFK_STATE_UPDATED",
};

const SOURCE = {
  GESTURE: "gesture",
  VOICE: "voice",
};

const INITIAL_STATE = {
  enabled: false,
  gesturesEnabled: true,
  voiceEnabled: true,
  requireWakeWord: true,
  customKeywords: {},
};

let currentState = { ...INITIAL_STATE };
let gestureEngine = null;
let voiceEngine = null;
let lastFocusedEditable = null;
let hud = null;
let debugList = null;
let commandToastEl = null;
let commandToastTimer = null;
let commandToastSwapTimer = null;
let lastCommandToastKey = "";

function hideCommandToast({ flyUp = false } = {}) {
  if (!commandToastEl) return;
  commandToastEl.style.opacity = "0";
  commandToastEl.style.transform = flyUp
    ? "translateX(-50%) translateY(-12px)"
    : "translateX(-50%) translateY(10px)";
}

function initDebugPanel() {
  if (document.getElementById("afk-debug-panel")) {
    debugList = document.getElementById("afk-debug-list");
    return;
  }

  const panel = document.createElement("div");
  panel.id = "afk-debug-panel";
  panel.style.cssText = [
    "position:fixed",
    "right:12px",
    "bottom:12px",
    "z-index:2147483647",
    "width:320px",
    "max-height:40vh",
    "overflow:hidden",
    "border:1px solid #334155",
    "border-radius:8px",
    "background:rgba(2,6,23,.96)",
    "color:#e2e8f0",
    "font:12px/1.4 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    "box-shadow:0 10px 25px rgba(0,0,0,.35)",
  ].join(";");
  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid #334155;">
      <strong style="font-size:11px;letter-spacing:.04em;">AFK DEBUG</strong>
      <button id="afk-debug-clear" style="border:1px solid #334155;background:#0f172a;color:#cbd5e1;border-radius:4px;padding:2px 6px;cursor:pointer;">Clear</button>
    </div>
    <div id="afk-debug-list" style="padding:8px 10px;overflow:auto;max-height:calc(40vh - 40px);"></div>
  `;

  document.documentElement.appendChild(panel);
  debugList = panel.querySelector("#afk-debug-list");

  panel.querySelector("#afk-debug-clear")?.addEventListener("click", () => {
    if (debugList) debugList.innerHTML = "";
  });
}

function debugLog(message, type = "info") {
  if (!debugList) return;
  const color =
    type === "error"
      ? "#fca5a5"
      : type === "warn"
        ? "#fdba74"
        : type === "ok"
          ? "#86efac"
          : "#93c5fd";
  const item = document.createElement("div");
  item.style.marginBottom = "6px";
  item.style.color = color;
  item.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  debugList.prepend(item);
}

function getCommandLabel(action, meta = {}) {
  const labels = {
    "page-down": "Page Down",
    "page-up": "Page Up",
    "go-home": "Home",
    "go-end": "End",
    "zoom-in": "Zoom In",
    "zoom-out": "Zoom Out",
    "next-tab": "Next Tab",
    "prev-tab": "Previous Tab",
    "go-back": "Go Back",
    "go-forward": "Go Forward",
    "new-tab": "New Tab",
    reload: "Reload",
    "video-play": "Video Play",
    "video-pause": "Video Pause",
    "video-next": "Video Next",
    "video-mute": "Video Mute",
    "video-unmute": "Video Unmute",
    "page-refresh": "Refresh",
    "fullscreen-enter": "Fullscreen",
    "fullscreen-exit": "Exit Fullscreen",
    "press-key": meta?.keyLabel ? `Press ${meta.keyLabel}` : "Press Key",
    "click-target": "Click Target",
    "click-text": meta?.labelText ? `Click: ${meta.labelText}` : "Click",
    "click-number": meta?.clickIndex ? `Click #${meta.clickIndex}` : "Click",
    "list-clickable": "Show Clickable",
    "close-list": "Close List",
    "voice-search": meta?.searchQuery ? `Search: ${meta.searchQuery}` : "Voice Search",
  };
  return labels[action] || action;
}

function showCommandToast(action, source, meta = {}) {
  if (!commandToastEl) {
    commandToastEl = document.createElement("div");
    commandToastEl.id = "afk-command-toast";
    commandToastEl.style.cssText = [
      "position:fixed",
      "left:50%",
      "bottom:90px",
      "transform:translateX(-50%) translateY(10px)",
      "z-index:2147483647",
      "padding:10px 14px",
      "border-radius:999px",
      "background:rgba(15,23,42,.94)",
      "color:#e2e8f0",
      "border:1px solid #334155",
      "font:600 12px/1.2 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial",
      "letter-spacing:.02em",
      "opacity:0",
      "transition:opacity .16s ease, transform .16s ease",
      "pointer-events:none",
      "box-shadow:0 10px 25px rgba(0,0,0,.35)",
    ].join(";");
    document.documentElement.appendChild(commandToastEl);
  }

  if (commandToastTimer) clearTimeout(commandToastTimer);
  if (commandToastSwapTimer) clearTimeout(commandToastSwapTimer);

  const sourceLabel = source === SOURCE.VOICE ? "Voice" : "Gesture";
  const nextKey = `${sourceLabel}:${action}`;
  const renderToast = () => {
    if (!commandToastEl) return;
    commandToastEl.textContent = `${sourceLabel}: ${getCommandLabel(action, meta)}`;
    commandToastEl.style.opacity = "1";
    commandToastEl.style.transform = "translateX(-50%) translateY(0)";
    commandToastTimer = setTimeout(() => {
      hideCommandToast();
    }, 1200);
  };

  if (commandToastEl.style.opacity === "1") {
    hideCommandToast({ flyUp: true });
    commandToastSwapTimer = setTimeout(renderToast, 110);
  } else {
    renderToast();
  }

  lastCommandToastKey = nextKey;
}

function mergeState(nextState) {
  currentState = { ...INITIAL_STATE, ...(nextState || {}) };
}

function isAllowedByMode(source) {
  if (source === SOURCE.GESTURE) return currentState.gesturesEnabled;
  if (source === SOURCE.VOICE) return currentState.voiceEnabled;
  return false;
}

function isVoiceCaptureAllowedInThisTab() {
  // Avoid multiple tabs competing for SpeechRecognition.
  return document.visibilityState === "visible" && document.hasFocus();
}

async function sendRuntimeMessage(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    console.warn("[AFK] sendMessage failed:", error);
    return { ok: false, error: String(error) };
  }
}

async function emitCommand(source, action, meta = {}) {
  if (!currentState.enabled || !isAllowedByMode(source)) return;
  if (!action || typeof action !== "string") return;

  const payload = { source, action, ...meta };
  debugLog(`command -> ${source}:${action}`);
  const result = await sendRuntimeMessage({ type: CHANNEL.COMMAND, payload });

  if (result?.ok && !result?.skipped) {
    // For list-clickable, render the overlay with returned items.
    if (action === "list-clickable" && Array.isArray(result.items)) {
      showClickableOverlay(result.items);
    }
    hud?.showFeedback?.({ action, source, labelText: meta?.labelText });
    showCommandToast(action, source, meta);
    const matchedLabel = result.matched ? ` -> "${result.matched}"` : "";
    debugLog(`command ok <- ${action}${matchedLabel}`, "ok");
    return;
  }

  if (result?.skipped) {
    debugLog(
      `command skipped <- ${action} (${result.reason || "unknown"})`,
      "warn",
    );
    console.info("[AFK] Command skipped:", result.reason || "unknown");
    return;
  }

  debugLog(
    `command failed <- ${action}${meta?.labelText ? ` ("${meta.labelText}")` : ""} (${result?.error || "unknown error"})`,
    "error",
  );
  console.warn("[AFK] Command failed:", result?.error || "unknown error");
}

// ── Clickable overlay ──────────────────────────────────────────────────────

const clickableBadges = [];

function removeClickableOverlay() {
  // Remove stale panel if it exists from a previous version
  document.getElementById("afk-clickable-panel")?.remove();
  for (const badge of clickableBadges) {
    badge.remove();
  }
  clickableBadges.length = 0;
  window.__afkClickableItems = null;
}

function showClickableOverlay(items) {
  removeClickableOverlay();
  if (!items || items.length === 0) return;

  // Store items so voice "click-number" can reference them without re-querying DOM
  window.__afkClickableItems = items;

  // ── Numbered badges on page ───────────────────────────────────────────────
  for (const item of items) {
    if (!item.rect) continue;
    const b = document.createElement("div");
    b.style.cssText = [
      "position:fixed",
      `top:${item.rect.top}px`,
      `left:${item.rect.left}px`,
      "z-index:2147483646",
      "min-width:20px",
      "height:20px",
      "border-radius:50%",
      "background:#6366f1",
      "color:#fff",
      "font:700 11px/20px ui-sans-serif,system-ui,-apple-system,sans-serif",
      "text-align:center",
      "padding:0 4px",
      "pointer-events:none",
      "box-shadow:0 2px 6px rgba(0,0,0,.4)",
    ].join(";");
    b.textContent = item.index;
    document.documentElement.appendChild(b);
    clickableBadges.push(b);
  }
}

function updateRuntimeModules() {
  const enabled = Boolean(currentState.enabled);
  const gesturesEnabled = enabled && Boolean(currentState.gesturesEnabled);
  const voiceEnabled =
    enabled &&
    Boolean(currentState.voiceEnabled) &&
    isVoiceCaptureAllowedInThisTab();
  const cameraActive = gesturesEnabled;

  if (gestureEngine?.setEnabled) {
    gestureEngine.setEnabled(gesturesEnabled);
  } else if (gesturesEnabled) {
    gestureEngine?.start?.();
  } else {
    gestureEngine?.stop?.();
  }

  if (voiceEngine?.setEnabled) {
    voiceEngine.setEnabled(voiceEnabled);
  } else if (voiceEnabled) {
    voiceEngine?.start?.();
  } else {
    voiceEngine?.stop?.();
  }

  voiceEngine?.setConfig?.({
    requireWakeWord: Boolean(currentState.requireWakeWord),
    customKeywords: currentState.customKeywords || {},
  });

  hud?.setState?.({
    enabled,
    gesturesEnabled,
    voiceEnabled: enabled && Boolean(currentState.voiceEnabled),
    cameraActive,
  });
}

function resolveFactory(mod, keys) {
  for (const key of keys) {
    if (typeof mod?.[key] === "function") return mod[key];
  }
  return null;
}

async function safeImport(path) {
  try {
    return await import(chrome.runtime.getURL(path));
  } catch (error) {
    debugLog(`import failed: ${path}`, "error");
    console.warn(`[AFK] Could not import ${path}:`, error);
    return null;
  }
}

async function initGestureEngine() {
  const mod = await safeImport("content/gesture-handler.js");
  const factory = resolveFactory(mod, ["createGestureHandler", "default"]);
  if (!factory) return;

  gestureEngine = factory({
    onCommand: (action, meta) => emitCommand(SOURCE.GESTURE, action, meta),
    onStatus: (status) => hud?.setGestureStatus?.(status),
  });
}

async function initVoiceEngine() {
  const mod = await safeImport("content/voice-handler.js");
  const factory = resolveFactory(mod, ["createVoiceHandler", "default"]);
  if (!factory) return;
  let lastTranscriptLog = "";

  voiceEngine = factory({
    onCommand: (action, meta) => {
      const transcript = String(meta?.transcript || "");
      if (transcript) debugLog(`voice heard: "${transcript}"`);
      debugLog(
        `voice parsed: ${action}${meta?.labelText ? ` ("${meta.labelText}")` : meta?.clickIndex != null ? ` (#${meta.clickIndex})` : meta?.keyLabel ? ` (${meta.keyLabel})` : ""}`,
      );
      if (action === "dictate-start") {
        if (lastFocusedEditable) voiceEngine?.setDictationTarget?.(lastFocusedEditable);
        return;
      }
      if (action === "dictate-stop") {
        voiceEngine?.setDictationTarget?.(null);
        return;
      }
      emitCommand(SOURCE.VOICE, action, meta);
    },
    onTranscript: (text, meta) => {
      const cleaned = String(text || "").trim();
      if (!cleaned) return;
      const prefix = meta?.committed ? "voice final" : "voice partial";
      const line = `${prefix}: "${cleaned}"`;
      if (line === lastTranscriptLog) return;
      lastTranscriptLog = line;
      debugLog(line);
    },
    onStatus: (status) => {
      hud?.setVoiceStatus?.(status);
      debugLog(`voice status: ${status}`);
    },
  });
}

async function initHud() {
  const mod = await safeImport("content/hud.js");
  const factory = resolveFactory(mod, ["createHud", "default"]);
  if (!factory) return;

  hud = factory();
}

function isEditableEl(el) {
  if (!el) return false;
  if (el.tagName === "TEXTAREA" || el.isContentEditable) return true;
  if (el.tagName === "INPUT") {
    const t = (el.type || "text").toLowerCase();
    return !["submit","button","checkbox","radio","file","range","color","hidden","image","reset"].includes(t);
  }
  return false;
}

function initDictationBridge() {
  document.addEventListener("focusin", (e) => {
    if (isEditableEl(e.target)) lastFocusedEditable = e.target;
  });
  document.addEventListener("focusout", () => {
    voiceEngine?.setDictationTarget?.(null);
    lastFocusedEditable = null;
  });
}

function initLocalEventBridge() {
  // Teams can dispatch afk:command without direct imports:
  // window.dispatchEvent(new CustomEvent("afk:command", { detail: { source, action, meta } }));
  window.addEventListener("afk:command", (event) => {
    const source = event?.detail?.source;
    const action = event?.detail?.action;
    const meta = event?.detail?.meta || {};
    emitCommand(source, action, meta);
  });

  // Close the clickable overlay when requested by background handlers.
  window.addEventListener("afk:close-clickable-list", () => {
    removeClickableOverlay();
  });
}

function initBackgroundStateListener() {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== CHANNEL.STATE_UPDATED) return;
    mergeState(message.payload);
    updateRuntimeModules();
  });
}

function initTabActivityListeners() {
  document.addEventListener("visibilitychange", () => {
    debugLog(
      `tab visibility: ${document.visibilityState}, focus=${document.hasFocus() ? "yes" : "no"}`,
    );
    updateRuntimeModules();
  });

  window.addEventListener("focus", () => {
    debugLog("tab focus: yes");
    updateRuntimeModules();
  });

  window.addEventListener("blur", () => {
    debugLog("tab focus: no");
    updateRuntimeModules();
  });
}

async function syncInitialState() {
  const response = await sendRuntimeMessage({ type: CHANNEL.GET_STATE });
  if (response?.ok && response.state) {
    mergeState(response.state);
  }
}

async function bootstrap() {
  initDebugPanel();
  debugLog("content script boot");
  await Promise.all([initHud(), initGestureEngine(), initVoiceEngine()]);
  initDictationBridge();
  initLocalEventBridge();
  initBackgroundStateListener();
  initTabActivityListeners();
  await syncInitialState();
  debugLog(
    `state: enabled=${currentState.enabled} voice=${currentState.voiceEnabled} wake=${currentState.requireWakeWord}`,
  );
  updateRuntimeModules();
}

bootstrap();
// Receives gesture messages from the service worker (relayed from offscreen.js)
// and translates them into DOM interactions.

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Finger cursor overlay
  // ---------------------------------------------------------------------------
  const cursor = document.createElement("div");
  Object.assign(cursor.style, {
    position: "fixed",
    width: "22px",
    height: "22px",
    borderRadius: "50%",
    background: "rgba(99, 102, 241, 0.85)",
    border: "2.5px solid white",
    boxShadow: "0 0 10px rgba(99,102,241,0.55)",
    pointerEvents: "none",
    zIndex: "2147483646",
    transform: "translate(-50%, -50%)",
    transition: "background 0.15s, box-shadow 0.15s",
    display: "none",
  });
  document.body.appendChild(cursor);

  const label = document.createElement("div");
  Object.assign(label.style, {
    position: "fixed",
    padding: "3px 8px",
    borderRadius: "999px",
    background: "rgba(0,0,0,0.65)",
    color: "#fff",
    fontSize: "11px",
    fontFamily: "system-ui, sans-serif",
    pointerEvents: "none",
    zIndex: "2147483646",
    display: "none",
    transform: "translate(-50%, -150%)",
    whiteSpace: "nowrap",
  });
  document.body.appendChild(label);

  const CURSOR_SMOOTHING = 0.22;
  const USE_DWELL_CLICK = true;
  const DWELL_CLICK_MS = 700;
  const DWELL_RADIUS_PX = 16;
  const DWELL_COOLDOWN_MS = 900;
  const DWELL_SCROLL_SUPPRESS_MS = 500;
  const EDGE_TAB_SWITCH_ENABLED = false;
  const EDGE_ZONE_RATIO = 0.08;
  const EDGE_SWIPE_WINDOW_MS = 700;
  const EDGE_SWIPE_MIN_SPEED_PX_PER_S = 650;
  const EDGE_SWIPE_MIN_TRAVEL_RATIO = 0.18;
  const EDGE_SWIPE_START_CENTER_RATIO = 0.7;
  const EDGE_TAB_COOLDOWN_MS = 900;
  const CURSOR_LOST_GRACE_MS = 280;
  let cursorTargetX = 0;
  let cursorTargetY = 0;
  let cursorRenderX = 0;
  let cursorRenderY = 0;
  let cursorAnimFrame = null;
  let currentCursorState = "idle";
  let dwellAnchorX = 0;
  let dwellAnchorY = 0;
  let dwellStartMs = 0;
  let dwellLastClickMs = 0;
  let dwellLocked = false;
  let dwellSuppressUntilMs = 0;
  let edgeLastSwitchMs = 0;
  let edgeSwipeStartX = 0;
  let edgeSwipeStartMs = 0;
  let cursorLostTimer = null;

  function paintCursor(x, y) {
    cursor.style.left = x + "px";
    cursor.style.top = y + "px";
    label.style.left = x + "px";
    label.style.top = y + "px";
  }

  function startCursorAnimation() {
    if (cursorAnimFrame != null) return;
    const tick = () => {
      cursorRenderX += (cursorTargetX - cursorRenderX) * CURSOR_SMOOTHING;
      cursorRenderY += (cursorTargetY - cursorRenderY) * CURSOR_SMOOTHING;
      paintCursor(cursorRenderX, cursorRenderY);
      cursorAnimFrame = requestAnimationFrame(tick);
    };
    cursorAnimFrame = requestAnimationFrame(tick);
  }

  function stopCursorAnimation() {
    if (cursorAnimFrame == null) return;
    cancelAnimationFrame(cursorAnimFrame);
    cursorAnimFrame = null;
  }

  function setCursorPos(x, y) {
    cursorTargetX = x;
    cursorTargetY = y;
    if (cursorAnimFrame == null) {
      cursorRenderX = x;
      cursorRenderY = y;
      paintCursor(x, y);
      startCursorAnimation();
    }
  }

  function setCursorState(state) {
    const states = {
      idle: {
        bg: "rgba(99,102,241,0.85)",
        shadow: "0 0 10px rgba(99,102,241,0.55)",
        text: null,
      },
      drag: {
        bg: "rgba(239,68,68,0.85)",
        shadow: "0 0 12px rgba(239,68,68,0.6)",
        text: "drag",
      },
      scroll: {
        bg: "rgba(34,197,94,0.85)",
        shadow: "0 0 12px rgba(34,197,94,0.6)",
        text: "scroll",
      },
      tabswitch: {
        bg: "rgba(245,158,11,0.9)",
        shadow: "0 0 12px rgba(245,158,11,0.6)",
        text: "tab switch",
      },
    };
    const s = states[state] || states.idle;
    currentCursorState = state;
    cursor.style.background = s.bg;
    cursor.style.boxShadow = s.shadow;
    if (s.text) {
      label.textContent = s.text;
      label.style.display = "block";
    } else {
      label.style.display = "none";
    }
  }

  // Convert normalised (0-1) coords from offscreen.js to screen pixels
  function toScreen(normX, normY) {
    return { x: normX * window.innerWidth, y: normY * window.innerHeight };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  let dragTarget = null;
  let scrollResetTimer;

  function elementAt(x, y) {
    cursor.style.display = "none";
    label.style.display = "none";
    const el = document.elementFromPoint(x, y);
    cursor.style.display = "block";
    return el;
  }

  function findScrollable(x, y, dy) {
    let el = document.elementFromPoint(x, y);
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      const overflow = style.overflow + style.overflowY;
      const canScroll = /auto|scroll/.test(overflow);
      const hasRoom =
        dy > 0
          ? el.scrollTop + el.clientHeight < el.scrollHeight
          : el.scrollTop > 0;
      if (canScroll && hasRoom) return el;
      el = el.parentElement;
    }
    return window;
  }

  function dispatchClickAt(x, y) {
    cursor.style.transform = "translate(-50%, -50%) scale(0.55)";
    setTimeout(() => {
      cursor.style.transform = "translate(-50%, -50%) scale(1)";
    }, 140);
    const el = elementAt(x, y);
    if (!el) return;
    el.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        view: window,
      }),
    );
    el.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        view: window,
      }),
    );
    el.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        view: window,
      }),
    );
    if (el.matches("input, textarea, select, [contenteditable]")) el.focus();
  }

  function updateDwellClick(x, y) {
    if (!USE_DWELL_CLICK) return;

    const now = Date.now();
    if (now < dwellSuppressUntilMs || currentCursorState === "scroll") {
      dwellAnchorX = x;
      dwellAnchorY = y;
      dwellStartMs = now;
      return;
    }

    if (!dwellStartMs) {
      dwellAnchorX = x;
      dwellAnchorY = y;
      dwellStartMs = now;
      return;
    }

    const moved = Math.hypot(x - dwellAnchorX, y - dwellAnchorY);

    if (dwellLocked) {
      // Rearm dwell click only after meaningful movement away from clicked point.
      if (moved > DWELL_RADIUS_PX * 1.6) {
        dwellLocked = false;
        dwellAnchorX = x;
        dwellAnchorY = y;
        dwellStartMs = now;
      }
      return;
    }

    if (moved > DWELL_RADIUS_PX) {
      dwellAnchorX = x;
      dwellAnchorY = y;
      dwellStartMs = now;
      return;
    }

    if (
      now - dwellStartMs >= DWELL_CLICK_MS &&
      now - dwellLastClickMs >= DWELL_COOLDOWN_MS
    ) {
      dispatchClickAt(x, y);
      dwellLastClickMs = now;
      dwellLocked = true;
    }
  }

  function updateEdgeTabSwitch(x) {
    if (!EDGE_TAB_SWITCH_ENABLED) return false;

    const now = Date.now();
    if (now - edgeLastSwitchMs < EDGE_TAB_COOLDOWN_MS) return false;
    if (currentCursorState === "scroll") return false;

    const leftZone = window.innerWidth * EDGE_ZONE_RATIO;
    const rightZone = window.innerWidth * (1 - EDGE_ZONE_RATIO);
    const centerHalf = (window.innerWidth * EDGE_SWIPE_START_CENTER_RATIO) / 2;
    const centerMin = window.innerWidth / 2 - centerHalf;
    const centerMax = window.innerWidth / 2 + centerHalf;

    if (!edgeSwipeStartMs) {
      edgeSwipeStartX = x;
      edgeSwipeStartMs = now;
      return false;
    }

    let dt = now - edgeSwipeStartMs;
    if (dt > EDGE_SWIPE_WINDOW_MS) {
      edgeSwipeStartX = x;
      edgeSwipeStartMs = now;
      dt = 0;
    }
    if (dt <= 0) return false;

    const dx = x - edgeSwipeStartX;
    const speed = Math.abs(dx) / (dt / 1000);
    const minTravel = window.innerWidth * EDGE_SWIPE_MIN_TRAVEL_RATIO;
    const startFromCenter =
      edgeSwipeStartX >= centerMin && edgeSwipeStartX <= centerMax;

    let direction = null;
    if (dx > 0 && x >= rightZone) direction = "next";
    if (dx < 0 && x <= leftZone) direction = "prev";

    if (
      direction &&
      startFromCenter &&
      Math.abs(dx) >= minTravel &&
      speed >= EDGE_SWIPE_MIN_SPEED_PX_PER_S
    ) {
      chrome.runtime
        .sendMessage({ type: "tabswitch", direction })
        .catch(() => {});
      edgeLastSwitchMs = now;
      edgeSwipeStartX = x;
      edgeSwipeStartMs = now;
      dwellSuppressUntilMs = now + DWELL_SCROLL_SUPPRESS_MS;
      return true;
    }

    return false;
  }

  // ---------------------------------------------------------------------------
  // Gesture → DOM action bindings
  // Gesture messages arrive via chrome.runtime.onMessage from the service worker.
  // Positions are normalised [0, 1]; toScreen() converts to page pixels.
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== "gesture") return;
    const { event, detail } = msg;

    if (event === "gesture:cursor") {
      if (cursorLostTimer) {
        clearTimeout(cursorLostTimer);
        cursorLostTimer = null;
      }
      const { x, y } = toScreen(detail.normX, detail.normY);
      setCursorPos(x, y);
      const edgeActive = updateEdgeTabSwitch(x);
      if (!edgeActive) updateDwellClick(x, y);
      if (cursor.style.display === "none") {
        cursor.style.display = "block";
        setCursorState("idle");
      }
    } else if (event === "gesture:none") {
      if (cursorLostTimer) clearTimeout(cursorLostTimer);
      cursorLostTimer = setTimeout(() => {
        cursor.style.display = "none";
        label.style.display = "none";
        stopCursorAnimation();
        dwellStartMs = 0;
        dwellLocked = false;
        edgeSwipeStartMs = 0;
        cursorLostTimer = null;
      }, CURSOR_LOST_GRACE_MS);
    } else if (event === "gesture:click") {
      if (!USE_DWELL_CLICK) {
        const { x, y } = toScreen(detail.normX, detail.normY);
        dispatchClickAt(x, y);
      }
    } else if (event === "gesture:dragstart") {
      const { x, y } = toScreen(detail.normX, detail.normY);
      dragTarget = elementAt(x, y);
      if (dragTarget) {
        dragTarget.dispatchEvent(
          new MouseEvent("mousedown", {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            view: window,
          }),
        );
      }
      setCursorState("drag");
    } else if (event === "gesture:drag") {
      const { x, y } = toScreen(detail.normX, detail.normY);
      setCursorPos(x, y);
      document.dispatchEvent(
        new MouseEvent("mousemove", {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          view: window,
        }),
      );
    } else if (event === "gesture:dragend") {
      const { x, y } = toScreen(detail.normX, detail.normY);
      const target = elementAt(x, y);
      [dragTarget, target].forEach((el) => {
        if (el)
          el.dispatchEvent(
            new MouseEvent("mouseup", {
              bubbles: true,
              cancelable: true,
              clientX: x,
              clientY: y,
              view: window,
            }),
          );
      });
      dragTarget = null;
      setCursorState("idle");
    } else if (event === "gesture:scroll") {
      const { dx, dy } = detail;
      setCursorState("scroll");
      dwellSuppressUntilMs = Date.now() + DWELL_SCROLL_SUPPRESS_MS;
      clearTimeout(scrollResetTimer);
      scrollResetTimer = setTimeout(() => setCursorState("idle"), 400);
      const pos = {
        x: parseFloat(cursor.style.left),
        y: parseFloat(cursor.style.top),
      };
      const scrollable = findScrollable(pos.x, pos.y, dy);
      if (scrollable && scrollable !== document.documentElement) {
        scrollable.scrollBy({ left: dx, top: dy, behavior: "auto" });
      } else {
        window.scrollBy({ left: dx, top: dy, behavior: "auto" });
      }
    } else if (event === "gesture:zoom") {
      chrome.runtime.sendMessage({ type: "zoom", direction: detail.direction });
    } else if (event === "gesture:navigate") {
      if (detail.direction === "back") history.back();
      else history.forward();
    } else if (event === "gesture:tabswitch:start") {
      setCursorState("tabswitch");
    } else if (event === "gesture:tabswitch:drag") {
      // Shift label slightly so the user can see drag progress
      const base = parseFloat(cursor.style.left) || 0;
      label.style.left = base + detail.normDx * window.innerWidth * 0.3 + "px";
    } else if (event === "gesture:tabswitch:end") {
      setCursorState("idle");
      chrome.runtime.sendMessage({
        type: "tabswitch",
        direction: detail.normDx > 0 ? "next" : "prev",
      });
    }
  });
})();
bootstrap();