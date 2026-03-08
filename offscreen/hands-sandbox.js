'use strict';

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
let hands = null;

function init() {
  hands = new Hands({
    locateFile: (file) => `../assets/mediapipe/${file}`,
  });
  hands.setOptions({
    maxNumHands: 2,
    modelComplexity: 1,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  hands.onResults((results) => {
    const landmarks = (results.multiHandLandmarks || []).map((hand) =>
      hand.map((pt) => ({ x: pt.x, y: pt.y, z: pt.z })),
    );
    const handedness = (results.multiHandedness || []).map((h) => ({
      label: h.label,
      score: h.score,
    }));
    window.parent.postMessage(
      { type: 'hands-results', landmarks, handedness },
      '*',
    );
  });
  window.parent.postMessage({ type: 'hands-ready' }, '*');
}

window.addEventListener('message', async (event) => {
  const data = event.data;
  if (!data?.type) return;

  if (data.type === 'hands-ping' && hands) {
    window.parent.postMessage({ type: 'hands-ready' }, '*');
    return;
  }

  if (data.type === 'hands-frame' && hands) {
    const bitmap = data.image;
    if (!bitmap) return;
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    try {
      await hands.send({ image: canvas });
    } catch (err) {
      window.parent.postMessage(
        { type: 'hands-error', error: err?.message || String(err) },
        '*',
      );
    }
  }
});

try {
  init();
} catch (err) {
  window.parent.postMessage(
    { type: 'hands-error', error: err?.message || String(err) },
    '*',
  );
}
