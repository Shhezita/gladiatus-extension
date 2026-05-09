(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : window;
  const SCORE = root.GladiatusScoreModel;
  if (!SCORE) {
    if (!isArenaPageUrl(root.document?.location?.href || root.location?.href || "")) return;
    throw new Error("GladiatusScoreModel must load before GladiatusArenaCore.");
  }

  if (root.GladiatusArenaCore) return;

  const FORMULAS_STORAGE_KEY = "glad-arena-formulas-v1";
  const RESULTS_STORAGE_KEY = "glad-arena-last-scan-v1";
  const PASSIVE_SCANS_STORAGE_KEY = "glad-arena-passive-scans-v1";
  const SCAN_STATUS_STORAGE_KEY = "glad-arena-scan-status-v1";
  const TEAM_DOLL_MIN = 2;
  const TEAM_DOLL_MAX = 6;

  const PRIMARY_STAT_KEYS = [
    "strength",
    "dexterity",
    "agility",
    "constitution",
    "charisma",
    "intelligence"
  ];

  const ARENA_STAT_LABELS = {
    level: "Level",
    strength: "Str",
    dexterity: "Dex",
    agility: "Agi",
    constitution: "Con",
    charisma: "Cha",
    intelligence: "Int",
    armour: "Armour",
    damageMin: "DMG min",
    damageMax: "DMG max",
    damageAvg: "DMG avg",
    healing: "Healing"
  };

  const ARENA_STAT_ORDER = [
    "level",
    "strength",
    "dexterity",
    "agility",
    "constitution",
    "charisma",
    "intelligence",
    "armour",
    "damageMin",
    "damageMax",
    "damageAvg",
    "healing"
  ];

  const ROLE_SECTION_KEYS = ["duel", "tank", "healer", "damage"];
  const ROLE_SECTION_LABELS = {
    duel: "Duel",
    tank: "Tank",
    healer: "Healer",
    damage: "Damage"
  };

  const PROFILE_SELECTORS = {
    level: "#char_level",
    strength: "#char_f0",
    dexterity: "#char_f1",
    agility: "#char_f2",
    constitution: "#char_f3",
    charisma: "#char_f4",
    intelligence: "#char_f5",
    armour: "#char_panzer",
    damage: "#char_schaden",
    healing: "#char_healing"
  };

  const DEFAULT_ARENA_FORMULA = {
    id: "role-aware-default",
    name: "Role-aware default",
    enabled: true,
    sections: {
      duel: {
        terms: [
          { stat: "dexterity", weight: 1 },
          { stat: "agility", weight: 1 },
          { stat: "damageAvg", weight: 1 }
        ],
        constraints: []
      },
      tank: {
        terms: [
          { stat: "agility", weight: 1 },
          { stat: "strength", weight: 0.5 },
          { stat: "armour", weight: 0.01 }
        ],
        constraints: []
      },
      healer: {
        terms: [
          { stat: "healing", weight: 1 }
        ],
        constraints: []
      },
      damage: {
        terms: [
          { stat: "dexterity", weight: 1 },
          { stat: "damageAvg", weight: 1 }
        ],
        constraints: []
      }
    }
  };

  class ArenaCharacter {
    constructor(data = {}) {
      this.id = String(data.id || "");
      this.name = String(data.name || "Unknown fighter").trim() || "Unknown fighter";
      this.profileUrl = String(data.profileUrl || "");
      this.province = String(data.province || "");
      this.language = String(data.language || "");
      this.level = parseInteger(data.level);
      this.doll = parseInteger(data.doll);
      this.role = normalizeRole(data.role);
      this.roleLabel = String(data.roleLabel || ROLE_SECTION_LABELS[this.role] || this.role);
      this.stats = normalizeStats({ ...(data.stats || {}), level: this.level });
    }

    get primaryStatSum() {
      return sumStats(this.stats, PRIMARY_STAT_KEYS);
    }

    get damageAvg() {
      return averageDamage(this.stats);
    }

    get simplePowerScore() {
      return this.primaryStatSum + this.damageAvg;
    }

    toJSON() {
      return {
        id: this.id,
        name: this.name,
        profileUrl: this.profileUrl,
        province: this.province,
        language: this.language,
        level: this.level,
        doll: this.doll,
        role: this.role,
        roleLabel: this.roleLabel,
        stats: { ...this.stats },
        scores: characterScores(this)
      };
    }
  }

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

  function arenaKindFromUrl(url) {
    try {
      const parsed = new URL(url);
      if (parsed.searchParams.get("submod") === "grouparena") return "team";
      if (parsed.searchParams.get("aType") === "3") return "team";
      return "single";
    } catch {
      return "single";
    }
  }

  function parseInteger(value) {
    const parsed = Number.parseInt(String(value || "").replace(/[^\d-]/g, ""), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function parseDamageRange(value) {
    const text = String(value || "");
    const range = text.match(/(\d[\d.]*)\s*-\s*(\d[\d.]*)/);
    if (range) {
      const damageMin = parseInteger(range[1]);
      const damageMax = parseInteger(range[2]);
      return {
        damageMin,
        damageMax,
        damageAvg: damageMin && damageMax ? (damageMin + damageMax) / 2 : 0
      };
    }

    const single = text.match(/\d[\d.]*/);
    const damage = single ? parseInteger(single[0]) : 0;
    return {
      damageMin: damage,
      damageMax: damage,
      damageAvg: damage
    };
  }

  function normalizeStats(stats) {
    const normalized = {};
    for (const key of ARENA_STAT_ORDER) {
      normalized[key] = Number(stats[key]) || 0;
    }
    if (!normalized.damageAvg) normalized.damageAvg = averageDamage(normalized);
    return normalized;
  }

  function sumStats(stats, keys) {
    return keys.reduce((total, key) => total + (Number(stats?.[key]) || 0), 0);
  }

  function averageDamage(stats) {
    if (Number(stats?.damageAvg)) return Number(stats.damageAvg);
    const min = Number(stats?.damageMin) || 0;
    const max = Number(stats?.damageMax) || 0;
    return min && max ? (min + max) / 2 : 0;
  }

  function characterScores(character) {
    const stats = character?.stats || {};
    const primaryStatSum = sumStats(stats, PRIMARY_STAT_KEYS);
    const damageAvg = averageDamage(stats);
    return {
      primaryStatSum,
      damageAvg,
      simplePowerScore: primaryStatSum + damageAvg
    };
  }

  function parseCharacterFromHtml(html, meta = {}) {
    const parser = new DOMParser();
    return parseCharacterFromDocument(parser.parseFromString(String(html || ""), "text/html"), meta);
  }

  function parseCharacterFromDocument(doc, meta = {}) {
    const activeDoll = readActiveDollMeta(doc, meta.profileUrl);
    const stat = (key) => parseInteger(doc.querySelector(PROFILE_SELECTORS[key])?.textContent);
    const damage = parseDamageRange(doc.querySelector(PROFILE_SELECTORS.damage)?.textContent || "");
    const name = doc.querySelector(".playername")?.textContent?.trim() || meta.name || activeDoll.name;
    const level = stat("level") || meta.level;

    return new ArenaCharacter({
      ...meta,
      name,
      level,
      doll: meta.doll || activeDoll.doll,
      role: meta.role || activeDoll.role,
      roleLabel: meta.roleLabel || activeDoll.roleLabel,
      stats: {
        level,
        strength: stat("strength"),
        dexterity: stat("dexterity"),
        agility: stat("agility"),
        constitution: stat("constitution"),
        charisma: stat("charisma"),
        intelligence: stat("intelligence"),
        armour: stat("armour"),
        healing: stat("healing"),
        ...damage
      }
    });
  }

  function readActiveDollMeta(doc, baseUrl = "") {
    const active = doc.querySelector(".charmercsel.active");
    if (!active) return { doll: 0, role: "duel", roleLabel: ROLE_SECTION_LABELS.duel, name: "" };
    return readDollTab(active, 0, baseUrl);
  }

  function readProfileDollTabsFromHtml(html, baseUrl = "") {
    const parser = new DOMParser();
    return readProfileDollTabsFromDocument(parser.parseFromString(String(html || ""), "text/html"), baseUrl);
  }

  function readProfileDollTabsFromDocument(doc, baseUrl = "") {
    return Array.from(doc.querySelectorAll(".charmercsel"))
      .map((tab, index) => readDollTab(tab, index, baseUrl || doc.location?.href || root.location?.href || ""))
      .filter((tab) => tab.url);
  }

  function readDollTab(tab, index, baseUrl = "") {
    const relativeUrl = extractDollUrl(tab.getAttribute("onclick") || "");
    const url = relativeUrl ? absoluteUrl(relativeUrl, baseUrl) : "";
    const rawTooltip = tab.querySelector("[data-tooltip]")?.getAttribute("data-tooltip") || "";
    const tooltipText = tooltipToText(rawTooltip);
    const role = parseRoleFromTooltipText(tooltipText);
    const doll = parseInteger(url ? new URL(url).searchParams.get("doll") : "") || index + 1;

    return {
      doll,
      url,
      tooltip: rawTooltip,
      tooltipText,
      role,
      roleLabel: ROLE_SECTION_LABELS[role] || ROLE_SECTION_LABELS.duel,
      active: tab.classList.contains("active")
    };
  }

  function extractDollUrl(onclick) {
    return String(onclick || "").match(/selectDoll\('([^']+)'\)/)?.[1]?.replaceAll("&amp;", "&") || "";
  }

  function absoluteUrl(value, baseUrl) {
    try {
      return new URL(value, baseUrl || root.location?.href || "").href;
    } catch {
      return "";
    }
  }

  function teamDollTabs(tabs) {
    return tabs.filter((tab) => tab.doll >= TEAM_DOLL_MIN && tab.doll <= TEAM_DOLL_MAX);
  }

  function tooltipToText(rawTooltip) {
    const values = [];
    try {
      collectStrings(JSON.parse(String(rawTooltip || "")), values);
    } catch {
      values.push(String(rawTooltip || ""));
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
    return decodeEntities(String(value || "")
      .replace(/\\\//g, "/")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]*>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
  }

  function decodeEntities(value) {
    return String(value || "")
      .replace(/&quot;/g, "\"")
      .replace(/&#039;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  }

  function parseRoleFromTooltipText(text) {
    const lower = String(text || "").toLowerCase();
    if (lower.includes("direct attention to oneself")) return "tank";
    if (lower.includes("heal group members")) return "healer";
    if (lower.includes("dish out damage")) return "damage";
    return "duel";
  }

  function normalizeRole(role) {
    if (role === "standard") return "duel";
    return ROLE_SECTION_KEYS.includes(role) ? role : "duel";
  }

  function readArenaOpponentEntries(doc = document, baseUrl = "") {
    const rows = Array.from(doc.querySelectorAll("#content tr"))
      .filter((row) => row.querySelector("a[href*='mod=player'][href*='p=']"))
      .filter((row) => row.querySelector(".attack[onclick]"));

    return rows.map((row, rowIndex) => {
      const link = row.querySelector("a[href*='mod=player'][href*='p=']");
      const attack = row.querySelector(".attack[onclick]");
      return {
        row,
        link,
        attack,
        opponent: readOpponentFromRow(row, link, attack, rowIndex, doc, baseUrl)
      };
    });
  }

  function readArenaOpponentEntriesFromHtml(html, baseUrl = "") {
    const parser = new DOMParser();
    return readArenaOpponentEntries(parser.parseFromString(String(html || ""), "text/html"), baseUrl);
  }

  function readOpponentFromRow(row, link, attack, rowIndex, doc = document, baseUrl = "") {
    const sourceUrl = baseUrl || doc.location?.href || root.location?.href || "";
    const profileUrl = new URL(link.getAttribute("href"), sourceUrl);
    const cells = Array.from(row.cells || []);
    const onclick = attack?.getAttribute("onclick") || "";
    const fightArgs = parseFightArgs(onclick);
    const arenaKind = fightArgs.arenaKind || arenaKindFromUrl(sourceUrl);

    return {
      rowIndex,
      arenaKind,
      id: profileUrl.searchParams.get("p") || fightArgs.playerId || "",
      name: link.textContent.trim(),
      level: parseInteger(cells[1]?.textContent),
      province: String(parseInteger(cells[2]?.textContent) || fightArgs.province || provinceFromHost(profileUrl.hostname) || ""),
      language: profileUrl.searchParams.get("language") || fightArgs.language || "",
      profileUrl: profileUrl.href
    };
  }

  function arenaOpponentFingerprint(entries) {
    return (entries || [])
      .map((entry) => entry?.opponent || entry)
      .map((opponent) => [
        String(opponent?.arenaKind || ""),
        String(opponent?.id || ""),
        normalizeFingerprintUrl(opponent?.profileUrl || "")
      ].join(":"))
      .join("|");
  }

  function normalizeFingerprintUrl(value) {
    try {
      const url = new URL(String(value || ""));
      url.hash = "";
      url.searchParams.delete("sh");
      url.searchParams.sort();
      return url.href;
    } catch {
      return String(value || "");
    }
  }

  function parseFightArgs(onclick) {
    const provincial = String(onclick || "").match(/startProvinciarumFight\([^,]+,\s*(\d+),\s*(\d+),\s*(\d+),\s*'([^']*)'/);
    if (provincial) {
      return {
        arenaType: provincial[1],
        arenaKind: provincial[1] === "3" ? "team" : "single",
        playerId: provincial[2],
        province: provincial[3],
        language: provincial[4]
      };
    }

    const group = String(onclick || "").match(/startGroupFight\([^,]+,\s*(\d+)/);
    return group ? { arenaType: "group", arenaKind: "team", playerId: group[1] } : {};
  }

  function provinceFromHost(hostname) {
    return String(hostname || "").match(/^s(\d+)-/)?.[1] || "";
  }

  function defaultArenaFormula() {
    return cloneArenaFormula(DEFAULT_ARENA_FORMULA);
  }

  function normalizeArenaFormulas(formulas) {
    return Array.isArray(formulas)
      ? formulas.map(normalizeArenaFormula).filter(Boolean)
      : [];
  }

  function normalizeArenaFormula(formula) {
    if (!formula || typeof formula !== "object") return null;

    const id = SCORE.sanitizeId(formula.id) || SCORE.makeId("arena-formula");
    const name = String(formula.name || "").trim() || "Untitled arena formula";
    const sourceSections = formula.sections && typeof formula.sections === "object" ? formula.sections : {};
    const sections = {};

    for (const key of ROLE_SECTION_KEYS) {
      const sourceSection = key === "duel"
        ? sourceSections.duel || sourceSections.standard || {}
        : sourceSections[key] || {};
      sections[key] = SCORE.normalizeScoreSection(sourceSection, { statKeys: ARENA_STAT_ORDER });
    }

    return {
      id,
      name,
      enabled: formula.enabled !== false,
      sections
    };
  }

  function cloneArenaFormula(formula) {
    return {
      id: formula.id,
      name: formula.name,
      enabled: formula.enabled !== false,
      sections: Object.fromEntries(ROLE_SECTION_KEYS.map((key) => [
        key,
        cloneSection(formula.sections?.[key] || {})
      ]))
    };
  }

  function cloneSection(section) {
    return {
      terms: (section.terms || []).map((term) => ({ ...term })),
      constraints: (section.constraints || []).map((constraint) => ({ ...constraint }))
    };
  }

  function scoreArenaCharacter(character, formula) {
    const normalizedFormula = normalizeArenaFormula(formula) || defaultArenaFormula();
    const sectionKey = normalizeRole(character?.role);
    const section = sectionWithFallback(normalizedFormula, sectionKey);
    const score = SCORE.score(character, section, stat);

    return {
      score,
      matches: SCORE.matches(character, section, stat),
      sectionKey
    };
  }

  function scoreArenaTeam(members, formula) {
    const scoredMembers = (members || []).map((member) => {
      const scored = scoreArenaCharacter(member, formula);
      return {
        ...member,
        formulaSection: scored.sectionKey,
        formulaScore: scored.score,
        formulaMatches: scored.matches
      };
    });
    return {
      members: scoredMembers,
      totalScore: scoredMembers.reduce((total, member) => total + member.formulaScore, 0),
      matches: scoredMembers.every((member) => member.formulaMatches)
    };
  }

  function sectionWithFallback(formula, sectionKey) {
    const section = formula.sections?.[sectionKey];
    if (section) return section;
    const duel = formula.sections?.duel;
    if (duel) return duel;
    return SCORE.normalizeScoreSection(DEFAULT_ARENA_FORMULA.sections[sectionKey] || DEFAULT_ARENA_FORMULA.sections.duel, { statKeys: ARENA_STAT_ORDER });
  }

  function stat(record, key) {
    if (key === "level") return Number(record?.level || record?.stats?.level) || 0;
    return Number(record?.stats?.[key]) || 0;
  }

  function summarizeArenaFormula(formula) {
    const normalized = normalizeArenaFormula(formula);
    if (!normalized) return "";
    return ROLE_SECTION_KEYS
      .map((key) => `${ROLE_SECTION_LABELS[key]}: ${SCORE.summarizeSection(normalized.sections[key], ARENA_STAT_LABELS)}`)
      .join(" | ");
  }

  function formatNumber(value) {
    return SCORE.formatNumber(Number(value) || 0);
  }

  function formatCharacterStats(character) {
    const stats = character?.stats || {};
    return [
      character?.roleLabel ? `${character.roleLabel}` : "",
      `Str ${stats.strength || 0}`,
      `Dex ${stats.dexterity || 0}`,
      `Agi ${stats.agility || 0}`,
      `Con ${stats.constitution || 0}`,
      `Cha ${stats.charisma || 0}`,
      `Int ${stats.intelligence || 0}`,
      `DMG ${formatNumber(averageDamage(stats))}`,
      `Armour ${stats.armour || 0}`,
      `Healing ${stats.healing || 0}`
    ].filter(Boolean).join(" | ");
  }

  root.GladiatusArenaCore = {
    ArenaCharacter,
    arenaKindFromUrl,
    defaultArenaFormula,
    formulasStorageKey: FORMULAS_STORAGE_KEY,
    passiveScansStorageKey: PASSIVE_SCANS_STORAGE_KEY,
    resultsStorageKey: RESULTS_STORAGE_KEY,
    scanStatusStorageKey: SCAN_STATUS_STORAGE_KEY,
    arenaOpponentFingerprint,
    formatArenaFormula: summarizeArenaFormula,
    formatCharacterStats,
    formatNumber,
    isArenaPageUrl,
    normalizeArenaFormula,
    normalizeArenaFormulas,
    parseCharacterFromDocument,
    parseCharacterFromHtml,
    parseDamageRange,
    parseFightArgs,
    parseInteger,
    parseRoleFromTooltipText,
    primaryStatKeys: PRIMARY_STAT_KEYS,
    profileSelectors: PROFILE_SELECTORS,
    readArenaOpponentEntries,
    readArenaOpponentEntriesFromHtml,
    readProfileDollTabsFromDocument,
    readProfileDollTabsFromHtml,
    roleSectionKeys: ROLE_SECTION_KEYS,
    roleSectionLabels: ROLE_SECTION_LABELS,
    scoreArenaCharacter,
    scoreArenaTeam,
    stat,
    statLabels: ARENA_STAT_LABELS,
    statOptions: ARENA_STAT_ORDER.map((key) => ({ key, label: ARENA_STAT_LABELS[key] || key })),
    statOrder: ARENA_STAT_ORDER,
    teamDollTabs,
    characterScores
  };
})();
