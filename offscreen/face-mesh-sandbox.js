'use strict';

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
let faceMesh = null;

function init() {
  faceMesh = new FaceMesh({
    locateFile: (file) => `../node_modules/@mediapipe/face_mesh/${file}`,
  });
  faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  faceMesh.onResults((results) => {
    const faces = (results.multiFaceLandmarks || []).map((face) =>
      face.map((pt) => ({ x: pt.x, y: pt.y, z: pt.z })),
    );
    window.parent.postMessage({ type: 'facemesh-results', faces }, '*');
  });
  window.parent.postMessage({ type: 'facemesh-ready' }, '*');
}

window.addEventListener('message', async (event) => {
  const data = event.data;
  if (!data?.type) return;

  if (data.type === 'facemesh-ping' && faceMesh) {
    window.parent.postMessage({ type: 'facemesh-ready' }, '*');
    return;
  }

  if (data.type === 'facemesh-frame' && faceMesh) {
    const bitmap = data.image;
    if (!bitmap) return;
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    try {
      await faceMesh.send({ image: canvas });
    } catch (err) {
      window.parent.postMessage(
        { type: 'facemesh-error', error: err?.message || String(err) },
        '*',
      );
    }
  }
});

try {
  init();
} catch (err) {
  window.parent.postMessage(
    { type: 'facemesh-error', error: err?.message || String(err) },
    '*',
  );
}
