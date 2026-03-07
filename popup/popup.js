/**
 * popup.js — AFK Chrome Extension
 * 
 * NOTE: Chrome extensions cannot access getUserMedia() in popups.
 * The camera runs in gesture-handler.js (content script) instead.
 * The popup receives video frames + landmarks via chrome.runtime messages
 * and draws them onto a canvas.
 */

function safeSend(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ── Element refs ──────────────────────────────────────────────────────────
const mainToggle     = document.getElementById("main-toggle");
const statusText     = document.getElementById("status-text");
const camDot         = document.getElementById("cam-dot");
const camLabel       = document.getElementById("cam-label");
const camFeedWrap    = document.getElementById("cam-feed-wrap");
const camPlaceholder = document.getElementById("cam-placeholder");
const videoCanvas    = document.getElementById("cam-video-canvas");  // shows the feed
const landmarkCanvas = document.getElementById("afk-landmark-canvas"); // overlay
const gestureLabel   = document.getElementById("gesture-label");
const toggleGesture  = document.getElementById("toggle-gesture");
const toggleVoice    = document.getElementById("toggle-voice");

const vCtx = videoCanvas.getContext("2d");
const lCtx = landmarkCanvas.getContext("2d");

// ── UI helpers ────────────────────────────────────────────────────────────
function setMainEnabled(enabled) {
  mainToggle.setAttribute("aria-checked", String(enabled));
  statusText.textContent = enabled ? "Enabled" : "Disabled";
  statusText.classList.toggle("is-on", enabled);
}

function setMiniToggle(btn, val) {
  btn.setAttribute("aria-checked", String(val));
}

function setCameraLive(live) {
  camDot.classList.toggle("is-live", live);
  camLabel.classList.toggle("is-live", live);
  camFeedWrap.classList.toggle("is-live", live);
  camLabel.textContent = live ? "Live" : "Off";
  if (!live) {
    camPlaceholder.classList.remove("hidden");
    vCtx.clearRect(0, 0, videoCanvas.width, videoCanvas.height);
    lCtx.clearRect(0, 0, landmarkCanvas.width, landmarkCanvas.height);
  } else {
    camPlaceholder.classList.add("hidden");
  }
}

// ── Load initial state ────────────────────────────────────────────────────
chrome.storage.sync.get(
  ["afkEnabled", "gestureEnabled", "voiceEnabled", "cameraActive"],
  ({ afkEnabled = false, gestureEnabled = true, voiceEnabled = true, cameraActive = false }) => {
    setMainEnabled(afkEnabled);
    setMiniToggle(toggleGesture, gestureEnabled);
    setMiniToggle(toggleVoice, voiceEnabled);
    setCameraLive(cameraActive);
  }
);

// ── Toggles ───────────────────────────────────────────────────────────────
mainToggle.addEventListener("click", () => {
  const next = mainToggle.getAttribute("aria-checked") !== "true";
  setMainEnabled(next);
  chrome.storage.sync.set({ afkEnabled: next });
  safeSend({ type: "SET_ENABLED", payload: next });
  if (!next) setCameraLive(false);
});

toggleGesture.addEventListener("click", () => {
  const next = toggleGesture.getAttribute("aria-checked") !== "true";
  setMiniToggle(toggleGesture, next);
  chrome.storage.sync.set({ gestureEnabled: next });
  safeSend({ type: "SET_GESTURE", payload: next });
});

toggleVoice.addEventListener("click", () => {
  const next = toggleVoice.getAttribute("aria-checked") !== "true";
  setMiniToggle(toggleVoice, next);
  chrome.storage.sync.set({ voiceEnabled: next });
  safeSend({ type: "SET_VOICE", payload: next });
});

chrome.storage.onChanged.addListener((changes) => {
  if ("afkEnabled"    in changes) setMainEnabled(changes.afkEnabled.newValue);
  if ("cameraActive"  in changes) setCameraLive(changes.cameraActive.newValue);
});

// ── Canvas sizing ─────────────────────────────────────────────────────────
function syncSize() {
  const w = camFeedWrap.clientWidth  || 268;
  const h = camFeedWrap.clientHeight || 201;
  videoCanvas.width    = w; videoCanvas.height    = h;
  landmarkCanvas.width = w; landmarkCanvas.height = h;
}
window.addEventListener("resize", syncSize);
syncSize();

// ── Receive frames from content script via background ─────────────────────
// Use requestAnimationFrame to paint smoothly without blocking the UI thread
let pendingFrame  = null;
let pendingLandmarks = null;
let rafScheduled  = false;

const frameImg = new Image();

function scheduleRender() {
  if (rafScheduled) return;
  rafScheduled = true;
  requestAnimationFrame(() => {
    rafScheduled = false;
    if (pendingFrame) {
      syncSize();
      vCtx.drawImage(frameImg, 0, 0, videoCanvas.width, videoCanvas.height);
      pendingFrame = null;
    }
    if (pendingLandmarks !== null) {
      drawLandmarks(pendingLandmarks);
      pendingLandmarks = null;
    }
  });
}

frameImg.onload = () => scheduleRender();

// ── Landmark drawing ──────────────────────────────────────────────────────
const HAND_CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [0,9],[9,10],[10,11],[11,12],
  [0,13],[13,14],[14,15],[15,16],
  [0,17],[17,18],[18,19],[19,20],
  [5,9],[9,13],[13,17],
];

function drawLandmarks(landmarks) {
  const w = landmarkCanvas.width, h = landmarkCanvas.height;
  lCtx.clearRect(0, 0, w, h);
  if (!landmarks?.length) return;

  lCtx.strokeStyle = "rgba(0,255,224,0.7)";
  lCtx.lineWidth = 1.5;

  // Landmarks are mirrored at source (gesture-handler) to match the video frame
  const mx = (x) => (1 - x) * w;

  for (const [a, b] of HAND_CONNECTIONS) {
    const pa = landmarks[a], pb = landmarks[b];
    if (!pa || !pb) continue;
    lCtx.beginPath();
    lCtx.moveTo(mx(pa.x), pa.y * h);
    lCtx.lineTo(mx(pb.x), pb.y * h);
    lCtx.stroke();
  }
  for (let i = 0; i < landmarks.length; i++) {
    const p = landmarks[i];
    const isTip = [4,8,12,16,20].includes(i);
    lCtx.beginPath();
    lCtx.arc(mx(p.x), p.y * h, isTip ? 4 : 2.5, 0, Math.PI * 2);
    lCtx.fillStyle = isTip ? "#00ffe0" : "rgba(0,255,224,0.8)";
    lCtx.fill();
  }
}

// ── Message listener ──────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case "POPUP_FRAME":
      // Frame already mirrored by gesture-handler — draw directly
      pendingFrame = true;
      pendingLandmarks = msg.landmarks;
      frameImg.src = msg.frame;
      break;
    case "CAMERA_STATE":
      setCameraLive(msg.payload);
      chrome.storage.sync.set({ cameraActive: msg.payload });
      break;
    case "GESTURE_LABEL":
      gestureLabel.textContent = msg.payload.replace(/-/g, " ");
      gestureLabel.classList.add("show");
      clearTimeout(gestureLabel._t);
      gestureLabel._t = setTimeout(() => gestureLabel.classList.remove("show"), 1200);
      break;
  }
});

// ── ElevenLabs key management ─────────────────────────────────────────────
const elApiKey  = document.getElementById("el-api-key");
const elSaveBtn = document.getElementById("el-save-btn");
const elStatus  = document.getElementById("el-status");

// Load saved key (show masked placeholder if set)
chrome.storage.sync.get(["elevenLabsKey"], ({ elevenLabsKey }) => {
  if (elevenLabsKey) {
    elApiKey.placeholder = "Key saved ✓";
    elStatus.textContent = "ElevenLabs voice feedback active";
    elStatus.className   = "el-status ok";
  }
});

// Save key on button click
elSaveBtn.addEventListener("click", async () => {
  const key = elApiKey.value.trim();
  if (!key) {
    elStatus.textContent = "Please paste a key first";
    elStatus.className   = "el-status err";
    return;
  }

  // Quick validation — ping ElevenLabs voices endpoint
  elStatus.textContent = "Validating…";
  elStatus.className   = "el-status";

  try {
    const res = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": key }
    });

    if (res.ok) {
      chrome.storage.sync.set({ elevenLabsKey: key });
      elApiKey.value       = "";
      elApiKey.placeholder = "Key saved ✓";
      elStatus.textContent = "Connected — voice feedback active";
      elStatus.className   = "el-status ok";
    } else {
      elStatus.textContent = "Invalid key — check and try again";
      elStatus.className   = "el-status err";
    }
  } catch (e) {
    // Network error in popup context — save anyway, validate at runtime
    chrome.storage.sync.set({ elevenLabsKey: key });
    elApiKey.value       = "";
    elApiKey.placeholder = "Key saved ✓";
    elStatus.textContent = "Saved (couldn't verify — check connection)";
    elStatus.className   = "el-status";
  }
});

// Clear key on triple-click of placeholder input
elApiKey.addEventListener("focus", () => {
  if (elApiKey.placeholder === "Key saved ✓") {
    elStatus.textContent = "Paste a new key to replace, or leave blank to keep current";
    elStatus.className   = "el-status";
  }
});