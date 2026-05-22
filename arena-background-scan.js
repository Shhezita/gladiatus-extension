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
  const SCAN_CONCURRENCY = 2;
  const CACHE_TTL_MS = 10 * 60 * 1000;
  const RETRYABLE_PROFILE_STATUSES = new Set([429, 500, 502, 503, 504]);
  const LOG_PREFIX = "[Gladiatus Background Scanner]";
  const KINDS = ["team", "single"];
  const KIND_LABELS = {
    single: "Arena",
    team: "Circus"
  };

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

  function kindLabel(kind) {
    return KIND_LABELS[kind] || kind;
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
      concurrency: SCAN_CONCURRENCY,
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
      concurrency: SCAN_CONCURRENCY,
      acquireLock: true,
      scanSource: "manual",
      updateLastResult: true
    });
    return ensured.result;
  }

  async function checkPassiveKind(kind, formula, options = {}) {
    log("checking scan cache", { kind });
    await updateScanStatus(kind, {
      state: "checking",
      source: "passive",
      message: `Checking ${kindLabel(kind)} scan cache`,
      lastError: ""
    });
    const cache = await loadPassiveCache();
    const record = cache[kind] || {};
    const candidates = arenaListCandidates(kind, options.url || "", record.listUrl);
    log("arena list candidates", { kind, urls: candidates.map(safeUrl), stored: Boolean(record.listUrl) });
    if (!candidates.length) {
      await updateScanStatus(kind, {
        state: "skipped",
        source: "passive",
        message: "No list URL yet",
        checkedAt: record.checkedAt || "",
        scannedAt: record.scannedAt || record.result?.scannedAt || "",
        lastError: ""
      });
      return { kind, skipped: "missing-url" };
    }

    const now = Date.now();
    const scannedAt = Date.parse(record.scannedAt || record.result?.scannedAt || "");
    const checkedAt = Date.parse(record.checkedAt || "");
    if (!options.force && record.result && Number.isFinite(scannedAt) && now - scannedAt < FULL_SCAN_QUIET_MS) {
      log("skip scan; full scan is still inside quiet period", { kind, scannedAt: record.scannedAt || record.result?.scannedAt });
      await updateScanStatus(kind, {
        state: "ready",
        source: "passive",
        message: "Ready, quiet phase",
        checkedAt: record.checkedAt || "",
        scannedAt: record.scannedAt || record.result?.scannedAt || "",
        opponentDone: record.result?.opponentCount || 0,
        opponentTotal: record.result?.opponentCount || 0,
        profileDone: defaultProfileTotal(kind, record.result?.opponentCount || 0),
        profileTotal: defaultProfileTotal(kind, record.result?.opponentCount || 0),
        lastError: ""
      });
      return { kind, skipped: "quiet" };
    }
    if (!options.force && Number.isFinite(checkedAt) && now - checkedAt < LIST_CHECK_INTERVAL_MS) {
      log("skip list check; checked recently", { kind, checkedAt: record.checkedAt });
      await updateScanStatus(kind, {
        state: record.result ? "ready" : "skipped",
        source: "passive",
        message: record.result ? "Ready, checked recently" : "Checked recently",
        checkedAt: record.checkedAt || "",
        scannedAt: record.scannedAt || record.result?.scannedAt || "",
        opponentDone: record.result?.opponentCount || 0,
        opponentTotal: record.result?.opponentCount || 0,
        profileDone: defaultProfileTotal(kind, record.result?.opponentCount || 0),
        profileTotal: defaultProfileTotal(kind, record.result?.opponentCount || 0),
        lastError: ""
      });
      return { kind, skipped: "fresh" };
    }

    const lockId = await acquirePassiveLock(kind, now);
    if (!lockId) {
      log("skip scan; another scan is in flight", { kind });
      await updateLockedStatus(kind, {
        source: "passive",
        checkedAt: record.checkedAt || "",
        scannedAt: record.scannedAt || record.result?.scannedAt || ""
      });
      return { kind, skipped: "locked" };
    }

    try {
      let lastError = "";
      for (const listUrl of candidates) {
        try {
          log("fetch arena page", { kind, url: safeUrl(listUrl) });
          await updateScanStatus(kind, {
            state: "checking",
            source: "passive",
            message: "Checking opponent list",
            checkedAt: record.checkedAt || "",
            scannedAt: record.scannedAt || record.result?.scannedAt || "",
            lastError: ""
          });
          const html = await fetchArenaListHtml(listUrl);
          const entries = readArenaOpponentEntriesFromHtml(html, listUrl);
          log("got player list", { kind, url: safeUrl(listUrl), count: entries.length });
          await updateScanStatus(kind, {
            state: "checking",
            source: "passive",
            message: entries.length ? `Checked opponent list: ${entries.length} opponents` : "Checked opponent list: no opponents found",
            checkedAt: new Date().toISOString(),
            scannedAt: record.scannedAt || record.result?.scannedAt || "",
            opponentDone: 0,
            opponentTotal: entries.length,
            profileDone: 0,
            profileTotal: defaultProfileTotal(kind, entries.length),
            lastError: ""
          });
          if (!entries.length) continue;

          const ensured = await ensureScanForEntries(entries, formula, {
            kind,
            listUrl,
            sourceUrl: listUrl,
            checkedAt: new Date().toISOString(),
            fingerprint: ARENA.arenaOpponentFingerprint(entries),
            delayMs: PASSIVE_SCAN_DELAY_MS,
            concurrency: SCAN_CONCURRENCY,
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
      await updateScanStatus(kind, {
        state: "skipped",
        source: "passive",
        message: "No opponent rows found",
        checkedAt: new Date().toISOString(),
        scannedAt: record.scannedAt || record.result?.scannedAt || "",
        lastError
      });
      log("no opponents found in arena page candidates", { kind, lastError });
      return { kind, skipped: "no-opponents" };
    } catch (error) {
      const message = error.message || String(error);
      await releasePassiveLock(kind, lockId, (current) => ({
        ...current,
        checkedAt: new Date().toISOString(),
        lastError: message
      }));
      await updateScanStatus(kind, {
        state: "error",
        source: "passive",
        message: "Error fetching list",
        checkedAt: new Date().toISOString(),
        scannedAt: record.scannedAt || record.result?.scannedAt || "",
        lastError: message
      });
      log("passive scan failed", { kind, error: message });
      return { kind, error: message };
    }
  }

  async function ensureScanForEntries(entries, rawFormula, options = {}) {
    if (!entries?.length) {
      if (options.kind) {
        await updateScanStatus(options.kind, {
          state: "skipped",
          source: options.scanSource || "unknown",
          message: "No opponent rows found",
          checkedAt: options.checkedAt || "",
          lastError: ""
        });
      }
      return { result: null, skipped: "empty" };
    }

    const formula = ARENA.normalizeArenaFormula(rawFormula) || ARENA.defaultArenaFormula();
    const kind = options.kind || entries[0]?.opponent?.arenaKind || "single";
    const fingerprint = options.fingerprint || ARENA.arenaOpponentFingerprint(entries);
    const formulaKey = arenaFormulaFingerprint(formula);
    const cache = await loadPassiveCache();
    const record = cache[kind] || {};
    const listUrl = options.listUrl || record.listUrl || options.sourceUrl || "";
    const checkedAt = options.checkedAt || new Date().toISOString();
    const recordScannedAt = Date.parse(record.scannedAt || record.result?.scannedAt || "");
    const isCacheExpired = Number.isFinite(recordScannedAt) && Date.now() - recordScannedAt > CACHE_TTL_MS;

    if (!options.force
      && record.result
      && record.fingerprint === fingerprint
      && record.formulaFingerprint === formulaKey
      && !isCacheExpired) {
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
      await updateScanStatus(kind, {
        state: "ready",
        source: options.scanSource || "unknown",
        message: options.scanSource === "passive-list" ? "Ready, opponent list unchanged" : "Ready, cache matches opponent list",
        checkedAt,
        scannedAt: record.scannedAt || record.result?.scannedAt || "",
        opponentDone: record.result?.opponentCount || entries.length,
        opponentTotal: record.result?.opponentCount || entries.length,
        profileDone: defaultProfileTotal(kind, record.result?.opponentCount || entries.length),
        profileTotal: defaultProfileTotal(kind, record.result?.opponentCount || entries.length),
        lastError: ""
      });
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
      if (!lockId) {
        await updateLockedStatus(kind, {
          source: options.scanSource || "unknown",
          checkedAt: record.checkedAt || "",
          scannedAt: record.scannedAt || record.result?.scannedAt || ""
        });
        return { result: null, skipped: "locked" };
      }
    }

    try {
      log("opponent list changed or no scan exists; commence scanning", { kind, source: options.scanSource || "unknown", count: entries.length });
      const result = await scanEntries(entries, formula, {
        arenaKind: kind,
        sourceUrl: options.sourceUrl || listUrl,
        fingerprint,
        scanSource: options.scanSource || "unknown",
        delayMs: Number(options.delayMs) || PASSIVE_SCAN_DELAY_MS,
        concurrency: Number(options.concurrency) || SCAN_CONCURRENCY
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
      await updateScanStatus(kind, {
        state: "ready",
        source: options.scanSource || "unknown",
        message: "Ready",
        checkedAt,
        scannedAt: result.scannedAt,
        opponentDone: result.opponentCount,
        opponentTotal: result.opponentCount,
        profileDone: defaultProfileTotal(kind, result.opponentCount),
        profileTotal: defaultProfileTotal(kind, result.opponentCount),
        lastError: ""
      });
      log("saved scan result", { kind, source: options.scanSource || "unknown", opponents: result.opponentCount, failed: result.failedCount });
      return { result, scanned: true };
    } catch (error) {
      await updateScanStatus(kind, {
        state: "error",
        source: options.scanSource || "unknown",
        message: "Scan failed",
        checkedAt,
        scannedAt: record.scannedAt || record.result?.scannedAt || "",
        lastError: error.message || String(error)
      });
      throw error;
    } finally {
      if (ownsLock) await releasePassiveLock(kind, lockId, (current) => current);
    }
  }

  async function scanEntries(entries, rawFormula, options = {}) {
    const formula = ARENA.normalizeArenaFormula(rawFormula) || ARENA.defaultArenaFormula();
    const arenaKind = options.arenaKind || entries[0]?.opponent?.arenaKind || "single";
    const fingerprint = options.fingerprint || ARENA.arenaOpponentFingerprint(entries);
    const delayMs = Number(options.delayMs) || MANUAL_SCAN_DELAY_MS;
    const concurrency = Math.max(1, Math.min(ARENA.parseInteger(options.concurrency) || SCAN_CONCURRENCY, entries.length));
    const opponents = new Array(entries.length);
    const fetchCache = new Map();
    const progress = {
      kind: arenaKind,
      source: options.scanSource || "unknown",
      opponentDone: 0,
      opponentTotal: entries.length,
      profileDone: 0,
      profileTotal: defaultProfileTotal(arenaKind, entries.length)
    };
    let nextIndex = 0;

    log("commence profile scanning", { kind: arenaKind, count: entries.length, concurrency, delayMs, sourceUrl: safeUrl(options.sourceUrl || "") });
    await updateScanStatus(arenaKind, {
      state: "scanning",
      source: progress.source,
      message: scanProgressMessage(progress),
      opponentDone: progress.opponentDone,
      opponentTotal: progress.opponentTotal,
      profileDone: progress.profileDone,
      profileTotal: progress.profileTotal,
      lastError: ""
    });

    async function worker() {
      while (nextIndex < entries.length) {
        const index = nextIndex;
        nextIndex += 1;
        const entry = entries[index];
        log("scan opponent profile", {
          kind: entry.opponent.arenaKind,
          rowIndex: entry.opponent.rowIndex,
          name: entry.opponent.name,
          profileUrl: safeUrl(entry.opponent.profileUrl)
        });
        opponents[index] = await scanOpponentEntry(entry, formula, { delayMs, progress, fetchCache });
        progress.opponentDone += 1;
        await updateScanStatus(arenaKind, {
          state: "scanning",
          source: progress.source,
          message: scanProgressMessage(progress),
          opponentDone: progress.opponentDone,
          opponentTotal: progress.opponentTotal,
          profileDone: progress.profileDone,
          profileTotal: progress.profileTotal,
          lastError: ""
        });
        if (progress.opponentDone < entries.length) await delay(delayMs);
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

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
    let countedBaseProfile = false;
    try {
      const html = await fetchProfileHtml(entry.opponent.profileUrl, options.fetchCache);
      await incrementProfileProgress(options.progress);
      countedBaseProfile = true;
      return entry.opponent.arenaKind === "team"
        ? await scanTeamOpponent(entry, html, formula, options)
        : scanSingleOpponent(entry, html, formula);
    } catch (error) {
      if (!countedBaseProfile) await incrementProfileProgress(options.progress);
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

    const baseCostume = ARENA.parseCostumeFromHtml(html);
    const delayMs = Number(options.delayMs) || MANUAL_SCAN_DELAY_MS;
    const characters = [];
    for (const tab of tabs) {
      log("scan circus doll", {
        name: entry.opponent.name,
        doll: tab.doll,
        role: tab.role,
        profileUrl: safeUrl(tab.url)
      });
      let dollHtml = "";
      try {
        dollHtml = await fetchProfileHtml(tab.url, options.fetchCache);
      } finally {
        await incrementProfileProgress(options.progress);
      }
      characters.push(parseCharacterFromHtml(dollHtml, {
        ...entry.opponent,
        profileUrl: tab.url,
        doll: tab.doll,
        role: tab.role,
        roleLabel: tab.roleLabel,
        costume: baseCostume
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
      costume: baseCostume,
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
    const costume = meta.costume || ARENA.parseCostumeFromHtml(html);

    return new ARENA.ArenaCharacter({
      ...meta,
      name,
      level,
      doll: meta.doll || activeDoll.doll,
      role: meta.role || activeDoll.role,
      roleLabel: meta.roleLabel || activeDoll.roleLabel,
      costume,
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

  async function incrementProfileProgress(progress) {
    if (!progress) return;
    progress.profileDone = Math.min(progress.profileTotal, progress.profileDone + 1);
    await updateScanStatus(progress.kind, {
      state: "scanning",
      source: progress.source,
      message: scanProgressMessage(progress),
      opponentDone: progress.opponentDone,
      opponentTotal: progress.opponentTotal,
      profileDone: progress.profileDone,
      profileTotal: progress.profileTotal,
      lastError: ""
    });
  }

  function scanProgressMessage(progress) {
    return progress.profileTotal
      ? `Scanning profiles ${progress.profileDone}/${progress.profileTotal}, opponents ${progress.opponentDone}/${progress.opponentTotal}`
      : "Scanning profiles";
  }

  function defaultProfileTotal(kind, countOrEntries) {
    const count = Array.isArray(countOrEntries) ? countOrEntries.length : ARENA.parseInteger(countOrEntries);
    return kind === "team" ? count * 6 : count;
  }

  async function updateScanStatus(kind, values = {}) {
    if (!KINDS.includes(kind)) return null;
    const status = await loadScanStatus();
    status[kind] = normalizeScanStatusRecord({
      ...(status[kind] || {}),
      ...values,
      kind,
      updatedAt: new Date().toISOString()
    }, kind);
    await saveScanStatus(status);
    return status[kind];
  }

  async function updateLockedStatus(kind, values = {}) {
    if (!KINDS.includes(kind)) return null;
    const status = await loadScanStatus();
    const current = status[kind] || {};
    if (current.state === "scanning" && Number(current.profileTotal) && Number(current.profileDone) < Number(current.profileTotal)) {
      return current;
    }
    return updateScanStatus(kind, {
      state: "scanning",
      source: values.source || "unknown",
      message: "Scan in progress",
      checkedAt: values.checkedAt || current.checkedAt || "",
      scannedAt: values.scannedAt || current.scannedAt || "",
      opponentDone: current.opponentDone || 0,
      opponentTotal: current.opponentTotal || 0,
      profileDone: current.profileDone || 0,
      profileTotal: current.profileTotal || 0,
      lastError: ""
    });
  }

  async function loadScanStatus() {
    const result = await chrome.storage.local.get(ARENA.scanStatusStorageKey);
    return normalizeScanStatus(result[ARENA.scanStatusStorageKey]);
  }

  async function saveScanStatus(status) {
    await chrome.storage.local.set({ [ARENA.scanStatusStorageKey]: normalizeScanStatus(status) });
  }

  function normalizeScanStatus(status) {
    const source = status && typeof status === "object" ? status : {};
    return {
      single: normalizeScanStatusRecord(source.single, "single"),
      team: normalizeScanStatusRecord(source.team, "team")
    };
  }

  function normalizeScanStatusRecord(record, kind) {
    const source = record && typeof record === "object" ? record : {};
    return {
      kind,
      state: String(source.state || "unknown"),
      source: String(source.source || ""),
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

  async function fetchProfileHtml(url, fetchCache = null) {
    const normalized = normalizeProfileUrl(url).href;
    if (fetchCache && fetchCache.has(normalized)) return fetchCache.get(normalized);

    const promise = fetchGladiatusHtml(normalizeProfileUrl(url), "Profile");
    if (fetchCache) fetchCache.set(normalized, promise);
    return promise;
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

      const waitMs = response.status === 429 ? 1500 : 500 * (attempt + 1);
      await delay(waitMs);
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

  const regexCache = new Map();

  function textById(html, id) {
    const key = `id:${id}`;
    let pattern = regexCache.get(key);
    if (!pattern) {
      pattern = new RegExp(`<([a-zA-Z0-9]+)\\b[^>]*\\bid\\s*=\\s*(["'])${escapeRegExp(id)}\\2[^>]*>([\\s\\S]*?)<\\/\\1>`, "i");
      regexCache.set(key, pattern);
    }
    return stripMarkup(String(html || "").match(pattern)?.[3] || "");
  }

  function textByClass(html, className) {
    const key = `class:${className}`;
    let pattern = regexCache.get(key);
    if (!pattern) {
      pattern = new RegExp(`<([a-zA-Z0-9]+)\\b[^>]*\\bclass\\s*=\\s*(["'])[^"']*\\b${escapeRegExp(className)}\\b[^"']*\\2[^>]*>([\\s\\S]*?)<\\/\\1>`, "i");
      regexCache.set(key, pattern);
    }
    return stripMarkup(String(html || "").match(pattern)?.[3] || "");
  }

  function readHtmlAttribute(value, attribute) {
    const key = `attr:${attribute}`;
    let pattern = regexCache.get(key);
    if (!pattern) {
      pattern = new RegExp(`${attribute}\\s*=\\s*("|')([\\s\\S]*?)\\1`, "i");
      regexCache.set(key, pattern);
    }
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
