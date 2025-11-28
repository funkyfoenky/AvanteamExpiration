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
      let checkUrlIntervalId = null;
      let waitingForLogin = false;
      let finishScheduled = false;

      const cleanup = () => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        if (timeoutId) clearTimeout(timeoutId);
        if (checkUrlIntervalId) clearTimeout(checkUrlIntervalId);
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

      // Vérifie si l'onglet est sur la page de connexion Microsoft
      const isOnMicrosoftLogin = async (tabId) => {
        try {
          const tab = await chrome.tabs.get(tabId);
          return tab?.url?.includes('login.microsoftonline.com') ?? false;
        } catch {
          return false;
        }
      };

      // Surveille les changements d'URL pour détecter la fin de la connexion
      const checkUrlChange = async () => {
        if (closed || !waitingForLogin || finishScheduled) return; // Arrête si déjà fermé ou si on n'attend plus la connexion
        
        const onLoginPage = await isOnMicrosoftLogin(newTabId);
        if (!onLoginPage) {
          // Plus sur la page de connexion, on peut fermer après un court délai
          scheduleFinish(1000);
        } else {
          // Toujours sur la page de connexion, on continue à surveiller
          // On vérifie à nouveau dans 1 seconde
          checkUrlIntervalId = setTimeout(checkUrlChange, 1000);
        }
      };

      const scheduleFinish = (delay = 1000) => {
        if (finishScheduled || closed) return;
        finishScheduled = true;
        waitingForLogin = false;
        if (checkUrlIntervalId) clearTimeout(checkUrlIntervalId);
        setTimeout(finish, delay);
      };

      const onUpdated = async (tabId, changeInfo) => {
        if (tabId === newTabId && !closed) {
          // Si l'URL change et qu'on attendait la connexion, vérifier si on est toujours sur la page de login
          if (changeInfo.url && waitingForLogin) {
            const onLoginPage = await isOnMicrosoftLogin(newTabId);
            if (!onLoginPage) {
              // L'URL a changé et on n'est plus sur la page de login, la connexion est probablement terminée
              scheduleFinish(1000);
            }
          }
          
          // Quand la page est complètement chargée
          if (changeInfo.status === "complete") {
            const onLoginPage = await isOnMicrosoftLogin(newTabId);
            
            if (onLoginPage) {
              // On est sur la page de connexion Microsoft, on attend que l'utilisateur se connecte
              if (!waitingForLogin) {
                waitingForLogin = true;
                // On surveille les changements d'URL
                checkUrlChange();
              }
            } else {
              // Pas sur la page de connexion
              if (!waitingForLogin) {
                // Si on n'attendait pas la connexion, on ferme normalement
                scheduleFinish(500);
              }
              // Si on attendait la connexion et qu'on n'est plus sur la page de login,
              // c'est qu'on vient de se connecter, donc on ferme (déjà géré par le check d'URL ci-dessus)
            }
          }
        }
      };
      chrome.tabs.onUpdated.addListener(onUpdated);

      // Filet de sécurité si jamais la page ne passe pas à "complete" ou si la connexion prend trop de temps
      timeoutId = setTimeout(() => {
        if (!closed && !finishScheduled) {
          scheduleFinish(0);
        }
      }, 60000); // Augmenté à 60 secondes pour laisser le temps de se connecter
    });
  }
});
