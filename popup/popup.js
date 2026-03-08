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

function setMiniToggle(toggle, enabled) {
  toggle.setAttribute("aria-checked", String(enabled));
}

const SENSITIVITY_LABELS = { 1: "Relaxed", 2: "Lenient", 3: "Balanced", 4: "Strict", 5: "Very Strict" };

const ZONE_BOUNDS = {
  1: 0.20,
  2: 0.27,
  3: 0.34,
  4: 0.38,
  5: 0.42,
};

function applyZoneBounds(row, slider, level) {
  if (!row) return;
  const pct = (ZONE_BOUNDS[level] || 0.34) * 100;
  const pauseL = row.querySelector(".face-zone__pause--l");
  const pauseR = row.querySelector(".face-zone__pause--r");
  if (pauseL) pauseL.style.width = pct + "%";
  if (pauseR) pauseR.style.width = pct + "%";
}

function updateDot(dot, normX, normY, getSensitivity, offsetX, offsetY) {
  if (!dot) return;
  const cx = normX - offsetX;
  const cy = normY - offsetY;
  const leftPct = Math.max(4, Math.min(96, cx * 100));
  const topPct = Math.max(4, Math.min(96, cy * 100));
  dot.style.left = leftPct + "%";
  dot.style.top = topPct + "%";
  const bound = ZONE_BOUNDS[getSensitivity()] || 0.34;
  const away = cx < bound || cx > (1 - bound);
  dot.classList.toggle("is-away", away);
  dot.classList.remove("is-idle");
}

function setSensitivityRowEnabled(row, slider, enabled) {
  if (!row || !slider) return;
  slider.disabled = !enabled;
  const delaySlider = row.querySelector("#face-delay");
  if (delaySlider) delaySlider.disabled = !enabled;
  row.style.opacity = enabled ? "1" : "0.4";
  row.style.pointerEvents = enabled ? "auto" : "none";
}

function setWakewordToggleEnabled(toggle, enabled) {
  toggle.disabled = !enabled;
  toggle.style.pointerEvents = enabled ? "auto" : "none";
  const row = toggle.closest(".feature-row");
  if (row) {
    row.style.opacity = enabled ? "1" : "0.4";
    row.style.pointerEvents = enabled ? "auto" : "none";
  }
}

function renderKeywordFields(container) {
  // Use correct CSS class names matching popup.css
  const rows = Object.keys(DEFAULT_KEYWORDS)
    .map(
      (action) => `
        <label class="keyword-row">
          <span class="keyword-row__label">${actionToLabel(action)}</span>
          <input class="keyword-row__input" data-action="${action}" type="text" spellcheck="false" />
        </label>
      `
    )
    .join("");
  container.innerHTML = rows;
}

function applyKeywordValues(container, customKeywords) {
  const merged = getMergedKeywordMap(customKeywords);
  const inputs = container.querySelectorAll(".keyword-row__input");
  inputs.forEach((input) => {
    const action = input.dataset.action;
    const phrases = merged[action] || [];
    input.value = phrases.join(", ");
  });
}

function collectKeywordValues(container) {
  const result = {};
  const inputs = container.querySelectorAll(".keyword-row__input");

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

function initAccordions() {
  document.querySelectorAll(".accordion__header").forEach((btn) => {
    if (btn.dataset.accordionBound) return;
    btn.dataset.accordionBound = "1";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const expanded = btn.getAttribute("aria-expanded") === "true";
      const bodyId = btn.getAttribute("aria-controls");
      const body = bodyId ? document.getElementById(bodyId) : null;
      btn.setAttribute("aria-expanded", String(!expanded));
      if (body) body.classList.toggle("is-open", !expanded);
    });
  });
}

initAccordions();

document.addEventListener("DOMContentLoaded", async () => {
  initAccordions();
  const elements = {
    mainToggle: document.getElementById("main-toggle"),
    statusText: document.getElementById("status-text"),
    popupBody: document.getElementById("popup-body"),
    toggleGesture: document.getElementById("toggle-gesture"),
    toggleFace: document.getElementById("toggle-face"),
    faceSensitivity: document.getElementById("face-sensitivity"),
    faceDelay: document.getElementById("face-delay"),
    faceSensitivityRow: document.getElementById("face-sensitivity-row"),
    sensitivityLabel: document.getElementById("sensitivity-label"),
    delayLabel: document.getElementById("delay-label"),
    toggleVoice: document.getElementById("toggle-voice"),
    toggleWakeword: document.getElementById("toggle-wakeword"),
    keywordsList: document.getElementById("keywords-list"),
    saveKeywords: document.getElementById("save-keywords"),
    keywordsStatus: document.getElementById("keywords-status"),
  };

  if (Object.values(elements).some((value) => !value)) return;

  renderKeywordFields(elements.keywordsList);

  const faceStatusEl = document.getElementById("face-status");
  const faceStatusText = document.getElementById("face-status-text");

  const FACE_STATUS_LABELS = {
    looking: "Looking at screen",
    away: "Looking away",
    "no-face": "No face detected",
    ready: "Ready",
    "face-detected": "Face detected",
    "face-uncertain": "Face uncertain",
    unsupported: "Not available",
  };

  const setFaceStatus = (stateStr) => {
    if (!faceStatusEl || !faceStatusText) return;
    faceStatusEl.setAttribute("data-state", stateStr);
    faceStatusText.textContent = FACE_STATUS_LABELS[stateStr] || stateStr;
    const screen = document.getElementById("face-zone-screen");
    if (screen) screen.classList.toggle("is-no-face", stateStr === "no-face");
  };

  const applyStateToUI = (state) => {
    const enabled = Boolean(state.enabled);
    const gesturesEnabled = Boolean(state.gesturesEnabled);
    const faceAttentionEnabled = state.faceAttentionEnabled !== false;
    const voiceEnabled = Boolean(state.voiceEnabled);
    const requireWakeWord = state.requireWakeWord !== false;
    const customKeywords = state.customKeywords || {};

    setMainEnabled(elements.mainToggle, elements.statusText, enabled);
    elements.popupBody.style.display = enabled ? "" : "none";
    setMiniToggle(elements.toggleGesture, gesturesEnabled);
    setMiniToggle(elements.toggleFace, faceAttentionEnabled);
    const sensitivity = Number(state.faceAttentionSensitivity) || 3;
    elements.faceSensitivity.value = sensitivity;
    elements.sensitivityLabel.textContent = SENSITIVITY_LABELS[sensitivity] || "Balanced";
    applyZoneBounds(elements.faceSensitivityRow, elements.faceSensitivity, sensitivity);
    const delayMs = Number(state.faceAttentionDelay) || 900;
    const delayTenths = Math.round(delayMs / 100);
    elements.faceDelay.value = delayTenths;
    elements.delayLabel.textContent = (delayTenths / 10).toFixed(1) + "s";
    setSensitivityRowEnabled(elements.faceSensitivityRow, elements.faceSensitivity, faceAttentionEnabled);
    if (faceStatusEl) faceStatusEl.style.display = faceAttentionEnabled ? "" : "none";
    if (elements.faceSensitivityRow) elements.faceSensitivityRow.style.display = faceAttentionEnabled ? "" : "none";
    if (!faceAttentionEnabled) setFaceStatus("disabled");
    setMiniToggle(elements.toggleVoice, voiceEnabled);
    setMiniToggle(elements.toggleWakeword, requireWakeWord);
    setWakewordToggleEnabled(elements.toggleWakeword, voiceEnabled);
    applyKeywordValues(elements.keywordsList, customKeywords);
    elements.keywordsStatus.textContent =
      Object.keys(customKeywords).length > 0 ? "Custom keywords active" : "Default fields loaded";
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

  const initial = await chrome.runtime.sendMessage({ type: CHANNEL.GET_STATE });
  if (initial?.ok && initial.state) {
    applyStateToUI(initial.state);
    if (initial.state.faceAttentionEnabled !== false) {
      const faceRes = await chrome.runtime.sendMessage({ type: "AFK_GET_FACE_STATUS" }).catch(() => null);
      if (faceRes?.ok && faceRes.state) {
        setFaceStatus(faceRes.state);
      } else {
        setFaceStatus("ready");
      }
    }
  }

  elements.mainToggle.addEventListener("click", () => {
    const next = elements.mainToggle.getAttribute("aria-checked") !== "true";
    updateState({ enabled: next });
  });

  elements.toggleGesture.addEventListener("click", () => {
    const next = elements.toggleGesture.getAttribute("aria-checked") !== "true";
    updateState({ gesturesEnabled: next });
  });

  elements.toggleFace.addEventListener("click", () => {
    const next = elements.toggleFace.getAttribute("aria-checked") !== "true";
    updateState({ faceAttentionEnabled: next });
  });

  elements.faceSensitivity.addEventListener("input", () => {
    const val = Number(elements.faceSensitivity.value);
    elements.sensitivityLabel.textContent = SENSITIVITY_LABELS[val] || "Balanced";
    applyZoneBounds(elements.faceSensitivityRow, elements.faceSensitivity, val);
  });
  elements.faceSensitivity.addEventListener("change", () => {
    const val = Number(elements.faceSensitivity.value);
    updateState({ faceAttentionSensitivity: val });
  });

  elements.faceDelay.addEventListener("input", () => {
    const tenths = Number(elements.faceDelay.value);
    elements.delayLabel.textContent = (tenths / 10).toFixed(1) + "s";
  });
  elements.faceDelay.addEventListener("change", () => {
    const tenths = Number(elements.faceDelay.value);
    updateState({ faceAttentionDelay: tenths * 100 });
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

  const dot = document.getElementById("face-zone-dot");
  const screen = document.getElementById("face-zone-screen");
  const getSensitivity = () => Number(elements.faceSensitivity.value) || 3;

  let gazeOffsetX = 0;
  let gazeOffsetY = 0;
  let lastRawNormX = 0.5;
  let lastRawNormY = 0.5;
  let isDragging = false;

  const loadOffset = (state) => {
    gazeOffsetX = Number(state.gazeOffsetX) || 0;
    gazeOffsetY = Number(state.gazeOffsetY) || 0;
  };
  if (initial?.ok && initial.state) loadOffset(initial.state);

  if (dot && screen) {
    dot.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      isDragging = true;
      dot.classList.add("is-dragging");
      dot.setPointerCapture(e.pointerId);
    });

    dot.addEventListener("pointermove", (e) => {
      if (!isDragging) return;
      const rect = screen.getBoundingClientRect();
      const nx = Math.max(0.04, Math.min(0.96, (e.clientX - rect.left) / rect.width));
      const ny = Math.max(0.04, Math.min(0.96, (e.clientY - rect.top) / rect.height));
      dot.style.left = (nx * 100) + "%";
      dot.style.top = (ny * 100) + "%";
    });

    dot.addEventListener("pointerup", (e) => {
      if (!isDragging) return;
      isDragging = false;
      dot.classList.remove("is-dragging");
      const rect = screen.getBoundingClientRect();
      const dropX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const dropY = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      gazeOffsetX = lastRawNormX - dropX;
      gazeOffsetY = lastRawNormY - dropY;
      updateState({ gazeOffsetX, gazeOffsetY });
    });
  }

  const recenterBtn = document.getElementById("face-recenter");
  if (recenterBtn) {
    recenterBtn.addEventListener("click", () => {
      gazeOffsetX = 0;
      gazeOffsetY = 0;
      updateState({ gazeOffsetX: 0, gazeOffsetY: 0 });
    });
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === CHANNEL.STATE_UPDATED && message.payload) {
      applyStateToUI(message.payload);
      loadOffset(message.payload);
    }
    if (message?.type === "AFK_FACE_STATUS") {
      setFaceStatus(message.state);
    }
    if (message?.type === "AFK_GAZE_UPDATE" && dot && !isDragging) {
      lastRawNormX = message.normX;
      lastRawNormY = message.normY;
      updateDot(dot, message.normX, message.normY, getSensitivity, gazeOffsetX, gazeOffsetY);
    }
  });

});
