/**
 * content.js — AFK Chrome Extension
 *
 * Bridges gesture-handler → AFK_COMMAND protocol (Jes's service worker).
 * Voice commands are handled directly by voice-handler → AFK_COMMAND.
 * This file handles:
 *   - Cursor tracking + floating dot
 *   - Click / drag (pointer events on the page)
 *   - Scroll (directly on page — faster than going via service worker)
 *   - Everything else → AFK_COMMAND to service worker
 *   - HUD show/hide on state changes
 */

(() => {
  if (window.__afkContent) return;
  window.__afkContent = true;

  let enabled    = false;
  let cursorNorm = { x: 0.5, y: 0.5 };
  let cursorEl   = null;
  let isDragging = false;

  // ── Action map ────────────────────────────────────────────────────────────
  // Scroll + click + drag run directly on the page for zero-latency.
  // Everything else goes through the service worker (needs tab/zoom/nav APIs).
  const LOCAL_ACTIONS = {
    "scroll-down":  () => window.scrollBy({ top:  300, behavior: "smooth" }),
    "scroll-up":    () => window.scrollBy({ top: -300, behavior: "smooth" }),
    "scroll-right": () => window.scrollBy({ left:  300, behavior: "smooth" }),
    "scroll-left":  () => window.scrollBy({ left: -300, behavior: "smooth" }),
    "click":        () => triggerClick(),
    "drag-start":   () => triggerDragStart(),
    "drag-end":     () => triggerDragEnd(),
  };

  const REMOTE_ACTIONS = new Set([
    "zoom-in", "zoom-out",
    "go-back", "go-forward",
    "tab-next", "tab-prev", "tab-new",
    "next-tab", "prev-tab", "new-tab", // voice-handler uses these strings
  ]);

  function dispatch(action) {
    if (LOCAL_ACTIONS[action]) {
      LOCAL_ACTIONS[action]();
    } else if (REMOTE_ACTIONS.has(action)) {
      chrome.runtime.sendMessage({ type: "AFK_COMMAND", payload: { action } }).catch(() => {});
    }
  }

  // ── Boot — use Jes's AFK_STATE_UPDATED protocol ───────────────────────────
  chrome.runtime.sendMessage({ type: "AFK_GET_STATE" }).then(({ state }) => {
    enabled = !!state?.enabled;
    if (enabled) bootstrap();
  }).catch(() => {});

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "AFK_STATE_UPDATED") {
      const wasEnabled = enabled;
      enabled = !!msg.payload?.enabled;
      if (enabled && !wasEnabled) bootstrap();
      if (!enabled && wasEnabled) teardown();
    }
    if (msg.type === "CAMERA_STATE") {
      window.__afkHUD?.setCameraActive(msg.payload);
    }
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  function bootstrap() {
    window.__afkHUD?.show();
    injectCursorEl();
    injectStyles();
    window.addEventListener("afk:gesture",  onGesture);
    window.addEventListener("afk:cursor",   onCursor);
  }

  function teardown() {
    window.__afkHUD?.hide();
    removeCursorEl();
    window.removeEventListener("afk:gesture",  onGesture);
    window.removeEventListener("afk:cursor",   onCursor);
    if (isDragging) triggerDragEnd();
  }

  // ── Gesture events (from gesture-handler.js) ──────────────────────────────
  function onGesture(e) {
    if (!enabled) return;
    const { action } = e.detail || {};
    if (!action) return;
    dispatch(action);
    if (!["drag-start", "drag-end"].includes(action)) {
      window.__afkHUD?.showFeedback({ action, source: "gesture" });
    }
  }

  function onCursor(e) {
    if (!enabled) return;
    cursorNorm = { x: e.detail.x, y: e.detail.y };
    updateCursorEl();
    if (isDragging) triggerDragMove();
  }

  // ── Click ─────────────────────────────────────────────────────────────────
  function triggerClick() {
    const { x, y } = toPixels();
    const el = document.elementFromPoint(x, y);
    if (!el) return;
    ["pointerdown", "mousedown", "mouseup", "click"].forEach(type =>
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }))
    );
    spawnRipple(x, y, false);
  }

  // ── Drag ──────────────────────────────────────────────────────────────────
  function triggerDragStart() {
    isDragging = true;
    const { x, y } = toPixels();
    const el = document.elementFromPoint(x, y);
    el?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y }));
    spawnRipple(x, y, true);
    cursorEl?.classList.add("afk-cursor--dragging");
  }

  function triggerDragMove() {
    const { x, y } = toPixels();
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y }));
  }

  function triggerDragEnd() {
    isDragging = false;
    const { x, y } = toPixels();
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y }));
    cursorEl?.classList.remove("afk-cursor--dragging");
  }

  // ── Cursor dot ────────────────────────────────────────────────────────────
  function toPixels() {
    return { x: cursorNorm.x * window.innerWidth, y: cursorNorm.y * window.innerHeight };
  }

  function injectCursorEl() {
    if (cursorEl) return;
    cursorEl = document.createElement("div");
    cursorEl.id = "afk-cursor";
    document.documentElement.appendChild(cursorEl);
  }

  function updateCursorEl() {
    if (!cursorEl) return;
    const { x, y } = toPixels();
    cursorEl.style.left = x + "px";
    cursorEl.style.top  = y + "px";
  }

  function removeCursorEl() {
    cursorEl?.remove();
    cursorEl = null;
  }

  function spawnRipple(x, y, isDrag) {
    const r = document.createElement("div");
    r.className = isDrag ? "afk-ripple afk-ripple--drag" : "afk-ripple";
    r.style.cssText = `left:${x}px;top:${y}px`;
    document.documentElement.appendChild(r);
    r.addEventListener("animationend", () => r.remove(), { once: true });
  }

  function injectStyles() {
    if (document.getElementById("afk-content-style")) return;
    const s = document.createElement("style");
    s.id = "afk-content-style";
    s.textContent = `
      #afk-cursor {
        position: fixed;
        width: 24px; height: 24px; border-radius: 50%;
        border: 2px solid #00ffe0;
        background: rgba(0,255,224,0.12);
        pointer-events: none; z-index: 2147483645;
        transform: translate(-50%,-50%);
        box-shadow: 0 0 10px rgba(0,255,224,0.5);
        transition: left .04s linear, top .04s linear, width .15s ease, height .15s ease;
        left: 50%; top: 50%;
      }
      #afk-cursor.afk-cursor--dragging {
        width: 32px; height: 32px;
        background: rgba(0,255,224,0.28);
        box-shadow: 0 0 18px rgba(0,255,224,0.7);
      }
      .afk-ripple {
        position: fixed; width: 36px; height: 36px; border-radius: 50%;
        border: 2px solid #00ffe0; pointer-events: none; z-index: 2147483646;
        transform: translate(-50%,-50%) scale(0);
        animation: afk-ripple-out .45s ease-out forwards;
      }
      .afk-ripple--drag { border-color: #bf80ff; width: 44px; height: 44px; }
      @keyframes afk-ripple-out { to { transform: translate(-50%,-50%) scale(2.5); opacity: 0; } }
    `;
    document.head.appendChild(s);
  }

})();