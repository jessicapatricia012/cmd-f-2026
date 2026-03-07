// Popup script
// Handles: popup UI interactions, local camera preview, and AFK state updates.

const CHANNEL = {
  GET_STATE: "AFK_GET_STATE",
  SET_STATE: "AFK_SET_STATE",
  STATE_UPDATED: "AFK_STATE_UPDATED",
};

function setMainEnabled(mainToggle, statusText, enabled) {
  mainToggle.setAttribute("aria-checked", String(enabled));
  statusText.textContent = enabled ? "Enabled" : "Disabled";
  statusText.classList.toggle("is-on", enabled);
}

function setCamLive(camDot, camLabel, live) {
  camDot.classList.toggle("is-live", live);
  camLabel.classList.toggle("is-live", live);
  camLabel.textContent = live ? "Camera live" : "Camera inactive";
}

function setMiniToggle(toggle, enabled) {
  toggle.setAttribute("aria-checked", String(enabled));
}

function setWakewordToggleEnabled(toggle, enabled) {
  toggle.disabled = !enabled;
  toggle.style.opacity = enabled ? "1" : "0.45";
  toggle.style.pointerEvents = enabled ? "auto" : "none";
}

document.addEventListener("DOMContentLoaded", async () => {
  const elements = {
    mainToggle: document.getElementById("main-toggle"),
    statusText: document.getElementById("status-text"),
    camDot: document.getElementById("cam-dot"),
    camLabel: document.getElementById("cam-label"),
    camFeedWrap: document.getElementById("cam-feed-wrap"),
    camPlaceholder: document.getElementById("cam-placeholder"),
    camPreview: document.getElementById("cam-preview"),
    camStartBtn: document.getElementById("cam-start-btn"),
    gestureLabel: document.getElementById("gesture-label"),
    toggleGesture: document.getElementById("toggle-gesture"),
    toggleVoice: document.getElementById("toggle-voice"),
    toggleWakeword: document.getElementById("toggle-wakeword"),
  };

  if (Object.values(elements).some((value) => !value)) return;

  let stream = null;
  let gestureTimer = null;

  const applyStateToUI = (state) => {
    const enabled = Boolean(state.enabled);
    const gesturesEnabled = Boolean(state.gesturesEnabled);
    const voiceEnabled = Boolean(state.voiceEnabled);
    const requireWakeWord = state.requireWakeWord !== false;

    setMainEnabled(elements.mainToggle, elements.statusText, enabled);
    setMiniToggle(elements.toggleGesture, gesturesEnabled);
    setMiniToggle(elements.toggleVoice, voiceEnabled);
    setMiniToggle(elements.toggleWakeword, requireWakeWord);
    setWakewordToggleEnabled(elements.toggleWakeword, voiceEnabled);

    const cameraLive = enabled && gesturesEnabled && Boolean(stream);
    setCamLive(elements.camDot, elements.camLabel, cameraLive);
  };

  const updateState = async (partial) => {
    try {
      const result = await chrome.runtime.sendMessage({
        type: CHANNEL.SET_STATE,
        payload: partial,
      });
      if (result?.ok && result.state) {
        applyStateToUI(result.state);
      }
    } catch (error) {
      console.warn("[AFK] popup update failed:", error);
    }
  };

  async function startCamera() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      elements.camPreview.srcObject = stream;
      elements.camPreview.classList.add("visible");
      elements.camPlaceholder.classList.add("hidden");
      elements.camFeedWrap.classList.add("is-live");
      setCamLive(elements.camDot, elements.camLabel, true);
      elements.camStartBtn.classList.add("hidden");
    } catch (_error) {
      elements.camLabel.textContent = "No permission";
    }
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
    elements.camPreview.srcObject = null;
    elements.camPreview.classList.remove("visible");
    elements.camPlaceholder.classList.remove("hidden");
    elements.camFeedWrap.classList.remove("is-live");
    setCamLive(elements.camDot, elements.camLabel, false);
    elements.camStartBtn.classList.remove("hidden");
    elements.gestureLabel.classList.remove("show");
  }

  const initial = await chrome.runtime.sendMessage({ type: CHANNEL.GET_STATE });
  if (initial?.ok && initial.state) {
    applyStateToUI(initial.state);
  }

  const demoGestures = ["Click", "Page Down", "Zoom In", "Next Tab", "Go Back", "Drag"];
  setInterval(() => {
    if (!stream || Math.random() > 0.35) return;
    elements.gestureLabel.textContent =
      demoGestures[Math.floor(Math.random() * demoGestures.length)];
    elements.gestureLabel.classList.add("show");
    clearTimeout(gestureTimer);
    gestureTimer = setTimeout(() => elements.gestureLabel.classList.remove("show"), 1100);
  }, 1800);

  elements.mainToggle.addEventListener("click", () => {
    const next = elements.mainToggle.getAttribute("aria-checked") !== "true";
    updateState({ enabled: next });
    if (!next) stopCamera();
  });

  elements.camStartBtn.addEventListener("click", startCamera);

  elements.toggleGesture.addEventListener("click", () => {
    const next = elements.toggleGesture.getAttribute("aria-checked") !== "true";
    updateState({ gesturesEnabled: next });
  });

  elements.toggleVoice.addEventListener("click", () => {
    const next = elements.toggleVoice.getAttribute("aria-checked") !== "true";
    updateState({ voiceEnabled: next });
  });

  elements.toggleWakeword.addEventListener("click", () => {
    if (elements.toggleWakeword.disabled) return;
    const next = elements.toggleWakeword.getAttribute("aria-checked") !== "true";
    updateState({ requireWakeWord: next });
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === CHANNEL.STATE_UPDATED && message.payload) {
      applyStateToUI(message.payload);
    }
  });
});