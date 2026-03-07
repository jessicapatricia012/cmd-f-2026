// Voice handler
// Handles: single-use token fetch, ElevenLabs Scribe session,
//          transcript dispatch to content.js
//
// Requires @elevenlabs/client — needs a bundler (e.g. vite) to run in the extension.

import { Scribe, RealtimeEvents } from "@elevenlabs/client";

const TOKEN_SERVER = "http://localhost:5001/scribe-token";

async function getToken() {
  const res = await fetch(TOKEN_SERVER);
  const { token } = await res.json();
  return token;
}

async function startVoiceEngine(onTranscript) {
  const token = await getToken();

  const connection = Scribe.connect({
    token,
    modelId: "scribe_v2_realtime",
    includeTimestamps: false,
    microphone: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  connection.on(RealtimeEvents.SESSION_STARTED, () => {
    console.log("[AFK] Voice session started");
  });

  // Partial — live feedback while user is speaking
  connection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, (data) => {
    onTranscript(data.text, { committed: false });
  });

  // Committed — final, stable transcript; dispatch command here
  connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, (data) => {
    onTranscript(data.text, { committed: true });
  });

  connection.on(RealtimeEvents.ERROR, (error) => {
    console.error("[AFK] Voice error:", error);
  });

  connection.on(RealtimeEvents.OPEN, () => console.log("[AFK] Voice connection opened"));
  connection.on(RealtimeEvents.CLOSE, () => console.log("[AFK] Voice connection closed"));

  return connection; // caller calls connection.close() to stop
}

export { startVoiceEngine };
