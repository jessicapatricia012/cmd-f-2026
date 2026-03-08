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
    toggleVoice: document.getElementById("toggle-voice"),
    toggleWakeword: document.getElementById("toggle-wakeword"),
    keywordsList: document.getElementById("keywords-list"),
    saveKeywords: document.getElementById("save-keywords"),
    keywordsStatus: document.getElementById("keywords-status"),
  };

  if (Object.values(elements).some((value) => !value)) return;

  renderKeywordFields(elements.keywordsList);

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

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === CHANNEL.STATE_UPDATED && message.payload) {
      applyStateToUI(message.payload);
    }
  });

});