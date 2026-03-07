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

