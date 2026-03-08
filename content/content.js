// Content script — injected into every page
// Receives gesture messages from the service worker (relayed from offscreen.js)
// and translates them into DOM interactions.

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Finger cursor overlay
  // ---------------------------------------------------------------------------
  const cursor = document.createElement('div');
  Object.assign(cursor.style, {
    position:      'fixed',
    width:         '22px',
    height:        '22px',
    borderRadius:  '50%',
    background:    'rgba(99, 102, 241, 0.85)',
    border:        '2.5px solid white',
    boxShadow:     '0 0 10px rgba(99,102,241,0.55)',
    pointerEvents: 'none',
    zIndex:        '2147483646',
    transform:     'translate(-50%, -50%)',
    transition:    'background 0.15s, box-shadow 0.15s',
    display:       'none',
  });
  document.body.appendChild(cursor);

  const label = document.createElement('div');
  Object.assign(label.style, {
    position:     'fixed',
    padding:      '3px 8px',
    borderRadius: '999px',
    background:   'rgba(0,0,0,0.65)',
    color:        '#fff',
    fontSize:     '11px',
    fontFamily:   'system-ui, sans-serif',
    pointerEvents:'none',
    zIndex:       '2147483646',
    display:      'none',
    transform:    'translate(-50%, -150%)',
    whiteSpace:   'nowrap',
  });
  document.body.appendChild(label);

  const CURSOR_SMOOTHING = 0.22;
  const USE_DWELL_CLICK = true;
  const DWELL_CLICK_MS = 700;
  const DWELL_RADIUS_PX = 16;
  const DWELL_COOLDOWN_MS = 900;
  const DWELL_SCROLL_SUPPRESS_MS = 500;
  const EDGE_TAB_SWITCH_ENABLED = false;
  const EDGE_ZONE_RATIO = 0.08;
  const EDGE_SWIPE_WINDOW_MS = 700;
  const EDGE_SWIPE_MIN_SPEED_PX_PER_S = 650;
  const EDGE_SWIPE_MIN_TRAVEL_RATIO = 0.18;
  const EDGE_SWIPE_START_CENTER_RATIO = 0.70;
  const EDGE_TAB_COOLDOWN_MS = 900;
  const CURSOR_LOST_GRACE_MS = 280;
  let cursorTargetX = 0;
  let cursorTargetY = 0;
  let cursorRenderX = 0;
  let cursorRenderY = 0;
  let cursorAnimFrame = null;
  let currentCursorState = 'idle';
  let dwellAnchorX = 0;
  let dwellAnchorY = 0;
  let dwellStartMs = 0;
  let dwellLastClickMs = 0;
  let dwellLocked = false;
  let dwellSuppressUntilMs = 0;
  let edgeLastSwitchMs = 0;
  let edgeSwipeStartX = 0;
  let edgeSwipeStartMs = 0;
  let cursorLostTimer = null;

  function paintCursor(x, y) {
    cursor.style.left = x + 'px';
    cursor.style.top  = y + 'px';
    label.style.left  = x + 'px';
    label.style.top   = y + 'px';
  }

  function startCursorAnimation() {
    if (cursorAnimFrame != null) return;
    const tick = () => {
      cursorRenderX += (cursorTargetX - cursorRenderX) * CURSOR_SMOOTHING;
      cursorRenderY += (cursorTargetY - cursorRenderY) * CURSOR_SMOOTHING;
      paintCursor(cursorRenderX, cursorRenderY);
      cursorAnimFrame = requestAnimationFrame(tick);
    };
    cursorAnimFrame = requestAnimationFrame(tick);
  }

  function stopCursorAnimation() {
    if (cursorAnimFrame == null) return;
    cancelAnimationFrame(cursorAnimFrame);
    cursorAnimFrame = null;
  }

  function setCursorPos(x, y) {
    cursorTargetX = x;
    cursorTargetY = y;
    if (cursorAnimFrame == null) {
      cursorRenderX = x;
      cursorRenderY = y;
      paintCursor(x, y);
      startCursorAnimation();
    }
  }

  function setCursorState(state) {
    const states = {
      idle:      { bg: 'rgba(99,102,241,0.85)',  shadow: '0 0 10px rgba(99,102,241,0.55)',  text: null },
      drag:      { bg: 'rgba(239,68,68,0.85)',   shadow: '0 0 12px rgba(239,68,68,0.6)',    text: 'drag' },
      scroll:    { bg: 'rgba(34,197,94,0.85)',   shadow: '0 0 12px rgba(34,197,94,0.6)',    text: 'scroll' },
      tabswitch: { bg: 'rgba(245,158,11,0.9)',   shadow: '0 0 12px rgba(245,158,11,0.6)',   text: 'tab switch' },
    };
    const s = states[state] || states.idle;
    currentCursorState = state;
    cursor.style.background = s.bg;
    cursor.style.boxShadow  = s.shadow;
    if (s.text) { label.textContent = s.text; label.style.display = 'block'; }
    else { label.style.display = 'none'; }
  }

  // Convert normalised (0-1) coords from offscreen.js to screen pixels
  function toScreen(normX, normY) {
    return { x: normX * window.innerWidth, y: normY * window.innerHeight };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  let dragTarget = null;
  let scrollResetTimer;

  function elementAt(x, y) {
    cursor.style.display = 'none';
    label.style.display  = 'none';
    const el = document.elementFromPoint(x, y);
    cursor.style.display = 'block';
    return el;
  }

  function findScrollable(x, y, dy) {
    let el = document.elementFromPoint(x, y);
    while (el && el !== document.body) {
      const style     = getComputedStyle(el);
      const overflow  = style.overflow + style.overflowY;
      const canScroll = /auto|scroll/.test(overflow);
      const hasRoom   = dy > 0
        ? el.scrollTop + el.clientHeight < el.scrollHeight
        : el.scrollTop > 0;
      if (canScroll && hasRoom) return el;
      el = el.parentElement;
    }
    return window;
  }

  function dispatchClickAt(x, y) {
    cursor.style.transform = 'translate(-50%, -50%) scale(0.55)';
    setTimeout(() => { cursor.style.transform = 'translate(-50%, -50%) scale(1)'; }, 140);
    const el = elementAt(x, y);
    if (!el) return;
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
    el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
    el.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
    if (el.matches('input, textarea, select, [contenteditable]')) el.focus();
  }

  function updateDwellClick(x, y) {
    if (!USE_DWELL_CLICK) return;

    const now = Date.now();
    if (now < dwellSuppressUntilMs || currentCursorState === 'scroll') {
      dwellAnchorX = x;
      dwellAnchorY = y;
      dwellStartMs = now;
      return;
    }

    if (!dwellStartMs) {
      dwellAnchorX = x;
      dwellAnchorY = y;
      dwellStartMs = now;
      return;
    }

    const moved = Math.hypot(x - dwellAnchorX, y - dwellAnchorY);

    if (dwellLocked) {
      // Rearm dwell click only after meaningful movement away from clicked point.
      if (moved > DWELL_RADIUS_PX * 1.6) {
        dwellLocked = false;
        dwellAnchorX = x;
        dwellAnchorY = y;
        dwellStartMs = now;
      }
      return;
    }

    if (moved > DWELL_RADIUS_PX) {
      dwellAnchorX = x;
      dwellAnchorY = y;
      dwellStartMs = now;
      return;
    }

    if (
      now - dwellStartMs >= DWELL_CLICK_MS &&
      now - dwellLastClickMs >= DWELL_COOLDOWN_MS
    ) {
      dispatchClickAt(x, y);
      dwellLastClickMs = now;
      dwellLocked = true;
    }
  }

  function updateEdgeTabSwitch(x) {
    if (!EDGE_TAB_SWITCH_ENABLED) return false;

    const now = Date.now();
    if (now - edgeLastSwitchMs < EDGE_TAB_COOLDOWN_MS) return false;
    if (currentCursorState === 'scroll') return false;

    const leftZone = window.innerWidth * EDGE_ZONE_RATIO;
    const rightZone = window.innerWidth * (1 - EDGE_ZONE_RATIO);
    const centerHalf = (window.innerWidth * EDGE_SWIPE_START_CENTER_RATIO) / 2;
    const centerMin = window.innerWidth / 2 - centerHalf;
    const centerMax = window.innerWidth / 2 + centerHalf;

    if (!edgeSwipeStartMs) {
      edgeSwipeStartX = x;
      edgeSwipeStartMs = now;
      return false;
    }

    let dt = now - edgeSwipeStartMs;
    if (dt > EDGE_SWIPE_WINDOW_MS) {
      edgeSwipeStartX = x;
      edgeSwipeStartMs = now;
      dt = 0;
    }
    if (dt <= 0) return false;

    const dx = x - edgeSwipeStartX;
    const speed = Math.abs(dx) / (dt / 1000);
    const minTravel = window.innerWidth * EDGE_SWIPE_MIN_TRAVEL_RATIO;
    const startFromCenter = edgeSwipeStartX >= centerMin && edgeSwipeStartX <= centerMax;

    let direction = null;
    if (dx > 0 && x >= rightZone) direction = 'next';
    if (dx < 0 && x <= leftZone) direction = 'prev';

    if (
      direction &&
      startFromCenter &&
      Math.abs(dx) >= minTravel &&
      speed >= EDGE_SWIPE_MIN_SPEED_PX_PER_S
    ) {
      chrome.runtime.sendMessage({ type: 'tabswitch', direction }).catch(() => {});
      edgeLastSwitchMs = now;
      edgeSwipeStartX = x;
      edgeSwipeStartMs = now;
      dwellSuppressUntilMs = now + DWELL_SCROLL_SUPPRESS_MS;
      return true;
    }

    return false;
  }

  // ---------------------------------------------------------------------------
  // Gesture → DOM action bindings
  // Gesture messages arrive via chrome.runtime.onMessage from the service worker.
  // Positions are normalised [0, 1]; toScreen() converts to page pixels.
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'gesture') return;
    const { event, detail } = msg;

    if (event === 'gesture:cursor') {
      if (cursorLostTimer) {
        clearTimeout(cursorLostTimer);
        cursorLostTimer = null;
      }
      const { x, y } = toScreen(detail.normX, detail.normY);
      setCursorPos(x, y);
      const edgeActive = updateEdgeTabSwitch(x);
      if (!edgeActive) updateDwellClick(x, y);
      if (cursor.style.display === 'none') {
        cursor.style.display = 'block';
        setCursorState('idle');
      }

    } else if (event === 'gesture:none') {
      if (cursorLostTimer) clearTimeout(cursorLostTimer);
      cursorLostTimer = setTimeout(() => {
        cursor.style.display = 'none';
        label.style.display  = 'none';
        stopCursorAnimation();
        dwellStartMs = 0;
        dwellLocked = false;
        edgeSwipeStartMs = 0;
        cursorLostTimer = null;
      }, CURSOR_LOST_GRACE_MS);

    } else if (event === 'gesture:click') {
      if (!USE_DWELL_CLICK) {
        const { x, y } = toScreen(detail.normX, detail.normY);
        dispatchClickAt(x, y);
      }

    } else if (event === 'gesture:dragstart') {
      const { x, y } = toScreen(detail.normX, detail.normY);
      dragTarget = elementAt(x, y);
      if (dragTarget) {
        dragTarget.dispatchEvent(new MouseEvent('mousedown', {
          bubbles: true, cancelable: true, clientX: x, clientY: y, view: window,
        }));
      }
      setCursorState('drag');

    } else if (event === 'gesture:drag') {
      const { x, y } = toScreen(detail.normX, detail.normY);
      setCursorPos(x, y);
      document.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, cancelable: true, clientX: x, clientY: y, view: window,
      }));

    } else if (event === 'gesture:dragend') {
      const { x, y } = toScreen(detail.normX, detail.normY);
      const target = elementAt(x, y);
      [dragTarget, target].forEach((el) => {
        if (el) el.dispatchEvent(new MouseEvent('mouseup', {
          bubbles: true, cancelable: true, clientX: x, clientY: y, view: window,
        }));
      });
      dragTarget = null;
      setCursorState('idle');

    } else if (event === 'gesture:scroll') {
      const { dx, dy } = detail;
      setCursorState('scroll');
      dwellSuppressUntilMs = Date.now() + DWELL_SCROLL_SUPPRESS_MS;
      clearTimeout(scrollResetTimer);
      scrollResetTimer = setTimeout(() => setCursorState('idle'), 400);
      const pos = { x: parseFloat(cursor.style.left), y: parseFloat(cursor.style.top) };
      const scrollable = findScrollable(pos.x, pos.y, dy);
      if (scrollable && scrollable !== document.documentElement) {
        scrollable.scrollBy({ left: dx, top: dy, behavior: 'auto' });
      } else {
        window.scrollBy({ left: dx, top: dy, behavior: 'auto' });
      }

    } else if (event === 'gesture:zoom') {
      chrome.runtime.sendMessage({ type: 'zoom', direction: detail.direction });

    } else if (event === 'gesture:navigate') {
      if (detail.direction === 'back') history.back();
      else history.forward();

    } else if (event === 'gesture:tabswitch:start') {
      setCursorState('tabswitch');

    } else if (event === 'gesture:tabswitch:drag') {
      // Shift label slightly so the user can see drag progress
      const base = parseFloat(cursor.style.left) || 0;
      label.style.left = (base + detail.normDx * window.innerWidth * 0.3) + 'px';

    } else if (event === 'gesture:tabswitch:end') {
      setCursorState('idle');
      chrome.runtime.sendMessage({
        type: 'tabswitch',
        direction: detail.normDx > 0 ? 'next' : 'prev',
      });
    }
  });

})();
