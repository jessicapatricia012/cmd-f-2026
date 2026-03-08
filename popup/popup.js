// Popup script
// Handles: popup UI interactions, local camera preview, and AFK state updates.

const CHANNEL = {
  GET_STATE: "AFK_GET_STATE",
  SET_STATE: "AFK_SET_STATE",
  STATE_UPDATED: "AFK_STATE_UPDATED",
};

const DEFAULT_KEYWORDS = {
  "page-down": ["page down", "scroll down"],
  "page-up": ["page up", "scroll up"],
  "go-home": ["home", "go home", "top", "to top"],
  "go-end": ["end", "go end", "bottom", "to bottom"],
  "video-play": ["play", "resume", "play video", "video play"],
  "video-pause": ["pause", "pause video", "paused video", "video pause", "stop video"],
  "video-next": ["next video", "skip video", "video next"],
  "video-mute": ["mute", "mute video", "video mute"],
  "video-unmute": ["unmute", "unmute video", "video unmute"],
  "page-refresh": ["refresh", "reload", "refresh page"],
  "fullscreen-enter": ["enter fullscreen", "enter full screen"],
  "fullscreen-exit": ["exit full screen", "leave full screen"],
  "click-target": ["click", "click that", "click this", "select this"],
  "zoom-in": ["zoom in"],
  "zoom-out": ["zoom out"],
  "next-tab": ["next tab", "tab next"],
  "prev-tab": ["previous tab", "prev tab", "back tab"],
  "go-back": ["go back"],
  "go-forward": ["go forward"],
  "new-tab": ["new tab", "open tab"],
};

function actionToLabel(action) {
  return String(action)
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getMergedKeywordMap(customKeywords) {
  return { ...DEFAULT_KEYWORDS, ...(customKeywords && typeof customKeywords === "object" ? customKeywords : {}) };
}

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

function renderKeywordFields(container) {
  const rows = Object.keys(DEFAULT_KEYWORDS)
    .map(
      (action) => `
        <label class="keyword-row">
          <span class="keyword-label">${actionToLabel(action)}</span>
          <input class="keyword-input" data-action="${action}" type="text" spellcheck="false" />
        </label>
      `
    )
    .join("");
  container.innerHTML = rows;
}

function applyKeywordValues(container, customKeywords) {
  const merged = getMergedKeywordMap(customKeywords);
  const inputs = container.querySelectorAll(".keyword-input");
  inputs.forEach((input) => {
    const action = input.dataset.action;
    const phrases = merged[action] || [];
    input.value = phrases.join(", ");
  });
}

function collectKeywordValues(container) {
  const result = {};
  const inputs = container.querySelectorAll(".keyword-input");

  inputs.forEach((input) => {
    const action = input.dataset.action;
    const phrases = String(input.value || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    if (action) {
      result[action] = phrases.length > 0 ? phrases : DEFAULT_KEYWORDS[action];
    }
  });

  return result;
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
    keywordsList: document.getElementById("keywords-list"),
    saveKeywords: document.getElementById("save-keywords"),
    keywordsStatus: document.getElementById("keywords-status"),
  };

  if (Object.values(elements).some((value) => !value)) return;

  let stream = null;
  let gestureTimer = null;
  renderKeywordFields(elements.keywordsList);

  const applyStateToUI = (state) => {
    const enabled = Boolean(state.enabled);
    const gesturesEnabled = Boolean(state.gesturesEnabled);
    const voiceEnabled = Boolean(state.voiceEnabled);
    const requireWakeWord = state.requireWakeWord !== false;
    const customKeywords = state.customKeywords || {};

    setMainEnabled(elements.mainToggle, elements.statusText, enabled);
    setMiniToggle(elements.toggleGesture, gesturesEnabled);
    setMiniToggle(elements.toggleVoice, voiceEnabled);
    setMiniToggle(elements.toggleWakeword, requireWakeWord);
    setWakewordToggleEnabled(elements.toggleWakeword, voiceEnabled);
    applyKeywordValues(elements.keywordsList, customKeywords);
    elements.keywordsStatus.textContent =
      Object.keys(customKeywords).length > 0 ? "Custom keywords active" : "Default fields loaded";

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
      stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false,
      });
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

  const demoGestures = [
    "Click",
    "Page Down",
    "Zoom In",
    "Next Tab",
    "Go Back",
    "Drag",
  ];
  setInterval(() => {
    if (!stream || Math.random() > 0.35) return;
    elements.gestureLabel.textContent =
      demoGestures[Math.floor(Math.random() * demoGestures.length)];
    elements.gestureLabel.classList.add("show");
    clearTimeout(gestureTimer);
    gestureTimer = setTimeout(
      () => elements.gestureLabel.classList.remove("show"),
      1100,
    );
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
    const next =
      elements.toggleWakeword.getAttribute("aria-checked") !== "true";
    updateState({ requireWakeWord: next });
  });

  elements.saveKeywords.addEventListener("click", async () => {
    try {
      const customKeywords = collectKeywordValues(elements.keywordsList);
      await updateState({ customKeywords });
      elements.keywordsStatus.textContent = "Saved";
      setTimeout(() => {
        elements.keywordsStatus.textContent =
          Object.keys(customKeywords).length > 0 ? "Custom keywords active" : "Using defaults";
      }, 900);
    } catch (error) {
      elements.keywordsStatus.textContent = `Error: ${error.message}`;
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === CHANNEL.STATE_UPDATED && message.payload) {
      applyStateToUI(message.payload);
    }
  });
});
// The Enable toggle gates camera permission.  Because Chrome's camera
// permission bubble often appears behind/outside a small popup, we open a
// full browser tab when permission needs to be granted for the first time.

const toggle = document.getElementById("toggle");
const cameraStatus = document.getElementById("camera-status");
const cameraHelp = document.getElementById("camera-help");

// ---------------------------------------------------------------------------
// Setup mode — when this page is opened as a full tab (?setup=1) it
// immediately requests camera, then messages the service worker to start.
// ---------------------------------------------------------------------------

if (location.search.includes("setup=1")) {
  cameraStatus.textContent = "Requesting camera access…";
  (async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false,
      });
      stream.getTracks().forEach((t) => t.stop());

      const res = await chrome.runtime.sendMessage({ type: "start" });
      if (!res?.ok) throw new Error(res?.error || "Unknown start error");

      cameraStatus.textContent =
        "Camera access granted! You can close this tab.";
      chrome.storage.local.set({ enabled: true });
    } catch (err) {
      cameraStatus.textContent =
        `Still blocked or failed (${err?.message || "unknown error"}). ` +
        "Go to chrome://settings/content/camera, remove this extension from the Blocked list, then try again.";
    }
  })();
}

// ---------------------------------------------------------------------------
// Camera permission helpers
// ---------------------------------------------------------------------------

async function isCameraGranted() {
  try {
    const result = await navigator.permissions.query({ name: "camera" });
    return result.state === "granted";
  } catch {
    return false;
  }
}

async function requestCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: false,
  });
  stream.getTracks().forEach((t) => t.stop());
}

// ---------------------------------------------------------------------------
// Restore toggle state on popup open
// ---------------------------------------------------------------------------

chrome.storage.local.get("enabled", ({ enabled }) => {
  toggle.checked = !!enabled;
  isCameraGranted().then((granted) => {
    cameraStatus.textContent =
      toggle.checked && granted ? "Camera active" : "Camera off";
    if (toggle.checked && granted) {
      chrome.runtime.sendMessage({ type: "start" }).catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// Toggle handler
// ---------------------------------------------------------------------------

toggle.addEventListener("change", async () => {
  cameraHelp.style.display = "none";

  if (toggle.checked) {
    cameraStatus.textContent = "Requesting camera…";
    try {
      await requestCamera();
      const res = await chrome.runtime.sendMessage({ type: "start" });
      if (!res?.ok)
        throw new Error(res?.error || "Failed to start camera pipeline");
      cameraStatus.textContent = "Camera active";
      chrome.storage.local.set({ enabled: true });
    } catch (err) {
      cameraStatus.textContent = `Camera access needed (${err?.message || "unknown error"})`;
      cameraHelp.style.display = "block";
      toggle.checked = false;
    }
  } else {
    cameraStatus.textContent = "Camera off";
    chrome.storage.local.set({ enabled: false });
    chrome.runtime.sendMessage({ type: "stop" }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Camera help buttons
// ---------------------------------------------------------------------------

document.getElementById("btn-open-tab").addEventListener("click", () => {
  // Open this same page as a full tab — Chrome shows the camera bar properly there
  chrome.tabs.create({
    url: chrome.runtime.getURL("popup/popup.html?setup=1"),
  });
  window.close();
});

document.getElementById("btn-open-settings").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://settings/content/camera" });
});
