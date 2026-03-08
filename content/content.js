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
    type === "error" ? "#fca5a5" : type === "warn" ? "#fdba74" : type === "ok" ? "#86efac" : "#93c5fd";
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
    "reload": "Reload",
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
    debugLog(`command skipped <- ${action} (${result.reason || "unknown"})`, "warn");
    console.info("[AFK] Command skipped:", result.reason || "unknown");
    return;
  }

  debugLog(`command failed <- ${action}${meta?.labelText ? ` ("${meta.labelText}")` : ""} (${result?.error || "unknown error"})`, "error");
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
    enabled && Boolean(currentState.voiceEnabled) && isVoiceCaptureAllowedInThisTab();
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
      debugLog(`voice parsed: ${action}${meta?.labelText ? ` ("${meta.labelText}")` : meta?.clickIndex != null ? ` (#${meta.clickIndex})` : meta?.keyLabel ? ` (${meta.keyLabel})` : ""}`);
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
      `tab visibility: ${document.visibilityState}, focus=${document.hasFocus() ? "yes" : "no"}`
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
  initLocalEventBridge();
  initBackgroundStateListener();
  initTabActivityListeners();
  await syncInitialState();
  debugLog(`state: enabled=${currentState.enabled} voice=${currentState.voiceEnabled} wake=${currentState.requireWakeWord}`);
  updateRuntimeModules();
}

bootstrap();