(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : self;
  const ARENA = root.GladiatusArenaCore;

  if (!ARENA || root.GladiatusArenaBackgroundScanner) return;

  const POPUP_STATE_KEY = "glad-ah-popup-state-v1";
  const FULL_SCAN_QUIET_MS = 10 * 60 * 1000;
  const LIST_CHECK_INTERVAL_MS = 3 * 60 * 1000;
  const LOCK_TIMEOUT_MS = 5 * 60 * 1000;
  const MANUAL_SCAN_DELAY_MS = 150;
  const PASSIVE_SCAN_DELAY_MS = 900;
  const RETRYABLE_PROFILE_STATUSES = new Set([429, 500, 502, 503, 504]);
  const LOG_PREFIX = "[Gladiatus Background Scanner]";
  const KINDS = ["team", "single"];

  function isGladiatusGamePage(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname.endsWith(".gladiatus.gameforge.com")
        && parsed.pathname.startsWith("/game/");
    } catch {
      return false;
    }
  }

  function currentArenaKind(url) {
    return ARENA.isArenaPageUrl(url || "") ? ARENA.arenaKindFromUrl(url) : "";
  }

  function orderedKinds(url = "", preferredKind = "") {
    const first = KINDS.includes(preferredKind) ? preferredKind : currentArenaKind(url);
    const order = first ? [first, ...KINDS.filter((kind) => kind !== first)] : ["team", "single"];
    return order.filter((kind, index) => order.indexOf(kind) === index);
  }

  function arenaListCandidates(kind, currentUrl = "", storedUrl = "") {
    if (storedUrl) return [storedUrl];

    return kind === "team"
      ? [
        buildArenaListUrl(currentUrl, { submod: "grouparena" }),
        buildArenaListUrl(currentUrl, { submod: "serverArena", aType: "3" })
      ].filter(Boolean)
      : [
        buildArenaListUrl(currentUrl, {}),
        buildArenaListUrl(currentUrl, { submod: "serverArena", aType: "2" })
      ].filter(Boolean);
  }

  function buildArenaListUrl(currentUrl, options) {
    try {
      const source = new URL(currentUrl || "");
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

  async function passiveCheck({ url = "", preferredKind = "", force = false } = {}) {
    if (!isGladiatusGamePage(url)) return [];

    log("passive check starting", { url: safeUrl(url) });
    await rememberListUrl(url);
    const formula = await loadSelectedFormula();
    const results = [];

    for (const kind of orderedKinds(url, preferredKind)) {
      results.push(await checkPassiveKind(kind, formula, { url, force }));
    }

    log("passive check finished", { results });
    return results;
  }

  async function ensureVisibleScan({ url = "", entries = [], formula = null } = {}) {
    const kind = currentArenaKind(url) || entries[0]?.opponent?.arenaKind || "single";
    await rememberListUrl(url);
    const ensured = await ensureScanForEntries(normalizeEntries(entries), formula || await loadSelectedFormula(), {
      kind,
      listUrl: url,
      sourceUrl: url,
      checkedAt: new Date().toISOString(),
      delayMs: MANUAL_SCAN_DELAY_MS,
      acquireLock: true,
      scanSource: "visible",
      updateLastResult: true
    });
    return ensured.result;
  }

  async function forceScan({ url = "", entries = [], formula = null } = {}) {
    const kind = currentArenaKind(url) || entries[0]?.opponent?.arenaKind || "single";
    await rememberListUrl(url);
    const ensured = await ensureScanForEntries(normalizeEntries(entries), formula || await loadSelectedFormula(), {
      force: true,
      kind,
      listUrl: url,
      sourceUrl: url,
      delayMs: MANUAL_SCAN_DELAY_MS,
      acquireLock: true,
      scanSource: "manual",
      updateLastResult: true
    });
    return ensured.result;
  }

  async function checkPassiveKind(kind, formula, options = {}) {
    log("checking scan cache", { kind });
    const cache = await loadPassiveCache();
    const record = cache[kind] || {};
    const candidates = arenaListCandidates(kind, options.url || "", record.listUrl);
    log("arena list candidates", { kind, urls: candidates.map(safeUrl), stored: Boolean(record.listUrl) });
    if (!candidates.length) return { kind, skipped: "missing-url" };

    const now = Date.now();
    const scannedAt = Date.parse(record.scannedAt || record.result?.scannedAt || "");
    const checkedAt = Date.parse(record.checkedAt || "");
    if (!options.force && record.result && Number.isFinite(scannedAt) && now - scannedAt < FULL_SCAN_QUIET_MS) {
      log("skip scan; full scan is still inside quiet period", { kind, scannedAt: record.scannedAt || record.result?.scannedAt });
      return { kind, skipped: "quiet" };
    }
    if (!options.force && Number.isFinite(checkedAt) && now - checkedAt < LIST_CHECK_INTERVAL_MS) {
      log("skip list check; checked recently", { kind, checkedAt: record.checkedAt });
      return { kind, skipped: "fresh" };
    }

    const lockId = await acquirePassiveLock(kind, now);
    if (!lockId) {
      log("skip scan; another scan is in flight", { kind });
      return { kind, skipped: "locked" };
    }

    try {
      let lastError = "";
      for (const listUrl of candidates) {
        try {
          log("fetch arena page", { kind, url: safeUrl(listUrl) });
          const html = await fetchArenaListHtml(listUrl);
          const entries = readArenaOpponentEntriesFromHtml(html, listUrl);
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
            updateLastResult: currentArenaKind(options.url) === kind
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

  async function ensureScanForEntries(entries, rawFormula, options = {}) {
    if (!entries?.length) return { result: null, skipped: "empty" };

    const formula = ARENA.normalizeArenaFormula(rawFormula) || ARENA.defaultArenaFormula();
    const kind = options.kind || entries[0]?.opponent?.arenaKind || "single";
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
    const arenaKind = options.arenaKind || entries[0]?.opponent?.arenaKind || "single";
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
    const character = parseCharacterFromHtml(html, {
      ...entry.opponent,
      role: "duel",
      roleLabel: ARENA.roleSectionLabels.duel
    });
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
    const tabs = teamDollTabs(readProfileDollTabsFromHtml(html, entry.opponent.profileUrl));
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
      characters.push(parseCharacterFromHtml(dollHtml, {
        ...entry.opponent,
        profileUrl: tab.url,
        doll: tab.doll,
        role: tab.role,
        roleLabel: tab.roleLabel
      }));
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

  function readArenaOpponentEntriesFromHtml(html, baseUrl = "") {
    const rows = [];
    const content = String(html || "");
    const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    for (const match of content.matchAll(rowPattern)) {
      const rowHtml = match[1];
      const link = readPlayerLink(rowHtml);
      const attack = readAttack(rowHtml);
      if (!link.href || !attack.onclick) continue;

      rows.push({
        opponent: readOpponentFromHtmlRow(rowHtml, link, attack, rows.length, baseUrl)
      });
    }
    return rows;
  }

  function readPlayerLink(rowHtml) {
    for (const match of String(rowHtml || "").matchAll(/<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
      const href = decodeHtml(match[2] || "");
      if (href.includes("mod=player") && href.includes("p=")) {
        return {
          href,
          text: stripMarkup(match[3] || "")
        };
      }
    }
    return { href: "", text: "" };
  }

  function readAttack(rowHtml) {
    for (const tagMatch of String(rowHtml || "").matchAll(/<[^>]+>/g)) {
      const tag = tagMatch[0];
      const className = readHtmlAttribute(tag, "class");
      const onclick = readHtmlAttribute(tag, "onclick");
      if (/\battack\b/.test(className) && onclick) return { onclick: decodeHtml(onclick) };
    }
    return { onclick: "" };
  }

  function readOpponentFromHtmlRow(rowHtml, link, attack, rowIndex, baseUrl) {
    const profileUrl = new URL(link.href, baseUrl || "").href;
    const profile = new URL(profileUrl);
    const cells = Array.from(String(rowHtml || "").matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi))
      .map((cell) => stripMarkup(cell[1] || ""));
    const fightArgs = ARENA.parseFightArgs(attack.onclick);
    const arenaKind = fightArgs.arenaKind || ARENA.arenaKindFromUrl(baseUrl || "");

    return {
      rowIndex,
      arenaKind,
      id: profile.searchParams.get("p") || fightArgs.playerId || "",
      name: link.text.trim(),
      level: ARENA.parseInteger(cells[1]),
      province: String(ARENA.parseInteger(cells[2]) || fightArgs.province || provinceFromHost(profile.hostname) || ""),
      language: profile.searchParams.get("language") || fightArgs.language || "",
      profileUrl
    };
  }

  function parseCharacterFromHtml(html, meta = {}) {
    const activeDoll = readActiveDollMeta(html, meta.profileUrl);
    const stat = (id) => ARENA.parseInteger(textById(html, id));
    const damage = ARENA.parseDamageRange(textById(html, "char_schaden"));
    const name = textByClass(html, "playername").trim() || meta.name || activeDoll.name;
    const level = stat("char_level") || meta.level;

    return new ARENA.ArenaCharacter({
      ...meta,
      name,
      level,
      doll: meta.doll || activeDoll.doll,
      role: meta.role || activeDoll.role,
      roleLabel: meta.roleLabel || activeDoll.roleLabel,
      stats: {
        level,
        strength: stat("char_f0"),
        dexterity: stat("char_f1"),
        agility: stat("char_f2"),
        constitution: stat("char_f3"),
        charisma: stat("char_f4"),
        intelligence: stat("char_f5"),
        armour: stat("char_panzer"),
        healing: stat("char_healing"),
        ...damage
      }
    }).toJSON();
  }

  function readActiveDollMeta(html, baseUrl = "") {
    const active = readProfileDollTabsFromHtml(html, baseUrl).find((tab) => tab.active);
    return active || { doll: 0, role: "duel", roleLabel: ARENA.roleSectionLabels.duel, name: "" };
  }

  function readProfileDollTabsFromHtml(html, baseUrl = "") {
    const source = String(html || "");
    const tabs = [];
    const matches = Array.from(source.matchAll(/charmercsel/g));
    for (let index = 0; index < matches.length; index += 1) {
      const position = matches[index].index || 0;
      const start = source.lastIndexOf("<", position);
      const next = index + 1 < matches.length ? matches[index + 1].index || source.length : source.length;
      const chunk = source.slice(Math.max(0, start), next);
      const startTag = chunk.slice(0, Math.max(0, chunk.indexOf(">") + 1));
      const rawUrl = String(readHtmlAttribute(startTag, "onclick") || readHtmlAttribute(chunk, "onclick"))
        .match(/selectDoll\(['"]([^'"]+)['"]\)/)?.[1]
        ?.replaceAll("&amp;", "&") || "";
      const url = rawUrl ? absoluteUrl(decodeHtml(rawUrl), baseUrl) : "";
      const rawTooltip = readHtmlAttribute(chunk, "data-tooltip");
      const tooltipText = tooltipToText(rawTooltip);
      const role = ARENA.parseRoleFromTooltipText(tooltipText);
      const doll = ARENA.parseInteger(url ? new URL(url).searchParams.get("doll") : "") || index + 1;

      if (url) {
        tabs.push({
          doll,
          url,
          tooltip: rawTooltip,
          tooltipText,
          role,
          roleLabel: ARENA.roleSectionLabels[role] || ARENA.roleSectionLabels.duel,
          active: /\bactive\b/.test(readHtmlAttribute(startTag, "class"))
        });
      }
    }
    return tabs;
  }

  function teamDollTabs(tabs) {
    return (tabs || []).filter((tab) => tab.doll >= 2 && tab.doll <= 6);
  }

  async function rememberListUrl(url = "") {
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

  async function loadSelectedFormula() {
    const result = await chrome.storage.local.get([ARENA.formulasStorageKey, POPUP_STATE_KEY]);
    const storedFormulas = ARENA.normalizeArenaFormulas(result[ARENA.formulasStorageKey]);
    const formulas = storedFormulas.length ? storedFormulas : [ARENA.defaultArenaFormula()];
    const enabled = formulas.filter((formula) => formula.enabled);
    const available = enabled.length ? enabled : formulas;
    const selectedFormulaId = String(result[POPUP_STATE_KEY]?.arenaFormulaId || "");
    return available.find((formula) => formula.id === selectedFormulaId) || available[0] || ARENA.defaultArenaFormula();
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
    log(acquired ? "acquired scan lock" : "failed to acquire scan lock", { kind });
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

  async function saveLastResult(result) {
    await chrome.storage.local.set({ [ARENA.resultsStorageKey]: result });
  }

  function normalizeEntries(entries) {
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

  async function fetchProfileHtml(url) {
    return fetchGladiatusHtml(normalizeProfileUrl(url), "Profile");
  }

  async function fetchArenaListHtml(url) {
    return fetchGladiatusHtml(normalizeArenaListUrl(url), "Arena list");
  }

  async function fetchGladiatusHtml(url, label) {
    let lastStatus = 0;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      log(`${label} fetch attempt`, { attempt: attempt + 1, url: safeUrl(url.href) });
      const response = await fetch(url.href, { credentials: "include" });
      if (response.ok) {
        log(`${label} fetch HTTP ok`, { attempt: attempt + 1, url: safeUrl(url.href), status: response.status });
        return response.text();
      }

      lastStatus = response.status;
      log(`${label} fetch HTTP failed`, { attempt: attempt + 1, url: safeUrl(url.href), status: response.status });
      if (!RETRYABLE_PROFILE_STATUSES.has(response.status) || attempt === 3) {
        throw new Error(`${label} fetch failed with HTTP ${response.status}.`);
      }

      await delay(500 * (attempt + 1));
    }

    throw new Error(`${label} fetch failed with HTTP ${lastStatus || "unknown"}.`);
  }

  function normalizeProfileUrl(rawUrl) {
    const url = new URL(String(rawUrl || ""));
    if (url.protocol !== "https:") throw new Error("Only HTTPS Gladiatus profile URLs can be fetched.");
    if (!url.hostname.endsWith(".gladiatus.gameforge.com")) throw new Error("Only Gladiatus profile URLs can be fetched.");
    if (!url.pathname.endsWith("/game/index.php") || url.searchParams.get("mod") !== "player") {
      throw new Error("Only Gladiatus player profiles can be fetched.");
    }
    return url;
  }

  function normalizeArenaListUrl(rawUrl) {
    const url = new URL(String(rawUrl || ""));
    if (url.protocol !== "https:") throw new Error("Only HTTPS Gladiatus arena URLs can be fetched.");
    if (!url.hostname.endsWith(".gladiatus.gameforge.com")) throw new Error("Only Gladiatus arena URLs can be fetched.");
    if (!url.pathname.endsWith("/game/index.php") || url.searchParams.get("mod") !== "arena") {
      throw new Error("Only Gladiatus arena pages can be fetched.");
    }
    return url;
  }

  function textById(html, id) {
    const pattern = new RegExp(`<([a-zA-Z0-9]+)\\b[^>]*\\bid\\s*=\\s*(["'])${escapeRegExp(id)}\\2[^>]*>([\\s\\S]*?)<\\/\\1>`, "i");
    return stripMarkup(String(html || "").match(pattern)?.[3] || "");
  }

  function textByClass(html, className) {
    const pattern = new RegExp(`<([a-zA-Z0-9]+)\\b[^>]*\\bclass\\s*=\\s*(["'])[^"']*\\b${escapeRegExp(className)}\\b[^"']*\\2[^>]*>([\\s\\S]*?)<\\/\\1>`, "i");
    return stripMarkup(String(html || "").match(pattern)?.[3] || "");
  }

  function readHtmlAttribute(value, attribute) {
    const pattern = new RegExp(`${attribute}\\s*=\\s*("|')([\\s\\S]*?)\\1`, "i");
    return decodeHtml(String(value || "").match(pattern)?.[2] || "");
  }

  function tooltipToText(rawTooltip) {
    const values = [];
    try {
      collectStrings(JSON.parse(decodeHtml(String(rawTooltip || ""))), values);
    } catch {
      values.push(decodeHtml(String(rawTooltip || "")));
    }
    return stripMarkup(values.join(" "));
  }

  function collectStrings(value, output) {
    if (Array.isArray(value)) {
      value.forEach((entry) => collectStrings(entry, output));
      return;
    }
    if (typeof value === "string") output.push(value);
  }

  function stripMarkup(value) {
    return decodeHtml(String(value || "")
      .replace(/\\\//g, "/")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]*>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
  }

  function decodeHtml(value) {
    return String(value || "")
      .replace(/&quot;/g, "\"")
      .replace(/&#0?39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code) || 0));
  }

  function absoluteUrl(value, baseUrl) {
    try {
      return new URL(value, baseUrl || "").href;
    } catch {
      return "";
    }
  }

  function provinceFromHost(hostname) {
    return String(hostname || "").match(/^s(\d+)-/)?.[1] || "";
  }

  function escapeRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

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

  root.GladiatusArenaBackgroundScanner = {
    arenaFormulaFingerprint,
    arenaListCandidates,
    ensureScanForEntries,
    ensureVisibleScan,
    fetchArenaListHtml,
    fetchProfileHtml,
    forceScan,
    fullScanQuietMs: FULL_SCAN_QUIET_MS,
    listCheckIntervalMs: LIST_CHECK_INTERVAL_MS,
    parseCharacterFromHtml,
    passiveCheck,
    readArenaOpponentEntriesFromHtml,
    readProfileDollTabsFromHtml,
    scanEntries
  };
})();
