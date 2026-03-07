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
};

let currentState = { ...INITIAL_STATE };
let gestureEngine = null;
let voiceEngine = null;
let hud = null;
let debugList = null;

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

function mergeState(nextState) {
  currentState = { ...INITIAL_STATE, ...(nextState || {}) };
}

function isAllowedByMode(source) {
  if (source === SOURCE.GESTURE) return currentState.gesturesEnabled;
  if (source === SOURCE.VOICE) return currentState.voiceEnabled;
  return false;
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
    hud?.showFeedback?.({ action, source });
    debugLog(`command ok <- ${action}`, "ok");
    return;
  }

  if (result?.skipped) {
    debugLog(`command skipped <- ${action} (${result.reason || "unknown"})`, "warn");
    console.info("[AFK] Command skipped:", result.reason || "unknown");
    return;
  }

  debugLog(`command failed <- ${action} (${result?.error || "unknown error"})`, "error");
  console.warn("[AFK] Command failed:", result?.error || "unknown error");
}

function updateRuntimeModules() {
  const enabled = Boolean(currentState.enabled);
  const gesturesEnabled = enabled && Boolean(currentState.gesturesEnabled);
  const voiceEnabled = enabled && Boolean(currentState.voiceEnabled);
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
  });

  hud?.setState?.({
    enabled,
    gesturesEnabled,
    voiceEnabled,
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

  voiceEngine = factory({
    onCommand: (action, meta) => {
      const transcript = String(meta?.transcript || "");
      if (transcript) debugLog(`voice heard: "${transcript}"`);
      debugLog(`voice parsed: ${action}`);
      emitCommand(SOURCE.VOICE, action, meta);
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
}

function initBackgroundStateListener() {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== CHANNEL.STATE_UPDATED) return;
    mergeState(message.payload);
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
  await syncInitialState();
  debugLog(`state: enabled=${currentState.enabled} voice=${currentState.voiceEnabled} wake=${currentState.requireWakeWord}`);
  updateRuntimeModules();
}

bootstrap();

