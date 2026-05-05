(() => {
  const UI_ID = "glad-ah-sorter";
  const BADGE_CLASS = "glad-ah-score";
  const CARD_SELECTOR = "form[id^='auctionForm']";
  const STAT_NAMES = [
    "Strength",
    "Dexterity",
    "Agility",
    "Constitution",
    "Charisma",
    "Intelligence",
    "Life points",
    "Damage",
    "Health",
    "Armour",
    "Block value",
    "Healing",
    "Critical attack value",
    "Critical healing value",
    "Critical damage",
    "Threat",
    "Hardening value"
  ];
  const PRIMARY_STATS = [
    "strength",
    "dexterity",
    "agility",
    "constitution",
    "charisma",
    "intelligence"
  ];
  const MODEL = window.GladiatusAuctionModel;
  const BASE_SORT_OPTIONS = [
    { id: "original", label: "Original order", group: "Base fields", get: (item) => -item.originalIndex },
    { id: "primaryTotal", label: "Primary stat total", group: "Base fields", get: (item) => sumKeys(item.stats, PRIMARY_STATS) },
    { id: "strength", label: "Strength", group: "Base stats", get: (item) => item.stats.strength || 0 },
    { id: "dexterity", label: "Dexterity", group: "Base stats", get: (item) => item.stats.dexterity || 0 },
    { id: "agility", label: "Agility", group: "Base stats", get: (item) => item.stats.agility || 0 },
    { id: "constitution", label: "Constitution", group: "Base stats", get: (item) => item.stats.constitution || 0 },
    { id: "charisma", label: "Charisma", group: "Base stats", get: (item) => item.stats.charisma || 0 },
    { id: "intelligence", label: "Intelligence", group: "Base stats", get: (item) => item.stats.intelligence || 0 },
    { id: "lifepoints", label: "Life points", group: "Base stats", get: (item) => item.stats.lifepoints || 0 },
    { id: "damageBonus", label: "Damage bonus", group: "Base stats", get: (item) => item.stats.damageBonus || 0 },
    { id: "health", label: "Health", group: "Base stats", get: (item) => item.stats.health || 0 },
    { id: "armour", label: "Armour", group: "Base stats", get: (item) => item.stats.armour || 0 },
    { id: "blockvalue", label: "Block value", group: "Tank stats", get: (item) => item.stats.blockvalue || 0 },
    { id: "healing", label: "Healing", group: "Tank stats", get: (item) => item.stats.healing || 0 },
    { id: "criticalattackvalue", label: "Critical attack", group: "Base stats", get: (item) => item.stats.criticalattackvalue || 0 },
    { id: "criticalhealingvalue", label: "Critical healing", group: "Tank stats", get: (item) => item.stats.criticalhealingvalue || 0 },
    { id: "criticaldamage", label: "Critical damage", group: "Base stats", get: (item) => item.stats.criticaldamage || 0 },
    { id: "threat", label: "Threat", group: "Tank stats", get: (item) => item.stats.threat || 0 },
    { id: "hardeningvalue", label: "Hardening", group: "Tank stats", get: (item) => item.stats.hardeningvalue || 0 },
    { id: "damageAvg", label: "Damage average", group: "Base fields", get: (item) => item.stats.damageAvg || 0 },
    { id: "damageMax", label: "Damage max", group: "Base fields", get: (item) => item.stats.damageMax || 0 },
    { id: "level", label: "Level", group: "Base fields", get: (item) => item.level || 0 },
    { id: "itemValue", label: "Item value", group: "Base fields", get: (item) => item.itemValue || 0 },
    { id: "buyoutGold", label: "Immediate gold", group: "Base fields", get: (item) => item.priceGold || 0, defaultAscending: true }
  ];
  const SORT_OPTIONS = [...MODEL.getPresetSortOptions(), ...BASE_SORT_OPTIONS];
  const STORAGE_KEY = "glad-ah-sorter-state-v1";
  const PAGE_CORE_SCRIPT_ID = "glad-ah-page-core";
  const MAIN_SCAN_TYPES = [
    { value: "1", label: "Weapons" },
    { value: "2", label: "Shields" },
    { value: "3", label: "Chest Armour" },
    { value: "4", label: "Helmets" },
    { value: "5", label: "Gloves" },
    { value: "8", label: "Shoes" },
    { value: "6", label: "Rings" },
    { value: "9", label: "Amulets" },
    { value: "7", label: "Usable" },
    { value: "11", label: "Reinforcements" },
    { value: "12", label: "Upgrades" },
    { value: "15", label: "Mercenary Contracts" }
  ];
  const MERCENARY_EQUIPMENT_SCAN_TYPES = [
    { value: "1", label: "Mercenary Weapons" },
    { value: "2", label: "Mercenary Shields" },
    { value: "3", label: "Mercenary Chest Armour" },
    { value: "4", label: "Mercenary Helmets" },
    { value: "5", label: "Mercenary Gloves" },
    { value: "8", label: "Mercenary Shoes" },
    { value: "6", label: "Mercenary Rings" },
    { value: "9", label: "Mercenary Amulets" }
  ];

  const initialState = readSortState();
  let selectedSort = initialState.selectedSort;
  let descending = initialState.descending;
  let sortContextKey = getSortContextKey();
  let bootTimer = 0;
  let refreshTimer = 0;
  let lastItemSetSignature = "";
  let pageCoreLoadPromise = null;

  function ensurePageCoreInjected() {
    if (typeof chrome === "undefined" || !chrome.runtime?.getURL) return Promise.resolve();
    if (document.getElementById(PAGE_CORE_SCRIPT_ID)) return Promise.resolve();
    if (pageCoreLoadPromise) return pageCoreLoadPromise;

    pageCoreLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.id = PAGE_CORE_SCRIPT_ID;
      script.src = chrome.runtime.getURL("auction-core.js");
      script.dataset.gladAuctionPageBridge = "1";
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Could not inject the Gladiatus auction scanner API."));
      (document.head || document.documentElement).append(script);
    });

    return pageCoreLoadPromise;
  }

  async function callPageCore(method, args = []) {
    await ensurePageCoreInjected();

    return new Promise((resolve, reject) => {
      const id = `glad-ah-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timeout = window.setTimeout(() => {
        window.removeEventListener("message", onMessage);
        reject(new Error("The auction scanner did not respond."));
      }, 60000);

      function onMessage(event) {
        if (event.source !== window || event.data?.source !== "glad-ah-page" || event.data.id !== id) return;

        window.clearTimeout(timeout);
        window.removeEventListener("message", onMessage);

        if (event.data.ok) {
          resolve(event.data.result);
        } else {
          reject(new Error(event.data.error || "The auction scanner failed."));
        }
      }

      window.addEventListener("message", onMessage);
      window.postMessage({ source: "glad-ah-extension", id, method, args }, "*");
    });
  }

  function readSortState() {
    const defaults = { selectedSort: getContextDefaultSortId(), descending: true };

    try {
      const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null");
      if (!saved || typeof saved !== "object") return defaults;

      const contextState = saved.byItemType?.[getSortContextKey()];
      if (!contextState || typeof contextState !== "object") return defaults;

      const selectedOption = SORT_OPTIONS.find((option) => option.id === contextState.selectedSort);
      if (!selectedOption) return defaults;

      return {
        selectedSort: selectedOption.id,
        descending: typeof contextState.descending === "boolean" ? contextState.descending : !selectedOption.defaultAscending
      };
    } catch {
      return defaults;
    }
  }

  function getContextDefaultSortId() {
    return MODEL.defaultPresetForItemType(getCurrentItemType());
  }

  function getCurrentItemType() {
    return document.querySelector("select[name='itemType']")?.value || "";
  }

  function getSortContextKey() {
    const ttype = new URL(window.location.href).searchParams.get("ttype") || "main";
    return `${ttype}:${getCurrentItemType() || "default"}`;
  }

  function saveSortState() {
    try {
      const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null") || {};
      const byItemType = saved && typeof saved === "object" && saved.byItemType && typeof saved.byItemType === "object"
        ? saved.byItemType
        : {};
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        byItemType: {
          ...byItemType,
          [getSortContextKey()]: { selectedSort, descending }
        }
      }));
    } catch {
      // Sorting should still work if local storage is blocked.
    }
  }

  function isAuctionPage() {
    try {
      return new URL(window.location.href).searchParams.get("mod") === "auction";
    } catch {
      return false;
    }
  }

  function sumKeys(record, keys) {
    return keys.reduce((total, key) => total + (record[key] || 0), 0);
  }

  function keyForStat(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function stripHtml(value) {
    const scratch = document.createElement("div");
    scratch.innerHTML = String(value || "");
    return (scratch.textContent || scratch.innerText || "").replace(/\s+/g, " ").trim();
  }

  function parseInteger(value) {
    const normalized = String(value || "").replace(/[^\d-]/g, "");
    const parsed = Number.parseInt(normalized, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function primaryTooltipSegment(line) {
    return String(line || "").split(",")[0];
  }

  function parseSignedBonus(line) {
    const segment = primaryTooltipSegment(line);
    const parenthesized = segment.match(/\(([+-]?\d+)\)/g) || [];
    if (parenthesized.length) {
      return parenthesized.reduce((total, match) => total + (Number.parseInt(match.replace(/[()]/g, ""), 10) || 0), 0);
    }

    const directValues = segment.match(/[+-]\d+/g) || [];
    return directValues.reduce((total, match) => total + (Number.parseInt(match, 10) || 0), 0);
  }

  function parseDamageRange(line) {
    const segment = primaryTooltipSegment(line);
    const rangePattern = /([+-]?\d+)\s*-\s*([+-]?\d+)/g;
    const total = { min: 0, max: 0, count: 0 };
    let match = rangePattern.exec(segment);

    while (match) {
      total.min += Number.parseInt(match[1], 10) || 0;
      total.max += Number.parseInt(match[2], 10) || 0;
      total.count += 1;
      match = rangePattern.exec(segment);
    }

    return total.count ? { min: total.min, max: total.max } : null;
  }

  function parseTooltipLines(icon) {
    if (window.GladiatusAuctionCore?.parseTooltipLines) {
      return window.GladiatusAuctionCore.parseTooltipLines(icon);
    }

    const raw = icon.dataset.tooltip || icon.getAttribute("data-tooltip") || "";
    if (!raw) return [];

    try {
      const tooltip = JSON.parse(raw);
      const itemLines = Array.isArray(tooltip) && Array.isArray(tooltip[0]) ? tooltip[0] : [];
      return itemLines
        .map((entry) => stripHtml(Array.isArray(entry) ? entry[0] : entry))
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  function parseStats(lines) {
    if (window.GladiatusAuctionCore?.parseStats) {
      return window.GladiatusAuctionCore.parseStats(lines);
    }

    const stats = {};
    let level = 0;
    let itemValue = 0;

    for (const line of lines) {
      const foodHealing = parseFoodHealingText(line);
      if (foodHealing) {
        stats.foodHealing = (stats.foodHealing || 0) + foodHealing;
        continue;
      }

      const damageRange = line.match(/^Damage\s+(.+)/i);
      if (damageRange) {
        const range = parseDamageRange(damageRange[1]);
        if (range) {
          stats.damageMin = range.min;
          stats.damageMax = range.max;
          stats.damageAvg = (range.min + range.max) / 2;
        } else {
          stats.damageBonus = (stats.damageBonus || 0) + parseSignedBonus(damageRange[1]);
        }
        continue;
      }

      const usingBonus = line.match(/^Using:\s+(.+)$/i);
      if (usingBonus) {
        parseUsingBonus(usingBonus[1], stats);
        continue;
      }

      const levelMatch = line.match(/^Level\s+(\d+)/i);
      if (levelMatch) {
        level = Number.parseInt(levelMatch[1], 10) || 0;
        continue;
      }

      const valueMatch = line.match(/^Value\s+([\d.,]+)/i);
      if (valueMatch) {
        itemValue = parseInteger(valueMatch[1]);
        continue;
      }

      for (const statName of STAT_NAMES) {
        const statPattern = new RegExp(`^${escapeRegExp(statName)}\\b\\s*:?`, "i");
        if (statPattern.test(line)) {
          const key = keyForStat(statName);
          stats[key] = (stats[key] || 0) + parseStatValue(statName, line);
          break;
        }
      }
    }

    return { stats, level, itemValue };
  }

  function parseStatValue(statName, line) {
    const absolute = line.match(new RegExp(`^${escapeRegExp(statName)}\\s*:\\s*([+-]?\\d+)`, "i"));
    if (absolute) {
      return Number.parseInt(absolute[1], 10) || 0;
    }

    return parseSignedBonus(line);
  }

  function parseUsingBonus(text, stats) {
    const foodHealing = parseFoodHealingText(text);
    if (foodHealing) {
      stats.foodHealing = (stats.foodHealing || 0) + foodHealing;
      return;
    }

    for (const statName of STAT_NAMES) {
      const statPattern = new RegExp(`\\b${escapeRegExp(statName)}\\b`, "i");
      if (!statPattern.test(text)) continue;

      const key = statName.toLowerCase() === "damage" ? "damageBonus" : keyForStat(statName);
      stats[key] = (stats[key] || 0) + parseSignedBonus(text);
      return;
    }
  }

  function parseFoodHealingText(text) {
    const healingMatch = String(text || "").match(/^(?:Using:\s*)?Heals\s+([\d.,]+)\s+(?:of\s+)?life\b/i);
    return healingMatch ? parseInteger(healingMatch[1]) : 0;
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function getAuctionTable() {
    const firstForm = document.querySelector(CARD_SELECTOR);
    return firstForm ? firstForm.closest("table") : null;
  }

  function collectItems() {
    const seenCells = new Set();
    return Array.from(document.querySelectorAll(CARD_SELECTOR))
      .map((form, index) => {
        const cell = form.closest("td");
        const icon = form.querySelector("[data-tooltip]");
        if (!cell || !icon || seenCells.has(cell)) return null;
        seenCells.add(cell);

        if (!cell.dataset.gladAhOriginalIndex) {
          cell.dataset.gladAhOriginalIndex = String(index);
        }

        const lines = parseTooltipLines(icon);
        const parsed = parseStats(lines);
        const originalIndex = Number.parseInt(cell.dataset.gladAhOriginalIndex, 10) || index;

        return {
          auctionId: getAuctionId(form, index),
          cell,
          form,
          icon,
          lines,
          name: lines[0] || "Unknown item",
          originalIndex,
          priceGold: parseInteger(icon.dataset.priceGold),
          bidAmount: parseInteger(form.querySelector("input[name='bid_amount']")?.value),
          ...parsed
        };
      })
      .filter(Boolean);
  }

  async function scanAllAuctionItems() {
    if (!isAuctionPage()) {
      throw new Error("Open a Gladiatus auction page before scanning.");
    }

    const filterForm = getFilterForm(document);
    if (!filterForm) {
      throw new Error("Could not find the auction filter form.");
    }

    const sharedFilters = readSharedFilterValues(filterForm);
    const categories = [];
    const items = [];

    for (const type of MAIN_SCAN_TYPES) {
      const doc = await fetchFilteredAuctionDocument(makeAuctionUrl(), filterForm, type.value, sharedFilters);
      categories.push(type.label);
      items.push(...parseAuctionItemsFromDocument(doc, {
        category: type.label,
        group: "Gladiator necessities",
        itemType: type.value
      }));
    }

    const mercenaryUrl = makeAuctionUrl("3");
    const mercenaryBaseDoc = await fetchAuctionDocument(mercenaryUrl);
    const mercenaryForm = getFilterForm(mercenaryBaseDoc);

    if (mercenaryForm) {
      for (const type of MERCENARY_EQUIPMENT_SCAN_TYPES) {
        const doc = await fetchFilteredAuctionDocument(mercenaryUrl, mercenaryForm, type.value, sharedFilters);
        categories.push(type.label);
        items.push(...parseAuctionItemsFromDocument(doc, {
          category: type.label,
          group: "Mercenary necessities",
          itemType: type.value
        }));
      }
    }

    return {
      scannedAt: new Date().toISOString(),
      categoriesScanned: categories.length,
      filterSummary: formatFilterSummary(sharedFilters),
      items: sortScannedItems(items)
    };
  }

  function makeAuctionUrl(ttype) {
    const url = new URL(window.location.href);
    url.searchParams.set("mod", "auction");
    url.searchParams.delete("submod");

    if (ttype) {
      url.searchParams.set("ttype", ttype);
    } else {
      url.searchParams.delete("ttype");
    }

    return url.href;
  }

  function getFilterForm(doc) {
    return Array.from(doc.querySelectorAll("#content form, form"))
      .find((form) => form.querySelector("select[name='itemType']"));
  }

  function readSharedFilterValues(form) {
    const valueOf = (selector, fallback = "") => form.querySelector(selector)?.value ?? fallback;

    return {
      qry: valueOf("input[name='qry']"),
      itemLevel: valueOf("select[name='itemLevel']", "39"),
      itemQuality: valueOf("select[name='itemQuality']", "-1")
    };
  }

  function formatFilterSummary(filters) {
    const parts = [
      filters.qry ? `Name: ${filters.qry}` : "",
      filters.itemLevel ? `Minimum level: ${filters.itemLevel}+` : "",
      filters.itemQuality !== undefined ? `Quality: ${qualityLabel(filters.itemQuality)}` : ""
    ].filter(Boolean);

    return parts.length ? `Using current filters: ${parts.join(" | ")}` : "Using current auction filters.";
  }

  function qualityLabel(value) {
    const labels = {
      "-1": "Standard+",
      "0": "Ceres+",
      "1": "Neptune+",
      "2": "Mars+"
    };

    return labels[value] || value;
  }

  async function fetchAuctionDocument(url) {
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok) {
      throw new Error(`Auction fetch failed with HTTP ${response.status}.`);
    }

    return new DOMParser().parseFromString(await response.text(), "text/html");
  }

  async function fetchFilteredAuctionDocument(url, form, itemType, sharedFilters) {
    const body = makeFilterBody(form, itemType, sharedFilters);
    const response = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });

    if (!response.ok) {
      throw new Error(`Auction filter fetch failed with HTTP ${response.status}.`);
    }

    return new DOMParser().parseFromString(await response.text(), "text/html");
  }

  function makeFilterBody(form, itemType, sharedFilters) {
    const body = new URLSearchParams(new FormData(form));
    body.set("itemType", itemType);
    body.set("qry", sharedFilters.qry || "");
    body.set("itemLevel", sharedFilters.itemLevel || "39");
    body.set("itemQuality", sharedFilters.itemQuality || "-1");
    return body;
  }

  function parseAuctionItemsFromDocument(doc, meta) {
    return Array.from(doc.querySelectorAll(CARD_SELECTOR))
      .map((form, index) => {
        const icon = form.querySelector("[data-tooltip]");
        if (!icon) return null;

        const lines = parseTooltipLines(icon);
        const parsed = parseStats(lines);
        const auctionId = getAuctionId(form, index);

        return {
          auctionId,
          category: meta.category,
          group: meta.group,
          itemType: meta.itemType,
          name: lines[0] || "Unknown item",
          priceGold: parseInteger(icon.dataset.priceGold),
          bidAmount: parseInteger(form.querySelector("input[name='bid_amount']")?.value),
          contentType: icon.getAttribute("data-content-type") || "",
          basis: icon.getAttribute("data-basis") || "",
          itemClass: icon.className || "",
          imageSrc: readIconImageSrc(icon),
          imageStyle: icon.getAttribute("style") || "",
          lines,
          level: parsed.level,
          itemValue: parsed.itemValue,
          stats: parsed.stats
        };
      })
      .filter(Boolean);
  }

  function readIconImageSrc(icon) {
    const image = icon.querySelector("img");
    if (image?.src) return image.src;

    const style = icon.getAttribute("style") || "";
    const backgroundImage = style.match(/background-image\s*:\s*url\((['"]?)(.*?)\1\)/i);
    return backgroundImage?.[2] || "";
  }

  function sortScannedItems(items) {
    const categoryRank = new Map(
      [...MAIN_SCAN_TYPES, ...MERCENARY_EQUIPMENT_SCAN_TYPES]
        .map((type, index) => [type.label, index])
    );

    return items.sort((a, b) => {
      const categoryDiff = (categoryRank.get(a.category) ?? 999) - (categoryRank.get(b.category) ?? 999);
      if (categoryDiff) return categoryDiff;
      if (a.level !== b.level) return a.level - b.level;
      return a.name.localeCompare(b.name);
    });
  }

  function getAuctionId(form, fallbackIndex) {
    const input = form.querySelector("input[name='auctionid']");
    return input && input.value ? input.value : String(fallbackIndex);
  }

  function getItemSetSignature() {
    return Array.from(document.querySelectorAll(CARD_SELECTOR))
      .map((form, index) => getAuctionId(form, index))
      .sort()
      .join("|");
  }

  function getSelectedOption() {
    return SORT_OPTIONS.find((option) => option.id === selectedSort) || SORT_OPTIONS[0];
  }

  function refreshSortContext() {
    const nextContextKey = getSortContextKey();
    if (nextContextKey === sortContextKey) return;

    sortContextKey = nextContextKey;
    const state = readSortState();
    selectedSort = state.selectedSort;
    descending = state.descending;
    syncSortSelect();
    updateOrderButton();
  }

  function sortItems() {
    refreshSortContext();

    const table = getAuctionTable();
    if (!table || !table.tBodies.length) return;

    const tbody = table.tBodies[0];
    const items = collectItems();
    if (!items.length) return;
    lastItemSetSignature = getItemSetSignature();

    const option = getSelectedOption();
    const direction = selectedSort === "original" ? 1 : descending ? -1 : 1;

    items.sort((a, b) => {
      if (selectedSort === "original") {
        return a.originalIndex - b.originalIndex;
      }

      const aScore = option.get(a);
      const bScore = option.get(b);
      if (aScore !== bScore) return (aScore - bScore) * direction;
      if (a.level !== b.level) return (a.level - b.level) * direction;
      return a.originalIndex - b.originalIndex;
    });

    removeRowsContaining(items.map((item) => item.cell), tbody);
    appendTwoColumnRows(items, tbody);
    updateBadges(items, option);
    updateItemCount(items.length);
  }

  function removeRowsContaining(cells, tbody) {
    const cellSet = new Set(cells);
    Array.from(tbody.rows).forEach((row) => {
      if (Array.from(row.cells).some((cell) => cellSet.has(cell))) {
        row.remove();
      }
    });
  }

  function appendTwoColumnRows(items, tbody) {
    let row = null;
    items.forEach((item, index) => {
      if (index % 2 === 0) {
        row = document.createElement("tr");
        tbody.append(row);
      }
      row.append(item.cell);
    });
  }

  function updateBadges(items, option) {
    items.forEach((item) => {
      item.cell.querySelectorAll(`.${BADGE_CLASS}`).forEach((badge) => badge.remove());
      if (selectedSort === "original") return;

      const target = item.cell.querySelector(".auction_item_div");
      if (!target) return;

      const score = option.get(item);
      const badge = document.createElement("div");
      badge.className = BADGE_CLASS;
      badge.textContent = option.display ? option.display(item, score) : `${formatScore(score)} ${option.label}`;
      badge.title = item.name;
      target.append(badge);
    });
  }

  function updateItemCount(count) {
    const countNode = document.querySelector(`#${UI_ID} .glad-ah-count`);
    if (countNode) countNode.textContent = `${count} items`;
  }

  function formatScore(score) {
    return Number.isInteger(score) ? String(score) : score.toFixed(1);
  }

  function makeSelect() {
    const select = document.createElement("select");
    select.id = "glad-ah-sort-field";
    for (const [group, options] of groupSortOptions()) {
      const container = document.createElement("optgroup");
      container.label = group;

      options.forEach((option) => {
        const optionEl = document.createElement("option");
        optionEl.value = option.id;
        optionEl.textContent = option.label;
        container.append(optionEl);
      });

      select.append(container);
    }
    select.value = selectedSort;
    select.addEventListener("change", () => {
      applySortSelection(select.value);
    });
    return select;
  }

  function groupSortOptions() {
    const groups = new Map();

    SORT_OPTIONS.forEach((option) => {
      const group = option.group || "Other";
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(option);
    });

    return groups.entries();
  }

  function applySortSelection(sortId) {
    selectedSort = sortId;
    const option = getSelectedOption();
    if (option.defaultAscending) {
      descending = false;
    } else if (selectedSort !== "original") {
      descending = true;
    }
    saveSortState();
    syncSortSelect();
    updateOrderButton();
    sortItems();
  }

  function syncSortSelect() {
    const select = document.getElementById("glad-ah-sort-field");
    if (select) select.value = selectedSort;
  }

  function updateOrderButton() {
    const button = document.getElementById("glad-ah-sort-order");
    if (!button) return;
    button.textContent = descending ? "High first" : "Low first";
    button.disabled = selectedSort === "original";
  }

  function ensureUi() {
    if (!isAuctionPage() || document.getElementById(UI_ID)) return;

    const table = getAuctionTable();
    if (!table) return;

    const panel = document.createElement("div");
    panel.id = UI_ID;

    const title = document.createElement("strong");
    title.textContent = "Auction sorter";

    const label = document.createElement("label");
    label.htmlFor = "glad-ah-sort-field";
    label.textContent = "Sort by";

    const select = makeSelect();

    const orderButton = document.createElement("button");
    orderButton.type = "button";
    orderButton.id = "glad-ah-sort-order";
    orderButton.addEventListener("click", () => {
      descending = !descending;
      saveSortState();
      updateOrderButton();
      sortItems();
    });

    const applyButton = document.createElement("button");
    applyButton.type = "button";
    applyButton.textContent = "Apply";
    applyButton.addEventListener("click", sortItems);

    const count = document.createElement("span");
    count.className = "glad-ah-count";
    count.textContent = `${collectItems().length} items`;

    panel.append(title, label, select, orderButton, applyButton, count);
    insertPanel(panel, table);
    updateOrderButton();
    sortItems();
  }

  function insertPanel(panel, table) {
    const compareHeader = Array.from(document.querySelectorAll("#content h2"))
      .find((heading) => heading.textContent.trim() === "Compare with");

    if (compareHeader && compareHeader.parentElement) {
      compareHeader.before(panel);
      return;
    }

    const auctionTableContainer = table.closest("#auction_table");
    if (auctionTableContainer) {
      auctionTableContainer.before(panel);
      return;
    }

    table.before(panel);
  }

  function boot() {
    window.clearTimeout(bootTimer);
    bootTimer = window.setTimeout(() => {
      if (isAuctionPage()) {
        ensurePageCoreInjected().catch(() => {});
      }
      ensureUi();
    }, 100);
  }

  function scheduleRefresh() {
    if (!document.getElementById(UI_ID)) {
      boot();
      return;
    }

    const signature = getItemSetSignature();
    if (!signature || signature === lastItemSetSignature) return;

    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(sortItems, 150);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "GLAD_AH_APPLY_SORT") {
        const option = SORT_OPTIONS.find((candidate) => candidate.id === message.sortId);
        if (!option) {
          sendResponse({ ok: false, error: "Unknown auction sort preset." });
          return false;
        }

        applySortSelection(option.id);
        sendResponse({ ok: true });
        return false;
      }

      if (message?.type !== "GLAD_AH_SCAN_ALL") return false;

      callPageCore("scanAllAuctionItems")
        .then((result) => sendResponse({ ok: true, result }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

      return true;
    });
  }

  const observer = new MutationObserver(() => {
    scheduleRefresh();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
