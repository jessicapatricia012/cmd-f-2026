// Background service worker
// Handles: tab management, extension state, message routing

const STORAGE_KEY = "afkState";
const DEFAULT_STATE = {
  enabled: false,
  gesturesEnabled: true,
  voiceEnabled: true,
};

async function getState() {
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  return {
    ...DEFAULT_STATE,
    ...(stored[STORAGE_KEY] || {}),
  };
}

async function setState(partial) {
  const current = await getState();
  const next = { ...current, ...partial };
  await chrome.storage.sync.set({ [STORAGE_KEY]: next });
  return next;
}

async function broadcastState(state) {
  const tabs = await chrome.tabs.query({});

  await Promise.all(
    tabs.map(async (tab) => {
      if (!tab.id) return;
      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: "AFK_STATE_UPDATED",
          payload: state,
        });
      } catch {
        // Ignore tabs without content script access.
      }
    })
  );
}

async function withActiveTab(callback) {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!activeTab?.id) return;
  await callback(activeTab);
}

async function executeInTab(tabId, fn, args = []) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: fn,
    args,
  });
}

const ACTION_HANDLERS = {
  "scroll-down": async () => {
    await withActiveTab(async (tab) => {
      await executeInTab(tab.id, (amount) => window.scrollBy(0, amount), [500]);
    });
  },
  "scroll-up": async () => {
    await withActiveTab(async (tab) => {
      await executeInTab(tab.id, (amount) => window.scrollBy(0, amount), [-500]);
    });
  },
  "next-tab": async () => {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!active) return;
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const currentIndex = tabs.findIndex((tab) => tab.id === active.id);
    if (currentIndex < 0) return;
    const next = tabs[(currentIndex + 1) % tabs.length];
    if (next?.id) {
      await chrome.tabs.update(next.id, { active: true });
    }
  },
  "prev-tab": async () => {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!active) return;
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const currentIndex = tabs.findIndex((tab) => tab.id === active.id);
    if (currentIndex < 0) return;
    const prevIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    const prev = tabs[prevIndex];
    if (prev?.id) {
      await chrome.tabs.update(prev.id, { active: true });
    }
  },
  "go-back": async () => {
    await withActiveTab(async (tab) => {
      await executeInTab(tab.id, () => history.back());
    });
  },
  "go-forward": async () => {
    await withActiveTab(async (tab) => {
      await executeInTab(tab.id, () => history.forward());
    });
  },
  "new-tab": async () => {
    await chrome.tabs.create({});
  },
};

chrome.runtime.onInstalled.addListener(async () => {
  const current = await getState();
  await chrome.storage.sync.set({ [STORAGE_KEY]: current });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (!message?.type) {
      sendResponse({ ok: false, error: "Missing message type" });
      return;
    }

    if (message.type === "AFK_GET_STATE") {
      const state = await getState();
      sendResponse({ ok: true, state });
      return;
    }

    if (message.type === "AFK_SET_STATE") {
      const nextState = await setState(message.payload || {});
      await broadcastState(nextState);
      sendResponse({ ok: true, state: nextState });
      return;
    }

    if (message.type === "AFK_COMMAND") {
      const state = await getState();
      const action = message.payload?.action;

      if (!state.enabled) {
        sendResponse({ ok: true, skipped: true, reason: "disabled" });
        return;
      }

      const handler = ACTION_HANDLERS[action];
      if (!handler) {
        sendResponse({ ok: false, error: `Unknown action: ${action}` });
        return;
      }

      await handler();
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: `Unsupported message type: ${message.type}` });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error?.message || String(error),
    });
  });

  return true;
});

