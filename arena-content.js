(() => {
  const ARENA = window.GladiatusArenaCore;
  const SCANNER = window.GladiatusArenaScanner;
  if (!isArenaPageUrl(window.location.href)) return;

  if (!ARENA || !SCANNER) {
    registerMissingArenaDependencyDiagnostic();
    return;
  }

  const PANEL_ID = "glad-arena-scanner";
  const BADGE_CLASS = "glad-arena-score";
  const BEST_CLASS = "glad-arena-best";
  const POPUP_STATE_KEY = window.GladiatusAuctionSchema?.storageKeys?.popupState || "glad-ah-popup-state-v1";
  let arenaFormulas = [ARENA.defaultArenaFormula()];
  let selectedFormulaId = "";
  let bootTimer = 0;

  function isArenaPageUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname.endsWith(".gladiatus.gameforge.com")
        && parsed.pathname.endsWith("/game/index.php")
        && parsed.searchParams.get("mod") === "arena";
    } catch {
      return false;
    }
  }

  function registerMissingArenaDependencyDiagnostic() {
    const error = "Arena content script dependency missing: arena-core.js or arena-scan.js. Reload the unpacked extension and refresh this arena tab.";
    console.error(error);

    if (typeof chrome === "undefined" || !chrome.runtime?.onMessage) return;

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== "GLAD_ARENA_SCAN_OPPONENTS") return false;
      sendResponse({ ok: false, error });
      return false;
    });
  }

  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== "GLAD_ARENA_SCAN_OPPONENTS") return false;

      scanOpponents(message.formula)
        .then(async (result) => {
          await saveArenaResult(result);
          sendResponse({ ok: true, result });
        })
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

      return true;
    });
  }

  async function scanOpponents(rawFormula) {
    if (!ARENA.isArenaPageUrl(window.location.href)) {
      throw new Error("Open a Gladiatus arena page before scanning opponents.");
    }

    clearArenaBadges();
    const result = await SCANNER.scanCurrentPage(rawFormula, { force: true });
    clearArenaBadges();
    annotateResult(result);
    return result;
  }

  async function loadFormulaState() {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      arenaFormulas = [ARENA.defaultArenaFormula()];
      selectedFormulaId = arenaFormulas[0].id;
      return;
    }

    const result = await chrome.storage.local.get([ARENA.formulasStorageKey, POPUP_STATE_KEY]);
    const storedFormulas = ARENA.normalizeArenaFormulas(result[ARENA.formulasStorageKey]);
    arenaFormulas = storedFormulas.length ? storedFormulas : [ARENA.defaultArenaFormula()];
    selectedFormulaId = String(result[POPUP_STATE_KEY]?.arenaFormulaId || "");
    if (!getSelectedFormula()) selectedFormulaId = getAvailableFormulas()[0]?.id || ARENA.defaultArenaFormula().id;
  }

  function getAvailableFormulas() {
    const enabled = arenaFormulas.filter((formula) => formula.enabled);
    return enabled.length ? enabled : arenaFormulas;
  }

  function getSelectedFormula() {
    const available = getAvailableFormulas();
    return available.find((formula) => formula.id === selectedFormulaId) || available[0] || ARENA.defaultArenaFormula();
  }

  async function saveSelectedFormulaId(formulaId) {
    selectedFormulaId = formulaId;
    if (typeof chrome === "undefined" || !chrome.storage?.local) return;

    const result = await chrome.storage.local.get(POPUP_STATE_KEY);
    await chrome.storage.local.set({
      [POPUP_STATE_KEY]: {
        ...(result[POPUP_STATE_KEY] || {}),
        arenaFormulaId: selectedFormulaId
      }
    });
  }

  async function saveArenaResult(result) {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return;
    await chrome.storage.local.set({ [ARENA.resultsStorageKey]: result });
  }

  function annotateResult(result) {
    const entries = ARENA.readArenaOpponentEntries(document, window.location.href);
    annotateRows(entries, result?.opponents || []);
  }

  async function annotateCachedResult(options = {}) {
    const result = options.fromStorage
      ? await SCANNER.getCachedResultForCurrentPage(getSelectedFormula(), {
        updateLastResult: true,
        scanSource: "storage"
      })
      : await SCANNER.ensureScanForCurrentPage(getSelectedFormula(), {
        updateLastResult: true,
        scanSource: "visible"
      });
    if (!result) return false;

    clearArenaBadges();
    annotateResult(result);
    const status = document.querySelector(`#${PANEL_ID} .glad-arena-status`);
    if (status) setPanelStatus(status, resultStatusText(result, "Cached"), false);
    return true;
  }

  function annotateRows(entries, opponents) {
    const best = opponents
      .filter((entry) => Number.isFinite(entry.score))
      .sort((a, b) => a.score - b.score)[0] || null;

    for (const entry of entries) {
      const result = opponents.find((candidate) => candidate.rowIndex === entry.opponent.rowIndex);
      if (!result) continue;

      const targetCell = entry.link.parentElement || entry.row.cells?.[0];
      if (!targetCell) continue;

      entry.row.classList.toggle(BEST_CLASS, Boolean(best && result.rowIndex === best.rowIndex));
      const badge = document.createElement("span");
      badge.className = BADGE_CLASS;

      if (Number.isFinite(result.score)) {
        badge.textContent = `${entry.opponent.arenaKind === "team" ? "Team" : "Power"} ${ARENA.formatNumber(result.score)}`;
        badge.title = scoreTitle(result);
        if (result.matches === false) badge.classList.add("glad-arena-score-warning");
      } else {
        badge.classList.add("glad-arena-score-error");
        badge.textContent = "Power ?";
        badge.title = result.error || "Scan failed.";
      }

      targetCell.append(badge);
    }
  }

  function scoreTitle(result) {
    if (result.team) {
      return result.team.members
        .map((member) => `${member.roleLabel}: ${ARENA.formatNumber(member.formulaScore)} (${ARENA.formatCharacterStats(member)})`)
        .join("\n");
    }
    return result.character ? ARENA.formatCharacterStats(result.character) : result.error || "";
  }

  function clearArenaBadges() {
    document.querySelectorAll(`.${BADGE_CLASS}`).forEach((badge) => badge.remove());
    document.querySelectorAll(`.${BEST_CLASS}`).forEach((row) => row.classList.remove(BEST_CLASS));
  }

  function ensurePanel() {
    if (!ARENA.isArenaPageUrl(window.location.href) || document.getElementById(PANEL_ID)) return;

    const entries = ARENA.readArenaOpponentEntries(document);
    const table = entries[0]?.row?.closest("table");
    if (!table) return;

    const panel = document.createElement("div");
    panel.id = PANEL_ID;

    const title = document.createElement("strong");
    title.textContent = "Arena scanner";

    const formulaLabel = document.createElement("label");
    formulaLabel.htmlFor = "glad-arena-formula";
    formulaLabel.textContent = "Formula";

    const select = document.createElement("select");
    select.id = "glad-arena-formula";
    renderFormulaOptions(select);
    select.addEventListener("change", () => {
      saveSelectedFormulaId(select.value)
        .then(() => {
          clearArenaBadges();
          return annotateCachedResult();
        })
        .catch(() => {});
    });

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Scan scores";
    button.addEventListener("click", () => {
      runPanelScan(button, select, status).catch((error) => {
        setPanelStatus(status, error.message || String(error), true);
      });
    });

    const status = document.createElement("span");
    status.className = "glad-arena-status";
    status.textContent = `${entries.length} opponents`;

    panel.append(title, formulaLabel, select, button, status);
    table.before(panel);
  }

  function renderFormulaOptions(select) {
    select.replaceChildren();
    for (const formula of getAvailableFormulas()) {
      const option = document.createElement("option");
      option.value = formula.id;
      option.textContent = formula.name;
      select.append(option);
    }
    select.value = getSelectedFormula().id;
  }

  async function runPanelScan(button, select, status) {
    button.disabled = true;
    select.disabled = true;
    setPanelStatus(status, "Scanning profiles...", false);

    try {
      const formula = arenaFormulas.find((candidate) => candidate.id === select.value) || getSelectedFormula();
      await saveSelectedFormulaId(formula.id);
      const result = await scanOpponents(formula);
      if (!result) throw new Error("Scan is already running. Wait for the current scan to finish.");
      await saveArenaResult(result);

      setPanelStatus(status, resultStatusText(result, "Best"), false);
    } finally {
      button.disabled = false;
      select.disabled = false;
    }
  }

  function resultStatusText(result, prefix) {
    if (!result) return "Scan is already running";
    const failed = result.failedCount ? `, ${result.failedCount} failed` : "";
    return result.bestName
      ? `${prefix}: ${result.bestName} (${ARENA.formatNumber(result.bestScore)})${failed}`
      : `Scanned ${result.opponentCount}${failed}`;
  }

  function setPanelStatus(status, text, isError) {
    status.textContent = text;
    status.classList.toggle("glad-arena-status-error", Boolean(isError));
  }

  function boot() {
    window.clearTimeout(bootTimer);
    bootTimer = window.setTimeout(() => {
      loadFormulaState()
        .then(async () => {
          ensurePanel();
          subscribeToPassiveCacheChanges();
          await SCANNER.rememberCurrentListUrl(window.location.href);
          await annotateCachedResult();
        })
        .catch(() => {
          arenaFormulas = [ARENA.defaultArenaFormula()];
          selectedFormulaId = arenaFormulas[0].id;
          ensurePanel();
        });
    }, 150);
  }

  const observer = new MutationObserver(() => {
    if (!document.getElementById(PANEL_ID)) boot();
  });

  function subscribeToPassiveCacheChanges() {
    if (!chrome.storage?.onChanged || window.__GladiatusArenaPassiveCacheListener) return;

    window.__GladiatusArenaPassiveCacheListener = (changes, areaName) => {
      if (areaName !== "local" || !changes[ARENA.passiveScansStorageKey]) return;
      annotateCachedResult({ fromStorage: true }).catch(() => {});
    };
    chrome.storage.onChanged.addListener(window.__GladiatusArenaPassiveCacheListener);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
