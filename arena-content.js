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
  let isAutoScanEnabled = false;
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
      arenaFormulas = [ARENA.defaultArenaFormula(), ARENA.defaultSimulatorFormula()];
      selectedFormulaId = arenaFormulas[0].id;
      return;
    }

    const result = await chrome.storage.local.get([ARENA.formulasStorageKey, POPUP_STATE_KEY]);
    const storedFormulas = ARENA.normalizeArenaFormulas(result[ARENA.formulasStorageKey]);
    arenaFormulas = storedFormulas.length ? storedFormulas : [ARENA.defaultArenaFormula(), ARENA.defaultSimulatorFormula()];
    
    if (!arenaFormulas.some((f) => f.id === "formula-simulator")) {
      arenaFormulas.push(ARENA.defaultSimulatorFormula());
      await chrome.storage.local.set({ [ARENA.formulasStorageKey]: arenaFormulas });
    }

    selectedFormulaId = String(result[POPUP_STATE_KEY]?.arenaFormulaId || "");
    if (!getSelectedFormula()) selectedFormulaId = getAvailableFormulas()[0]?.id || ARENA.defaultArenaFormula().id;
    isAutoScanEnabled = Boolean(result[POPUP_STATE_KEY]?.arenaAutoScan);
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

  async function saveAutoScanState(enabled) {
    isAutoScanEnabled = Boolean(enabled);
    if (typeof chrome === "undefined" || !chrome.storage?.local) return;

    const result = await chrome.storage.local.get(POPUP_STATE_KEY);
    await chrome.storage.local.set({
      [POPUP_STATE_KEY]: {
        ...(result[POPUP_STATE_KEY] || {}),
        arenaAutoScan: isAutoScanEnabled
      }
    });
  }

  async function saveArenaResult(result) {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return;
    await chrome.storage.local.set({ [ARENA.resultsStorageKey]: result });
  }

  function annotateResult(result) {
    const entries = ARENA.readArenaOpponentEntries(document, window.location.href);
    annotateRows(entries, result?.opponents || [], result?.formulaId);
  }

  async function annotateCachedResult(options = {}) {
    const result = await SCANNER.getCachedResultForCurrentPage(getSelectedFormula(), {
      updateLastResult: true,
      scanSource: options.fromStorage ? "storage" : "visible"
    });
    if (!result) return false;

    clearArenaBadges();
    annotateResult(result);
    const status = document.querySelector(`#${PANEL_ID} .glad-arena-status`);
    if (status) setPanelStatus(status, resultStatusText(result, "Cached"), false);
    return true;
  }

  function annotateRows(entries, opponents, formulaId = "") {
    const isSimulator = formulaId === "formula-simulator";
    const best = opponents
      .filter((entry) => Number.isFinite(entry.score))
      .sort((a, b) => isSimulator ? (b.score - a.score) : (a.score - b.score))[0] || null;

    const opponentsByRow = new Map(opponents.map((candidate) => [candidate.rowIndex, candidate]));

    for (const entry of entries) {
      const result = opponentsByRow.get(entry.opponent.rowIndex);
      if (!result) continue;

      const targetCell = entry.link.parentElement || entry.row.cells?.[0];
      if (!targetCell) continue;

      entry.row.classList.toggle(BEST_CLASS, Boolean(best && result.rowIndex === best.rowIndex));
      const badge = document.createElement("span");
      badge.className = BADGE_CLASS;

      if (Number.isFinite(result.score)) {
        if (isSimulator) {
          badge.textContent = `Win Chance: ${result.score}%`;
        } else {
          badge.textContent = `${entry.opponent.arenaKind === "team" ? "Team" : "Power"} ${ARENA.formatNumber(result.score)}`;
        }
        badge.title = scoreTitle(result);
        if (result.matches === false) badge.classList.add("glad-arena-score-warning");
      } else {
        badge.classList.add("glad-arena-score-error");
        badge.textContent = "Power ?";
        badge.title = result.error || "Scan failed.";
      }

      targetCell.append(badge);

      const costume = result.character?.costume || result.costume || null;
      if (costume?.tier) {
        const costumeBadge = document.createElement("span");
        costumeBadge.className = `glad-arena-costume glad-arena-costume-${costume.tier.toLowerCase()}`;
        costumeBadge.textContent = costume.tier;
        costumeBadge.title = `Costume set ${costume.setId} (${costume.tier})`;
        targetCell.append(costumeBadge);
      }
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
    document.querySelectorAll(".glad-arena-costume").forEach((badge) => badge.remove());
    document.querySelectorAll(`.${BEST_CLASS}`).forEach((row) => row.classList.remove(BEST_CLASS));
  }

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (key === "className") el.className = value;
        else if (key === "textContent") el.textContent = value;
        else if (key === "innerHTML") el.innerHTML = value;
        else if (typeof value === "function") {
          const eventName = key.replace(/^on/, "").toLowerCase();
          el.addEventListener(eventName, value);
          if (eventName === "click") {
            let startY = 0;
            el.addEventListener("touchstart", (e) => { startY = e.changedTouches[0].screenY; }, { passive: true });
            el.addEventListener("touchend", (e) => {
              if (el.disabled || Math.abs(e.changedTouches[0].screenY - startY) > 10) return;
              e.preventDefault();
              value(e);
            });
          }
        }
        else if (key === "style" && typeof value === "object") Object.assign(el.style, value);
        else el.setAttribute(key === "htmlFor" ? "for" : key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`), String(value));
      }
    }
    el.append(...children.flat().filter((c) => c != null && c !== false));
    return el;
  }

  function ensurePanel() {
    if (!ARENA.isArenaPageUrl(window.location.href) || document.getElementById(PANEL_ID)) return;

    const entries = ARENA.readArenaOpponentEntries(document);
    const table = entries[0]?.row?.closest("table");
    if (!table) return;

    const status = h("span", { className: "glad-arena-status", textContent: `${entries.length} opponents` });
    const select = h("select", { id: "glad-arena-formula" });
    renderFormulaOptions(select);

    const selectWrapper = h("div", { className: "glad-select-wrapper" },
      select,
      h("span", { className: "glad-select-icon", html: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>` })
    );

    const button = h("button", {
      type: "button",
      innerHTML: `<span class="glad-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg></span> <span>Scan scores</span>`,
      onClick: () => {
        runPanelScan(button, select, status).catch((error) => {
          setPanelStatus(status, error.message || String(error), true);
        });
      }
    });

    const toggleButton = h("button", {
      type: "button",
      className: isAutoScanEnabled ? "glad-arena-button-active" : "",
      innerHTML: isAutoScanEnabled 
        ? `<span style="color:var(--glad-border-focus)">Auto: On</span>` 
        : `<span>Auto: Off</span>`,
      style: { marginLeft: "4px" },
      onClick: () => {
        saveAutoScanState(!isAutoScanEnabled).then(() => {
          toggleButton.innerHTML = isAutoScanEnabled 
            ? `<span style="color:var(--glad-border-focus)">Auto: On</span>` 
            : `<span>Auto: Off</span>`;
          toggleButton.classList.toggle("glad-arena-button-active", isAutoScanEnabled);
          if (isAutoScanEnabled) runAutoScan(button, select, status).catch(() => {});
        });
      }
    });

    select.addEventListener("change", () => {
      saveSelectedFormulaId(select.value).then(() => {
        clearArenaBadges();
        if (isAutoScanEnabled) {
          return runPanelScan(button, select, status);
        } else {
          return annotateCachedResult();
        }
      }).catch(() => {});
    });

    const panel = h("div", { id: PANEL_ID },
      h("strong", { style: { display: "inline-flex", alignItems: "center", gap: "6px" }, innerHTML: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color: var(--glad-border-focus);"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg> Arena Scanner` }),
      h("label", { htmlFor: "glad-arena-formula", textContent: "Formula" }),
      selectWrapper,
      button,
      toggleButton,
      status
    );

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

  async function runAutoScan(button, select, status) {
    if (button) button.disabled = true;
    if (select) select.disabled = true;
    if (status) setPanelStatus(status, "Auto scanning...", false);

    try {
      const formula = getSelectedFormula();
      const result = await SCANNER.ensureScanForCurrentPage(formula, {
        updateLastResult: true,
        scanSource: "visible"
      });
      if (result) {
        clearArenaBadges();
        annotateResult(result);
        if (status) setPanelStatus(status, resultStatusText(result, "Auto"), false);
      } else {
        await annotateCachedResult({ fromStorage: true });
      }
    } catch (error) {
      if (status) setPanelStatus(status, error.message || String(error), true);
    } finally {
      if (button) button.disabled = false;
      if (select) select.disabled = false;
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
    if (bootTimer) return;
    bootTimer = window.setTimeout(() => {
      bootTimer = 0;
      loadFormulaState()
        .then(async () => {
          ensurePanel();
          subscribeToPassiveCacheChanges();
          await SCANNER.rememberCurrentListUrl(window.location.href);
          if (isAutoScanEnabled) {
            const status = document.querySelector(`#${PANEL_ID} .glad-arena-status`);
            const button = document.querySelector(`#${PANEL_ID} button`);
            const select = document.querySelector(`#${PANEL_ID} select`);
            await runAutoScan(button, select, status);
          } else {
            await annotateCachedResult();
          }
        })
        .catch(() => {
          arenaFormulas = [ARENA.defaultArenaFormula()];
          selectedFormulaId = arenaFormulas[0].id;
          isAutoScanEnabled = false;
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
      if (areaName !== "local") return;
      if (changes[ARENA.passiveScansStorageKey] || changes[POPUP_STATE_KEY] || changes[ARENA.formulasStorageKey]) {
        if (changes[POPUP_STATE_KEY] || changes[ARENA.formulasStorageKey]) {
          loadFormulaState().then(() => {
            const select = document.getElementById("glad-arena-formula");
            if (select) renderFormulaOptions(select);
            const toggleButton = document.querySelector(`#${PANEL_ID} button:nth-of-type(2)`);
            if (toggleButton) {
              toggleButton.textContent = isAutoScanEnabled ? "Auto: On" : "Auto: Off";
              toggleButton.className = isAutoScanEnabled ? "glad-arena-button-active" : "";
            }
            annotateCachedResult({ fromStorage: true }).catch(() => {});
          });
        } else {
          annotateCachedResult({ fromStorage: true }).catch(() => {});
        }
      }
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
