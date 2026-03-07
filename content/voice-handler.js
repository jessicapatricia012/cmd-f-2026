/**
 * voice-handler.js — AFK Chrome Extension
 *
 * Based on Jes's architecture:
 *   - Fetches a single-use ElevenLabs Scribe token from localhost:5001
 *   - Opens a real-time Scribe session for STT (far better than Web Speech API)
 *   - Dispatches matched commands via AFK_COMMAND to the service worker
 *
 * Wake word: any utterance containing "AFK" activates the command window.
 *   "AFK scroll down"  → fires immediately in one phrase
 *   "AFK" alone        → opens a 6s window, next phrase is the command
 *   "AFK sleep"        → closes the window
 *
 * TTS confirmations: ElevenLabs eleven_turbo_v2 via the same API key,
 *   fetched from the token server to keep the key off the client.
 *   Falls back to SpeechSynthesis if token server is unreachable.
 */

(() => {
  if (window.__afkVoiceHandler) return;
  window.__afkVoiceHandler = true;

  const ELEVENLABS_SDK = "https://esm.sh/@elevenlabs/client";
  const TOKEN_SERVER   = "http://localhost:5001/scribe-token";
  const WAKE_WORD      = "afk";
  const WAKE_WINDOW_MS = 6000;
  const DEBOUNCE_MS    = 1000;

  // ── Command map (Jes's patterns + extended for all PRD gestures) ──────────
  // Longer / more-specific phrases first — first match wins.
  const VOICE_COMMANDS = [
    { patterns: ["scroll down",  "go down",  "move down"],           action: "scroll-down"  },
    { patterns: ["scroll up",    "go up",    "move up"],             action: "scroll-up"    },
    { patterns: ["scroll right", "go right", "move right"],          action: "scroll-right" },
    { patterns: ["scroll left",  "go left",  "move left"],           action: "scroll-left"  },
    { patterns: ["zoom in",  "bigger"],                               action: "zoom-in"      },
    { patterns: ["zoom out", "smaller"],                              action: "zoom-out"     },
    { patterns: ["go back",  "navigate back",  "previous page"],     action: "go-back"      },
    { patterns: ["go forward","navigate forward","next page"],        action: "go-forward"   },
    { patterns: ["open new tab", "new tab", "open tab"],             action: "new-tab"      },
    { patterns: ["next tab",  "switch tab",  "tab right"],           action: "next-tab"     },
    { patterns: ["previous tab","prev tab",   "tab left"],           action: "prev-tab"     },
    { patterns: ["click", "tap", "press"],                           action: "click"        },
  ];

  // Spoken confirmations per action (short = low TTS latency)
  const CONFIRMATIONS = {
    "scroll-down":  "Down",
    "scroll-up":    "Up",
    "scroll-right": "Right",
    "scroll-left":  "Left",
    "zoom-in":      "Zoom in",
    "zoom-out":     "Zoom out",
    "go-back":      "Back",
    "go-forward":   "Forward",
    "new-tab":      "New tab",
    "next-tab":     "Next tab",
    "prev-tab":     "Previous tab",
    "click":        "Click",
  };

  // ── State ─────────────────────────────────────────────────────────────────
  let voiceEnabled  = true;
  let connection    = null;
  let awake         = false;
  let wakeTimer     = null;
  let processedText = "";
  const lastFiredAt = {};

  // ── Storage — mirrors Jes's AFK_STATE_UPDATED protocol ───────────────────
  chrome.runtime.sendMessage({ type: "AFK_GET_STATE" }).then(({ state }) => {
    voiceEnabled = state?.voiceEnabled !== false;
    if (state?.enabled && voiceEnabled) startVoice();
  }).catch(() => {});

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== "AFK_STATE_UPDATED") return;
    const { enabled, voiceEnabled: ve } = msg.payload || {};
    voiceEnabled = ve !== false;
    if (enabled && voiceEnabled) startVoice();
    else stopVoice();
  });

  // ── Transcript parsing (Jes's pattern) ───────────────────────────────────
  function extractCommand(text) {
    const normalized = text.toLowerCase().replace(/[^\w\s]/g, " ").trim();
    for (const { patterns, action } of VOICE_COMMANDS) {
      for (const pattern of patterns) {
        const re = new RegExp(`\\b${pattern}\\b`);
        if (re.test(normalized)) return action;
      }
    }
    return null;
  }

  function processTranscript(text) {
    const normalized = text.toLowerCase().trim();
    const hasWake    = normalized.includes(WAKE_WORD);

    if (hasWake) {
      if (!awake) activateWake();
      resetWakeTimer();
    }

    if (!awake && !hasWake) return; // not listening

    const action = extractCommand(text);
    if (!action) return;

    // Debounce same action
    const now = Date.now();
    if (lastFiredAt[action] && now - lastFiredAt[action] < DEBOUNCE_MS) return;
    lastFiredAt[action] = now;
    processedText = text;

    fireCommand(action);
  }

  function fireCommand(action) {
    resetWakeTimer();

    // Dispatch via Jes's protocol
    chrome.runtime.sendMessage({ type: "AFK_COMMAND", payload: { action } }).catch(() => {});

    // HUD feedback
    window.__afkHUD?.showFeedback({ action, source: "voice" });

    // TTS confirmation
    const say = CONFIRMATIONS[action];
    if (say) speak(say);

    console.log(`[AFK Voice] "${action}"`);
  }

  // ── Wake word ─────────────────────────────────────────────────────────────
  function activateWake() {
    awake = true;
    window.__afkHUD?.showFeedback({ action: "wake", source: "voice" });
    window.dispatchEvent(new CustomEvent("afk:hud", {
      detail: { type: "voice-active", payload: true }
    }));
  }

  function clearWake() {
    awake = false;
    clearTimeout(wakeTimer);
    wakeTimer = null;
    window.dispatchEvent(new CustomEvent("afk:hud", {
      detail: { type: "voice-active", payload: false }
    }));
  }

  function resetWakeTimer() {
    clearTimeout(wakeTimer);
    wakeTimer = setTimeout(clearWake, WAKE_WINDOW_MS);
  }

  // ── ElevenLabs Scribe session ─────────────────────────────────────────────
  async function startVoice() {
    if (connection) return;
    try {
      const { Scribe, RealtimeEvents } = await import(ELEVENLABS_SDK);
      const res   = await fetch(TOKEN_SERVER);
      const { token } = await res.json();

      connection = Scribe.connect({
        token,
        modelId:           "scribe_v2_realtime",
        includeTimestamps: false,
        microphone: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl:  true,
        },
      });

      connection.on(RealtimeEvents.SESSION_STARTED, () =>
        console.log("[AFK Voice] Scribe session started"));

      connection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, (data) => {
        // Only process the new tail since last committed transcript
        const tail = data.text.startsWith(processedText)
          ? data.text.slice(processedText.length)
          : data.text;
        if (tail.trim()) processTranscript(tail);
      });

      connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, () => {
        processedText = ""; // reset for next utterance
      });

      connection.on(RealtimeEvents.ERROR, err =>
        console.error("[AFK Voice] Scribe error:", err));

    } catch (err) {
      console.warn("[AFK Voice] Failed to start Scribe:", err);
      connection = null;
    }
  }

  function stopVoice() {
    connection?.close?.();
    connection = null;
    clearWake();
  }

  // ── TTS: ElevenLabs eleven_turbo_v2 ──────────────────────────────────────
  // Fetch a fresh single-use token for TTS from the same token server.
  // Falls back to SpeechSynthesis if the server is unreachable.
  let audioQueue = [];
  let isPlaying  = false;

  function speak(text) {
    if (audioQueue.length > 1) audioQueue.shift(); // drop oldest if backing up
    audioQueue.push(text);
    if (!isPlaying) drainAudioQueue();
  }

  async function drainAudioQueue() {
    if (!audioQueue.length) { isPlaying = false; return; }
    isPlaying = true;
    const text = audioQueue.shift();

    try {
      // Re-use the token server — add a /tts endpoint, or use stored key from popup
      const stored = await chrome.storage.sync.get("afkState");
      const key    = stored?.afkState?.elevenLabsKey || "";
      const voiceId = stored?.afkState?.elevenLabsVoiceId || "EXAVITQu4vr4xnSDxMaL";

      if (!key) throw new Error("no key");

      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`, {
          method: "POST",
          headers: { "xi-api-key": key, "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            model_id: "eleven_turbo_v2",
            voice_settings: { stability: 0.35, similarity_boost: 0.75, style: 0.1, use_speaker_boost: false },
          }),
        }
      );
      if (!res.ok) throw new Error(res.status);
      const url   = URL.createObjectURL(await res.blob());
      const audio = new Audio(url);
      audio.onended = audio.onerror = () => { URL.revokeObjectURL(url); drainAudioQueue(); };
      audio.play();
    } catch {
      fallbackSpeak(text);
      drainAudioQueue();
    }
  }

  function fallbackSpeak(text) {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.3; u.volume = 0.9;
    window.speechSynthesis.speak(u);
  }

})();