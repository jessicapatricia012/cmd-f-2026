// Background service worker
// Handles: offscreen document lifecycle, gesture message relay, zoom, tab switching

// ---------------------------------------------------------------------------
// Offscreen document helpers
// ---------------------------------------------------------------------------

async function offscreenExists() {
  // Chrome 116+ supports runtime.getContexts; older versions need SW clients fallback.
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return contexts.length > 0;
  }

  const offscreenUrl = chrome.runtime.getURL('offscreen/offscreen.html');
  const matched = await clients.matchAll();
  return matched.some((client) => client.url === offscreenUrl);
}

async function startOffscreen() {
  if (await offscreenExists()) return;
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL('offscreen/offscreen.html'),
    reasons: ['USER_MEDIA'],
    justification: 'Webcam access for real-time hand gesture recognition',
  });
}

async function stopOffscreen() {
  if (!(await offscreenExists())) return;
  await chrome.offscreen.closeDocument();
}

// ---------------------------------------------------------------------------
// Auto-start if camera permission was previously granted
// ---------------------------------------------------------------------------

async function autoStartIfPermitted() {
  try {
    const perm = await navigator.permissions.query({ name: 'camera' });
    if (perm.state === 'granted') await startOffscreen();
  } catch {
    // permissions API unavailable — skip auto-start; user opens popup to enable
  }
}

chrome.runtime.onInstalled.addListener(() => autoStartIfPermitted().catch(console.error));
chrome.runtime.onStartup.addListener(()   => autoStartIfPermitted().catch(console.error));

// Revive offscreen doc if service worker woke up and doc was closed
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') autoStartIfPermitted().catch(console.error);
});

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // Popup toggled ON — camera permission was just granted by the popup
  if (msg.type === 'start') {
    startOffscreen()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error('[AFK] failed to start offscreen:', err);
        sendResponse({ ok: false, error: err?.message || String(err) });
      });
    return true;
  }

  // Popup toggled OFF
  if (msg.type === 'stop') {
    stopOffscreen()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error('[AFK] failed to stop offscreen:', err);
        sendResponse({ ok: false, error: err?.message || String(err) });
      });
    return true;
  }

  // Relay gesture events from offscreen doc → active tab's content script
  if (msg.type === 'gesture') {
    if (msg.event === 'gesture:closetab') {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const id = tabs[0]?.id;
        if (id != null) chrome.tabs.remove(id).catch(() => {});
      });
      return;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, msg).catch(() => {});
      }
    });
    return;
  }

  // Zoom in / out on the sender tab (request from content script)
  if (msg.type === 'zoom') {
    const tabId = sender.tab?.id;
    if (!tabId) return;
    chrome.tabs.getZoom(tabId, (current) => {
      const delta = msg.direction === 'in' ? 0.1 : -0.1;
      const next  = Math.min(5, Math.max(0.25, Math.round((current + delta) * 10) / 10));
      chrome.tabs.setZoom(tabId, next);
    });
  }

  // Switch to the adjacent tab (request from content script)
  if (msg.type === 'tabswitch') {
    chrome.tabs.query({ currentWindow: true }, (tabs) => {
      const sorted    = tabs.slice().sort((a, b) => a.index - b.index);
      const activeIdx = sorted.findIndex((t) => t.active);
      if (activeIdx === -1) return;
      const step    = msg.direction === 'next' ? 1 : -1;
      const nextIdx = (activeIdx + step + sorted.length) % sorted.length;
      chrome.tabs.update(sorted[nextIdx].id, { active: true });
    });
  }

});
