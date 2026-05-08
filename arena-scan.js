(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : window;
  const ARENA = root.GladiatusArenaCore;
  const SCHEMA = root.GladiatusAuctionSchema;

  if (!ARENA || typeof chrome === "undefined" || !chrome.runtime?.sendMessage || !chrome.storage?.local) return;

  if (root.GladiatusArenaScanner) {
    root.GladiatusArenaScanner.bootPassive?.();
    return;
  }

  const POPUP_STATE_KEY = SCHEMA?.storageKeys?.popupState || "glad-ah-popup-state-v1";
  const FULL_SCAN_QUIET_MS = 10 * 60 * 1000;
  const LIST_CHECK_INTERVAL_MS = 3 * 60 * 1000;
  const LOCK_TIMEOUT_MS = 5 * 60 * 1000;
  const PASSIVE_BOOT_DELAY_MS = 1200;
  const MANUAL_SCAN_DELAY_MS = 150;
  const PASSIVE_SCAN_DELAY_MS = 900;
  const LOG_PREFIX = "[Gladiatus Arena Scanner]";
  const KINDS = ["team", "single"];
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

  function orderedKinds(preferredKind = "") {
    const first = KINDS.includes(preferredKind) ? preferredKind : currentArenaKind();
    const order = first ? [first, ...KINDS.filter((kind) => kind !== first)] : ["team", "single"];
    return order.filter((kind, index) => order.indexOf(kind) === index);
  }

  function arenaListCandidates(kind, storedUrl = "") {
    if (storedUrl) return [storedUrl];

    return kind === "team"
      ? [
        buildArenaListUrl({ submod: "grouparena" }),
        buildArenaListUrl({ submod: "serverArena", aType: "3" })
      ].filter(Boolean)
      : [
        buildArenaListUrl({}),
        buildArenaListUrl({ submod: "serverArena", aType: "2" })
      ].filter(Boolean);
  }

  function buildArenaListUrl(options) {
    try {
      const source = new URL(root.location?.href || "");
      const url = new URL("/game/index.php", source.href);
      const sh = source.searchParams.get("sh");
      url.search = "";
      url.searchParams.set("mod", "arena");
      if (options.submod) url.searchParams.set("submod", options.submod);
      if (options.aType) url.searchParams.set("aType", options.aType);
      if (sh) url.searchParams.set("sh", sh);
      return url.href;
    } catch {
      return "";
    }
  }

  async function scanCurrentPage(rawFormula, options = {}) {
    if (!ARENA.isArenaPageUrl(root.location?.href || "")) {
      throw new Error("Open a Gladiatus arena page before scanning opponents.");
    }

    log("manual scan requested", { url: safeUrl(root.location.href) });
    const formula = rawFormula ? ARENA.normalizeArenaFormula(rawFormula) : await loadSelectedFormula();
    const normalizedFormula = formula || ARENA.defaultArenaFormula();
    const entries = ARENA.readArenaOpponentEntries(root.document, root.location.href);
    log("read visible opponent list", { count: entries.length, kind: ARENA.arenaKindFromUrl(root.location.href) });
    if (!entries.length) throw new Error("Could not find arena opponent rows.");

    const kind = ARENA.arenaKindFromUrl(root.location.href);
    const ensured = await ensureScanForEntries(entries, normalizedFormula, {
      force: true,
      kind,
      listUrl: root.location.href,
      sourceUrl: root.location.href,
      delayMs: MANUAL_SCAN_DELAY_MS,
      acquireLock: true,
      scanSource: "manual"
    });

    if (options.updateListUrl !== false) await rememberCurrentListUrl(root.location.href);
    log("manual scan finished", { kind, opponents: ensured.result?.opponentCount || 0, failed: ensured.result?.failedCount || 0 });
    return ensured.result;
  }

  async function ensureScanForCurrentPage(rawFormula, options = {}) {
    if (!ARENA.isArenaPageUrl(root.location?.href || "")) return null;
    const entries = ARENA.readArenaOpponentEntries(root.document, root.location.href);
    const ensured = await ensureScanForEntries(entries, rawFormula, {
      ...options,
      kind: ARENA.arenaKindFromUrl(root.location.href),
      listUrl: root.location.href,
      sourceUrl: root.location.href,
      delayMs: Number(options.delayMs) || PASSIVE_SCAN_DELAY_MS,
      acquireLock: options.acquireLock !== false,
      scanSource: options.scanSource || "visible"
    });
    return ensured.result;
  }

  async function ensureScanForEntries(entries, rawFormula, options = {}) {
    if (!entries?.length) return { result: null, skipped: "empty" };

    const formula = ARENA.normalizeArenaFormula(rawFormula) || ARENA.defaultArenaFormula();
    const kind = options.kind || entries[0]?.opponent?.arenaKind || currentArenaKind() || "single";
    const fingerprint = options.fingerprint || ARENA.arenaOpponentFingerprint(entries);
    const formulaKey = arenaFormulaFingerprint(formula);
    const cache = await loadPassiveCache();
    const record = cache[kind] || {};
    const listUrl = options.listUrl || record.listUrl || options.sourceUrl || "";
    const checkedAt = options.checkedAt || new Date().toISOString();

    if (!options.force
      && record.result
      && record.fingerprint === fingerprint
      && record.formulaFingerprint === formulaKey) {
      if (options.updateCacheOnMatch || options.checkedAt) {
        await saveCachedResult(kind, {
          listUrl,
          checkedAt,
          fingerprint,
          formulaFingerprint: formulaKey,
          lastError: ""
        });
      }
      if (options.updateLastResult !== false) await saveLastResult(record.result);
      log("scan data already matches opponent list", { kind, source: options.scanSource || "unknown", count: entries.length });
      return { result: record.result, skipped: "unchanged" };
    }

    if (options.scanIfMissing === false) {
      log("no matching cached scan for opponent list", { kind, source: options.scanSource || "unknown", count: entries.length });
      return { result: null, skipped: "missing" };
    }

    let lockId = options.lockId || "";
    let ownsLock = false;
    if (options.acquireLock && !lockId) {
      lockId = await acquirePassiveLock(kind);
      ownsLock = Boolean(lockId);
      if (!lockId) return { result: null, skipped: "locked" };
    }

    try {
      log("opponent list changed or no scan exists; commence scanning", { kind, source: options.scanSource || "unknown", count: entries.length });
      const result = await scanEntries(entries, formula, {
        arenaKind: kind,
        sourceUrl: options.sourceUrl || listUrl,
        fingerprint,
        delayMs: Number(options.delayMs) || PASSIVE_SCAN_DELAY_MS
      });
      await saveCachedResult(kind, {
        listUrl,
        checkedAt,
        scannedAt: result.scannedAt,
        fingerprint,
        formulaFingerprint: formulaKey,
        result,
        lastError: ""
      });
      if (options.updateLastResult !== false) await saveLastResult(result);
      log("saved scan result", { kind, source: options.scanSource || "unknown", opponents: result.opponentCount, failed: result.failedCount });
      return { result, scanned: true };
    } finally {
      if (ownsLock) await releasePassiveLock(kind, lockId, (current) => current);
    }
  }

  async function scanEntries(entries, rawFormula, options = {}) {
    const formula = ARENA.normalizeArenaFormula(rawFormula) || ARENA.defaultArenaFormula();
    const arenaKind = options.arenaKind || entries[0]?.opponent?.arenaKind || currentArenaKind() || "single";
    const fingerprint = options.fingerprint || ARENA.arenaOpponentFingerprint(entries);
    const delayMs = Number(options.delayMs) || MANUAL_SCAN_DELAY_MS;
    const opponents = [];

    log("commence profile scanning", { kind: arenaKind, count: entries.length, delayMs, sourceUrl: safeUrl(options.sourceUrl || "") });
    for (const entry of entries) {
      log("scan opponent profile", {
        kind: entry.opponent.arenaKind,
        rowIndex: entry.opponent.rowIndex,
        name: entry.opponent.name,
        profileUrl: safeUrl(entry.opponent.profileUrl)
      });
      opponents.push(await scanOpponentEntry(entry, formula, { delayMs }));
      await delay(delayMs);
    }

    const successful = opponents.filter((entry) => Number.isFinite(entry.score));
    const best = [...successful].sort((a, b) => a.score - b.score)[0] || null;

    const result = {
      scannedAt: new Date().toISOString(),
      formulaId: formula.id,
      formulaName: formula.name,
      formulaFingerprint: arenaFormulaFingerprint(formula),
      arenaKind,
      sourceUrl: options.sourceUrl || "",
      fingerprint,
      opponentCount: opponents.length,
      failedCount: opponents.filter((entry) => entry.error).length,
      bestName: best?.displayName || "",
      bestScore: best?.score || 0,
      opponents
    };
    log("profile scanning finished", { kind: arenaKind, count: result.opponentCount, failed: result.failedCount });
    return result;
  }

  async function scanOpponentEntry(entry, formula, options = {}) {
    try {
      const html = await fetchProfileHtml(entry.opponent.profileUrl);
      return entry.opponent.arenaKind === "team"
        ? await scanTeamOpponent(entry, html, formula, options)
        : scanSingleOpponent(entry, html, formula);
    } catch (error) {
      log("opponent profile scan failed", {
        name: entry.opponent.name,
        profileUrl: safeUrl(entry.opponent.profileUrl),
        error: error.message || String(error)
      });
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

  async function scanTeamOpponent(entry, html, formula, options = {}) {
    const tabs = ARENA.teamDollTabs(ARENA.readProfileDollTabsFromHtml(html, entry.opponent.profileUrl));
    log("read circus team tabs", { name: entry.opponent.name, count: tabs.length });
    if (!tabs.length) throw new Error("Could not find Circus team tabs on profile.");

    const delayMs = Number(options.delayMs) || MANUAL_SCAN_DELAY_MS;
    const characters = [];
    for (const tab of tabs) {
      log("scan circus doll", {
        name: entry.opponent.name,
        doll: tab.doll,
        role: tab.role,
        profileUrl: safeUrl(tab.url)
      });
      const dollHtml = await fetchProfileHtml(tab.url);
      characters.push(ARENA.parseCharacterFromHtml(dollHtml, {
        ...entry.opponent,
        profileUrl: tab.url,
        doll: tab.doll,
        role: tab.role,
        roleLabel: tab.roleLabel
      }).toJSON());
      await delay(delayMs);
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

  async function rememberCurrentListUrl(url = root.location?.href || "") {
    if (!ARENA.isArenaPageUrl(url)) {
      log("current page is not an arena list; using derived URLs if needed", { url: safeUrl(url) });
      return "";
    }
    const kind = ARENA.arenaKindFromUrl(url);
    await updatePassiveRecord(kind, (record) => ({
      ...record,
      listUrl: url
    }));
    log("remembered visible arena list URL", { kind, url: safeUrl(url) });
    return kind;
  }

  async function getCachedResultForCurrentPage(rawFormula, options = {}) {
    if (!ARENA.isArenaPageUrl(root.location?.href || "")) return null;
    const entries = ARENA.readArenaOpponentEntries(root.document, root.location.href);
    return getCachedResultForEntries(entries, rawFormula, options);
  }

  async function getCachedResultForEntries(entries, rawFormula, options = {}) {
    const ensured = await ensureScanForEntries(entries, rawFormula || await loadSelectedFormula(), {
      ...options,
      scanIfMissing: false,
      scanSource: "cache"
    });
    return ensured.result;
  }

  async function runPassiveCheck(options = {}) {
    if (!isGladiatusGamePage(root.location?.href || "")) return [];

    log("passive check starting", { url: safeUrl(root.location?.href || "") });
    await rememberCurrentListUrl(root.location?.href || "");
    const formula = await loadSelectedFormula();
    const results = [];

    for (const kind of orderedKinds(options.preferredKind)) {
      results.push(await checkPassiveKind(kind, formula, options));
    }

    log("passive check finished", { results });
    return results;
  }

  async function checkPassiveKind(kind, formula, options = {}) {
    log("checking scan cache", { kind });
    const cache = await loadPassiveCache();
    const record = cache[kind] || {};
    const candidates = arenaListCandidates(kind, record.listUrl);
    log("arena list candidates", { kind, urls: candidates.map(safeUrl), stored: Boolean(record.listUrl) });
    if (!candidates.length) {
      log("no arena list URL available", { kind });
      return { kind, skipped: "missing-url" };
    }

    const now = Date.now();
    const scannedAt = Date.parse(record.scannedAt || record.result?.scannedAt || "");
    const checkedAt = Date.parse(record.checkedAt || "");
    if (!options.force && record.result && Number.isFinite(scannedAt) && now - scannedAt < FULL_SCAN_QUIET_MS) {
      log("skip scan; full scan is still inside quiet period", { kind, scannedAt: record.scannedAt || record.result?.scannedAt });
      return { kind, skipped: "quiet" };
    }
    if (!options.force
      && Number.isFinite(checkedAt)
      && now - checkedAt < LIST_CHECK_INTERVAL_MS) {
      log("skip list check; checked recently", { kind, checkedAt: record.checkedAt });
      return { kind, skipped: "fresh" };
    }

    const lockId = await acquirePassiveLock(kind, now);
    if (!lockId) {
      log("skip scan; another passive scan is in flight", { kind });
      return { kind, skipped: "locked" };
    }

    try {
      let lastError = "";
      for (const listUrl of candidates) {
        try {
          log("fetch arena page", { kind, url: safeUrl(listUrl) });
          const html = await fetchArenaListHtml(listUrl);
          const entries = ARENA.readArenaOpponentEntriesFromHtml(html, listUrl);
          log("got player list", { kind, url: safeUrl(listUrl), count: entries.length });
          if (!entries.length) continue;

          const ensured = await ensureScanForEntries(entries, formula, {
            kind,
            listUrl,
            sourceUrl: listUrl,
            checkedAt: new Date().toISOString(),
            fingerprint: ARENA.arenaOpponentFingerprint(entries),
            delayMs: PASSIVE_SCAN_DELAY_MS,
            lockId,
            scanSource: "passive-list",
            updateLastResult: currentArenaKind() === kind
          });
          await releasePassiveLock(kind, lockId, (current) => current);
          return { kind, ...ensured };
        } catch (error) {
          lastError = error.message || String(error);
          log("arena page candidate failed", { kind, url: safeUrl(listUrl), error: lastError });
          if (record.listUrl) throw error;
        }
      }

      await releasePassiveLock(kind, lockId, (current) => ({
        ...current,
        checkedAt: new Date().toISOString(),
        lastError
      }));
      log("no opponents found in arena page candidates", { kind, lastError });
      return { kind, skipped: "no-opponents" };
    } catch (error) {
      const message = error.message || String(error);
      await releasePassiveLock(kind, lockId, (current) => ({
        ...current,
        checkedAt: new Date().toISOString(),
        lastError: message
      }));
      log("passive scan failed", { kind, error: message });
      return { kind, error: message };
    }
  }

  async function acquirePassiveLock(kind, now = Date.now()) {
    const lockId = `${now}-${Math.random().toString(36).slice(2)}`;
    const cache = await loadPassiveCache();
    const record = cache[kind] || {};
    if (isFreshLock(record.lock, now)) return "";

    cache[kind] = {
      ...record,
      lock: {
        id: lockId,
        startedAt: new Date(now).toISOString()
      }
    };
    await savePassiveCache(cache);

    const confirmed = await loadPassiveCache();
    const acquired = confirmed[kind]?.lock?.id === lockId;
    log(acquired ? "acquired passive scan lock" : "failed to acquire passive scan lock", { kind });
    return acquired ? lockId : "";
  }

  async function releasePassiveLock(kind, lockId, update) {
    await updatePassiveRecord(kind, (record) => {
      const next = typeof update === "function" ? update(record) : { ...record };
      if (next.lock?.id === lockId) {
        const { lock: _lock, ...withoutLock } = next;
        return withoutLock;
      }
      return next;
    });
  }

  function isFreshLock(lock, now = Date.now()) {
    const startedAt = Date.parse(lock?.startedAt || "");
    return Boolean(lock?.id && Number.isFinite(startedAt) && now - startedAt < LOCK_TIMEOUT_MS);
  }

  async function saveCachedResult(kind, values) {
    await updatePassiveRecord(kind, (record) => ({
      ...record,
      ...values
    }));
  }

  async function updatePassiveRecord(kind, update) {
    if (!KINDS.includes(kind)) return null;
    const cache = await loadPassiveCache();
    cache[kind] = typeof update === "function" ? update(cache[kind] || {}) : { ...(cache[kind] || {}), ...update };
    await savePassiveCache(cache);
    return cache[kind];
  }

  async function loadPassiveCache() {
    const result = await chrome.storage.local.get(ARENA.passiveScansStorageKey);
    return normalizePassiveCache(result[ARENA.passiveScansStorageKey]);
  }

  async function savePassiveCache(cache) {
    await chrome.storage.local.set({ [ARENA.passiveScansStorageKey]: normalizePassiveCache(cache) });
  }

  function normalizePassiveCache(cache) {
    const source = cache && typeof cache === "object" ? cache : {};
    return {
      single: normalizePassiveRecord(source.single),
      team: normalizePassiveRecord(source.team)
    };
  }

  function normalizePassiveRecord(record) {
    if (!record || typeof record !== "object") return {};
    return { ...record };
  }

  async function loadSelectedFormula() {
    const result = await chrome.storage.local.get([ARENA.formulasStorageKey, POPUP_STATE_KEY]);
    const storedFormulas = ARENA.normalizeArenaFormulas(result[ARENA.formulasStorageKey]);
    const formulas = storedFormulas.length ? storedFormulas : [ARENA.defaultArenaFormula()];
    const enabled = formulas.filter((formula) => formula.enabled);
    const available = enabled.length ? enabled : formulas;
    const selectedFormulaId = String(result[POPUP_STATE_KEY]?.arenaFormulaId || "");
    return available.find((formula) => formula.id === selectedFormulaId) || available[0] || ARENA.defaultArenaFormula();
  }

  function arenaFormulaFingerprint(rawFormula) {
    return JSON.stringify(ARENA.normalizeArenaFormula(rawFormula) || ARENA.defaultArenaFormula());
  }

  async function saveLastResult(result) {
    await chrome.storage.local.set({ [ARENA.resultsStorageKey]: result });
  }

  function fetchProfileHtml(url) {
    log("fetch profile html", { url: safeUrl(url) });
    return sendRuntimeMessage({ type: "GLAD_ARENA_FETCH_PROFILE", url })
      .then((response) => {
        if (!response?.ok) throw new Error(response?.error || "Could not fetch profile.");
        log("fetched profile html", { url: safeUrl(url), bytes: String(response.html || "").length });
        return response.html || "";
      });
  }

  function fetchArenaListHtml(url) {
    log("request arena list html", { url: safeUrl(url) });
    return sendRuntimeMessage({ type: "GLAD_ARENA_FETCH_LIST", url })
      .then((response) => {
        if (!response?.ok) throw new Error(response?.error || "Could not fetch arena list.");
        log("received arena list html", { url: safeUrl(url), bytes: String(response.html || "").length });
        return response.html || "";
      });
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

  function delay(milliseconds) {
    return new Promise((resolve) => root.setTimeout(resolve, milliseconds));
  }

  function bootPassive() {
    if (!isGladiatusGamePage(root.location?.href || "")) return;
    root.clearTimeout(passiveBootTimer);
    log("schedule passive check", { delayMs: PASSIVE_BOOT_DELAY_MS, url: safeUrl(root.location?.href || "") });
    passiveBootTimer = root.setTimeout(() => {
      runPassiveCheck().catch((error) => {
        console.warn("Passive arena scan failed.", error);
      });
    }, PASSIVE_BOOT_DELAY_MS);
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
    arenaListCandidates,
    rememberCurrentListUrl,
    runPassiveCheck,
    scanCurrentPage,
    scanEntries
  };

  bootPassive();

  function log(message, details = {}) {
    console.log(LOG_PREFIX, message, details);
  }

  function safeUrl(value) {
    try {
      const url = new URL(String(value || ""));
      if (url.searchParams.has("sh")) url.searchParams.set("sh", "[redacted]");
      return url.href;
    } catch {
      return String(value || "");
    }
  }
})();
