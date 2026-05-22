(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : window;
  const ARENA = root.GladiatusArenaCore;

  if (!ARENA || typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;

  if (root.GladiatusArenaScanner) {
    root.GladiatusArenaScanner.bootPassive?.();
    return;
  }

  const PASSIVE_BOOT_DELAY_MS = 1200;
  const FULL_SCAN_QUIET_MS = 10 * 60 * 1000;
  const LIST_CHECK_INTERVAL_MS = 3 * 60 * 1000;
  const STATUS_BOX_ID = "glad-arena-passive-status";
  const STATUS_KINDS = ["single", "team"];
  let passiveBootTimer = 0;

  function isGladiatusGamePage(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname.endsWith(".gladiatus.gameforge.com")
        && parsed.pathname.startsWith("/game/");
    } catch {
      return false;
    }
  }

  function currentArenaKind() {
    return ARENA.isArenaPageUrl(root.location?.href || "") ? ARENA.arenaKindFromUrl(root.location.href) : "";
  }

  function readVisibleEntries() {
    if (!ARENA.isArenaPageUrl(root.location?.href || "")) return [];
    return ARENA.readArenaOpponentEntries(root.document, root.location.href);
  }

  async function scanCurrentPage(rawFormula) {
    if (!ARENA.isArenaPageUrl(root.location?.href || "")) {
      throw new Error("Open a Gladiatus arena page before scanning opponents.");
    }

    const entries = readVisibleEntries();
    if (!entries.length) throw new Error("Could not find arena opponent rows.");

    const response = await sendRuntimeMessage({
      type: "GLAD_ARENA_FORCE_SCAN",
      url: root.location.href,
      entries: serializeEntries(entries),
      formula: rawFormula || null
    });
    if (!response?.ok) throw new Error(response?.error || "Could not scan arena opponents.");
    if (!response.result) throw new Error("Scan is already running. Wait for the current scan to finish.");
    return response.result;
  }

  async function ensureScanForCurrentPage(rawFormula, options = {}) {
    if (!ARENA.isArenaPageUrl(root.location?.href || "")) return null;
    const entries = readVisibleEntries();
    const ensured = await ensureScanForEntries(entries, rawFormula, {
      ...options,
      url: root.location.href,
      scanSource: options.scanSource || "visible"
    });
    return ensured.result;
  }

  async function ensureScanForEntries(entries, rawFormula, options = {}) {
    const serialized = serializeEntries(entries);
    if (!serialized.length) return { result: null, skipped: "empty" };

    const response = await sendRuntimeMessage({
      type: options.force ? "GLAD_ARENA_FORCE_SCAN" : "GLAD_ARENA_ENSURE_VISIBLE_SCAN",
      url: options.url || options.listUrl || options.sourceUrl || root.location?.href || "",
      entries: serialized,
      formula: rawFormula || null
    });
    if (!response?.ok) throw new Error(response?.error || "Could not ensure arena scan.");
    return {
      result: response.result || null,
      scanned: Boolean(response.result),
      skipped: response.result ? "" : "locked"
    };
  }

  async function getCachedResultForCurrentPage(rawFormula, options = {}) {
    if (!ARENA.isArenaPageUrl(root.location?.href || "")) return null;
    return getCachedResultForEntries(readVisibleEntries(), rawFormula, options);
  }

  async function getCachedResultForEntries(entries, rawFormula, options = {}) {
    if (!chrome.storage?.local) return null;
    const serialized = serializeEntries(entries);
    if (!serialized.length) return null;

    const formula = ARENA.normalizeArenaFormula(rawFormula) || ARENA.defaultArenaFormula();
    const kind = options.kind || serialized[0]?.opponent?.arenaKind || currentArenaKind() || "single";
    const fingerprint = ARENA.arenaOpponentFingerprint(serialized);
    const formulaKey = arenaFormulaFingerprint(formula);
    const stored = await chrome.storage.local.get(ARENA.passiveScansStorageKey);
    const record = stored[ARENA.passiveScansStorageKey]?.[kind] || {};
    if (!record.result || record.fingerprint !== fingerprint || record.formulaFingerprint !== formulaKey) return null;

    const recordScannedAt = Date.parse(record.scannedAt || record.result?.scannedAt || "");
    const CACHE_TTL_MS = 10 * 60 * 1000;
    if (Number.isFinite(recordScannedAt) && Date.now() - recordScannedAt > CACHE_TTL_MS) return null;

    if (options.updateLastResult !== false) {
      await chrome.storage.local.set({ [ARENA.resultsStorageKey]: record.result });
    }
    return record.result;
  }

  function runPassiveCheck(options = {}) {
    const url = options.url || root.location?.href || "";
    if (!isGladiatusGamePage(url)) return Promise.resolve([]);

    return sendRuntimeMessage({
      type: "GLAD_ARENA_PASSIVE_CHECK",
      url,
      preferredKind: options.preferredKind || currentArenaKind(),
      force: Boolean(options.force)
    }).then((response) => {
      if (!response?.ok) throw new Error(response?.error || "Could not run passive arena check.");
      return response.results || [];
    });
  }

  function rememberCurrentListUrl(url = root.location?.href || "") {
    if (!ARENA.isArenaPageUrl(url)) return Promise.resolve("");
    return Promise.resolve(ARENA.arenaKindFromUrl(url));
  }

  function bootPassive() {
    if (!isGladiatusGamePage(root.location?.href || "")) return;
    bootStatusBox();
    root.clearTimeout(passiveBootTimer);
    passiveBootTimer = root.setTimeout(() => {
      runPassiveCheck().catch((error) => {
        console.warn("Passive arena scan trigger failed.", error);
      });
    }, PASSIVE_BOOT_DELAY_MS);
  }

  function bootStatusBox() {
    if (!shouldRenderStatusBox()) {
      root.document?.getElementById?.(STATUS_BOX_ID)?.remove();
      return;
    }

    const boot = () => {
      ensureStatusBox();
      subscribeToStatusChanges();
      refreshStatusBox().catch(() => {});
    };

    if (root.document?.readyState === "loading") {
      root.document.addEventListener("DOMContentLoaded", boot, { once: true });
    } else {
      root.setTimeout(boot, 0);
    }
  }

  function shouldRenderStatusBox(url = root.location?.href || "") {
    return isGladiatusGamePage(url);
  }

  async function refreshStatusBox() {
    if (!shouldRenderStatusBox() || !chrome.storage?.local) return;
    const stored = await chrome.storage.local.get(ARENA.scanStatusStorageKey);
    renderStatusBox(stored[ARENA.scanStatusStorageKey]);
  }

  function h(tag, props, ...children) {
    const el = root.document.createElement(tag);
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

  function ensureStatusBox() {
    if (!shouldRenderStatusBox()) return null;
    const existing = root.document?.getElementById?.(STATUS_BOX_ID);
    if (existing) return existing;

    const panel = h("div", {
      id: STATUS_BOX_ID,
      ariaLive: "polite",
      ariaLabel: "Arena and Circus scan status",
      style: { position: "relative" }
    });
    if (!insertStatusBox(panel)) return null;
    return panel;
  }

  function insertStatusBox(panel) {
    const menu = findMenuAnchor();
    if (menu?.parentElement) {
      menu.after(panel);
      return true;
    }

    return false;
  }

  function findMenuAnchor() {
    const byText = findMenuAnchorByText();
    if (byText) return byText;

    const selectors = ["#mainmenu", ".mainmenu", "#menu", ".menu", "nav", "#submenu", ".submenu"];
    for (const selector of selectors) {
      const elements = root.document.querySelectorAll(selector);
      for (const element of elements) {
        if (element.closest && !element.closest("#mmoNetbar, #mmoNetbarSubmenu")) return element;
      }
    }
    return null;
  }

  function findMenuAnchorByText() {
    const candidates = Array.from(root.document.querySelectorAll("div, td, nav, ul"));
    return candidates
      .filter((element) => menuScore(element) >= 3)
      .sort((a, b) => a.textContent.length - b.textContent.length)[0] || null;
  }

  function menuScore(element) {
    const text = String(element?.textContent || "").replace(/\s+/g, " ").toLowerCase();
    return ["overview", "pantheon", "guild", "high score", "recruiting"]
      .reduce((score, label) => score + (text.includes(label) ? 1 : 0), 0);
  }

  function subscribeToStatusChanges() {
    if (!chrome.storage?.onChanged || root.__GladiatusArenaStatusBoxListener) return;
    root.__GladiatusArenaStatusBoxListener = (changes, areaName) => {
      if (areaName !== "local" || !changes[ARENA.scanStatusStorageKey]) return;
      renderStatusBox(changes[ARENA.scanStatusStorageKey].newValue);
    };
    chrome.storage.onChanged.addListener(root.__GladiatusArenaStatusBoxListener);
  }

  let isStatusBoxCollapsed = root.sessionStorage?.getItem("glad-arena-passive-collapsed") === "true";

  function renderStatusBox(rawStatus) {
    if (!shouldRenderStatusBox()) return;
    const panel = ensureStatusBox();
    if (!panel) return;

    root.__GladArenaLastRawStatus = rawStatus;
    const status = normalizeStatusCache(rawStatus);

    const toggleCollapse = () => {
      isStatusBoxCollapsed = !isStatusBoxCollapsed;
      try { root.sessionStorage?.setItem("glad-arena-passive-collapsed", String(isStatusBoxCollapsed)); } catch (e) {}
      renderStatusBox(root.__GladArenaLastRawStatus);
    };

    if (isStatusBoxCollapsed) {
      let overallState = "ready";
      if (status.single.state === "error" || status.team.state === "error") overallState = "error";
      else if (status.single.state === "scanning" || status.team.state === "scanning" || status.single.state === "checking" || status.team.state === "checking") overallState = "scanning";

      const pseudoRecord = { state: overallState };

      const headerDiv = h("div", { 
        style: { display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", padding: "2px 0" },
        onclick: toggleCollapse
      }, 
        h("div", { style: { display: "flex", alignItems: "center", gap: "6px" } },
          h("strong", { style: { color: "var(--glad-border-focus)", fontSize: "11px", textTransform: "uppercase" }, textContent: "SCANNER" }),
          h("div", { className: `glad-arena-passive-status-${overallState}`, style: { display: "flex", margin: 0, padding: 0 } }, 
            h("span", { className: "glad-arena-passive-status-badge", textContent: statusBadgeText(pseudoRecord) })
          )
        ),
        h("span", { style: { color: "var(--glad-text-muted)", fontSize: "10px" }, textContent: "▼" })
      );
      panel.replaceChildren(headerDiv);
      return;
    }

    const headerDiv = h("div", { 
      style: { position: "absolute", top: "4px", right: "6px", cursor: "pointer", zIndex: 10 },
      onclick: toggleCollapse
    }, 
      h("span", { style: { color: "var(--glad-text-muted)", fontSize: "12px", padding: "4px" }, textContent: "▲" })
    );

    panel.replaceChildren(headerDiv, ...STATUS_KINDS.map((kind) => renderStatusRow(kind, status[kind])));
  }

  function renderStatusRow(kind, record) {
    const isScanning = record.state === "scanning" && record.profileTotal > 0;
    const progressPercent = isScanning ? Math.min(100, Math.round((record.profileDone / record.profileTotal) * 100)) : 0;

    return h("div", { className: `glad-arena-passive-status-row glad-arena-passive-status-${record.state}` },
      h("strong", { textContent: kind === "team" ? "Circus" : "Arena" }),
      h("span", { className: "glad-arena-passive-status-badge", textContent: statusBadgeText(record) }),
      h("span", { className: "glad-arena-passive-status-message", textContent: statusText(kind, record) }),
      isScanning ? h("div", { className: "glad-arena-progress-container" }, 
        h("div", { className: "glad-arena-progress-bar", style: { width: `${progressPercent}%` } })
      ) : null
    );
  }

  function normalizeStatusCache(status) {
    const source = status && typeof status === "object" ? status : {};
    return {
      single: normalizeStatusRecord(source.single, "single"),
      team: normalizeStatusRecord(source.team, "team")
    };
  }

  function normalizeStatusRecord(record, kind) {
    const source = record && typeof record === "object" ? record : {};
    return {
      kind,
      state: String(source.state || "unknown"),
      message: String(source.message || ""),
      updatedAt: String(source.updatedAt || ""),
      checkedAt: String(source.checkedAt || ""),
      scannedAt: String(source.scannedAt || ""),
      opponentDone: ARENA.parseInteger(source.opponentDone),
      opponentTotal: ARENA.parseInteger(source.opponentTotal),
      profileDone: ARENA.parseInteger(source.profileDone),
      profileTotal: ARENA.parseInteger(source.profileTotal),
      lastError: String(source.lastError || "")
    };
  }

  function statusText(kind, record) {
    if (record.state === "scanning") {
      if (isStaleStatus(record)) return "Previous scan stale - next trigger will retry";
      if (record.profileTotal) {
        return `Profiles ${record.profileDone}/${record.profileTotal} - opponents ${record.opponentDone}/${record.opponentTotal}`;
      }
      return cleanStatusMessage(record.message || "Scan in progress");
    }

    if (record.state === "checking") return cleanStatusMessage(record.message || "Checking opponent list");

    if (record.state === "ready") {
      return cleanStatusMessage(record.message || "Ready");
    }

    if (record.state === "error") {
      return record.lastError
        ? `${cleanStatusMessage(record.message || "Error")} - ${shortError(record.lastError)}`
        : cleanStatusMessage(record.message || "Error");
    }

    if (record.state === "skipped") return cleanStatusMessage(record.message || "Skipped");

    return kind === "team" ? "No Circus list URL yet" : "No Arena list URL yet";
  }

  function statusBadgeText(record) {
    if (record.state === "ready") return "Ready";
    if (record.state === "checking") return "Check";
    if (record.state === "scanning") return "Run";
    if (record.state === "error") return "Error";
    if (record.state === "skipped") return "Skip";
    return "Idle";
  }

  function cleanStatusMessage(message) {
    return String(message || "")
      .replace(/^Ready,\s*/i, "")
      .replace(/^Checked opponent list:\s*/i, "List: ")
      .replace(/^Checking Arena scan cache$/i, "Checking cache")
      .replace(/^Checking Circus scan cache$/i, "Checking cache")
      .replace(/^Scan already running$/i, "Scan in progress")
      .trim() || "Ready";
  }

  function isStaleStatus(record) {
    if (record.state !== "scanning") return false;
    const timestamp = Date.parse(record.updatedAt || "");
    return Number.isFinite(timestamp) && Date.now() - timestamp > 5 * 60 * 1000;
  }

  function formatAge(isoDate) {
    const timestamp = Date.parse(isoDate || "");
    if (!Number.isFinite(timestamp)) return "";
    const elapsed = Math.max(0, Date.now() - timestamp);
    const minutes = Math.floor(elapsed / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h`;
  }

  function shortError(message) {
    const text = String(message || "").replace(/\s+/g, " ").trim();
    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
  }

  function serializeEntries(entries) {
    return Array.isArray(entries)
      ? entries.map((entry, index) => ({
        opponent: {
          ...(entry?.opponent || entry || {}),
          rowIndex: ARENA.parseInteger(entry?.opponent?.rowIndex ?? entry?.rowIndex ?? index)
        }
      })).filter((entry) => entry.opponent.profileUrl)
      : [];
  }

  function arenaFormulaFingerprint(rawFormula) {
    return JSON.stringify(ARENA.normalizeArenaFormula(rawFormula) || ARENA.defaultArenaFormula());
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }
        resolve(response);
      });
    });
  }

  root.GladiatusArenaScanner = {
    arenaFormulaFingerprint,
    bootPassive,
    checkIntervalMs: LIST_CHECK_INTERVAL_MS,
    fullScanQuietMs: FULL_SCAN_QUIET_MS,
    getCachedResultForCurrentPage,
    getCachedResultForEntries,
    ensureScanForCurrentPage,
    ensureScanForEntries,
    passiveScansStorageKey: ARENA.passiveScansStorageKey,
    scanStatusStorageKey: ARENA.scanStatusStorageKey,
    rememberCurrentListUrl,
    runPassiveCheck,
    scanCurrentPage
  };

  bootPassive();
})();
