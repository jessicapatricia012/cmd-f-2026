// Popup script
// The Enable toggle gates camera permission.  Because Chrome's camera
// permission bubble often appears behind/outside a small popup, we open a
// full browser tab when permission needs to be granted for the first time.

const toggle       = document.getElementById('toggle');
const cameraStatus = document.getElementById('camera-status');
const cameraHelp   = document.getElementById('camera-help');

// ---------------------------------------------------------------------------
// Setup mode — when this page is opened as a full tab (?setup=1) it
// immediately requests camera, then messages the service worker to start.
// ---------------------------------------------------------------------------

if (location.search.includes('setup=1')) {
  cameraStatus.textContent = 'Requesting camera access…';
  (async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      stream.getTracks().forEach((t) => t.stop());

      const res = await chrome.runtime.sendMessage({ type: 'start' });
      if (!res?.ok) throw new Error(res?.error || 'Unknown start error');

      cameraStatus.textContent = 'Camera access granted! You can close this tab.';
      chrome.storage.local.set({ enabled: true });
    } catch (err) {
      cameraStatus.textContent =
        `Still blocked or failed (${err?.message || 'unknown error'}). ` +
        'Go to chrome://settings/content/camera, remove this extension from the Blocked list, then try again.';
    }
  })();
}

// ---------------------------------------------------------------------------
// Camera permission helpers
// ---------------------------------------------------------------------------

async function isCameraGranted() {
  try {
    const result = await navigator.permissions.query({ name: 'camera' });
    return result.state === 'granted';
  } catch {
    return false;
  }
}

async function requestCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  stream.getTracks().forEach((t) => t.stop());
}

// ---------------------------------------------------------------------------
// Restore toggle state on popup open
// ---------------------------------------------------------------------------

chrome.storage.local.get('enabled', ({ enabled }) => {
  toggle.checked = !!enabled;
  isCameraGranted().then((granted) => {
    cameraStatus.textContent = (toggle.checked && granted) ? 'Camera active' : 'Camera off';
    if (toggle.checked && granted) {
      chrome.runtime.sendMessage({ type: 'start' }).catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// Toggle handler
// ---------------------------------------------------------------------------

toggle.addEventListener('change', async () => {
  cameraHelp.style.display = 'none';

  if (toggle.checked) {
    cameraStatus.textContent = 'Requesting camera…';
    try {
      await requestCamera();
      const res = await chrome.runtime.sendMessage({ type: 'start' });
      if (!res?.ok) throw new Error(res?.error || 'Failed to start camera pipeline');
      cameraStatus.textContent = 'Camera active';
      chrome.storage.local.set({ enabled: true });
    } catch (err) {
      cameraStatus.textContent = `Camera access needed (${err?.message || 'unknown error'})`;
      cameraHelp.style.display = 'block';
      toggle.checked = false;
    }
  } else {
    cameraStatus.textContent = 'Camera off';
    chrome.storage.local.set({ enabled: false });
    chrome.runtime.sendMessage({ type: 'stop' }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Camera help buttons
// ---------------------------------------------------------------------------

document.getElementById('btn-open-tab').addEventListener('click', () => {
  // Open this same page as a full tab — Chrome shows the camera bar properly there
  chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html?setup=1') });
  window.close();
});

document.getElementById('btn-open-settings').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://settings/content/camera' });
});
