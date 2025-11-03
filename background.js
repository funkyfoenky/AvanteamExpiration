// background.js (MV3 service worker)

// Reçoit les pings d'activité de n'importe quelle frame et notifie le tab.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === "activity_ping") {
    const tabId = sender?.tab?.id;
    if (tabId != null) {
      chrome.tabs.sendMessage(tabId, { type: "reset_from_bg" });
    }
  }

  // Workflow "réinit" : ouvrir même URL dans un nouvel onglet, attendre le load, fermer, revenir à l'onglet d'origine
  if (msg && msg.type === "open_and_close_same_url") {
    const originTabId   = sender?.tab?.id;
    const originWindowId = sender?.tab?.windowId;
    const originIndex    = sender?.tab?.index;
    const url = msg.url || sender?.tab?.url || "";
    if (!originTabId || !url) return;

    // Ouvre l'onglet ACTIF (focus immédiat) juste à côté de l’onglet courant
    chrome.tabs.create({ url, active: true, index: (originIndex ?? 0) + 1 }, (newTab) => {
      if (!newTab?.id) {
        chrome.tabs.sendMessage(originTabId, { type: "reset_from_bg" });
        return;
      }

      const newTabId = newTab.id;

      // Met la fenêtre au premier plan (anti focus-stealing des OS)
      const winId = newTab.windowId ?? originWindowId;
      if (typeof winId === "number") {
        try { chrome.windows.update(winId, { focused: true }); } catch {}
      }

      let closed = false;
      let timeoutId = null;

      const cleanup = () => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        if (timeoutId) clearTimeout(timeoutId);
      };

      const finish = () => {
        if (closed) return;
        closed = true;

        chrome.tabs.remove(newTabId, () => {
          // Laisse Chrome activer automatiquement l’onglet voisin, puis reprends la main
          setTimeout(async () => {
            // 1) Tente de réactiver l’onglet d’origine par ID (chemin rapide)
            let restored = false;
            try {
              await chrome.tabs.update(originTabId, { active: true });
              restored = true;
            } catch {
              // 2) Fallback : si l’onglet d’origine n’existe plus, surligne (active) par index
              if (typeof originWindowId === "number" && typeof originIndex === "number") {
                try {
                  await chrome.tabs.highlight({ windowId: originWindowId, tabs: originIndex });
                  restored = true;
                } catch {}
              }
            }

            // 3) Re-focus la fenêtre d’origine si possible
            try {
              if (typeof originWindowId === "number") {
                await chrome.windows.update(originWindowId, { focused: true });
              }
            } catch {}

            // Notifie le content script de l’onglet d’origine (si toujours présent)
            try { chrome.tabs.sendMessage(originTabId, { type: "reset_from_bg" }); } catch {}

            cleanup();
          }, 100); // Petit délai pour battre la sélection auto de Chrome (50–150ms)
        });
      };

      const onUpdated = (tabId, changeInfo) => {
        if (tabId === newTabId && changeInfo.status === "complete") {
          // Laisse un court délai pour laisser le site confirmer l’accessibilité
          setTimeout(finish, 500);
        }
      };
      chrome.tabs.onUpdated.addListener(onUpdated);

      // Filet de sécurité si jamais la page ne passe pas à "complete"
      timeoutId = setTimeout(finish, 20000);
    });
  }
});
