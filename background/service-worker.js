// Background service worker
// Handles: offscreen document lifecycle, gesture message relay, zoom, tab switching

const STORAGE_KEY = "afkState";
const DEFAULT_STATE = {
  enabled: false,
  gesturesEnabled: true,
  voiceEnabled: true,
  requireWakeWord: true,
  customKeywords: {},
};

async function getState() {
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  return {
    ...DEFAULT_STATE,
    ...(stored[STORAGE_KEY] || {}),
  };
}

async function setState(partial) {
  const current = await getState();
  const next = { ...current, ...partial };
  await chrome.storage.sync.set({ [STORAGE_KEY]: next });
  return next;
}

async function broadcastState(state) {
  const tabs = await chrome.tabs.query({});

  await Promise.all(
    tabs.map(async (tab) => {
      if (!tab.id) return;
      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: "AFK_STATE_UPDATED",
          payload: state,
        });
      } catch {
        // Ignore tabs without content script access.
      }
    }),
  );
}

async function withActiveTab(callback, preferredTabId) {
  if (preferredTabId) {
    try {
      const tab = await chrome.tabs.get(preferredTabId);
      if (tab?.id) {
        await callback(tab);
        return;
      }
    } catch {
      // Fallback to currently active tab.
    }
  }

  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!activeTab?.id) return;
  await callback(activeTab);
}

async function executeInTab(tabId, fn, args = []) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: fn,
    args,
  });
}

async function executeInTabWithResult(tabId, fn, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: fn,
    args,
  });
  return results?.[0]?.result;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

const ACTION_HANDLERS = {
  "page-down": async (targetTabId) => {
    await withActiveTab(async (tab) => {
      await executeInTab(tab.id, () => {
        function findScrollableParent(el) {
          while (el && el !== document.body) {
            const style = window.getComputedStyle(el);
            const overflowY = style.overflowY;
            const canScroll = overflowY === "auto" || overflowY === "scroll";
            if (canScroll && el.scrollHeight > el.clientHeight) return el;
            el = el.parentElement;
          }
          return window;
        }
        const hovered = document.querySelectorAll(":hover");
        const deepest = hovered[hovered.length - 1];
        const target = deepest ? findScrollableParent(deepest) : window;
        const amount = Math.max(200, Math.floor(window.innerHeight * 0.9));
        target.scrollBy({ top: amount, left: 0, behavior: "smooth" });
      });
    }, targetTabId);
  },
  "page-up": async (targetTabId) => {
    await withActiveTab(async (tab) => {
      await executeInTab(tab.id, () => {
        function findScrollableParent(el) {
          while (el && el !== document.body) {
            const style = window.getComputedStyle(el);
            const overflowY = style.overflowY;
            const canScroll = overflowY === "auto" || overflowY === "scroll";
            if (canScroll && el.scrollHeight > el.clientHeight) return el;
            el = el.parentElement;
          }
          return window;
        }
        const hovered = document.querySelectorAll(":hover");
        const deepest = hovered[hovered.length - 1];
        const target = deepest ? findScrollableParent(deepest) : window;
        const amount = Math.max(200, Math.floor(window.innerHeight * 0.9));
        target.scrollBy({ top: -amount, left: 0, behavior: "smooth" });
      });
    }, targetTabId);
  },
  "go-home": async (targetTabId) => {
    await withActiveTab(async (tab) => {
      await executeInTab(tab.id, () => {
        window.scrollTo({ top: 0, left: 0, behavior: "smooth" });
      });
    }, targetTabId);
  },
  "go-end": async (targetTabId) => {
    await withActiveTab(async (tab) => {
      await executeInTab(tab.id, () => {
        const doc = document.documentElement;
        const body = document.body;
        const maxTop = Math.max(
          doc?.scrollHeight || 0,
          body?.scrollHeight || 0,
          doc?.offsetHeight || 0,
          body?.offsetHeight || 0,
        );
        window.scrollTo({ top: maxTop, left: 0, behavior: "smooth" });
      });
    }, targetTabId);
  },
  "video-play": async (targetTabId) => {
    await withActiveTab(async (tab) => {
      await executeInTab(tab.id, () => {
        const ytPlayer = document.getElementById("movie_player");
        if (ytPlayer && typeof ytPlayer.playVideo === "function") {
          ytPlayer.playVideo();
          return;
        }

        const videos = Array.from(document.querySelectorAll("video"));
        const target =
          videos.find((video) => !video.paused || !video.ended) ||
          videos.find((video) => video.readyState >= 1) ||
          videos[0];
        if (!target) return;
        target.play().catch(() => {});
      });
    }, targetTabId);
  },
  "video-pause": async (targetTabId) => {
    await withActiveTab(async (tab) => {
      await executeInTab(tab.id, () => {
        const ytPlayer = document.getElementById("movie_player");
        if (ytPlayer && typeof ytPlayer.pauseVideo === "function") {
          ytPlayer.pauseVideo();
          return;
        }

        const videos = Array.from(document.querySelectorAll("video"));
        const target = videos.find((video) => !video.paused) || videos[0];
        if (!target) return;
        target.pause();
      });
    }, targetTabId);
  },
  "video-next": async (targetTabId) => {
    await withActiveTab(async (tab) => {
      await executeInTab(tab.id, () => {
        const ytPlayer = document.getElementById("movie_player");
        if (ytPlayer && typeof ytPlayer.nextVideo === "function") {
          ytPlayer.nextVideo();
          return;
        }

        const videos = Array.from(document.querySelectorAll("video"));
        const target =
          videos.find((video) => !video.paused || video.currentTime > 0) ||
          videos[0];
        if (!target) return;

        if (Number.isFinite(target.duration) && target.duration > 0) {
          const nextTime = Math.min(
            target.currentTime + 10,
            Math.max(target.duration - 0.05, 0),
          );
          target.currentTime = nextTime;
          return;
        }

        target.currentTime = target.currentTime + 10;
      });
    }, targetTabId);
  },
  "video-mute": async (targetTabId) => {
    await withActiveTab(async (tab) => {
      await executeInTab(tab.id, () => {
        const pressMKey = () => {
          const player = document.getElementById("movie_player");
          const target =
            player ||
            document.activeElement ||
            document.body ||
            document.documentElement;
          const eventInit = {
            key: "m",
            code: "KeyM",
            keyCode: 77,
            which: 77,
            bubbles: true,
            cancelable: true,
          };
          target?.dispatchEvent(new KeyboardEvent("keydown", eventInit));
          target?.dispatchEvent(new KeyboardEvent("keyup", eventInit));
        };

        const ytPlayer = document.getElementById("movie_player");
        if (ytPlayer && typeof ytPlayer.mute === "function") {
          const wasMuted =
            typeof ytPlayer.isMuted === "function" ? ytPlayer.isMuted() : null;
          if (wasMuted !== true) {
            // Prefer M-key toggle on YouTube so the player shows mute UI.
            pressMKey();
            const nowMuted =
              typeof ytPlayer.isMuted === "function"
                ? ytPlayer.isMuted()
                : null;
            if (nowMuted === true) return;
          }
          // Fallback when key dispatch does not toggle state.
          ytPlayer.mute();
          return;
        }

        // Non-YouTube fallback path: try keyboard toggle first.
        pressMKey();
        const videos = Array.from(document.querySelectorAll("video"));
        for (const video of videos) {
          video.muted = true;
        }
      });
    }, targetTabId);
  },
  "video-unmute": async (targetTabId) => {
    await withActiveTab(async (tab) => {
      await executeInTab(tab.id, () => {
        const pressMKey = () => {
          const player = document.getElementById("movie_player");
          const target =
            player ||
            document.activeElement ||
            document.body ||
            document.documentElement;
          const eventInit = {
            key: "m",
            code: "KeyM",
            keyCode: 77,
            which: 77,
            bubbles: true,
            cancelable: true,
          };
          target?.dispatchEvent(new KeyboardEvent("keydown", eventInit));
          target?.dispatchEvent(new KeyboardEvent("keyup", eventInit));
        };

        const ytPlayer = document.getElementById("movie_player");
        if (ytPlayer && typeof ytPlayer.unMute === "function") {
          const wasMuted =
            typeof ytPlayer.isMuted === "function" ? ytPlayer.isMuted() : null;
          if (wasMuted !== false) {
            // Prefer M-key toggle on YouTube so the player shows unmute UI.
            pressMKey();
            const nowMuted =
              typeof ytPlayer.isMuted === "function"
                ? ytPlayer.isMuted()
                : null;
            if (nowMuted === false) return;
          }
          // Fallback when key dispatch does not toggle state.
          ytPlayer.unMute();
          return;
        }

        // Non-YouTube fallback path: try keyboard toggle first.
        pressMKey();
        const videos = Array.from(document.querySelectorAll("video"));
        for (const video of videos) {
          video.muted = false;
        }
      });
    }, targetTabId);
  },
  "page-refresh": async (targetTabId) => {
    const active = targetTabId
      ? await chrome.tabs.get(targetTabId).catch(() => null)
      : null;
    const [fallback] = active
      ? []
      : await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = active || fallback;
    if (!tab?.id) return;
    await chrome.tabs.reload(tab.id);
  },
  "fullscreen-enter": async (targetTabId) => {
    let status = { ok: false, error: "No active tab" };
    await withActiveTab(async (tab) => {
      status = await executeInTabWithResult(tab.id, async () => {
        if (document.fullscreenElement) {
          return { ok: true, skipped: true, reason: "already fullscreen" };
        }

        const target =
          document.documentElement ||
          document.querySelector("video") ||
          document.body;
        if (!target?.requestFullscreen) {
          return { ok: false, error: "Fullscreen API unavailable" };
        }

        try {
          await target.requestFullscreen();
          if (document.fullscreenElement) {
            return { ok: true };
          }
          return { ok: false, error: "Fullscreen was blocked" };
        } catch (error) {
          return {
            ok: false,
            error: error?.message || "Fullscreen was blocked",
          };
        }
      });
    }, targetTabId);
    return status;
  },
  "fullscreen-exit": async (targetTabId) => {
    let status = { ok: false, error: "No active tab" };
    await withActiveTab(async (tab) => {
      status = await executeInTabWithResult(tab.id, async () => {
        if (!document.fullscreenElement) {
          return { ok: true, skipped: true, reason: "not fullscreen" };
        }
        if (!document.exitFullscreen) {
          return { ok: false, error: "Fullscreen API unavailable" };
        }

        try {
          await document.exitFullscreen();
          if (!document.fullscreenElement) {
            return { ok: true };
          }
          return { ok: false, error: "Failed to exit fullscreen" };
        } catch (error) {
          return {
            ok: false,
            error: error?.message || "Failed to exit fullscreen",
          };
        }
      });
    }, targetTabId);
    return status;
  },
  "click-target": async (targetTabId) => {
    let status = { ok: false, error: "No clickable target found" };
    await withActiveTab(async (tab) => {
      status = await executeInTabWithResult(tab.id, () => {
        const getElementLabel = (el) => {
          if (!(el instanceof HTMLElement)) return "";
          return (
            el.innerText?.trim() ||
            el.value ||
            el.getAttribute("aria-label") ||
            el.getAttribute("title") ||
            el.getAttribute("placeholder") ||
            `<${el.tagName.toLowerCase()}>`
          ).slice(0, 60);
        };

        const isVisible = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(el);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.pointerEvents === "none"
          ) {
            return false;
          }
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };

        const isClickable = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          if (!isVisible(el)) return false;
          return Boolean(
            el.closest(
              "button,a,[role='button'],input[type='button'],input[type='submit'],summary,[onclick],[data-action],[jsaction],[tabindex]",
            ) ||
            el.tagName === "BUTTON" ||
            el.tagName === "A" ||
            el.getAttribute("tabindex") === "0",
          );
        };

        const clickElement = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const target =
            el.closest(
              "button,a,[role='button'],input[type='button'],input[type='submit'],summary,[onclick],[data-action],[jsaction]",
            ) || el;
          target.dispatchEvent(
            new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
          );
          target.dispatchEvent(
            new MouseEvent("mouseup", { bubbles: true, cancelable: true }),
          );
          target.click?.();
          return true;
        };

        const active = document.activeElement;
        if (isClickable(active) && clickElement(active)) {
          return { ok: true, matched: getElementLabel(active) };
        }

        const hovered = Array.from(
          document.querySelectorAll(":hover"),
        ).reverse();
        const hoveredTarget = hovered.find((el) => isClickable(el));
        if (hoveredTarget && clickElement(hoveredTarget)) {
          return { ok: true, matched: getElementLabel(hoveredTarget) };
        }

        const centerEl = document.elementFromPoint(
          window.innerWidth / 2,
          window.innerHeight / 2,
        );
        if (isClickable(centerEl) && clickElement(centerEl)) {
          return { ok: true, matched: getElementLabel(centerEl) };
        }

        // Last resort: find any visible clickable element on screen
        const allClickable = Array.from(
          document.querySelectorAll(
            "button, a, [role='button'], input[type='submit'], [tabindex='0']",
          ),
        ).filter(isVisible);
        if (allClickable.length > 0 && clickElement(allClickable[0])) {
          return { ok: true, matched: getElementLabel(allClickable[0]) };
        }

        return { ok: false, error: "No clickable target found" };
      });
    }, targetTabId);
    return status;
  },
  // Finds and clicks an element by its visible text label.
  // Triggered by voice commands like "AFK click sign in".
  // Prefers exact matches over partial matches to avoid greedy misfires.
  "click-text": async (targetTabId, payload = {}) => {
    const label = String(payload.labelText || "")
      .toLowerCase()
      .trim();
    if (!label) return { ok: false, error: "No label provided" };

    let status = { ok: false, error: "No matching element found" };

    await withActiveTab(async (tab) => {
      status = await executeInTabWithResult(
        tab.id,
        (searchLabel) => {
          const normalize = (s) =>
            String(s || "")
              .toLowerCase()
              .replace(/\s+/g, " ")
              .trim();

          const isVisible = (el) => {
            if (!(el instanceof HTMLElement)) return false;
            const style = window.getComputedStyle(el);
            if (
              style.display === "none" ||
              style.visibility === "hidden" ||
              style.pointerEvents === "none"
            ) {
              return false;
            }
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };

          const getLabel = (el) =>
            normalize(
              el.innerText ||
                el.value ||
                el.getAttribute("aria-label") ||
                el.getAttribute("title") ||
                el.getAttribute("placeholder") ||
                "",
            );

          const isInteractableLi = (el) =>
            el.tagName === "LI" &&
            (el.hasAttribute("onclick") ||
              el.hasAttribute("data-action") ||
              el.getAttribute("tabindex") === "0" ||
              el.getAttribute("jsaction") ||
              el.closest("[jsaction]"));

          const candidates = Array.from(
            document.querySelectorAll(
              "a, button, [role='button'], [role='option'], [role='menuitem'], [role='tab'], " +
                "input[type='submit'], input[type='button'], label, summary, li",
            ),
          ).filter(
            (el) =>
              isVisible(el) && (el.tagName !== "LI" || isInteractableLi(el)),
          );

          // Prefer exact match first, fall back to partial match.
          const exactMatch = candidates.find(
            (el) => getLabel(el) === searchLabel,
          );
          const match =
            exactMatch ||
            candidates.find((el) => getLabel(el).includes(searchLabel));

          if (!match) return { ok: false, error: "No matching element found" };

          match.dispatchEvent(
            new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
          );
          match.dispatchEvent(
            new MouseEvent("mouseup", { bubbles: true, cancelable: true }),
          );
          match.click();

          return {
            ok: true,
            matched: getLabel(match),
            exact: Boolean(exactMatch),
          };
        },
        [label],
      );
    }, targetTabId);

    return status;
  },
  "zoom-in": async (targetTabId) => {
    const active = targetTabId
      ? await chrome.tabs.get(targetTabId).catch(() => null)
      : null;
    const [fallback] = active
      ? []
      : await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = active || fallback;
    if (!tab?.id) return;
    const currentZoom = await chrome.tabs.getZoom(tab.id);
    const nextZoom = clamp(currentZoom + 0.1, 0.25, 5);
    await chrome.tabs.setZoom(tab.id, Number(nextZoom.toFixed(2)));
  },
  "zoom-out": async (targetTabId) => {
    const active = targetTabId
      ? await chrome.tabs.get(targetTabId).catch(() => null)
      : null;
    const [fallback] = active
      ? []
      : await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = active || fallback;
    if (!tab?.id) return;
    const currentZoom = await chrome.tabs.getZoom(tab.id);
    const nextZoom = clamp(currentZoom - 0.1, 0.25, 5);
    await chrome.tabs.setZoom(tab.id, Number(nextZoom.toFixed(2)));
  },
  "next-tab": async () => {
    const [active] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!active?.id) return;
    if (!active) return;
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const currentIndex = tabs.findIndex((tab) => tab.id === active.id);
    if (currentIndex < 0) return;
    const next = tabs[(currentIndex + 1) % tabs.length];
    if (next?.id) {
      await chrome.tabs.update(next.id, { active: true });
    }
  },
  "prev-tab": async () => {
    const [active] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!active) return;
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const currentIndex = tabs.findIndex((tab) => tab.id === active.id);
    if (currentIndex < 0) return;
    const prevIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    const prev = tabs[prevIndex];
    if (prev?.id) {
      await chrome.tabs.update(prev.id, { active: true });
    }
  },
  "go-back": async () => {
    await withActiveTab(async (tab) => {
      await executeInTab(tab.id, () => history.back());
    });
  },
  "go-forward": async () => {
    await withActiveTab(async (tab) => {
      await executeInTab(tab.id, () => history.forward());
    });
  },
  "new-tab": async () => {
    await chrome.tabs.create({});
  },

  reload: async () => {
    const [active] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (active?.id) await chrome.tabs.reload(active.id);
  },
  "press-key": async (targetTabId, payload = {}) => {
    await withActiveTab(async (tab) => {
      await executeInTab(
        tab.id,
        (keyPayload) => {
          if (!keyPayload?.key || !keyPayload?.code) return;

          const target =
            (document.activeElement instanceof HTMLElement &&
              document.activeElement) ||
            document.body ||
            document.documentElement;
          const eventInit = {
            key: keyPayload.key,
            code: keyPayload.code,
            keyCode: Number(keyPayload.keyCode) || 0,
            which: Number(keyPayload.keyCode) || 0,
            bubbles: true,
            cancelable: true,
          };

          target?.dispatchEvent(new KeyboardEvent("keydown", eventInit));
          target?.dispatchEvent(new KeyboardEvent("keyup", eventInit));
        },
        [payload],
      );
    }, targetTabId);
  },
  // Scans the page for all clickable elements and returns them as a list.
  // content.js renders the overlay + badges using this data.
  "list-clickable": async (targetTabId) => {
    let result = { ok: false, error: "No active tab" };
    await withActiveTab(async (tab) => {
      result = await executeInTabWithResult(tab.id, () => {
        const normalize = (s) =>
          String(s || "")
            .toLowerCase()
            .replace(/\s+/g, " ")
            .trim();

        const getLabel = (el) =>
          normalize(
            el.innerText ||
              el.value ||
              el.getAttribute("aria-label") ||
              el.getAttribute("title") ||
              el.getAttribute("placeholder") ||
              el.getAttribute("data-label") ||
              "",
          );

        const isVisible = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(el);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.pointerEvents === "none"
          )
            return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };

        const isInteractableLi = (el) =>
          el.tagName === "LI" &&
          (el.hasAttribute("onclick") ||
            el.hasAttribute("data-action") ||
            el.getAttribute("tabindex") === "0" ||
            el.getAttribute("jsaction") ||
            el.closest("[jsaction]"));

        const candidates = Array.from(
          document.querySelectorAll(
            "a, button, [role='button'], [role='option'], [role='menuitem'], [role='tab'], " +
              "input[type='submit'], input[type='button'], label, summary, li",
          ),
        ).filter(
          (el) =>
            isVisible(el) && (el.tagName !== "LI" || isInteractableLi(el)),
        );

        const items = candidates
          .map((el, i) => {
            const rect = el.getBoundingClientRect();
            const label = getLabel(el) || el.tagName.toLowerCase();
            return {
              index: i + 1,
              label,
              rect: {
                top: rect.top,
                left: rect.left,
                width: rect.width,
                height: rect.height,
              },
            };
          })
          .filter((item) => item.label.length > 0)
          .slice(0, 30);

        return { ok: true, items };
      });
    }, targetTabId);
    return result;
  },
  // Tells content.js to close the clickable overlay.
  "close-list": async (targetTabId) => {
    await withActiveTab(async (tab) => {
      await executeInTab(tab.id, () => {
        window.dispatchEvent(new CustomEvent("afk:close-clickable-list"));
      });
    }, targetTabId);
  },
  // Clicks an element by its number from the list-clickable overlay.
  "click-number": async (targetTabId, payload = {}) => {
    const clickIndex = Number(payload.clickIndex);
    if (!clickIndex || clickIndex < 1)
      return { ok: false, error: "Invalid index" };

    let result = { ok: false, error: "No active tab" };
    await withActiveTab(async (tab) => {
      result = await executeInTabWithResult(
        tab.id,
        (idx) => {
          // Try to use stored items from the overlay for accurate targeting
          const stored = window.__afkClickableItems;
          if (stored && stored[idx - 1]) {
            const item = stored[idx - 1];
            const { top, left, width, height } = item.rect;
            const centerX = left + width / 2;
            const centerY = top + height / 2;
            const el = document.elementFromPoint(centerX, centerY);
            if (el instanceof HTMLElement) {
              el.dispatchEvent(
                new MouseEvent("mousedown", {
                  bubbles: true,
                  cancelable: true,
                }),
              );
              el.dispatchEvent(
                new MouseEvent("mouseup", { bubbles: true, cancelable: true }),
              );
              el.click();
              window.dispatchEvent(new CustomEvent("afk:close-clickable-list"));
              return { ok: true };
            }
          }

          // Fallback: re-query the DOM
          const isVisible = (el) => {
            if (!(el instanceof HTMLElement)) return false;
            const style = window.getComputedStyle(el);
            if (
              style.display === "none" ||
              style.visibility === "hidden" ||
              style.pointerEvents === "none"
            )
              return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };

          const isInteractableLi = (el) =>
            el.tagName === "LI" &&
            (el.hasAttribute("onclick") ||
              el.hasAttribute("data-action") ||
              el.getAttribute("tabindex") === "0" ||
              el.getAttribute("jsaction") ||
              el.closest("[jsaction]"));

          const candidates = Array.from(
            document.querySelectorAll(
              "a, button, [role='button'], [role='option'], [role='menuitem'], [role='tab'], " +
                "input[type='submit'], input[type='button'], label, summary, li",
            ),
          ).filter(
            (el) =>
              isVisible(el) && (el.tagName !== "LI" || isInteractableLi(el)),
          );

          const target = candidates[idx - 1];
          if (!target)
            return { ok: false, error: `No element at index ${idx}` };

          target.dispatchEvent(
            new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
          );
          target.dispatchEvent(
            new MouseEvent("mouseup", { bubbles: true, cancelable: true }),
          );
          target.click();
          window.dispatchEvent(new CustomEvent("afk:close-clickable-list"));

          return { ok: true };
        },
        [clickIndex],
      );
    }, targetTabId);
    return result;
  },
};

chrome.runtime.onInstalled.addListener(async () => {
  const current = await getState();
  await chrome.storage.sync.set({ [STORAGE_KEY]: current });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (!message?.type) {
      sendResponse({ ok: false, error: "Missing message type" });
      return;
    }

    if (message.type === "AFK_GET_STATE") {
      const state = await getState();
      sendResponse({ ok: true, state });
      return;
    }

    if (message.type === "AFK_SET_STATE") {
      const nextState = await setState(message.payload || {});
      await broadcastState(nextState);
      sendResponse({ ok: true, state: nextState });
      return;
    }

    if (message.type === "AFK_COMMAND") {
      const state = await getState();
      const action = message.payload?.action;

      if (!state.enabled) {
        sendResponse({ ok: true, skipped: true, reason: "disabled" });
        return;
      }

      const handler = ACTION_HANDLERS[action];
      if (!handler) {
        sendResponse({ ok: false, error: `Unknown action: ${action}` });
        return;
      }

      const sourceTabId = sender?.tab?.id;
      const result = await handler(sourceTabId, message.payload || {});
      if (result && typeof result === "object" && "ok" in result) {
        sendResponse(result);
        return;
      }

      sendResponse({ ok: true });
      return;
    }

    sendResponse({
      ok: false,
      error: `Unsupported message type: ${message.type}`,
    });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error?.message || String(error),
    });
  });

  return true;
});

// ---------------------------------------------------------------------------
// Offscreen document helpers
// ---------------------------------------------------------------------------

async function offscreenExists() {
  // Chrome 116+ supports runtime.getContexts; older versions need SW clients fallback.
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    return contexts.length > 0;
  }

  const offscreenUrl = chrome.runtime.getURL("offscreen/offscreen.html");
  const matched = await clients.matchAll();
  return matched.some((client) => client.url === offscreenUrl);
}

async function startOffscreen() {
  if (await offscreenExists()) return;
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL("offscreen/offscreen.html"),
    reasons: ["USER_MEDIA"],
    justification: "Webcam access for real-time hand gesture recognition",
  });
}

async function stopOffscreen() {
  if (!(await offscreenExists())) return;
  await chrome.offscreen.closeDocument();
}

// ---------------------------------------------------------------------------
// Auto-start if camera permission was previously granted
// ---------------------------------------------------------------------------

async function autoStartIfPermitted() {
  try {
    const perm = await navigator.permissions.query({ name: "camera" });
    if (perm.state === "granted") await startOffscreen();
  } catch {
    // permissions API unavailable — skip auto-start; user opens popup to enable
  }
}

chrome.runtime.onInstalled.addListener(() =>
  autoStartIfPermitted().catch(console.error),
);
chrome.runtime.onStartup.addListener(() =>
  autoStartIfPermitted().catch(console.error),
);

// Revive offscreen doc if service worker woke up and doc was closed
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete")
    autoStartIfPermitted().catch(console.error);
});

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Popup toggled ON — camera permission was just granted by the popup
  if (msg.type === "start") {
    startOffscreen()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error("[AFK] failed to start offscreen:", err);
        sendResponse({ ok: false, error: err?.message || String(err) });
      });
    return true;
  }

  // Popup toggled OFF
  if (msg.type === "stop") {
    stopOffscreen()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error("[AFK] failed to stop offscreen:", err);
        sendResponse({ ok: false, error: err?.message || String(err) });
      });
    return true;
  }

  // Relay gesture events from offscreen doc → active tab's content script
  if (msg.type === "gesture") {
    if (msg.event === "gesture:closetab") {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const id = tabs[0]?.id;
        if (id != null) chrome.tabs.remove(id).catch(() => {});
      });
      return;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, msg).catch(() => {});
      }
    });
    return;
  }

  // Zoom in / out on the sender tab (request from content script)
  if (msg.type === "zoom") {
    const tabId = sender.tab?.id;
    if (!tabId) return;
    chrome.tabs.getZoom(tabId, (current) => {
      const delta = msg.direction === "in" ? 0.1 : -0.1;
      const next = Math.min(
        5,
        Math.max(0.25, Math.round((current + delta) * 10) / 10),
      );
      chrome.tabs.setZoom(tabId, next);
    });
  }

  // Switch to the adjacent tab (request from content script)
  if (msg.type === "tabswitch") {
    chrome.tabs.query({ currentWindow: true }, (tabs) => {
      const sorted = tabs.slice().sort((a, b) => a.index - b.index);
      const activeIdx = sorted.findIndex((t) => t.active);
      if (activeIdx === -1) return;
      const step = msg.direction === "next" ? 1 : -1;
      const nextIdx = (activeIdx + step + sorted.length) % sorted.length;
      chrome.tabs.update(sorted[nextIdx].id, { active: true });
    });
  }
});
