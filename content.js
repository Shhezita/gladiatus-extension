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
  const SORT_OPTIONS = [
    { id: "original", label: "Original order", get: (item) => -item.originalIndex },
    { id: "primaryTotal", label: "Primary stat total", get: (item) => sumKeys(item.stats, PRIMARY_STATS) },
    { id: "strength", label: "Strength", get: (item) => item.stats.strength || 0 },
    { id: "dexterity", label: "Dexterity", get: (item) => item.stats.dexterity || 0 },
    { id: "agility", label: "Agility", get: (item) => item.stats.agility || 0 },
    { id: "constitution", label: "Constitution", get: (item) => item.stats.constitution || 0 },
    { id: "charisma", label: "Charisma", get: (item) => item.stats.charisma || 0 },
    { id: "intelligence", label: "Intelligence", get: (item) => item.stats.intelligence || 0 },
    { id: "lifepoints", label: "Life points", get: (item) => item.stats.lifepoints || 0 },
    { id: "damageBonus", label: "Damage bonus", get: (item) => item.stats.damageBonus || 0 },
    { id: "health", label: "Health", get: (item) => item.stats.health || 0 },
    { id: "armour", label: "Armour", get: (item) => item.stats.armour || 0 },
    { id: "blockvalue", label: "Block value", get: (item) => item.stats.blockvalue || 0 },
    { id: "healing", label: "Healing", get: (item) => item.stats.healing || 0 },
    { id: "criticalattackvalue", label: "Critical attack", get: (item) => item.stats.criticalattackvalue || 0 },
    { id: "criticalhealingvalue", label: "Critical healing", get: (item) => item.stats.criticalhealingvalue || 0 },
    { id: "criticaldamage", label: "Critical damage", get: (item) => item.stats.criticaldamage || 0 },
    { id: "threat", label: "Threat", get: (item) => item.stats.threat || 0 },
    { id: "hardeningvalue", label: "Hardening", get: (item) => item.stats.hardeningvalue || 0 },
    { id: "damageAvg", label: "Damage average", get: (item) => item.stats.damageAvg || 0 },
    { id: "damageMax", label: "Damage max", get: (item) => item.stats.damageMax || 0 },
    { id: "level", label: "Level", get: (item) => item.level || 0 },
    { id: "itemValue", label: "Item value", get: (item) => item.itemValue || 0 },
    { id: "buyoutGold", label: "Immediate gold", get: (item) => item.priceGold || 0, defaultAscending: true }
  ];

  let selectedSort = "strength";
  let descending = true;
  let bootTimer = 0;
  let refreshTimer = 0;
  let lastItemSetSignature = "";

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

  function parseSignedBonus(line) {
    const parenthesized = Array.from(line.matchAll(/\(([+-]?\d+)\)/g));
    if (parenthesized.length) {
      return parenthesized.reduce((total, match) => total + (Number.parseInt(match[1], 10) || 0), 0);
    }

    const directValues = Array.from(line.matchAll(/[+-]\d+/g));
    return directValues.reduce((total, match) => total + (Number.parseInt(match[0], 10) || 0), 0);
  }

  function parseDamageRange(line) {
    const ranges = Array.from(line.matchAll(/([+-]?\d+)\s*-\s*([+-]?\d+)/g));
    if (!ranges.length) return null;

    return ranges.reduce(
      (total, match) => {
        total.min += Number.parseInt(match[1], 10) || 0;
        total.max += Number.parseInt(match[2], 10) || 0;
        return total;
      },
      { min: 0, max: 0 }
    );
  }

  function parseTooltipLines(icon) {
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
    const stats = {};
    let level = 0;
    let itemValue = 0;

    for (const line of lines) {
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
    for (const statName of STAT_NAMES) {
      const statPattern = new RegExp(`\\b${escapeRegExp(statName)}\\b`, "i");
      if (!statPattern.test(text)) continue;

      const key = statName.toLowerCase() === "damage" ? "damageBonus" : keyForStat(statName);
      stats[key] = (stats[key] || 0) + parseSignedBonus(text);
      return;
    }
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
          ...parsed
        };
      })
      .filter(Boolean);
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

  function sortItems() {
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
      badge.textContent = `${formatScore(score)} ${option.label}`;
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
    SORT_OPTIONS.forEach((option) => {
      const optionEl = document.createElement("option");
      optionEl.value = option.id;
      optionEl.textContent = option.label;
      select.append(optionEl);
    });
    select.value = selectedSort;
    select.addEventListener("change", () => {
      selectedSort = select.value;
      const option = getSelectedOption();
      if (option.defaultAscending) descending = false;
      updateOrderButton();
      sortItems();
    });
    return select;
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
    table.before(panel);
    updateOrderButton();
    sortItems();
  }

  function boot() {
    window.clearTimeout(bootTimer);
    bootTimer = window.setTimeout(ensureUi, 100);
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

  const observer = new MutationObserver(() => {
    scheduleRefresh();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
