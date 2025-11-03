(() => {
  const DURATION_MS = 15 * 60 * 1000; // 15 min
  const TICK_MS = 1000;
  const AUTO_RESET_COOLDOWN_MS = 3000; // anti-doublon

  if (window.__activityTimerInjected__) return;
  window.__activityTimerInjected__ = true;

  const IS_TOP = window === window.top;

  // --------- Détection stricte: href / onclick uniquement ----------
  function hasHref(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hasAttribute && el.hasAttribute("href")) {
      const href = el.getAttribute("href");
      return href != null && href.trim() !== "" && href.trim() !== "#";
    }
    return false;
  }
  function hasOnclick(el) {
    if (!el || el.nodeType !== 1) return false;
    return typeof el.onclick === "function" || (el.getAttribute && el.getAttribute("onclick") != null);
  }
  function isActionable(start) {
    let el = start, hops = 0;
    while (el && el !== document && hops < 10) {
      if (hasHref(el) || hasOnclick(el)) return true;
      el = el.parentElement;
      hops++;
    }
    return false;
  }

  // --------- Ping d’activité (uniquement si actionable) ----------
  let lastPing = 0;
  const PING_MIN_INTERVAL = 250;

  function pingActivity() {
    const now = Date.now();
    if (now - lastPing < PING_MIN_INTERVAL) return;
    lastPing = now;
    try { chrome.runtime?.sendMessage?.({ type: "activity_ping" }); } catch {}
  }

  function onPointerLike(e) {
    const target = (e.composedPath?.()[0]) || e.target;
    if (isActionable(target)) pingActivity();
  }
  function onKeydown(e) {
    const k = e.key || e.code;
    if (k !== "Enter" && k !== " " && k !== "Spacebar") return;
    const active = document.activeElement || e.target;
    if (isActionable(active)) pingActivity();
  }

  const EVENTS_POINTER = ["mousedown", "pointerdown", "click", "touchstart", "touchend"];
  EVENTS_POINTER.forEach(ev => {
    window.addEventListener(ev, onPointerLike, true);
    document.addEventListener(ev, onPointerLike, true);
  });
  window.addEventListener("keydown", onKeydown, true);
  document.addEventListener("keydown", onKeydown, true);

  // --------- UI top-frame ---------
  if (!IS_TOP) return;
  if (document.getElementById("activity-timer-root-fixed")) return;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const calcTopOffset = () => {
    const h = window.innerHeight || document.documentElement.clientHeight || 800;
    return Math.round(clamp(h * 0.10, 60, 200));
  };

  function createUI() {
    const root = document.createElement("div");
    root.id = "activity-timer-root-fixed";
    root.style.setProperty("--timer-top", `${calcTopOffset()}px`);

    const card = document.createElement("div");
    card.id = "activity-timer-card";

    const dot = document.createElement("div");
    dot.id = "activity-timer-dot";

    const timeEl = document.createElement("div");
    timeEl.id = "activity-timer-time";
    timeEl.textContent = "15:00";

    const resetBtn = document.createElement("button");
    resetBtn.id = "activity-timer-reset";
    resetBtn.textContent = "Reset";

    card.append(dot, timeEl, resetBtn);
    root.append(card);
    document.documentElement.append(root);

    const banner = document.createElement("div");
    banner.id = "activity-timer-expired";
    banner.style.display = "none";
    const link = document.createElement("a");
    link.id = "activity-timer-expired-link";
    link.href = "#";
    link.textContent =
      "Time-out. If you would like to reconnect, click on this banner to reset connection.";
    banner.append(link);
    document.documentElement.append(banner);

    return { root, timeEl, resetBtn, banner, link };
  }

  let deadline = Date.now() + DURATION_MS;
  let interval = null;
  let expiredShown = false;
  let lastAutoResetAt = 0;

  const fmt = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  };

  const timeLeft = () => deadline - Date.now();
  const isExpired = () => timeLeft() <= 0;
  const canAutoReset = () => (Date.now() - lastAutoResetAt) > AUTO_RESET_COOLDOWN_MS;

  function tryAutoResetWhenVisible() {
    if (document.visibilityState === "visible" && isExpired() && canAutoReset()) {
      lastAutoResetAt = Date.now();
      openAndClose(); // background notifiera ensuite reset_from_bg
    }
  }

  function updateUI(timeEl, root, banner) {
    const left = timeLeft();
    if (left <= 0) {
      timeEl.textContent = "00:00";
      if (!expiredShown) {
        expiredShown = true;
        root.classList.add("expired");
        banner.style.display = "block";
      }
      // Auto-reset immédiat si on est sur l’onglet
      tryAutoResetWhenVisible();
      return;
    }
    if (expiredShown) {
      expiredShown = false;
      root.classList.remove("expired");
      banner.style.display = "none";
    }
    timeEl.textContent = fmt(left);
  }

  function startTick(timeEl, root, banner) {
    clearInterval(interval);
    interval = setInterval(() => updateUI(timeEl, root, banner), TICK_MS);
    updateUI(timeEl, root, banner);
  }

  function resetTimer(timeEl, root, banner) {
    deadline = Date.now() + DURATION_MS;
    root.classList.remove("expired");
    banner.style.display = "none";
    startTick(timeEl, root, banner);
    root.classList.add("pulse");
    setTimeout(() => root.classList.remove("pulse"), 150);
  }

  const { root, timeEl, resetBtn, banner, link } = createUI();
  window.addEventListener("resize", () =>
    root.style.setProperty("--timer-top", `${calcTopOffset()}px`)
  );

  // Reset diffusé par le background (après pings / open&close)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "reset_from_bg") resetTimer(timeEl, root, banner);
  });

  // Ouvre la même URL dans un nouvel onglet, puis le ferme (flow existant)
  const openAndClose = () =>
    chrome.runtime.sendMessage({ type: "open_and_close_same_url", url: location.href });

  // Clicks explicites
  resetBtn.addEventListener("click", (e) => { e.stopPropagation(); openAndClose(); });
  link.addEventListener("click", (e) => { e.preventDefault(); openAndClose(); });

  // Auto-reset différé : si l’onglet redevient visible et que c’est expiré
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      tryAutoResetWhenVisible();
    }
  }, true);

  startTick(timeEl, root, banner);
})();
