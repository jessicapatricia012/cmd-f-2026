// TTS Worker — fetches audio from the local server and transfers the ArrayBuffer
// back to the offscreen document for playback via Web Audio API.
// Runs in a dedicated worker so the fetch doesn't block the main thread.

self.onmessage = async (e) => {
  const { text } = e.data;
  try {
    const res = await fetch("http://localhost:5001/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return;
    const buffer = await res.arrayBuffer();
    // Transfer ownership (zero-copy) back to the main thread
    self.postMessage({ buffer }, [buffer]);
  } catch (err) {
    console.warn("[AFK TTS Worker]", err);
  }
};
