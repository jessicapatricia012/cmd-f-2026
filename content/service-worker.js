/**
 * service-worker.js — AFK Chrome Extension
 * Jes's original architecture, extended with:
 *   - jenol's popup frame / camera relay pipeline
 *   - zoom in/out
 *   - tab-next / tab-prev aliases (gesture-handler uses these strings)
 *   - tab-new alias
 */

const STORAGE_KEY = "afkState";
const DEFAULT_STATE = {
  enabled:           false,
  gesturesEnabled:   true,
  voiceEnabled:      true,
  cameraActive:      false,
};

// ── State helpers ─────────────────────────────────────────────────────────
async function getState() {
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  return { ...DEFAULT_STATE, ...(stored[STORAGE_KEY] || {}) };
}

async function setState(partial) {
  const current = await getState();
  const next    = { ...current, ...partial };
  await chrome.storage.sync.set({ [STORAGE_KEY]: next });
  return next;
}

async function broadcastState(state) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(async (tab) => {
    if (!tab.id) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "AFK_STATE_UPDATED", payload: state });
    } catch { /* tab has no content script */ }
  }));
}

async function withActiveTab(callback) {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id) return;
  await callback(activeTab);
}

async function executeInTab(tabId, fn, args = []) {
  await chrome.scripting.executeScript({ target: { tabId }, func: fn, args });
}

// ── Shared tab switcher ───────────────────────────────────────────────────
async function shiftTab(delta) {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!active) return;
  const tabs  = await chrome.tabs.query({ currentWindow: true });
  const i     = tabs.findIndex(t => t.id === active.id);
  if (i < 0) return;
  const next  = tabs[(i + delta + tabs.length) % tabs.length];
  if (next?.id) await chrome.tabs.update(next.id, { active: true });
}

// ── Action handlers ───────────────────────────────────────────────────────
// Jes's originals kept intact, extra aliases added for gesture-handler strings
const ACTION_HANDLERS = {
  // Scroll
  "scroll-down":  () => withActiveTab(tab => executeInTab(tab.id, a => window.scrollBy(0, a),  [500])),
  "scroll-up":    () => withActiveTab(tab => executeInTab(tab.id, a => window.scrollBy(0, a),  [-500])),
  "scroll-right": () => withActiveTab(tab => executeInTab(tab.id, a => window.scrollBy(a, 0),  [400])),
  "scroll-left":  () => withActiveTab(tab => executeInTab(tab.id, a => window.scrollBy(a, 0),  [-400])),

  // Navigation
  "go-back":    () => withActiveTab(tab => executeInTab(tab.id, () => history.back())),
  "go-forward": () => withActiveTab(tab => executeInTab(tab.id, () => history.forward())),

  // Tabs — Jes's names + gesture-handler aliases
  "next-tab":  () => shiftTab(+1),
  "tab-next":  () => shiftTab(+1),
  "prev-tab":  () => shiftTab(-1),
  "tab-prev":  () => shiftTab(-1),
  "new-tab":   () => chrome.tabs.create({}),
  "tab-new":   () => chrome.tabs.create({}),

  // Zoom (gesture-handler only — no voice equivalent in Jes's map)
  "zoom-in":  () => withActiveTab(async tab => {
    const cur  = await chrome.tabs.getZoom(tab.id);
    await chrome.tabs.setZoom(tab.id, Math.min(3, Math.round((cur + 0.1) * 10) / 10));
  }),
  "zoom-out": () => withActiveTab(async tab => {
    const cur  = await chrome.tabs.getZoom(tab.id);
    await chrome.tabs.setZoom(tab.id, Math.max(0.25, Math.round((cur - 0.1) * 10) / 10));
  }),

  // Click (Jes's original)
  "click": () => withActiveTab(async tab => {
    await executeInTab(tab.id, () => {
      const focused = document.activeElement;
      if (focused && focused !== document.body) { focused.click(); return; }
      const sel = 'a,button,[role="button"],input,select,textarea,[tabindex]:not([tabindex="-1"])';
      const el  = Array.from(document.querySelectorAll(sel)).find(e => {
        const r = e.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight && r.width > 0;
      });
      el?.click();
    });
  }),
};

// ── Message listener ──────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (!message?.type) {
      sendResponse({ ok: false, error: "Missing message type" });
      return;
    }

    // ── Jes's protocol ────────────────────────────────────────────────
    if (message.type === "AFK_GET_STATE") {
      sendResponse({ ok: true, state: await getState() });
      return;
    }

    if (message.type === "AFK_SET_STATE") {
      const next = await setState(message.payload || {});
      await broadcastState(next);
      sendResponse({ ok: true, state: next });
      return;
    }

    if (message.type === "AFK_COMMAND") {
      const state  = await getState();
      const action = message.payload?.action;
      if (!state.enabled) { sendResponse({ ok: true, skipped: true, reason: "disabled" }); return; }
      const handler = ACTION_HANDLERS[action];
      if (!handler) { sendResponse({ ok: false, error: `Unknown action: ${action}` }); return; }
      await handler();
      sendResponse({ ok: true });
      return;
    }

    // ── jenol's popup / camera relay pipeline ─────────────────────────
    if (message.type === "POPUP_FRAME" || message.type === "GESTURE_LABEL") {
      // Forward to popup — silently ignore if popup is closed
      chrome.runtime.sendMessage(message).catch(() => {});
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "CAMERA_STATE") {
      await setState({ cameraActive: !!message.payload });
      chrome.runtime.sendMessage(message).catch(() => {});
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: `Unsupported message type: ${message.type}` });
  })().catch(err => sendResponse({ ok: false, error: String(err) }));

  return true; // keep channel open for async response
});

// ── Install ───────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  const current = await getState();
  await chrome.storage.sync.set({ [STORAGE_KEY]: current });
});

// ── Keyboard shortcut ─────────────────────────────────────────────────────
chrome.commands.onCommand.addListener(async (command) => {
  if (command === "_execute_action") {
    const { enabled } = await getState();
    const next = await setState({ enabled: !enabled });
    await broadcastState(next);
  }
});