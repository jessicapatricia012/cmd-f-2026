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
  await sendRuntimeMessage({ type: CHANNEL.COMMAND, payload });
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
    onCommand: (action, meta) => emitCommand(SOURCE.VOICE, action, meta),
    onStatus: (status) => hud?.setVoiceStatus?.(status),
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
  await Promise.all([initHud(), initGestureEngine(), initVoiceEngine()]);
  initLocalEventBridge();
  initBackgroundStateListener();
  await syncInitialState();
  updateRuntimeModules();
}

bootstrap();

