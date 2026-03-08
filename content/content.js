// Content script — injected into every page
// Glue layer: connects gesture + voice + HUD modules to background actions.

const CHANNEL = {
  GET_STATE: "AFK_GET_STATE",
  GET_ATTENTION_STATUS: "AFK_GET_ATTENTION_STATUS",
  SET_STATE: "AFK_SET_STATE",
  COMMAND: "AFK_COMMAND",
  STATE_UPDATED: "AFK_STATE_UPDATED",
};

const SOURCE = {
  GESTURE: "gesture",
  VOICE: "voice",
  SYSTEM: "system",
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
let hud = null;
let debugList = null;
let commandToastEl = null;
let commandToastTimer = null;
let commandToastSwapTimer = null;
let lastCommandToastKey = "";
let attentionAutoPaused = false;
let attentionPauseTimer = null;
let eyeAttentionState = "unknown";
let eyeAwayDebounceTimer = null;
let eyeBackDebounceTimer = null;
let eyeAttentionBadgeEl = null;
let eyeGazeDotEl = null;
let eyeAttentionSignalSeen = false;
let eyeAttentionInitTimer = null;

function hideCommandToast({ flyUp = false } = {}) {
  if (!commandToastEl) return;
  commandToastEl.style.opacity = "0";
  commandToastEl.style.transform = flyUp
    ? "translateX(-50%) translateY(-12px)"
    : "translateX(-50%) translateY(10px)";
}

function ensureEyeAttentionBadge() {
  if (eyeAttentionBadgeEl) return eyeAttentionBadgeEl;
  const el = document.createElement("div");
  el.id = "afk-eye-attention-badge";
  el.style.cssText = [
    "position:fixed",
    "left:12px",
    "top:12px",
    "z-index:2147483647",
    "padding:6px 10px",
    "border-radius:999px",
    "font:700 11px/1.1 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial",
    "letter-spacing:.02em",
    "border:1px solid #334155",
    "background:rgba(15,23,42,.9)",
    "color:#cbd5e1",
    "box-shadow:0 8px 20px rgba(0,0,0,.35)",
    "pointer-events:none",
    "user-select:none",
  ].join(";");
  document.documentElement.appendChild(el);
  eyeAttentionBadgeEl = el;
  return el;
}

function ensureEyeGazeDot() {
  if (eyeGazeDotEl) return eyeGazeDotEl;
  const dot = document.createElement("div");
  dot.id = "afk-eye-gaze-dot";
  dot.style.cssText = [
    "position:fixed",
    "left:0",
    "top:0",
    "width:12px",
    "height:12px",
    "border-radius:50%",
    "background:#22d3ee",
    "border:2px solid #0e7490",
    "box-shadow:0 0 0 2px rgba(15,23,42,.6), 0 0 14px rgba(34,211,238,.65)",
    "transform:translate(-50%,-50%)",
    "z-index:2147483647",
    "pointer-events:none",
    "opacity:0",
    "transition:opacity .12s ease",
  ].join(";");
  document.documentElement.appendChild(dot);
  eyeGazeDotEl = dot;
  return dot;
}

function updateEyeGazeDot(detail = {}) {
  const x = Number(detail?.normX);
  const y = Number(detail?.normY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const dot = ensureEyeGazeDot();
  const px = Math.max(0, Math.min(window.innerWidth, x * window.innerWidth));
  const py = Math.max(0, Math.min(window.innerHeight, y * window.innerHeight));
  dot.style.left = `${px}px`;
  dot.style.top = `${py}px`;
  dot.style.opacity = "1";
}

function renderEyeAttentionBadge(state, detail = {}) {
  const el = ensureEyeAttentionBadge();
  const stableForMs = Number(detail?.stableForMs) || 0;
  const stableText = stableForMs > 0 ? ` ${Math.round(stableForMs)}ms` : "";

  if (state === "looking") {
    el.textContent = `EYE: LOOKING${stableText}`;
    el.style.background = "rgba(6,78,59,.92)";
    el.style.borderColor = "#065f46";
    el.style.color = "#bbf7d0";
    return;
  }

  if (state === "away") {
    el.textContent = `EYE: AWAY${stableText}`;
    el.style.background = "rgba(127,29,29,.92)";
    el.style.borderColor = "#7f1d1d";
    el.style.color = "#fecaca";
    return;
  }

  if (state === "unsupported") {
    const reason = detail?.reason ? ` (${detail.reason})` : "";
    el.textContent = `EYE: UNSUPPORTED${reason}`;
    el.style.background = "rgba(120,53,15,.94)";
    el.style.borderColor = "#92400e";
    el.style.color = "#fed7aa";
    return;
  }

  if (state === "no-face") {
    el.textContent = "EYE: NO FACE";
    el.style.background = "rgba(127,29,29,.92)";
    el.style.borderColor = "#7f1d1d";
    el.style.color = "#fecaca";
    return;
  }

  if (state === "face-detected") {
    el.textContent = "EYE: FACE DETECTED";
    el.style.background = "rgba(30,58,138,.92)";
    el.style.borderColor = "#1e40af";
    el.style.color = "#bfdbfe";
    return;
  }

  if (state === "face-uncertain") {
    el.textContent = "EYE: FACE UNCERTAIN";
    el.style.background = "rgba(30,58,138,.92)";
    el.style.borderColor = "#1e40af";
    el.style.color = "#bfdbfe";
    return;
  }

  if (state === "ready") {
    const engine = detail?.engine ? ` (${detail.engine})` : "";
    el.textContent = `EYE: READY${engine}`;
    el.style.background = "rgba(6,78,59,.92)";
    el.style.borderColor = "#065f46";
    el.style.color = "#bbf7d0";
    return;
  }

  el.textContent = "EYE: UNKNOWN";
  el.style.background = "rgba(15,23,42,.9)";
  el.style.borderColor = "#334155";
  el.style.color = "#cbd5e1";
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
  if (source === SOURCE.SYSTEM) return true;
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

function isVideoPlayingNow() {
  const ytPlayer = document.getElementById("movie_player");
  if (ytPlayer && typeof ytPlayer.getPlayerState === "function") {
    if (ytPlayer.getPlayerState() === 1) return true;
  }

  const videos = Array.from(document.querySelectorAll("video"));
  return videos.some((video) => !video.paused && !video.ended && video.readyState >= 2);
}

async function maybePauseOnAttentionLost(reason = "attention-lost") {
  if (!currentState.enabled || attentionAutoPaused) return;
  if (!isVideoPlayingNow()) return;
  if (eyeAttentionState === "unknown") return;

  await emitCommand(SOURCE.SYSTEM, "video-pause", { reason });
  attentionAutoPaused = true;
  debugLog("attention auto-pause: video paused", "warn");
}

async function maybeResumeOnAttentionBack(reason = "attention-back") {
  if (!currentState.enabled || !attentionAutoPaused) return;
  if (eyeAttentionState === "away") return;

  await emitCommand(SOURCE.SYSTEM, "video-play", { reason });
  attentionAutoPaused = false;
  debugLog("attention auto-resume: video resumed", "ok");
}

function handleEyeAttentionEvent(eventName, detail = {}) {
  eyeAttentionSignalSeen = true;

  if (eventName === "attention:look-away") {
    eyeAttentionState = "away";
    renderEyeAttentionBadge("away", detail);
    debugLog("eye attention: look-away", "warn");
    if (eyeBackDebounceTimer) {
      clearTimeout(eyeBackDebounceTimer);
      eyeBackDebounceTimer = null;
    }
    if (eyeAwayDebounceTimer) clearTimeout(eyeAwayDebounceTimer);
    eyeAwayDebounceTimer = setTimeout(() => {
      eyeAwayDebounceTimer = null;
      maybePauseOnAttentionLost("eye-look-away");
    }, 180);
    return;
  }

  if (eventName === "attention:look-at") {
    eyeAttentionState = "looking";
    renderEyeAttentionBadge("looking", detail);
    debugLog("eye attention: look-at", "ok");
    if (eyeAwayDebounceTimer) {
      clearTimeout(eyeAwayDebounceTimer);
      eyeAwayDebounceTimer = null;
    }
    if (eyeBackDebounceTimer) clearTimeout(eyeBackDebounceTimer);
    eyeBackDebounceTimer = setTimeout(() => {
      eyeBackDebounceTimer = null;
      maybeResumeOnAttentionBack("eye-look-at");
    }, 220);
  }
}

function handleEyeAttentionStatus(detail = {}) {
  const state = String(detail?.state || "").trim();
  if (!state) return;
  eyeAttentionSignalSeen = true;
  const visualStates = new Set([
    "looking",
    "away",
    "unsupported",
    "no-face",
    "face-detected",
    "face-uncertain",
    "ready",
  ]);
  if (visualStates.has(state)) {
    renderEyeAttentionBadge(state, detail);
  }
  if (state === "ready") {
    const dot = ensureEyeGazeDot();
    dot.style.left = `${Math.round(window.innerWidth * 0.5)}px`;
    dot.style.top = `${Math.round(window.innerHeight * 0.5)}px`;
    dot.style.opacity = "0.35";
  }
  if (state === "no-face" || state === "unsupported") {
    if (eyeGazeDotEl) eyeGazeDotEl.style.opacity = "0";
  }
  if (state === "unsupported") {
    debugLog(`eye attention unsupported: ${detail?.reason || "unknown"}`, "warn");
  } else if (state === "ready") {
    debugLog(`eye attention ready: ${detail?.engine || "unknown engine"}`, "ok");
  } else if (
    state === "mesh-send" ||
    state === "mesh-send-ok" ||
    state === "mesh-results"
  ) {
    const extra =
      detail?.reason
        ? ` (${detail.reason})`
        : detail?.points
          ? ` (points=${detail.points})`
          : "";
    const type = state === "mesh-send-failed" ? "error" : "info";
    debugLog(`eye attention ${state}${extra}`, type);
  }
}

function handleAttentionAction(detail = {}) {
  const action = detail?.action || detail?.eventName || "attention";
  if (detail?.ok === false) {
    debugLog(`attention action failed: ${action} (${detail?.error || detail?.reason || "unknown"})`, "error");
    return;
  }
  if (detail?.skipped) {
    debugLog(`attention action skipped: ${action} (${detail?.reason || "unknown"})`, "warn");
    return;
  }
  debugLog(`attention action ok: ${action}`, "ok");
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

  // Bridge attention events from localhost companion page -> extension runtime.
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data || {};
    if (data?.type !== "AFK_EXTERNAL_ATTENTION") return;
    if (!String(data?.event || "").startsWith("attention:")) return;
    const isLocalCompanionHost =
      location.hostname === "localhost" || location.hostname === "127.0.0.1";
    if (!isLocalCompanionHost) return;
    sendRuntimeMessage({
      type: "AFK_EXTERNAL_ATTENTION",
      payload: {
        event: data.event,
        detail: data.detail || {},
      },
    }).catch(() => {});
  });
}

function initBackgroundStateListener() {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "gesture") {
      const eventName = message?.event;
      if (
        eventName === "attention:look-away" ||
        eventName === "attention:look-at"
      ) {
        handleEyeAttentionEvent(eventName, message?.detail || {});
      } else if (eventName === "attention:status") {
        handleEyeAttentionStatus(message?.detail || {});
      } else if (eventName === "attention:gaze") {
        updateEyeGazeDot(message?.detail || {});
      } else if (eventName === "attention:action") {
        handleAttentionAction(message?.detail || {});
      }
      return;
    }

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

    if (document.visibilityState === "hidden") {
      if (attentionPauseTimer) clearTimeout(attentionPauseTimer);
      attentionPauseTimer = setTimeout(() => {
        attentionPauseTimer = null;
        if (eyeAttentionState !== "unknown") {
          maybePauseOnAttentionLost("tab-hidden");
        }
      }, 900);
    } else {
      if (attentionPauseTimer) {
        clearTimeout(attentionPauseTimer);
        attentionPauseTimer = null;
      }
      maybeResumeOnAttentionBack("tab-visible");
    }
  });

  window.addEventListener("focus", () => {
    debugLog("tab focus: yes");
    updateRuntimeModules();
    if (attentionPauseTimer) {
      clearTimeout(attentionPauseTimer);
      attentionPauseTimer = null;
    }
    if (eyeAttentionState !== "unknown") {
      maybeResumeOnAttentionBack("tab-focus");
    }
  });

  window.addEventListener("blur", () => {
    debugLog("tab focus: no");
    updateRuntimeModules();
    // Blur can happen from transient UI focus changes (e.g. extension popup),
    // so avoid auto-pausing here to reduce false positives.
  });
}

async function syncInitialState() {
  const response = await sendRuntimeMessage({ type: CHANNEL.GET_STATE });
  if (response?.ok && response.state) {
    mergeState(response.state);
  }
}

async function syncInitialAttentionStatus() {
  const response = await sendRuntimeMessage({
    type: CHANNEL.GET_ATTENTION_STATUS,
  });
  if (!response?.ok || !response?.event) return;
  if (response.event === "attention:status") {
    handleEyeAttentionStatus(response.detail || {});
    return;
  }
  if (
    response.event === "attention:look-away" ||
    response.event === "attention:look-at"
  ) {
    handleEyeAttentionEvent(response.event, response.detail || {});
  }
}

async function bootstrap() {
  initDebugPanel();
  renderEyeAttentionBadge("unknown");
  if (eyeAttentionInitTimer) clearTimeout(eyeAttentionInitTimer);
  eyeAttentionInitTimer = setTimeout(() => {
    if (!eyeAttentionSignalSeen && eyeAttentionState === "unknown") {
      renderEyeAttentionBadge("unsupported", {
        reason: "no attention events from offscreen",
      });
      debugLog("eye attention: no events received from offscreen", "warn");
    }
  }, 5000);
  debugLog("content script boot");
  await Promise.all([initHud(), initGestureEngine(), initVoiceEngine()]);
  initLocalEventBridge();
  initBackgroundStateListener();
  initTabActivityListeners();
  await syncInitialState();
  await syncInitialAttentionStatus();
  debugLog(
    `state: enabled=${currentState.enabled} voice=${currentState.voiceEnabled} wake=${currentState.requireWakeWord}`,
  );
  updateRuntimeModules();
}

bootstrap();
