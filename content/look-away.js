// AFK Look-Away Detector
// CSP-safe fallback path using built-in FaceDetector API.
// Sends AFK_LOOK_AWAY / AFK_LOOK_BACK to background.

(async () => {
  if (window.__afkLookAwayRunning) return;
  window.__afkLookAwayRunning = true;

  const LOOK_AWAY_GRACE_MS = 1800;
  const LOOK_BACK_GRACE_MS = 650;
  const POLL_INTERVAL_MS = 220;
  const DARK_FRAME_LUMA_MAX = 70;
  const FLAT_FRAME_VAR_MAX = 18;

  let stream = null;
  let detector = null;
  let video = null;
  let pollTimer = null;
  let running = false;

  let awaySince = null;
  let backSince = null;
  let awayFired = false;
  let backFired = true;
  let detectErrorStreak = 0;
  let canvas = null;
  let ctx = null;

  function getLandmark(face, type) {
    return face?.landmarks?.find((l) => l?.type === type);
  }

  function isFacingScreen(face) {
    if (!face?.boundingBox || !video?.videoWidth || !video?.videoHeight) return false;

    const bb = face.boundingBox;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const cx = (bb.x + bb.width / 2) / vw;
    const cy = (bb.y + bb.height / 2) / vh;
    const faceSize = bb.width / vw;

    let facing =
      cx > 0.22 &&
      cx < 0.78 &&
      cy > 0.18 &&
      cy < 0.82 &&
      faceSize > 0.12;

    const leftEye = getLandmark(face, "leftEye");
    const rightEye = getLandmark(face, "rightEye");
    const nose = getLandmark(face, "noseTip");
    if (!(leftEye && rightEye && nose)) return false;
    const eyeMidX = (leftEye.location.x + rightEye.location.x) / 2;
    const eyeDx = rightEye.location.x - leftEye.location.x;
    const eyeDy = rightEye.location.y - leftEye.location.y;
    const eyeDist = Math.hypot(eyeDx, eyeDy);
    if (eyeDist <= 3) return false;
    const yaw = (nose.location.x - eyeMidX) / eyeDist;
    const roll = eyeDy / eyeDist;
    facing = facing && Math.abs(yaw) < 0.55 && Math.abs(roll) < 0.45;

    return facing;
  }

  function frameSignal() {
    if (!ctx || !canvas || !video?.videoWidth || !video?.videoHeight) return false;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let total = 0;
    let totalSq = 0;
    let samples = 0;
    for (let i = 0; i < data.length; i += 64) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      total += luma;
      totalSq += luma * luma;
      samples++;
    }
    const luma = samples ? total / samples : 255;
    const meanSq = samples ? totalSq / samples : 0;
    const variance = Math.max(0, meanSq - luma * luma);
    const covered = luma <= DARK_FRAME_LUMA_MAX || (luma <= 110 && variance <= FLAT_FRAME_VAR_MAX);
    return { covered, luma, variance };
  }

  function pauseLocal() {
    const yt = document.getElementById("movie_player");
    if (yt?.pauseVideo) yt.pauseVideo();
    document.querySelectorAll("video").forEach((v) => {
      if (!v.paused) {
        v.pause();
        v.dataset.afkPaused = "1";
      }
    });
  }

  function resumeLocal() {
    const yt = document.getElementById("movie_player");
    if (yt?.playVideo) yt.playVideo();
    document.querySelectorAll("video[data-afk-paused='1']").forEach((v) => {
      v.play().catch(() => {});
      delete v.dataset.afkPaused;
    });
  }

  async function start() {
    if (running) return;

    if (!("FaceDetector" in window)) {
      console.warn("[AFK look-away] FaceDetector API unavailable");
      window.__afkLookAwayRunning = false;
      return;
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: 320, height: 240 },
        audio: false,
      });
    } catch (e) {
      console.warn("[AFK look-away] camera error:", e?.name, e?.message);
      window.__afkLookAwayRunning = false;
      return;
    }

    video = document.createElement("video");
    video.srcObject = stream;
    video.setAttribute("playsinline", "");
    video.muted = true;
    video.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;top:-9999px";
    document.body.appendChild(video);
    await video.play();
    canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 120;
    ctx = canvas.getContext("2d", { willReadFrequently: true });

    detector = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
    running = true;
    schedulePoll();
    console.log("[AFK look-away] started");
  }

  function stop() {
    running = false;
    clearTimeout(pollTimer);
    detector = null;
    canvas = null;
    ctx = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video?.remove();
    video = null;
    window.__afkLookAwayRunning = false;
    console.log("[AFK look-away] stopped");
  }

  function handleFacing(facing) {
    if (facing === null) return;
    const now = Date.now();

    if (facing) {
      awaySince = null;
      if (!backSince) backSince = now;
      if (awayFired && !backFired && now - backSince >= LOOK_BACK_GRACE_MS) {
        awayFired = false;
        backFired = true;
        resumeLocal();
        chrome.runtime.sendMessage({ type: "AFK_LOOK_BACK" }).catch(() => {});
      }
      return;
    }

    backSince = null;
    if (!awaySince) awaySince = now;
    if (!awayFired && now - awaySince >= LOOK_AWAY_GRACE_MS) {
      awayFired = true;
      backFired = false;
      pauseLocal();
      chrome.runtime.sendMessage({ type: "AFK_LOOK_AWAY" }).catch(() => {});
    }
  }

  function schedulePoll() {
    if (!running) return;
    pollTimer = setTimeout(async () => {
      const signal = frameSignal() || { covered: false, luma: 255, variance: 0 };
      const dark = signal.covered;
      try {
        const faces = await detector.detect(video);
        detectErrorStreak = 0;
        const face = faces?.[0] || null;
        const facing = isFacingScreen(face);
        if (dark && !face) {
          handleFacing(false);
        } else {
          handleFacing(facing);
        }
      } catch {
        detectErrorStreak += 1;
        if (dark || detectErrorStreak >= 2) handleFacing(false);
      }
      schedulePoll();
    }, POLL_INTERVAL_MS);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "AFK_LOOK_AWAY_STOP") stop();
  });

  await start();
})();
