// Voice handler
// Handles: token fetch, ElevenLabs Scribe session, and command filtering.
// Only committed transcripts with wake-word + known command are emitted.

import { Scribe, RealtimeEvents } from "@elevenlabs/client";

const TOKEN_SERVER = "http://localhost:5001/scribe-token";
const WAKE_WORD = "afk";

const COMMAND_PATTERNS = [
  { pattern: /^(?:scroll\s+)?down$/, action: "scroll-down" },
  { pattern: /^(?:scroll\s+)?up$/, action: "scroll-up" },
  { pattern: /^(?:next\s+tab|tab\s+next|next)$/, action: "next-tab" },
  { pattern: /^(?:previous\s+tab|prev(?:ious)?\s+tab|back\s+tab)$/, action: "prev-tab" },
  { pattern: /^(?:go\s+back|back)$/, action: "go-back" },
  { pattern: /^(?:go\s+forward|forward)$/, action: "go-forward" },
  { pattern: /^(?:new\s+tab|open\s+tab)$/, action: "new-tab" },
];

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ");
}

function parseCommand(text, { requireWakeWord = true } = {}) {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  let phrase = normalized;
  if (requireWakeWord) {
    if (!normalized.startsWith(`${WAKE_WORD} `)) return null;
    phrase = normalized.slice(WAKE_WORD.length).trim();
  } else if (normalized.startsWith(`${WAKE_WORD} `)) {
    // Allow either "afk scroll down" or "scroll down" in non-strict mode.
    phrase = normalized.slice(WAKE_WORD.length).trim();
  }

  if (!phrase) return null;
  for (const { pattern, action } of COMMAND_PATTERNS) {
    if (pattern.test(phrase)) return action;
  }
  return null;
}

async function getToken() {
  const response = await fetch(TOKEN_SERVER);
  if (!response.ok) {
    throw new Error(`Token request failed (${response.status})`);
  }
  const { token } = await response.json();
  if (!token) throw new Error("Token response missing `token`");
  return token;
}

function createVoiceHandler({ onCommand, onStatus } = {}) {
  let connection = null;
  let enabled = false;
  let starting = false;
  let requireWakeWord = true;

  const setStatus = (status) => {
    if (typeof onStatus === "function") onStatus(status);
  };

  async function start() {
    if (!enabled || connection || starting) return;
    starting = true;
    setStatus("starting");

    try {
      const token = await getToken();
      if (!enabled) {
        starting = false;
        return;
      }

      connection = Scribe.connect({
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
        setStatus("listening");
      });

      connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, (data) => {
        const transcript = String(data?.text || "");
        const action = parseCommand(transcript, { requireWakeWord });

        if (!action) {
          setStatus("ignored");
          return;
        }

        if (typeof onCommand === "function") {
          onCommand(action, {
            transcript,
            committed: true,
            source: "voice",
          });
        }
        setStatus(`heard: ${action}`);
      });

      connection.on(RealtimeEvents.ERROR, (error) => {
        console.error("[AFK] Voice error:", error);
        setStatus("error");
      });

      connection.on(RealtimeEvents.OPEN, () => setStatus("connected"));
      connection.on(RealtimeEvents.CLOSE, () => {
        connection = null;
        setStatus(enabled ? "disconnected" : "off");
      });
    } catch (error) {
      console.error("[AFK] Voice start failed:", error);
      setStatus(`error: ${error?.message || String(error)}`);
      connection = null;
    } finally {
      starting = false;
    }
  }

  function stop() {
    if (connection) {
      connection.close();
      connection = null;
    }
    setStatus("off");
  }

  function setEnabled(nextEnabled) {
    enabled = Boolean(nextEnabled);
    if (enabled) {
      start();
    } else {
      stop();
    }
  }

  function setConfig(nextConfig = {}) {
    if (typeof nextConfig.requireWakeWord === "boolean") {
      requireWakeWord = nextConfig.requireWakeWord;
      setStatus(requireWakeWord ? "wake-word:on" : "wake-word:off");
    }
  }

  return { start, stop, setEnabled, setConfig };
}

export { createVoiceHandler };
export default createVoiceHandler;
