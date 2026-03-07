// Popup script
// Handles: toggle state, mode selection, communicating settings to service worker

function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function applyStateToUI(state, elements) {
  elements.toggle.checked = Boolean(state.enabled);
  elements.gestures.checked = Boolean(state.gesturesEnabled);
  elements.voice.checked = Boolean(state.voiceEnabled);

  const cameraOn = state.enabled && state.gesturesEnabled;
  elements.cameraStatus.textContent = cameraOn ? "Camera on" : "Camera off";
}

document.addEventListener("DOMContentLoaded", async () => {
  const elements = {
    toggle: document.getElementById("toggle"),
    gestures: document.getElementById("gestures"),
    voice: document.getElementById("voice"),
    cameraStatus: document.getElementById("camera-status"),
  };

  if (!elements.toggle || !elements.gestures || !elements.voice || !elements.cameraStatus) {
    return;
  }

  const initial = await sendMessage({ type: "AFK_GET_STATE" });
  if (initial?.ok && initial.state) {
    applyStateToUI(initial.state, elements);
  }

  async function updateState(partial) {
    const result = await sendMessage({
      type: "AFK_SET_STATE",
      payload: partial,
    });
    if (result?.ok && result.state) {
      applyStateToUI(result.state, elements);
    }
  }

  elements.toggle.addEventListener("change", () => {
    updateState({ enabled: elements.toggle.checked });
  });

  elements.gestures.addEventListener("change", () => {
    updateState({ gesturesEnabled: elements.gestures.checked });
  });

  elements.voice.addEventListener("change", () => {
    updateState({ voiceEnabled: elements.voice.checked });
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "AFK_STATE_UPDATED" && message.payload) {
      applyStateToUI(message.payload, elements);
    }
  });
});

// ── Element refs ───────────────────────────────────────────────────────────
const mainToggle    = document.getElementById("main-toggle");
const statusText    = document.getElementById("status-text");
const camDot        = document.getElementById("cam-dot");
const camLabel      = document.getElementById("cam-label");
const toggleGesture = document.getElementById("toggle-gesture");
const toggleVoice   = document.getElementById("toggle-voice");

// ── Helpers ────────────────────────────────────────────────────────────────
function setMainEnabled(enabled) {
  mainToggle.setAttribute("aria-checked", String(enabled));
  statusText.textContent = enabled ? "Enabled" : "Disabled";
  statusText.classList.toggle("is-on", enabled);
}

function setCamLive(live) {
  camDot.classList.toggle("is-live", live);
  camLabel.classList.toggle("is-live", live);
  camLabel.textContent = live ? "Camera live" : "Camera inactive";
}

function setMiniToggle(btn, enabled) {
  btn.setAttribute("aria-checked", String(enabled));
}

// ── Load initial state from chrome.storage ─────────────────────────────────
chrome.storage.sync.get(
  ["afkEnabled", "gestureEnabled", "voiceEnabled", "cameraActive"],
  ({ afkEnabled = false, gestureEnabled = true, voiceEnabled = true, cameraActive = false }) => {
    setMainEnabled(afkEnabled);
    setCamLive(cameraActive);
    setMiniToggle(toggleGesture, gestureEnabled);
    setMiniToggle(toggleVoice, voiceEnabled);
  }
);

// ── Main toggle click ──────────────────────────────────────────────────────
mainToggle.addEventListener("click", () => {
  const next = mainToggle.getAttribute("aria-checked") !== "true";
  setMainEnabled(next);
  chrome.storage.sync.set({ afkEnabled: next });
  // Notify background service worker
  chrome.runtime.sendMessage({ type: "SET_ENABLED", payload: next });
});

// ── Gesture toggle ─────────────────────────────────────────────────────────
toggleGesture.addEventListener("click", () => {
  const next = toggleGesture.getAttribute("aria-checked") !== "true";
  setMiniToggle(toggleGesture, next);
  chrome.storage.sync.set({ gestureEnabled: next });
  chrome.runtime.sendMessage({ type: "SET_GESTURE", payload: next });
});

// ── Voice toggle ───────────────────────────────────────────────────────────
toggleVoice.addEventListener("click", () => {
  const next = toggleVoice.getAttribute("aria-checked") !== "true";
  setMiniToggle(toggleVoice, next);
  chrome.storage.sync.set({ voiceEnabled: next });
  chrome.runtime.sendMessage({ type: "SET_VOICE", payload: next });
});

// ── Listen for camera state changes from content scripts ───────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "CAMERA_STATE") {
    setCamLive(msg.payload);
    chrome.storage.sync.set({ cameraActive: msg.payload });
  }
});

// ── Reflect storage changes in real time ───────────────────────────────────
chrome.storage.onChanged.addListener((changes) => {
  if ("afkEnabled"   in changes) setMainEnabled(changes.afkEnabled.newValue);
  if ("cameraActive" in changes) setCamLive(changes.cameraActive.newValue);
});