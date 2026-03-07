// Voice handler
// Handles: browser speech recognition and command filtering.
// Commands fire as soon as they appear in interim transcripts.

const WAKE_WORD = "afk";
const COMMAND_COOLDOWN_MS = 900;

const COMMAND_ALIASES = [
  { action: "page-down", phrases: ["page down"] },
  { action: "page-up", phrases: ["page up"] },
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
          marker: `${action}@${index}`,
        });
      }

      if (requireWakeWord) continue;

      const plainIndexes = findPhraseIndexes(normalized, phrase);
      for (const index of plainIndexes) {
        const hasWakePrefix =
          index >= WAKE_WORD.length + 1 &&
          normalized.slice(index - (WAKE_WORD.length + 1), index) === `${WAKE_WORD} `;
        if (hasWakePrefix) continue;

        matches.push({
          action,
          index,
          marker: `${action}@${index}`,
        });
      }
    }
  }

  matches.sort((a, b) => a.index - b.index);

  const unique = [];
  const seen = new Set();
  for (const match of matches) {
    if (seen.has(match.marker)) continue;
    seen.add(match.marker);
    unique.push(match);
  }

  return { normalized, matches: unique };
}

const SpeechRecognitionCtor =
  window.SpeechRecognition || window.webkitSpeechRecognition || null;

function createVoiceHandler({ onCommand, onStatus } = {}) {
  let recognition = null;
  let enabled = false;
  let shouldRestart = false;
  let requireWakeWord = true;
  let firedMarkers = new Set();
  let lastPartialNormalized = "";
  const lastFiredAt = new Map();

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
    const { normalized, matches } = detectCommands(transcript, { requireWakeWord });

    if (!committed && normalized.length < lastPartialNormalized.length) {
      firedMarkers = new Set();
    }
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

  function start() {
    if (!enabled || recognition) return;
    setStatus("starting");

    if (!SpeechRecognitionCtor) {
      setStatus("error: speech api unsupported");
      return;
    }

    try {
      recognition = new SpeechRecognitionCtor();
      recognition.lang = "en-US";
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      recognition.onstart = () => {
        setStatus("listening");
      };

      recognition.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          const transcript = result?.[0]?.transcript || "";
          processTranscript(transcript, { committed: Boolean(result?.isFinal) });
        }
      };

      recognition.onerror = (event) => {
        const errorCode = event?.error || "unknown";
        console.error("[AFK] Voice error:", event);
        setStatus(`error: ${errorCode}`);
      };

      recognition.onend = () => {
        recognition = null;
        if (enabled && shouldRestart) {
          setStatus("restarting");
          setTimeout(() => {
            if (enabled && shouldRestart) start();
          }, 250);
          return;
        }
        setStatus("off");
      };

      recognition.start();
    } catch (error) {
      console.error("[AFK] Voice start failed:", error);
      setStatus(`error: ${error?.message || String(error)}`);
      recognition = null;
    }
  }

  function stop() {
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
