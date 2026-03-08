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
  faceAttentionEnabled: true,
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
let debugGestureLog = null;
let debugFaceLog = null;
let debugVoiceLog = null;
let debugGestureStatus = null;
let debugFaceStatus = null;
let debugVoiceStatus = null;
let handCursorDotEl = null;
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
let lastVideoPresence = null;

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

function ensureHandCursorDot() {
  if (handCursorDotEl) return handCursorDotEl;
  const dot = document.createElement("div");
  dot.id = "afk-hand-cursor-dot";
  dot.style.cssText = [
    "position:fixed",
    "left:0",
    "top:0",
    "width:18px",
    "height:18px",
    "border-radius:50%",
    "background:rgba(234,88,12,.85)",
    "border:2px solid #fff",
    "box-shadow:0 0 0 2px rgba(234,88,12,.4), 0 0 16px rgba(234,88,12,.5)",
    "transform:translate(-50%,-50%)",
    "z-index:2147483647",
    "pointer-events:none",
    "opacity:0",
    "transition:opacity .1s ease",
  ].join(";");
  document.documentElement.appendChild(dot);
  handCursorDotEl = dot;
  return dot;
}

function updateHandCursorDot(detail = {}) {
  const x = Number(detail?.normX);
  const y = Number(detail?.normY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const dot = ensureHandCursorDot();
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
    debugGestureLog = document.getElementById("afk-debug-gesture");
    debugFaceLog = document.getElementById("afk-debug-face");
    debugVoiceLog = document.getElementById("afk-debug-voice");
    debugGestureStatus = document.getElementById("afk-debug-gesture-status");
    debugFaceStatus = document.getElementById("afk-debug-face-status");
    debugVoiceStatus = document.getElementById("afk-debug-voice-status");
    return;
  }

  const panel = document.createElement("div");
  panel.id = "afk-debug-panel";
  panel.style.cssText = [
    "position:fixed",
    "right:12px",
    "bottom:12px",
    "z-index:2147483647",
    "width:340px",
    "max-height:45vh",
    "overflow:hidden",
    "border:1px solid #334155",
    "border-radius:8px",
    "background:rgba(2,6,23,.96)",
    "color:#e2e8f0",
    "font:12px/1.4 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    "box-shadow:0 10px 25px rgba(0,0,0,.35)",
  ].join(";");
  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border-bottom:1px solid #334155;">
      <strong style="font-size:11px;letter-spacing:.04em;">AFK DEBUG</strong>
      <button id="afk-debug-clear" style="border:1px solid #334155;background:#0f172a;color:#cbd5e1;border-radius:4px;padding:2px 6px;cursor:pointer;font-size:10px;">Clear</button>
    </div>
    <div id="afk-debug-tabs" style="display:flex;gap:0;border-bottom:1px solid #334155;">
      <button class="afk-dtab afk-dtab--active" data-tab="gesture" style="flex:1;padding:6px 4px;border:none;background:none;color:#e2e8f0;font:600 11px/1 ui-sans-serif,system-ui,sans-serif;cursor:pointer;border-bottom:2px solid #f97316;transition:all .12s;">✋ Gesture</button>
      <button class="afk-dtab" data-tab="face" style="flex:1;padding:6px 4px;border:none;background:none;color:#64748b;font:600 11px/1 ui-sans-serif,system-ui,sans-serif;cursor:pointer;border-bottom:2px solid transparent;transition:all .12s;">👁 Face</button>
      <button class="afk-dtab" data-tab="voice" style="flex:1;padding:6px 4px;border:none;background:none;color:#64748b;font:600 11px/1 ui-sans-serif,system-ui,sans-serif;cursor:pointer;border-bottom:2px solid transparent;transition:all .12s;">🎙 Voice</button>
    </div>
    <div id="afk-debug-gesture-status" style="padding:4px 10px;font:600 11px/1.3 ui-sans-serif,system-ui,sans-serif;color:#94a3b8;background:rgba(15,23,42,.6);border-bottom:1px solid #1e293b;">Waiting…</div>
    <div id="afk-debug-face-status" style="padding:4px 10px;font:600 11px/1.3 ui-sans-serif,system-ui,sans-serif;color:#94a3b8;background:rgba(15,23,42,.6);border-bottom:1px solid #1e293b;display:none;">Waiting…</div>
    <div id="afk-debug-voice-status" style="padding:4px 10px;font:600 11px/1.3 ui-sans-serif,system-ui,sans-serif;color:#94a3b8;background:rgba(15,23,42,.6);border-bottom:1px solid #1e293b;display:none;">Waiting…</div>
    <div id="afk-debug-gesture" style="padding:6px 10px;overflow:auto;max-height:calc(45vh - 100px);"></div>
    <div id="afk-debug-face" style="padding:6px 10px;overflow:auto;max-height:calc(45vh - 100px);display:none;"></div>
    <div id="afk-debug-voice" style="padding:6px 10px;overflow:auto;max-height:calc(45vh - 100px);display:none;"></div>
    <div id="afk-debug-list" style="display:none;"></div>
  `;

  document.documentElement.appendChild(panel);
  debugList = panel.querySelector("#afk-debug-list");
  debugGestureLog = panel.querySelector("#afk-debug-gesture");
  debugFaceLog = panel.querySelector("#afk-debug-face");
  debugVoiceLog = panel.querySelector("#afk-debug-voice");
  debugGestureStatus = panel.querySelector("#afk-debug-gesture-status");
  debugFaceStatus = panel.querySelector("#afk-debug-face-status");
  debugVoiceStatus = panel.querySelector("#afk-debug-voice-status");

  let activeDebugTab = "gesture";
  panel.querySelector("#afk-debug-clear")?.addEventListener("click", () => {
    const logMap = {
      gesture: debugGestureLog,
      face: debugFaceLog,
      voice: debugVoiceLog,
    };
    const target = logMap[activeDebugTab];
    if (target) target.innerHTML = "";
  });

  const tabs = panel.querySelectorAll(".afk-dtab");
  const tabColors = { gesture: "#f97316", face: "#22d3ee", voice: "#a78bfa" };
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      activeDebugTab = target;
      tabs.forEach((t) => {
        const isActive = t.dataset.tab === target;
        t.classList.toggle("afk-dtab--active", isActive);
        t.style.color = isActive ? "#e2e8f0" : "#64748b";
        t.style.borderBottomColor = isActive
          ? tabColors[t.dataset.tab] || "#e2e8f0"
          : "transparent";
      });
      [debugGestureLog, debugFaceLog, debugVoiceLog].forEach((el) => {
        if (el) el.style.display = "none";
      });
      [debugGestureStatus, debugFaceStatus, debugVoiceStatus].forEach((el) => {
        if (el) el.style.display = "none";
      });
      const logMap = {
        gesture: debugGestureLog,
        face: debugFaceLog,
        voice: debugVoiceLog,
      };
      const statusMap = {
        gesture: debugGestureStatus,
        face: debugFaceStatus,
        voice: debugVoiceStatus,
      };
      if (logMap[target]) logMap[target].style.display = "";
      if (statusMap[target]) statusMap[target].style.display = "";
    });
  });
}

const DEBUG_MAX_ENTRIES = 50;

function debugAppendToLog(logEl, message, type = "info") {
  if (!logEl) return;
  const color =
    type === "error"
      ? "#fca5a5"
      : type === "warn"
        ? "#fdba74"
        : type === "ok"
          ? "#86efac"
          : "#93c5fd";
  const item = document.createElement("div");
  item.style.cssText = `margin-bottom:4px;color:${color};font-size:11px;line-height:1.4;word-break:break-word;`;
  const ts = new Date().toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  item.textContent = `[${ts}] ${message}`;
  logEl.prepend(item);
  while (logEl.children.length > DEBUG_MAX_ENTRIES) logEl.lastChild.remove();
}

function debugSetStatus(statusEl, text, color = "#94a3b8") {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.style.color = color;
}

function debugLogGesture(message, type = "info") {
  if (!currentState.enabled) return;
  debugAppendToLog(debugGestureLog, message, type);
}

function debugLogFace(message, type = "info") {
  if (!currentState.enabled) return;
  debugAppendToLog(debugFaceLog, message, type);
}

function debugLogVoice(message, type = "info") {
  if (!currentState.enabled) return;
  debugAppendToLog(debugVoiceLog, message, type);
}

function debugLog(message, type = "info") {
  if (!currentState.enabled) return;
  debugAppendToLog(debugGestureLog, message, type);
}

function setDebugUIVisible(visible) {
  const debugPanel = document.getElementById("afk-debug-panel");
  if (debugPanel) debugPanel.style.display = visible ? "" : "none";
  const faceVisible =
    visible &&
    currentState.faceAttentionEnabled !== false &&
    lastVideoPresence === true;
  if (eyeAttentionBadgeEl)
    eyeAttentionBadgeEl.style.display = faceVisible ? "" : "none";
  if (eyeGazeDotEl) eyeGazeDotEl.style.display = faceVisible ? "" : "none";
  // Keep only the primary blue cursor overlay to avoid duplicate cursor visuals.
  if (handCursorDotEl) handCursorDotEl.style.display = "none";
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
    "voice-search": meta?.searchQuery
      ? `Search: ${meta.searchQuery}`
      : "Voice Search",
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

function checkVideoPresence() {
  const hasVideo = document.querySelectorAll("video").length > 0;
  if (hasVideo === lastVideoPresence) return;
  lastVideoPresence = hasVideo;
  sendRuntimeMessage({ type: "AFK_VIDEO_PRESENCE", hasVideo }).catch(() => {});
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

function forwardVoiceDebug(kind, text) {
  try {
    chrome.runtime
      .sendMessage({ type: "AFK_VOICE_DEBUG", detail: { kind, text } })
      .catch(() => {});
  } catch {}
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
  const logFn =
    source === SOURCE.VOICE
      ? debugLogVoice
      : source === SOURCE.SYSTEM
        ? debugLogFace
        : debugLogGesture;
  logFn(`command -> ${action}`);
  const result = await sendRuntimeMessage({ type: CHANNEL.COMMAND, payload });

  if (result?.ok && !result?.skipped) {
    if (action === "list-clickable" && Array.isArray(result.items)) {
      showClickableOverlay(result.items);
    }
    hud?.showFeedback?.({ action, source, labelText: meta?.labelText });
    showCommandToast(action, source, meta);
    const matchedLabel = result.matched ? ` -> "${result.matched}"` : "";
    logFn(`command ok <- ${action}${matchedLabel}`, "ok");
    return;
  }

  if (result?.skipped) {
    logFn(
      `command skipped <- ${action} (${result.reason || "unknown"})`,
      "warn",
    );
    console.info("[AFK] Command skipped:", result.reason || "unknown");
    return;
  }

  logFn(
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
  return videos.some(
    (video) => !video.paused && !video.ended && video.readyState >= 2,
  );
}

async function maybePauseOnAttentionLost(reason = "attention-lost") {
  if (!currentState.enabled || attentionAutoPaused) return;
  if (!isVideoPlayingNow()) return;
  if (eyeAttentionState === "unknown") return;

  await emitCommand(SOURCE.SYSTEM, "video-pause", { reason });
  attentionAutoPaused = true;
  debugLogFace("auto-pause: video paused", "warn");
}

async function maybeResumeOnAttentionBack(reason = "attention-back") {
  if (!currentState.enabled || !attentionAutoPaused) return;
  if (eyeAttentionState === "away") return;

  await emitCommand(SOURCE.SYSTEM, "video-play", { reason });
  attentionAutoPaused = false;
  debugLogFace("auto-resume: video resumed", "ok");
}

function handleEyeAttentionEvent(eventName, detail = {}) {
  eyeAttentionSignalSeen = true;

  if (eventName === "attention:look-away") {
    eyeAttentionState = "away";
    renderEyeAttentionBadge("away", detail);
    debugLogFace("look-away", "warn");
    debugSetStatus(debugFaceStatus, "AWAY — user not looking", "#fca5a5");
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
    debugLogFace("look-at", "ok");
    debugSetStatus(debugFaceStatus, "LOOKING — user engaged", "#86efac");
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
    debugLogFace(`unsupported: ${detail?.reason || "unknown"}`, "warn");
    debugSetStatus(
      debugFaceStatus,
      `Unsupported: ${detail?.reason || ""}`,
      "#fdba74",
    );
  } else if (state === "ready") {
    debugLogFace(`engine ready: ${detail?.engine || "unknown"}`, "ok");
    debugSetStatus(
      debugFaceStatus,
      `Ready (${detail?.engine || "unknown"})`,
      "#86efac",
    );
  } else if (state === "no-face") {
    debugSetStatus(debugFaceStatus, "No face detected", "#fca5a5");
  } else if (state === "face-detected") {
    debugSetStatus(debugFaceStatus, "Face detected", "#93c5fd");
  } else if (state === "face-uncertain") {
    debugSetStatus(debugFaceStatus, "Face uncertain", "#93c5fd");
  } else if (
    state === "mesh-send" ||
    state === "mesh-send-ok" ||
    state === "mesh-results"
  ) {
    const extra = detail?.reason
      ? ` (${detail.reason})`
      : detail?.points
        ? ` (points=${detail.points})`
        : "";
    const type = state === "mesh-send-failed" ? "error" : "info";
    debugLogFace(`${state}${extra}`, type);
  }
}

function handleAttentionAction(detail = {}) {
  const action = detail?.action || detail?.eventName || "attention";
  if (detail?.ok === false) {
    debugLogFace(
      `action failed: ${action} (${detail?.error || detail?.reason || "unknown"})`,
      "error",
    );
    return;
  }
  if (detail?.skipped) {
    debugLogFace(
      `action skipped: ${action} (${detail?.reason || "unknown"})`,
      "warn",
    );
    return;
  }
  debugLogFace(`action ok: ${action}`, "ok");
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

  setDebugUIVisible(enabled);

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
      if (transcript) debugLogVoice(`heard: "${transcript}"`);
      const extra = meta?.labelText
        ? ` ("${meta.labelText}")`
        : meta?.clickIndex != null
          ? ` (#${meta.clickIndex})`
          : meta?.keyLabel
            ? ` (${meta.keyLabel})`
            : "";
      debugLogVoice(`command: ${action}${extra}`, "ok");
      debugSetStatus(debugVoiceStatus, `Command: ${action}${extra}`, "#86efac");
      emitCommand(SOURCE.VOICE, action, meta);
    },
    onTranscript: (text, meta) => {
      const cleaned = String(text || "").trim();
      if (!cleaned) return;
      const prefix = meta?.committed ? "final" : "partial";
      const line = `${prefix}: "${cleaned}"`;
      if (line === lastTranscriptLog) return;
      lastTranscriptLog = line;
      debugLogVoice(line);
      debugSetStatus(debugVoiceStatus, `Hearing: "${cleaned}"`, "#93c5fd");
      forwardVoiceDebug("transcript", cleaned);
    },
    onStatus: (status) => {
      hud?.setVoiceStatus?.(status);
      debugLogVoice(`status: ${status}`);
      debugSetStatus(debugVoiceStatus, `Voice: ${status}`, "#94a3b8");
      forwardVoiceDebug("status", `Voice: ${status}`);
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
    return ![
      "submit",
      "button",
      "checkbox",
      "radio",
      "file",
      "range",
      "color",
      "hidden",
      "image",
      "reset",
    ].includes(t);
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

function findVideo() {
  const videos = Array.from(document.querySelectorAll("video"));
  return (
    videos.find((v) => !v.paused && v.readyState >= 2) || videos[0] || null
  );
}

function executePageCommand(action, meta = {}) {
  switch (action) {
    case "page-down":
      window.scrollBy({ top: window.innerHeight * 0.8, behavior: "smooth" });
      break;
    case "page-up":
      window.scrollBy({ top: -window.innerHeight * 0.8, behavior: "smooth" });
      break;
    case "go-home":
      window.scrollTo({ top: 0, behavior: "smooth" });
      break;
    case "go-end":
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
      break;
    case "video-play": {
      const v = findVideo();
      v?.play();
      break;
    }
    case "video-pause": {
      const v = findVideo();
      v?.pause();
      break;
    }
    case "video-mute": {
      const v = findVideo();
      if (v) v.muted = true;
      break;
    }
    case "video-unmute": {
      const v = findVideo();
      if (v) v.muted = false;
      break;
    }
    case "video-next": {
      const btn = document.querySelector(
        ".ytp-next-button, [aria-label*='next' i], [aria-label*='skip' i]",
      );
      btn?.click();
      break;
    }
    case "fullscreen-enter":
      if (!document.fullscreenElement)
        document.documentElement.requestFullscreen().catch(() => {});
      break;
    case "fullscreen-exit":
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      break;
    case "press-key": {
      const target = document.activeElement || document.body;
      ["keydown", "keypress", "keyup"].forEach((type) => {
        target.dispatchEvent(
          new KeyboardEvent(type, {
            key: meta.key,
            code: meta.code,
            keyCode: meta.keyCode,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      break;
    }
    case "click-target": {
      const focused = document.activeElement;
      if (focused && focused !== document.body) focused.click();
      break;
    }
    case "dictate-start": {
      const target =
        lastFocusedEditable ||
        (isEditableEl(document.activeElement) ? document.activeElement : null);
      voiceEngine?.setDictationTarget?.(target);
      break;
    }
    case "enter-key": {
      const target = document.activeElement || document.body;
      ["keydown", "keypress", "keyup"].forEach((type) => {
        target.dispatchEvent(
          new KeyboardEvent(type, {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      break;
    }
    case "click-text": {
      if (!meta.labelText) break;
      const needle = meta.labelText.toLowerCase();
      const candidates = document.querySelectorAll(
        "a, button, [role='button'], [role='link'], input[type='submit'], input[type='button']",
      );
      for (const el of candidates) {
        if (
          (el.textContent || el.value || el.ariaLabel || "")
            .toLowerCase()
            .includes(needle)
        ) {
          el.click();
          break;
        }
      }
      break;
    }
    case "click-number": {
      const items = window.__afkClickableItems;
      if (Array.isArray(items) && meta.clickIndex > 0) {
        const item = items[meta.clickIndex - 1];
        if (item?.rect) {
          const cx = item.rect.left + item.rect.width / 2;
          const cy = item.rect.top + item.rect.height / 2;
          // elementsFromPoint returns all elements in z-order; skip our own
          // overlay badges so we reach the actual clickable element beneath.
          const els = document.elementsFromPoint(cx, cy);
          const el = els.find(
            (e) =>
              e !== document.documentElement &&
              e !== document.body &&
              !clickableBadges.includes(e),
          );
          el?.click();
        }
      }
      break;
    }
    case "list-clickable": {
      const clickable = Array.from(
        document.querySelectorAll(
          "a[href], button:not([disabled]), [role='button'], [role='link'], input[type='submit'], input[type='button']",
        ),
      )
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return (
            r.width > 0 &&
            r.height > 0 &&
            r.top >= 0 &&
            r.top < window.innerHeight
          );
        })
        .slice(0, 20)
        .map((el, i) => ({
          index: i + 1,
          label: (el.textContent || el.value || el.ariaLabel || "")
            .trim()
            .slice(0, 40),
          rect: el.getBoundingClientRect(),
        }));
      return { ok: true, items: clickable };
    }
    case "close-list":
      window.dispatchEvent(new CustomEvent("afk:close-clickable-list"));
      break;
  }
  return { ok: true };
}

function initBackgroundStateListener() {
  let lastCursorStatusMs = 0;

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "gesture") {
      const eventName = message?.event;
      const detail = message?.detail || {};

      // -- Hand gesture events --
      if (eventName === "gesture:cursor") {
        const now = Date.now();
        if (now - lastCursorStatusMs > 400) {
          lastCursorStatusMs = now;
          debugSetStatus(
            debugGestureStatus,
            `Cursor: (${(detail.normX ?? 0).toFixed(2)}, ${(detail.normY ?? 0).toFixed(2)})`,
            "#86efac",
          );
        }
        return;
      }
      if (eventName === "gesture:none") {
        if (handCursorDotEl) handCursorDotEl.style.opacity = "0";
        debugSetStatus(debugGestureStatus, "No hand detected", "#fca5a5");
        debugLogGesture("no hand detected", "warn");
        return;
      }
      if (eventName === "gesture:scroll") {
        debugLogGesture(
          `scroll dx=${(detail.dx ?? 0).toFixed(1)} dy=${(detail.dy ?? 0).toFixed(1)}`,
        );
        debugSetStatus(debugGestureStatus, "Scrolling", "#93c5fd");
        return;
      }
      if (eventName === "gesture:click") {
        debugLogGesture(
          `click (${(detail.normX ?? 0).toFixed(2)}, ${(detail.normY ?? 0).toFixed(2)})`,
          "ok",
        );
        debugSetStatus(debugGestureStatus, "Click", "#86efac");
        return;
      }
      if (eventName === "gesture:closetab") {
        debugLogGesture("close tab (clap)", "ok");
        debugSetStatus(debugGestureStatus, "Close Tab", "#86efac");
        return;
      }
      if (eventName === "gesture:tabswitch:start") {
        debugLogGesture("tab switch started");
        debugSetStatus(debugGestureStatus, "Tab Switch…", "#93c5fd");
        return;
      }
      if (eventName === "gesture:tabswitch:end") {
        const dir = (detail.normDx ?? 0) > 0 ? "right" : "left";
        debugLogGesture(`tab switch ${dir}`, "ok");
        debugSetStatus(debugGestureStatus, `Tab Switch ${dir}`, "#86efac");
        return;
      }
      if (eventName === "gesture:navigate") {
        debugLogGesture(`navigate ${detail.direction || ""}`, "ok");
        debugSetStatus(
          debugGestureStatus,
          `Navigate ${detail.direction || ""}`,
          "#86efac",
        );
        return;
      }
      if (
        typeof eventName === "string" &&
        eventName.startsWith("gesture:drag")
      ) {
        debugLogGesture(eventName.replace("gesture:", ""));
        return;
      }

      // -- Face attention events --
      if (
        eventName === "attention:look-away" ||
        eventName === "attention:look-at"
      ) {
        handleEyeAttentionEvent(eventName, detail);
      } else if (eventName === "attention:status") {
        handleEyeAttentionStatus(detail);
      } else if (eventName === "attention:gaze") {
        updateEyeGazeDot(detail);
      } else if (eventName === "attention:action") {
        handleAttentionAction(detail);
      }
      return;
    }

    if (message?.type !== CHANNEL.STATE_UPDATED) return;
    mergeState(message.payload);
    updateRuntimeModules();
  });
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === CHANNEL.STATE_UPDATED) {
      mergeState(message.payload);
      updateRuntimeModules();
      return;
    }
    if (message?.type === "afk:execute") {
      const result = executePageCommand(message.action, message) || {
        ok: true,
      };
      sendResponse(result);
    }
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
      debugLogFace("no events received from offscreen", "warn");
      debugSetStatus(debugFaceStatus, "No attention events", "#fdba74");
    }
  }, 5000);
  debugLogGesture("content script boot");
  debugLogFace("content script boot");
  debugLogVoice("content script boot");
  await Promise.all([initHud(), initGestureEngine(), initVoiceEngine()]);
  initDictationBridge();
  initLocalEventBridge();
  initBackgroundStateListener();
  initTabActivityListeners();
  await syncInitialState();
  await syncInitialAttentionStatus();
  debugLogGesture(
    `state: enabled=${currentState.enabled} gestures=${currentState.gesturesEnabled}`,
  );
  debugLogFace(
    `state: enabled=${currentState.enabled} face=${currentState.faceAttentionEnabled}`,
  );
  debugLogVoice(
    `state: enabled=${currentState.enabled} voice=${currentState.voiceEnabled} wake=${currentState.requireWakeWord}`,
  );
  updateRuntimeModules();
  checkVideoPresence();
  new MutationObserver(() => checkVideoPresence()).observe(
    document.documentElement,
    { childList: true, subtree: true },
  );
}

// Receives gesture messages from the service worker (relayed from offscreen.js)
// and translates them into DOM interactions.

(function () {
  "use strict";

  if (window.__AFK_PAGE_CURSOR_LAYER_INIT__) return;
  window.__AFK_PAGE_CURSOR_LAYER_INIT__ = true;

  document.querySelectorAll("#afk-primary-cursor, #afk-primary-cursor-label").forEach((el) => el.remove());

  // ---------------------------------------------------------------------------
  // Finger cursor overlay
  // ---------------------------------------------------------------------------
  const cursor = document.createElement("div");
  cursor.id = "afk-primary-cursor";
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
  label.id = "afk-primary-cursor-label";
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

  const CURSOR_SMOOTHING = 0.16;
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

if (!window.__AFK_MAIN_BOOTSTRAPPED__) {
  window.__AFK_MAIN_BOOTSTRAPPED__ = true;
  bootstrap();
}
