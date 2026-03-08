// Voice handler
// Handles: browser speech recognition and command filtering.
// Commands fire as soon as they appear in interim transcripts.

const WAKE_WORD = "afk";
const COMMAND_COOLDOWN_MS = 900;
const RESTART_BASE_DELAY_MS = 700;
const RESTART_MAX_DELAY_MS = 4000;
const TOKEN_SERVER = "http://localhost:5001/scribe-token";
const SpeechRecognitionCtor =
  window.SpeechRecognition || window.webkitSpeechRecognition || null;

const COMMAND_ALIASES = [
  { action: "page-down", phrases: ["page down", "scroll down", "go down"] },
  { action: "page-up", phrases: ["page up", "scroll up", "go up"] },
  { action: "zoom-in", phrases: ["zoom in", "zoom in please"] },
  { action: "zoom-out", phrases: ["zoom out", "zoom out please"] },
  { action: "next-tab", phrases: ["next tab", "tab next"] },
  { action: "prev-tab", phrases: ["previous tab", "prev tab", "back tab"] },
  { action: "go-back", phrases: ["go back"] },
  { action: "go-forward", phrases: ["go forward"] },
  { action: "new-tab", phrases: ["new tab", "open tab"] },
];

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ");
}

function isWordBoundaryChar(char) {
  return char === " " || char === "";
}

function findPhraseIndexes(text, phrase) {
  const indexes = [];
  let from = 0;

  while (from < text.length) {
    const index = text.indexOf(phrase, from);
    if (index < 0) break;

    const before = index === 0 ? "" : text[index - 1];
    const afterPos = index + phrase.length;
    const after = afterPos >= text.length ? "" : text[afterPos];
    if (isWordBoundaryChar(before) && isWordBoundaryChar(after)) {
      indexes.push(index);
    }

    from = index + phrase.length;
  }

  return indexes;
}

function detectCommands(text, { requireWakeWord = true } = {}) {
  const normalized = normalizeText(text);
  if (!normalized) return { normalized, matches: [] };

  const matches = [];

  for (const { action, phrases } of COMMAND_ALIASES) {
    for (const phrase of phrases) {
      const wakeNeedle = `${WAKE_WORD} ${phrase}`;
      const wakeIndexes = findPhraseIndexes(normalized, wakeNeedle);
      for (const index of wakeIndexes) {
        matches.push({
          action,
          index,
        });
      }

      if (requireWakeWord) continue;

      const plainIndexes = findPhraseIndexes(normalized, phrase);
      for (const index of plainIndexes) {
        const hasWakePrefix =
          index >= WAKE_WORD.length + 1 &&
          normalized.slice(index - (WAKE_WORD.length + 1), index) ===
            `${WAKE_WORD} `;
        if (hasWakePrefix) continue;

        matches.push({
          action,
          index,
        });
      }
    }
  }

  matches.sort((a, b) => a.index - b.index);

  // Build stable markers by per-action order in the utterance.
  // This avoids duplicate firing when partial transcript edits shift indexes.
  const actionOrdinal = new Map();
  for (const match of matches) {
    const nextOrdinal = (actionOrdinal.get(match.action) || 0) + 1;
    actionOrdinal.set(match.action, nextOrdinal);
    match.marker = `${match.action}#${nextOrdinal}`;
  }

  const unique = [];
  const seen = new Set();
  for (const match of matches) {
    if (seen.has(match.marker)) continue;
    seen.add(match.marker);
    unique.push(match);
  }

  return { normalized, matches: unique };
}

let scribeModulePromise = null;

function getScribeModule() {
  if (!scribeModulePromise) {
    // Load vendored module from extension package (MV3-safe, no remote code import).
    scribeModulePromise = import(
      chrome.runtime.getURL("content/vendor/elevenlabs-client.bundle.mjs")
    );
  }
  return scribeModulePromise;
}

async function getToken() {
  const response = await fetch(TOKEN_SERVER);
  if (!response.ok) {
    throw new Error(`token fetch failed (${response.status})`);
  }
  const { token } = await response.json();
  if (!token) throw new Error("token missing");
  return token;
}

function createVoiceHandler({ onCommand, onStatus, onTranscript } = {}) {
  let connection = null;
  let recognition = null;
  let starting = false;
  let enabled = false;
  let shouldRestart = false;
  let forceBrowserSpeech = false;
  let requireWakeWord = true;
  let firedMarkers = new Set();
  let lastPartialNormalized = "";
  const lastFiredAt = new Map();
  let restartTimer = null;
  let consecutiveErrors = 0;
  let lastErrorCode = "";

  const setStatus = (status) => {
    if (typeof onStatus === "function") onStatus(status);
  };

  function emitMatches(matches, transcript, committed) {
    let firedCount = 0;
    const now = Date.now();

    for (const match of matches) {
      if (firedMarkers.has(match.marker)) continue;

      const previous = lastFiredAt.get(match.action) || 0;
      if (now - previous < COMMAND_COOLDOWN_MS) continue;

      firedMarkers.add(match.marker);
      lastFiredAt.set(match.action, now);
      firedCount += 1;

      if (typeof onCommand === "function") {
        onCommand(match.action, {
          transcript,
          committed,
          source: "voice",
        });
      }
      setStatus(`heard: ${match.action}`);
    }

    return firedCount;
  }

  function processTranscript(text, { committed = false } = {}) {
    const transcript = String(text || "");
    const { normalized, matches } = detectCommands(transcript, {
      requireWakeWord,
    });

    if (!committed) {
      lastPartialNormalized = normalized;
    }

    const firedCount = emitMatches(matches, transcript, committed);
    if (committed && firedCount === 0) {
      setStatus("ignored");
    }

    if (committed) {
      firedMarkers = new Set();
      lastPartialNormalized = "";
    }
  }

  function scheduleRestart() {
    if (!enabled || !shouldRestart) return;
    const delay = Math.min(
      RESTART_MAX_DELAY_MS,
      RESTART_BASE_DELAY_MS + consecutiveErrors * 400,
    );
    setStatus(`restarting in ${delay}ms`);

    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (enabled && shouldRestart) start();
    }, delay);
  }

  function startBrowserSpeech() {
    if (!SpeechRecognitionCtor) {
      setStatus("error: no speech engine available");
      return;
    }
    if (recognition) return;

    recognition = new SpeechRecognitionCtor();
    recognition.lang = "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      consecutiveErrors = 0;
      lastErrorCode = "";
      setStatus("listening (browser)");
    };

    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = String(result?.[0]?.transcript || "");
        if (typeof onTranscript === "function" && transcript) {
          onTranscript(transcript, { committed: Boolean(result?.isFinal) });
        }
        processTranscript(transcript, { committed: Boolean(result?.isFinal) });
      }
    };

    recognition.onerror = (event) => {
      const errorCode = String(event?.error || "unknown");
      lastErrorCode = errorCode;
      consecutiveErrors += 1;
      setStatus(`retry: ${errorCode}`);
    };

    recognition.onend = () => {
      recognition = null;
      if (enabled && shouldRestart) {
        scheduleRestart();
        return;
      }
      setStatus("off");
    };

    try {
      recognition.start();
    } catch (error) {
      lastErrorCode = String(error?.message || "unknown");
      consecutiveErrors += 1;
      setStatus(`error: ${lastErrorCode}`);
      recognition = null;
      if (enabled && shouldRestart) scheduleRestart();
    }
  }

  async function start() {
    if (!enabled || connection || recognition || starting) return;
    starting = true;
    setStatus("starting");

    try {
      if (forceBrowserSpeech) {
        startBrowserSpeech();
        return;
      }

      const [{ Scribe, RealtimeEvents }, token] = await Promise.all([
        getScribeModule(),
        getToken(),
      ]);
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

      connection.on(RealtimeEvents.OPEN, () => {
        setStatus("connected");
      });

      connection.on(RealtimeEvents.SESSION_STARTED, () => {
        consecutiveErrors = 0;
        lastErrorCode = "";
        setStatus("listening");
      });

      connection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, (data) => {
        const transcript = String(data?.text || "");
        if (typeof onTranscript === "function" && transcript) {
          onTranscript(transcript, { committed: false });
        }
        processTranscript(transcript, { committed: false });
      });

      connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, (data) => {
        const transcript = String(data?.text || "");
        if (typeof onTranscript === "function" && transcript) {
          onTranscript(transcript, { committed: true });
        }
        processTranscript(transcript, { committed: true });
      });

      connection.on(RealtimeEvents.ERROR, (error) => {
        const errorCode = String(
          error?.code || error?.type || error?.message || "unknown",
        );
        lastErrorCode = errorCode;
        consecutiveErrors += 1;
        console.error("[AFK] Voice error:", error);
        setStatus(`error: ${errorCode}`);
      });

      connection.on(RealtimeEvents.CLOSE, () => {
        connection = null;
        if (enabled && shouldRestart) {
          scheduleRestart();
          return;
        }
        setStatus("off");
      });
    } catch (error) {
      lastErrorCode = String(error?.message || "unknown");
      consecutiveErrors += 1;
      forceBrowserSpeech = true;
      console.warn(
        "[AFK] ElevenLabs unavailable, falling back to browser speech:",
        error,
      );
      setStatus("fallback: browser speech");
      connection = null;
      if (enabled && shouldRestart) startBrowserSpeech();
    } finally {
      starting = false;
    }
  }

  function stop() {
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }

    if (connection) {
      const active = connection;
      connection = null;
      try {
        active.close();
      } catch (_error) {
        // Ignore stop race conditions.
      }
    }
    if (recognition) {
      const active = recognition;
      recognition = null;
      active.onend = null;
      try {
        active.stop();
      } catch (_error) {
        // Ignore stop race conditions.
      }
    }
    firedMarkers = new Set();
    lastPartialNormalized = "";
    consecutiveErrors = 0;
    setStatus("off");
  }

  function setEnabled(nextEnabled) {
    enabled = Boolean(nextEnabled);
    shouldRestart = enabled;
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
