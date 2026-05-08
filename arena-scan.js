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
    return response.result || null;
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
      skipped: response.result ? "" : "empty"
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
    root.clearTimeout(passiveBootTimer);
    passiveBootTimer = root.setTimeout(() => {
      runPassiveCheck().catch((error) => {
        console.warn("Passive arena scan trigger failed.", error);
      });
    }, PASSIVE_BOOT_DELAY_MS);
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
    rememberCurrentListUrl,
    runPassiveCheck,
    scanCurrentPage
  };

  bootPassive();
})();
