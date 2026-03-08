# AFK

## Overview
A Chrome extension that enables hands-free browser control via webcam-based hand gesture recognition and voice commands, targeting users who are away from their keyboard — e.g., during presentations, cooking, reading, or accessibility use cases.

## Inspiration

We've all been there:
- Hands covered in flour mid-recipe, needing to scroll down
- Standing at a whiteboard mid-presentation, fumbling for a mouse
- Lying in bed with your laptop just out of reach

AFK started as a joke on the acronym — what if "Away From Keyboard" wasn't a problem to solve, but a mode to embrace? We are here to re-define hands-free browsing feel natural, not futuristic.

---

## What it does

AFK is a Chrome extension that lets you control your browser entirely through hand gestures and voice commands — no keyboard, no mouse, no contact required.

**Gesture controls:**
- **Cursor tracking** — index finger moves the cursor in real-time via webcam
- **Click** — hold a pinch gesture for 700ms
- **Scroll** — index + middle finger raised, move hand up/down
- **Tab switch** — pinch index + middle, drag left/right
- **Back / Forward** — wide left or right swipe

**Voice commands (30+):**
- Navigation: `"scroll down"`, `"go back"`, `"next tab"`, `"new tab"`
- Playback: `"play video"`, `"pause"`, `"mute"`, `"next video"`
- Page control: `"zoom in"`, `"refresh"`, `"enter fullscreen"`
- Input: `"start writing"` activates voice-to-text in any focused field
- **Fully customizable** — remap any command to your own phrases in any language. Not a native English speaker? Set your commands in French, Tagalog, Bahasa, or whatever feels natural. AFK works the way you talk, not the other way around.

**Eyes & attention detection:**
- **Video pauses when you look away** — using real-time eye and face landmark detection, AFK automatically pauses any playing video the moment you turn away from the screen, and resumes when you look back. No more missing content because you glanced away.

**Text-to-speech (ElevenLabs):**
- AFK uses ElevenLabs to read back page content, confirmations, and command feedback in natural-sounding voice — closing the loop on a fully hands-free, eyes-free experience.

**Privacy & control:**
- Live camera indicator always visible when active
- Tracking pauses automatically when you look away from the screen
- One-key kill switch disables everything instantly

---

## How we built it

| Layer | Technology | Role |
|---|---|---|
| Hand tracking | MediaPipe Hands | 21-landmark model, runs via WASM |
| Eye/face detection | MediaPipe Face Mesh | Gaze and attention tracking for look-away pause |
| Voice input | Web Speech API | Customizable phrase matching for 30+ commands |
| Voice output | ElevenLabs TTS | Natural-sounding spoken feedback and readback |
| Extension | Chrome MV3 | Content script + offscreen document |
| Gesture engine | Custom JS | Debounce, hold-timer, cooldown windows |
| HUD overlay | React + Shadow DOM | Isolated UI injected into every page |
| Bundler | Vite | Multi-entry build for all extension contexts |

Key architectural decisions:
- **Offscreen document** for camera access — MV3 disallows `getUserMedia` in content scripts
- **Web Worker** for MediaPipe — keeps the main thread free, throttled to 24fps
- **Shadow DOM** for the HUD — fully isolated from host page styles
- **Rolling-window phrase matcher** on top of Web Speech API for stable, language-agnostic voice detection
- **ElevenLabs integration** for TTS responses — so AFK can talk back, not just listen

---

## Challenges we ran into

- **MV3 camera restrictions** — routing the webcam through an offscreen document added latency we had to aggressively optimize away
- **Gesture false positives** — raw landmarks are noisy; we built a multi-stage filter using velocity thresholding, hold-duration gating, and per-gesture cooldown windows
- **Voice stability** — Web Speech API returns partial results in real-time; we had to wait for stable output while still feeling instant to the user
- **Multilingual voice commands** — making the phrase matcher language-agnostic required decoupling the action logic entirely from hardcoded English strings, so any phrase in any language can map to any action
- **Gaze detection reliability** — distinguishing "user looked away" from "user blinked" or "user shifted slightly" required tuning eye landmark thresholds carefully to avoid false pauses
- **Performance** — running hand tracking, face mesh, and TTS simultaneously inside a live webpage is expensive; we stay under 8% CPU on a mid-range laptop by combining Web Worker offloading, 24fps throttling, and `requestAnimationFrame` gating
- **Shadow DOM isolation** — injecting UI into arbitrary pages without breaking their layout required wrapping the entire HUD in a shadow root

---

## Accomplishments that we're proud of

- 30+ voice commands responding to natural phrasing, not rigid syntax — and fully remappable in any language
- **Look-away video pause** — face and eye detection that automatically pauses video content the moment you stop watching, and resumes when you return
- **ElevenLabs TTS feedback** — AFK doesn't just accept commands, it talks back in a natural voice, making the experience even more accessible
- Privacy-first UX: live camera thumbnail + activity indicator + one-key kill switch
- Everything runs client-side — zero data leaves the device for gesture and voice processing, no backend required

---

## What we learned

- **Gesture UX is a feedback problem first.** Adding a live camera thumbnail and gesture label to the HUD was the single biggest UX improvement — users stopped questioning whether it worked and just used it
- **Gestures and voice are complementary, not competing.** Gestures handle spatial tasks naturally (cursor, scroll, drag); voice handles discrete commands cleanly. Together they cover nearly every browsing interaction
- **Language shouldn't be a barrier to accessibility.** Building customizable voice commands taught us that defaulting to English is a design choice, not a technical constraint — and one worth challenging
- **MV3 is genuinely hard.** A lot of MV2 patterns are gone and the documentation hasn't caught up — the offscreen document pattern for camera access took significant reverse-engineering

---

## What's next for AFK

- Two-hand gestures — pinch-to-zoom, two-hand swipe for fullscreen
- Expanded multilingual support — pre-built command packs for major languages out of the box
- Accessibility partnerships — optimize with occupational therapists for mobility impairment use cases
- Firefox + Edge support — core architecture is already browser-agnostic
- On-device wake-word detection for voice activation without always-on listening
