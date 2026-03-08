// HUD (heads-up display)
// Handles: on-screen indicator rendering, camera-active badge, gesture feedback UI

/**
 * hud.js — AFK Chrome Extension
 * Floating HUD overlay: camera-active indicator, gesture/voice feedback
 *
 * Interface contract (listens for):
 *   window.__afkHUD.show()
 *   window.__afkHUD.hide()
 *   window.__afkHUD.showFeedback({ action: "page-down", source: "gesture"|"voice", labelText?: string })
 *   window.__afkHUD.setCameraActive(bool)
 *   window.__afkHUD.setEnabled(bool)
 */

(() => {
  // ── Prevent double-injection ───────────────────────────────────────────────
  if (window.__afkHUD) return;

  // ── Action label map ───────────────────────────────────────────────────────
  const ACTION_LABELS = {
    "page-down":  { icon: "↓", label: "Page Down"    },
    "page-up":    { icon: "↑", label: "Page Up"      },
    "go-home":    { icon: "⇤", label: "Home"         },
    "go-end":     { icon: "⇥", label: "End"          },
    "click":        { icon: "◎", label: "Click"        },
    "next-tab":     { icon: "▶", label: "Next Tab"     },
    "prev-tab":     { icon: "◀", label: "Prev Tab"     },
    "tab-next":     { icon: "▶", label: "Next Tab"     },
    "tab-prev":     { icon: "◀", label: "Prev Tab"     },
    "go-back":      { icon: "↩", label: "Go Back"      },
    "go-forward":   { icon: "↪", label: "Go Forward"   },
    "new-tab":      { icon: "+", label: "New Tab"       },
    "video-play":   { icon: "▶", label: "Video Play"    },
    "video-pause":  { icon: "⏸", label: "Video Pause"   },
    "video-next":   { icon: "⏭", label: "Video Next"    },
    "video-mute":   { icon: "🔇", label: "Video Mute"    },
    "video-unmute": { icon: "🔊", label: "Video Unmute"  },
    "page-refresh": { icon: "⟳", label: "Refresh"       },
    "fullscreen-enter": { icon: "⛶", label: "Fullscreen" },
    "fullscreen-exit":  { icon: "🗗", label: "Exit Fullscreen" },
    "press-key":    { icon: "⌨", label: "Press Key"     },
    "click-target": { icon: "🖱", label: "Click Target"  },
    "zoom-in":      { icon: "⊕", label: "Zoom In"      },
    "zoom-out":     { icon: "⊖", label: "Zoom Out"     },
  };

  // ── Build DOM ──────────────────────────────────────────────────────────────
  const container = document.createElement("div");
  container.id = "afk-hud-root";
  container.setAttribute("aria-live", "polite");
  container.setAttribute("aria-label", "AFK Extension HUD");

  container.innerHTML = `
    <div id="afk-hud-panel">
      <!-- Status bar -->
      <div id="afk-hud-status">
        <div id="afk-cam-indicator">
          <span id="afk-cam-dot"></span>
          <span id="afk-cam-label">CAM</span>
        </div>
        <div id="afk-logo">AFK</div>
        <div id="afk-enabled-indicator">
          <span id="afk-enabled-dot"></span>
          <span id="afk-enabled-label">OFF</span>
        </div>
      </div>

      <!-- Feedback zone -->
      <div id="afk-feedback-zone" aria-hidden="true">
        <div id="afk-feedback-icon"></div>
        <div id="afk-feedback-label"></div>
        <div id="afk-feedback-source"></div>
      </div>
    </div>

    <!-- Ripple container (appended on gesture) -->
    <div id="afk-ripple-container"></div>
  `;

  document.documentElement.appendChild(container);

  // ── Cache refs ─────────────────────────────────────────────────────────────
  const panel        = document.getElementById("afk-hud-panel");
  const camDot       = document.getElementById("afk-cam-dot");
  const camLabel     = document.getElementById("afk-cam-label");
  const enabledDot   = document.getElementById("afk-enabled-dot");
  const enabledLabel = document.getElementById("afk-enabled-label");
  const feedZone     = document.getElementById("afk-feedback-zone");
  const feedIcon     = document.getElementById("afk-feedback-icon");
  const feedLabel    = document.getElementById("afk-feedback-label");
  const feedSource   = document.getElementById("afk-feedback-source");
  const rippleCont   = document.getElementById("afk-ripple-container");

  // ── State ──────────────────────────────────────────────────────────────────
  let feedbackTimer  = null;
  let isVisible      = false;

  // ── Internal helpers ───────────────────────────────────────────────────────
  function _setCamActive(active) {
    camDot.classList.toggle("afk-cam-dot--active", active);
    camLabel.classList.toggle("afk-cam-label--active", active);
    camLabel.textContent = active ? "LIVE" : "CAM";
  }

  function _setEnabled(enabled) {
    enabledDot.classList.toggle("afk-enabled-dot--on", enabled);
    enabledLabel.textContent = enabled ? "ON" : "OFF";
    panel.classList.toggle("afk-hud-panel--enabled", enabled);
  }

  function _showFeedback({ action, source = "gesture", labelText } = {}) {
    // For click-text, show the actual element label that was clicked.
    const meta = action === "click-text"
      ? { icon: "🖱", label: labelText ? `Click: ${labelText}` : "Click" }
      : ACTION_LABELS[action] || { icon: "◈", label: action };

    feedIcon.textContent   = meta.icon;
    feedLabel.textContent  = meta.label;
    feedSource.textContent = source === "voice" ? "🎙 voice" : "✋ gesture";
    feedSource.dataset.source = source;

    // Animate in
    feedZone.classList.remove("afk-feedback--exit");
    feedZone.classList.add("afk-feedback--active");

    // Ripple
    _spawnRipple(source);

    clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => {
      feedZone.classList.remove("afk-feedback--active");
      feedZone.classList.add("afk-feedback--exit");
    }, 1800);
  }

  function _spawnRipple(source) {
    const ripple = document.createElement("div");
    ripple.className = `afk-ripple afk-ripple--${source}`;
    rippleCont.appendChild(ripple);
    ripple.addEventListener("animationend", () => ripple.remove());
  }

  function _show() {
    if (isVisible) return;
    isVisible = true;
    container.classList.add("afk-hud--visible");
  }

  function _hide() {
    isVisible = false;
    container.classList.remove("afk-hud--visible");
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  window.__afkHUD = {
    show:            _show,
    hide:            _hide,
    setCameraActive: _setCamActive,
    setEnabled:      _setEnabled,
    showFeedback:    _showFeedback,
  };

  // ── Listen for messages from content.js ───────────────────────────────────
  window.addEventListener("afk:hud", (e) => {
    const { type, payload } = e.detail || {};
    switch (type) {
      case "show":            _show();                        break;
      case "hide":            _hide();                        break;
      case "camera-active":   _setCamActive(payload);         break;
      case "enabled":         _setEnabled(payload);           break;
      case "feedback":        _showFeedback(payload);         break;
    }
  });

  // ── Init: read stored state ────────────────────────────────────────────────
  chrome.storage.sync.get(["afkEnabled"], ({ afkEnabled }) => {
    _setEnabled(!!afkEnabled);
    if (afkEnabled) _show();
  });

  chrome.storage.onChanged.addListener((changes) => {
    if ("afkEnabled" in changes) {
      const enabled = changes.afkEnabled.newValue;
      _setEnabled(enabled);
      enabled ? _show() : _hide();
    }
  });

})();