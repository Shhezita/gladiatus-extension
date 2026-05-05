(() => {
  const ARENA = window.GladiatusArenaCore;
  if (!ARENA) {
    throw new Error("Gladiatus arena core must load before the arena content script.");
  }

  const PANEL_ID = "glad-arena-scanner";
  const BADGE_CLASS = "glad-arena-score";
  const BEST_CLASS = "glad-arena-best";
  const POPUP_STATE_KEY = window.GladiatusAuctionSchema?.storageKeys?.popupState || "glad-ah-popup-state-v1";
  let arenaFormulas = [ARENA.defaultArenaFormula()];
  let selectedFormulaId = "";
  let bootTimer = 0;

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

    const formula = ARENA.normalizeArenaFormula(rawFormula) || ARENA.defaultArenaFormula();
    const entries = ARENA.readArenaOpponentEntries(document);
    if (!entries.length) {
      throw new Error("Could not find arena opponent rows.");
    }

    clearArenaBadges();
    const opponents = [];
    for (const entry of entries) {
      opponents.push(await scanOpponentEntry(entry, formula));
      await delay(150);
    }
    annotateRows(entries, opponents);

    const successful = opponents.filter((entry) => Number.isFinite(entry.score));
    const best = [...successful].sort((a, b) => a.score - b.score)[0] || null;

    return {
      scannedAt: new Date().toISOString(),
      formulaId: formula.id,
      formulaName: formula.name,
      arenaKind: ARENA.arenaKindFromUrl(window.location.href),
      opponentCount: opponents.length,
      failedCount: opponents.filter((entry) => entry.error).length,
      bestName: best?.displayName || "",
      bestScore: best?.score || 0,
      opponents
    };
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

  async function scanOpponentEntry(entry, formula) {
    try {
      const html = await fetchProfileHtml(entry.opponent.profileUrl);
      return entry.opponent.arenaKind === "team"
        ? await scanTeamOpponent(entry, html, formula)
        : scanSingleOpponent(entry, html, formula);
    } catch (error) {
      return {
        rowIndex: entry.opponent.rowIndex,
        opponent: { ...entry.opponent },
        score: Number.POSITIVE_INFINITY,
        displayName: entry.opponent.name,
        error: error.message || String(error)
      };
    }
  }

  function scanSingleOpponent(entry, html, formula) {
    const character = ARENA.parseCharacterFromHtml(html, {
      ...entry.opponent,
      role: "duel",
      roleLabel: ARENA.roleSectionLabels.duel
    }).toJSON();
    const scored = ARENA.scoreArenaCharacter(character, formula);

    return {
      rowIndex: entry.opponent.rowIndex,
      opponent: { ...entry.opponent },
      displayName: character.name,
      score: scored.score,
      matches: scored.matches,
      formulaSection: scored.sectionKey,
      character
    };
  }

  async function scanTeamOpponent(entry, html, formula) {
    const tabs = ARENA.teamDollTabs(ARENA.readProfileDollTabsFromHtml(html, entry.opponent.profileUrl));
    if (!tabs.length) throw new Error("Could not find Circus team tabs on profile.");

    const characters = [];
    for (const tab of tabs) {
      const dollHtml = await fetchProfileHtml(tab.url);
      characters.push(ARENA.parseCharacterFromHtml(dollHtml, {
        ...entry.opponent,
        profileUrl: tab.url,
        doll: tab.doll,
        role: tab.role,
        roleLabel: tab.roleLabel
      }).toJSON());
      await delay(150);
    }
    const team = ARENA.scoreArenaTeam(characters, formula);

    return {
      rowIndex: entry.opponent.rowIndex,
      opponent: { ...entry.opponent },
      displayName: entry.opponent.name,
      score: team.totalScore,
      matches: team.matches,
      team
    };
  }

  function fetchProfileHtml(url) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "GLAD_ARENA_FETCH_PROFILE", url }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }

        if (!response?.ok) {
          reject(new Error(response?.error || "Could not fetch profile."));
          return;
        }

        resolve(response.html || "");
      });
    });
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
      saveSelectedFormulaId(select.value).catch(() => {});
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
      await saveArenaResult(result);

      const failed = result.failedCount ? `, ${result.failedCount} failed` : "";
      setPanelStatus(
        status,
        result.bestName ? `Best: ${result.bestName} (${ARENA.formatNumber(result.bestScore)})${failed}` : `Scanned ${result.opponentCount}${failed}`,
        false
      );
    } finally {
      button.disabled = false;
      select.disabled = false;
    }
  }

  function setPanelStatus(status, text, isError) {
    status.textContent = text;
    status.classList.toggle("glad-arena-status-error", Boolean(isError));
  }

  function delay(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  function boot() {
    window.clearTimeout(bootTimer);
    bootTimer = window.setTimeout(() => {
      loadFormulaState()
        .then(ensurePanel)
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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
