// Voice handler
// Handles: browser speech recognition and command filtering.
// Commands fire as soon as they appear in interim transcripts.

const WAKE_WORD = "afk";
const COMMAND_COOLDOWN_MS = 900;
const RESTART_BASE_DELAY_MS = 700;
const RESTART_MAX_DELAY_MS = 4000;
const SpeechRecognitionCtor =
  window.SpeechRecognition || window.webkitSpeechRecognition || null;

const DEFAULT_COMMAND_ALIASES = [
  { action: "page-down", phrases: ["page down", "scroll down", "go down"] },
  { action: "page-up", phrases: ["page up", "scroll up", "go up"] },
  { action: "go-home", phrases: ["home", "go home", "top", "to top"] },
  { action: "go-end", phrases: ["end", "go end", "bottom", "to bottom"] },
  {
    action: "video-play",
    phrases: ["play", "resume", "play video", "video play"],
  },
  {
    action: "video-pause",
    phrases: [
      "pause",
      "pause video",
      "paused video",
      "video pause",
      "stop video",
    ],
  },
  { action: "video-next", phrases: ["next video", "skip video", "video next"] },
  { action: "video-mute", phrases: ["mute", "mute video", "video mute"] },
  {
    action: "video-unmute",
    phrases: ["unmute", "unmute video", "video unmute"],
  },
  { action: "page-refresh", phrases: ["refresh", "reload", "refresh page"] },
  {
    action: "fullscreen-enter",
    phrases: ["enter fullscreen", "enter full screen"],
  },
  {
    action: "fullscreen-exit",
    phrases: ["exit full screen", "leave full screen"],
  },
  {
    action: "click-target",
    phrases: ["click", "click that", "click this", "select this"],
  },
  { action: "enter-key", phrases: ["enter", "press enter", "hit enter", "submit"] },
  { action: "zoom-in", phrases: ["zoom in"] },
  { action: "zoom-out", phrases: ["zoom out"] },
  { action: "next-tab", phrases: ["next tab", "tab next"] },
  { action: "prev-tab", phrases: ["previous tab", "prev tab", "back tab"] },
  { action: "go-back", phrases: ["go back"] },
  { action: "go-forward", phrases: ["go forward"] },
  { action: "new-tab", phrases: ["new tab", "open tab"] },
  {
    action: "list-clickable",
    phrases: [
      "what can i click",
      "show clickable",
      "list clickable",
      "show buttons",
      "show clickables",
    ],
  },
  {
    action: "close-list",
    phrases: [
      "close list",
      "hide list",
      "dismiss list",
      "close overlay",
      "hide clickable",
      "hide clickables",
      "close clickable",
      "close clickables",
    ],
  },
  {
    action: "dictate-start",
    phrases: [
      "start writing",
      "start dictation",
      "start typing",
      "begin writing",
    ],
  },
  {
    action: "dictate-stop",
    phrases: [
      "stop writing",
      "stop dictation",
      "stop typing",
      "done writing",
      "done typing",
    ],
  },
];

function normalizePhrase(phrase) {
  return normalizeText(String(phrase || ""));
}

const SPECIAL_KEY_MAP = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, label: "Enter" },
  return: { key: "Enter", code: "Enter", keyCode: 13, label: "Enter" },
  tab: { key: "Tab", code: "Tab", keyCode: 9, label: "Tab" },
  space: { key: " ", code: "Space", keyCode: 32, label: "Space" },
  spacebar: { key: " ", code: "Space", keyCode: 32, label: "Space" },
  escape: { key: "Escape", code: "Escape", keyCode: 27, label: "Escape" },
  esc: { key: "Escape", code: "Escape", keyCode: 27, label: "Escape" },
  backspace: {
    key: "Backspace",
    code: "Backspace",
    keyCode: 8,
    label: "Backspace",
  },
  delete: { key: "Delete", code: "Delete", keyCode: 46, label: "Delete" },
  home: { key: "Home", code: "Home", keyCode: 36, label: "Home" },
  end: { key: "End", code: "End", keyCode: 35, label: "End" },
  "page up": { key: "PageUp", code: "PageUp", keyCode: 33, label: "Page Up" },
  "page down": {
    key: "PageDown",
    code: "PageDown",
    keyCode: 34,
    label: "Page Down",
  },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38, label: "Arrow Up" },
  "arrow up": {
    key: "ArrowUp",
    code: "ArrowUp",
    keyCode: 38,
    label: "Arrow Up",
  },
  down: {
    key: "ArrowDown",
    code: "ArrowDown",
    keyCode: 40,
    label: "Arrow Down",
  },
  "arrow down": {
    key: "ArrowDown",
    code: "ArrowDown",
    keyCode: 40,
    label: "Arrow Down",
  },
  left: {
    key: "ArrowLeft",
    code: "ArrowLeft",
    keyCode: 37,
    label: "Arrow Left",
  },
  "arrow left": {
    key: "ArrowLeft",
    code: "ArrowLeft",
    keyCode: 37,
    label: "Arrow Left",
  },
  right: {
    key: "ArrowRight",
    code: "ArrowRight",
    keyCode: 39,
    label: "Arrow Right",
  },
  "arrow right": {
    key: "ArrowRight",
    code: "ArrowRight",
    keyCode: 39,
    label: "Arrow Right",
  },
};

function resolveSpokenKey(phrase) {
  const normalized = normalizePhrase(phrase);
  if (!normalized) return null;

  if (SPECIAL_KEY_MAP[normalized]) return SPECIAL_KEY_MAP[normalized];

  if (/^[a-z]$/.test(normalized)) {
    const upper = normalized.toUpperCase();
    return {
      key: normalized,
      code: `Key${upper}`,
      keyCode: upper.charCodeAt(0),
      label: upper,
    };
  }

  if (/^[0-9]$/.test(normalized)) {
    return {
      key: normalized,
      code: `Digit${normalized}`,
      keyCode: normalized.charCodeAt(0),
      label: normalized,
    };
  }

  const fKeyMatch = normalized.match(/^f([1-9]|1[0-2])$/);
  if (fKeyMatch) {
    const n = Number(fKeyMatch[1]);
    return {
      key: `F${n}`,
      code: `F${n}`,
      keyCode: 111 + n,
      label: `F${n}`,
    };
  }

  return null;
}

function buildCommandAliases(customKeywords = {}) {
  const merged = [];

  for (const entry of DEFAULT_COMMAND_ALIASES) {
    const custom = customKeywords?.[entry.action];
    if (Array.isArray(custom) && custom.length > 0) {
      const phrases = custom.map(normalizePhrase).filter(Boolean);
      if (phrases.length > 0) {
        merged.push({ action: entry.action, phrases });
        continue;
      }
    }
    merged.push(entry);
  }

  return merged;
}

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

function detectCommands(
  text,
  { requireWakeWord = true, commandAliases = DEFAULT_COMMAND_ALIASES } = {},
) {
  const normalized = normalizeText(text);
  if (!normalized) return { normalized, matches: [] };

  const matches = [];

  for (const { action, phrases } of commandAliases) {
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

  // Detect "afk press/hit/tap/type/key <key>" pattern
  const keyPattern = requireWakeWord
    ? /\bafk\s+(?:press|hit|tap|type|key)\s+([a-z0-9]+(?:\s+[a-z0-9]+)?)\b/g
    : /\b(?:press|hit|tap|type|key)\s+([a-z0-9]+(?:\s+[a-z0-9]+)?)\b/g;
  let keyMatch = keyPattern.exec(normalized);
  while (keyMatch) {
    const keyPhrase = keyMatch[1];
    const keyData = resolveSpokenKey(keyPhrase);
    if (keyData) {
      matches.push({
        action: "press-key",
        index: keyMatch.index,
        keyData,
      });
    }
    keyMatch = keyPattern.exec(normalized);
  }

  // Detect "afk click clickable <number>" pattern — e.g. "afk click clickable 3" or "afk click clickable three"
  // Using "clickable" as a disambiguator prevents conflicts with elements named after numbers.
  const WORD_TO_NUM = {
    one: 1,
    two: 2,
    to: 2,
    too: 2,
    three: 3,
    four: 4,
    for: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
  };
  const numWords = Object.keys(WORD_TO_NUM).join("|");
  const clickNumberPattern = requireWakeWord
    ? new RegExp(`\\bafk\\s+click\\s+clickable\\s+(\\d+|${numWords})\\b`, "g")
    : new RegExp(`\\bclick\\s+clickable\\s+(\\d+|${numWords})\\b`, "g");
  let clickNumberMatch = clickNumberPattern.exec(normalized);
  while (clickNumberMatch) {
    const raw = clickNumberMatch[1];
    const clickIndex = /^\d+$/.test(raw)
      ? parseInt(raw, 10)
      : WORD_TO_NUM[raw] || 0;
    if (clickIndex > 0) {
      matches.push({
        action: "click-number",
        index: clickNumberMatch.index,
        clickIndex,
      });
    }
    clickNumberMatch = clickNumberPattern.exec(normalized);
  }

  // Detect "afk click <label text>" pattern — e.g. "afk click sign in"
  // Strips trailing "button" or "link" suffix so natural speech works.
  const clickTextPattern = requireWakeWord
    ? /\bafk\s+click\s+(.+?)(?:\s+button|\s+link)?\s*$/g
    : /\bclick\s+(.+?)(?:\s+button|\s+link)?\s*$/g;
  let clickTextMatch = clickTextPattern.exec(normalized);
  while (clickTextMatch) {
    const labelText = clickTextMatch[1].trim();
    // Skip generic click phrases and anything starting with "clickable" (handled by click-number)
    const genericClickPhrases = new Set(["that", "this", ""]);
    const isClickableNumber =
      /^clickable\s+(\d+|one|two|to|too|three|four|for|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)$/.test(
        labelText,
      );
    const startsWithClickable = /^clickable\b/.test(labelText);
    if (
      labelText &&
      !genericClickPhrases.has(labelText) &&
      !isClickableNumber &&
      !startsWithClickable
    ) {
      matches.push({
        action: "click-text",
        index: clickTextMatch.index,
        labelText,
      });
    }
    clickTextMatch = clickTextPattern.exec(normalized);
  }

  matches.sort((a, b) => a.index - b.index);

  // Build stable markers by per-action order in the utterance.
  // This avoids duplicate firing when partial transcript edits shift indexes.
  const actionOrdinal = new Map();
  for (const match of matches) {
    const actionKey = match.keyData
      ? `${match.action}:${match.keyData.code}`
      : match.labelText
        ? `${match.action}:${match.labelText}`
        : match.clickIndex != null
          ? `${match.action}:${match.clickIndex}`
          : match.action;
    const nextOrdinal = (actionOrdinal.get(actionKey) || 0) + 1;
    actionOrdinal.set(actionKey, nextOrdinal);
    match.marker = `${actionKey}#${nextOrdinal}`;
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

// The ElevenLabs bundle has a race condition where the internal audio port
// forwards microphone data before the WebSocket finishes connecting. That throw
// is unguarded inside the bundle, so we intercept it here and suppress the
// uncaught error. The consecutive-error fallback in the CLOSE handler will
// switch to browser speech after repeated failures.
if (typeof window !== "undefined") {
  window.addEventListener("error", (event) => {
    if (
      String(event?.error?.message || "").includes("WebSocket is not connected")
    ) {
      event.preventDefault();
    }
  });
}

// Patch AudioWorklet.prototype.addModule so that blob:/data: URLs created by the
// ElevenLabs bundle are redirected to our self-hosted worklet file on pages with a
// strict script-src CSP that blocks blob: and data: schemes.
//
// The identification strategy: when a blob/data URL fails, fetch the blob text and
// check whether it registers "scribeAudioProcessor". If so, substitute our hosted
// file (loaded from chrome-extension:// which is always CSP-exempt for extensions).
if (typeof AudioWorklet !== "undefined") {
  const _origAddModule = AudioWorklet.prototype.addModule;
  const SCRIBE_URL = chrome.runtime.getURL("content/vendor/scribe-audio-processor.js");

  AudioWorklet.prototype.addModule = async function patchedAddModule(moduleUrl, options) {
    // Only intercept blob:/data: URLs — extension and https URLs pass through as-is.
    if (typeof moduleUrl !== "string" ||
        (!moduleUrl.startsWith("blob:") && !moduleUrl.startsWith("data:"))) {
      return _origAddModule.call(this, moduleUrl, options);
    }

    try {
      return await _origAddModule.call(this, moduleUrl, options);
    } catch (err) {
      // Original call failed (likely CSP). Identify the worklet by reading the source.
      try {
        let source;
        if (moduleUrl.startsWith("blob:")) {
          source = await fetch(moduleUrl).then((r) => r.text());
        } else {
          // data:application/javascript;base64,<b64>
          const b64 = moduleUrl.replace(/^data:[^,]+,/, "");
          source = atob(b64);
        }

        if (source.includes('"scribeAudioProcessor"') || source.includes("'scribeAudioProcessor'")) {
          return await _origAddModule.call(this, SCRIBE_URL, options);
        }
      } catch {
        // Could not read source — rethrow original error
      }
      throw err;
    }
  };
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

function isYouTubeHost() {
  const host = (window.location.hostname || "").toLowerCase();
  return (
    host === "youtube.com" ||
    host === "www.youtube.com" ||
    host === "m.youtube.com"
  );
}

async function getToken() {
  const response = await chrome.runtime.sendMessage({ type: "GET_SCRIBE_TOKEN" });
  if (!response?.ok) throw new Error(response?.error || "token fetch failed");
  return response.token;
}

function isEditableInput(el) {
  if (!el) return false;
  if (el.tagName === "TEXTAREA") return true;
  if (el.isContentEditable) return true;
  if (el.tagName === "INPUT") {
    const type = (el.type || "text").toLowerCase();
    const excluded = new Set([
      "submit",
      "button",
      "checkbox",
      "radio",
      "file",
      "range",
      "color",
      "hidden",
      "image",
      "reset",
    ]);
    return !excluded.has(type);
  }
  return false;
}

function isEditableInput(el) {
  if (!el) return false;
  if (el.tagName === "TEXTAREA") return true;
  if (el.isContentEditable) return true;
  if (el.tagName === "INPUT") {
    const type = (el.type || "text").toLowerCase();
    const excluded = new Set([
      "submit",
      "button",
      "checkbox",
      "radio",
      "file",
      "range",
      "color",
      "hidden",
      "image",
      "reset",
    ]);
    return !excluded.has(type);
  }
  return false;
}

function createVoiceHandler({ onCommand, onStatus, onTranscript } = {}) {
  let connection = null;
  let recognition = null;
  let starting = false;
  let enabled = false;
  let shouldRestart = false;
  let forceBrowserSpeech = false;
  let requireWakeWord = true;
  let commandAliases = DEFAULT_COMMAND_ALIASES;
  let firedMarkers = new Set();
  let lastPartialNormalized = "";
  const lastFiredAt = new Map();
  let restartTimer = null;
  let consecutiveErrors = 0;
  let lastErrorCode = "";
  let dictationTarget = null;
  let skipCurrentUtterance = false;
  let partialStart = -1;
  let lastPartialLength = 0;
  let partialSpan = null;
  let searchPauseTimer = null;
  let lastSearchQuery = null;

  function deleteLastWord(el) {
    if (!el) return;
    if (el.isContentEditable) {
      document.execCommand("deleteWordBackward");
      return;
    }
    const pos = el.selectionStart ?? el.value.length;
    const before = el.value.slice(0, pos).trimEnd();
    const lastSpace = before.lastIndexOf(" ");
    const deleteFrom = lastSpace < 0 ? 0 : lastSpace + 1;
    el.value = before.slice(0, deleteFrom) + el.value.slice(pos);
    el.setSelectionRange(deleteFrom, deleteFrom);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function resetDictationState() {
    partialStart = -1;
    lastPartialLength = 0;
    if (partialSpan) {
      partialSpan.remove();
      partialSpan = null;
    }
  }

  function applyPartial(text) {
    const el = dictationTarget;
    if (!el || !text) return;

    if (el.isContentEditable) {
      if (!partialSpan) {
        partialSpan = document.createElement("span");
        partialSpan.style.cssText = "opacity:0.55;font-style:italic";
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          range.insertNode(partialSpan);
          range.setStartAfter(partialSpan);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        } else {
          el.appendChild(partialSpan);
        }
      }
      partialSpan.textContent = text;
      return;
    }

    if (partialStart < 0) {
      partialStart = el.selectionStart ?? el.value.length;
      lastPartialLength = 0;
    }
    const before = el.value.slice(0, partialStart);
    const after = el.value.slice(partialStart + lastPartialLength);
    el.value = before + text + after;
    lastPartialLength = text.length;
    const pos = partialStart + text.length;
    el.setSelectionRange(pos, pos);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function applyCommit(text) {
    const el = dictationTarget;
    const textWithSpace = text + " ";

    if (el.isContentEditable) {
      if (partialSpan) {
        const textNode = document.createTextNode(textWithSpace);
        partialSpan.replaceWith(textNode);
        partialSpan = null;
        const range = document.createRange();
        range.setStartAfter(textNode);
        range.collapse(true);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      } else {
        document.execCommand("insertText", false, textWithSpace);
      }
      return;
    }

    const insertAt =
      partialStart >= 0 ? partialStart : (el.selectionStart ?? el.value.length);
    const before = el.value.slice(0, insertAt);
    const after = el.value.slice(insertAt + lastPartialLength);
    el.value = before + textWithSpace + after;
    const pos = insertAt + textWithSpace.length;
    el.setSelectionRange(pos, pos);
    el.dispatchEvent(new Event("input", { bubbles: true }));

    partialStart = -1;
    lastPartialLength = 0;
  }

  const setStatus = (status) => {
    if (typeof onStatus === "function") onStatus(status);
  };

  function emitMatches(matches, transcript, committed) {
    let firedCount = 0;
    const now = Date.now();

    for (const match of matches) {
      if (firedMarkers.has(match.marker)) continue;

      const cooldownKey = match.keyData
        ? `${match.action}:${match.keyData.code}`
        : match.labelText
          ? `${match.action}:${match.labelText}`
          : match.clickIndex != null
            ? `${match.action}:${match.clickIndex}`
            : match.action;
      const previous = lastFiredAt.get(cooldownKey) || 0;
      if (now - previous < COMMAND_COOLDOWN_MS) continue;

      firedMarkers.add(match.marker);
      lastFiredAt.set(cooldownKey, now);
      firedCount += 1;

      if (typeof onCommand === "function") {
        const meta = {
          transcript,
          committed,
          source: "voice",
        };
        if (match.keyData) {
          meta.key = match.keyData.key;
          meta.code = match.keyData.code;
          meta.keyCode = match.keyData.keyCode;
          meta.keyLabel = match.keyData.label;
        }
        if (match.labelText) {
          meta.labelText = match.labelText;
        }
        if (match.clickIndex != null) {
          meta.clickIndex = match.clickIndex;
        }
        onCommand(match.action, meta);
      }
      setStatus(
        `heard: ${match.labelText ? `click: ${match.labelText}` : match.action}`,
      );
    }

    return firedCount;
  }

  function processTranscript(text, { committed = false } = {}) {
    const transcript = String(text || "");

    // Dictation mode: show partials immediately, finalize on commit.
    if (dictationTarget) {
      const norm = normalizeText(transcript);
      const stopPhrases = [
        "stop writing",
        "stop dictation",
        "stop typing",
        "done writing",
        "done typing",
      ];
      if (stopPhrases.some((p) => norm.includes(p))) {
        resetDictationState();
        dictationTarget = null;
        setStatus(enabled ? "listening" : "off");
        return;
      }
      const backspacePhrases = [
        "backspace",
        "delete that",
        "delete last word",
        "undo that",
      ];
      if (backspacePhrases.some((p) => norm.includes(p))) {
        resetDictationState();
        deleteLastWord(dictationTarget);
        setStatus("dictating");
        return;
      }
      if (skipCurrentUtterance) {
        if (committed) {
          skipCurrentUtterance = false;
          resetDictationState();
        }
        setStatus("dictating");
        return;
      }
      if (committed) {
        if (transcript.trim()) applyCommit(transcript.trim());
        else resetDictationState();
      } else if (transcript.trim()) {
        applyPartial(transcript.trim());
      }
      setStatus("dictating");
      return;
    }

    const rawNorm = normalizeText(transcript);
    const vsRe = [
      /\bsearch(?:\s+for)?\s+(.+?)\s*$/,
      /\blook\s+(?:up|for)\s+(.+?)\s*$/,
      /\bfind\s+(.+?)\s*$/,
    ];
    let detectedQuery = null;
    for (const re of vsRe) {
      const m = re.exec(rawNorm);
      if (m && m[1].trim()) {
        detectedQuery = m[1].trim();
        break;
      }
    }
    if (detectedQuery) {
      const fireSearch = (q, isCommitted) => {
        if (searchPauseTimer) {
          clearTimeout(searchPauseTimer);
          searchPauseTimer = null;
        }
        lastSearchQuery = null;
        if (typeof onCommand === "function")
          onCommand("voice-search", {
            transcript,
            committed: isCommitted,
            source: "voice",
            searchQuery: q,
          });
        setStatus(`search: ${q}`);
        firedMarkers = new Set();
        lastPartialNormalized = "";
      };
      if (committed) {
        fireSearch(detectedQuery, true);
        return;
      }
      const queryGrew =
        !lastSearchQuery || detectedQuery.length > lastSearchQuery.length;
      lastSearchQuery = detectedQuery;
      if (queryGrew) {
        if (searchPauseTimer) clearTimeout(searchPauseTimer);
        searchPauseTimer = setTimeout(() => {
          searchPauseTimer = null;
          const q = lastSearchQuery;
          if (q) fireSearch(q, false);
        }, 500);
      }
      return;
    } else {
      if (searchPauseTimer) {
        clearTimeout(searchPauseTimer);
        searchPauseTimer = null;
      }
      lastSearchQuery = null;
    }

    const { normalized, matches } = detectCommands(transcript, {
      requireWakeWord,
      commandAliases,
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

  function setDictationTarget(el) {
    resetDictationState();
    dictationTarget = isEditableInput(el) ? el : null;
    if (dictationTarget) {
      firedMarkers = new Set();
      lastPartialNormalized = "";
      skipCurrentUtterance = true;
      setStatus("dictating");
    } else if (enabled) {
      skipCurrentUtterance = false;
      setStatus("listening");
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
      if (isYouTubeHost()) {
        forceBrowserSpeech = true;
        setStatus("fallback: browser speech (youtube csp)");
        startBrowserSpeech();
        return;
      }

      if (forceBrowserSpeech) {
        startBrowserSpeech();
        return;
      }

      const [{ Scribe, RealtimeEvents, CommitStrategy }, token] = await Promise.all([
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
        commitStrategy: CommitStrategy.VAD,
        vadSilenceThresholdSecs: 1.5,
        vadThreshold: 0.4,
        minSpeechDurationMs: 100,
        minSilenceDurationMs: 100,
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
          consecutiveErrors += 1;
          if (consecutiveErrors >= 3) {
            forceBrowserSpeech = true;
            console.warn("[AFK] ElevenLabs disconnected repeatedly, falling back to browser speech");
            setStatus("fallback: browser speech");
          }
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
    if (
      nextConfig.customKeywords &&
      typeof nextConfig.customKeywords === "object"
    ) {
      commandAliases = buildCommandAliases(nextConfig.customKeywords);
      setStatus("keywords:updated");
    }
  }

  return { start, stop, setEnabled, setConfig, setDictationTarget };
}

export { createVoiceHandler };
export default createVoiceHandler;
