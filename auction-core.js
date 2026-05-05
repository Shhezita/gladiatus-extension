(() => {
  if (window.GladiatusAuctionCore) {
    if (shouldInstallPageBridge()) {
      installPageBridge(window.GladiatusAuctionCore);
    }
    return;
  }

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

  function isAuctionPage(doc = document) {
    try {
      return new URL(doc.location?.href || window.location.href).searchParams.get("mod") === "auction";
    } catch {
      return false;
    }
  }

  function keyForStat(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function stripHtml(value, doc = document) {
    const scratch = doc.createElement("div");
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

  function parseTooltipLines(icon, doc = icon.ownerDocument || document) {
    const raw = icon.dataset?.tooltip || icon.getAttribute("data-tooltip") || "";
    if (!raw) return [];

    try {
      const tooltip = JSON.parse(raw);
      const itemLines = Array.isArray(tooltip) && Array.isArray(tooltip[0]) ? tooltip[0] : [];
      return itemLines
        .map((entry) => stripHtml(Array.isArray(entry) ? entry[0] : entry, doc))
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

  function getFilterForm(doc = document) {
    return Array.from(doc.querySelectorAll("#content form, form"))
      .find((form) => form.querySelector("select[name='itemType']"));
  }

  function getAuctionId(form, fallbackIndex) {
    const input = form.querySelector("input[name='auctionid']");
    return input && input.value ? input.value : String(fallbackIndex);
  }

  function readSharedFilterValues(form) {
    const valueOf = (selector, fallback = "") => form.querySelector(selector)?.value ?? fallback;

    return {
      qry: valueOf("input[name='qry']"),
      itemLevel: valueOf("select[name='itemLevel']", "39"),
      itemQuality: valueOf("select[name='itemQuality']", "-1")
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

  function makeFilterBody(form, itemType, sharedFilters) {
    const body = new URLSearchParams(new FormData(form));
    body.set("itemType", itemType);
    body.set("qry", sharedFilters.qry || "");
    body.set("itemLevel", sharedFilters.itemLevel || "39");
    body.set("itemQuality", sharedFilters.itemQuality || "-1");
    return body;
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
    const items = [];
    const scannedCategories = [];

    for (const type of MAIN_SCAN_TYPES) {
      const doc = await loadFilteredAuctionDocument(makeAuctionUrl(), filterForm, type.value, sharedFilters);
      scannedCategories.push(type.label);
      items.push(...parseAuctionItemsFromDocument(doc, {
        category: type.label,
        group: "Gladiator necessities",
        itemType: type.value
      }));
    }

    const mercenaryUrl = makeAuctionUrl("3");
    const mercenaryBaseDoc = await loadAuctionDocument(mercenaryUrl);
    const mercenaryForm = getFilterForm(mercenaryBaseDoc);

    if (mercenaryForm) {
      for (const type of MERCENARY_EQUIPMENT_SCAN_TYPES) {
        const doc = await loadFilteredAuctionDocument(mercenaryUrl, mercenaryForm, type.value, sharedFilters);
        scannedCategories.push(type.label);
        items.push(...parseAuctionItemsFromDocument(doc, {
          category: type.label,
          group: "Mercenary necessities",
          itemType: type.value
        }));
      }
    }

    return {
      scannedAt: new Date().toISOString(),
      categoriesScanned: scannedCategories.length,
      filterSummary: formatFilterSummary(sharedFilters),
      items: sortScannedItems(items)
    };
  }

  async function loadFilteredAuctionDocument(url, form, itemType, sharedFilters) {
    const body = makeFilterBody(form, itemType, sharedFilters);

    try {
      return await fetchDocument(url, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      });
    } catch {
      return await loadDocumentViaForm(url, body, "POST");
    }
  }

  async function loadAuctionDocument(url) {
    try {
      return await fetchDocument(url, { credentials: "same-origin" });
    } catch {
      return await loadDocumentViaFrame(url);
    }
  }

  async function fetchDocument(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) {
      throw new Error(`Auction fetch failed with HTTP ${response.status}.`);
    }

    return new DOMParser().parseFromString(await response.text(), "text/html");
  }

  function loadDocumentViaFrame(url) {
    return new Promise((resolve, reject) => {
      const iframe = makeHiddenFrame();
      const timeout = window.setTimeout(() => {
        cleanupFrame(iframe);
        reject(new Error("Auction iframe load timed out."));
      }, 20000);

      iframe.addEventListener("load", () => {
        window.clearTimeout(timeout);
        try {
          resolve(copyFrameDocument(iframe));
        } catch (error) {
          reject(error);
        } finally {
          cleanupFrame(iframe);
        }
      }, { once: true });

      iframe.src = url;
      document.documentElement.append(iframe);
    });
  }

  function loadDocumentViaForm(url, body, method) {
    return new Promise((resolve, reject) => {
      const iframe = makeHiddenFrame();
      const form = document.createElement("form");
      const timeout = window.setTimeout(() => {
        cleanupFrame(iframe, form);
        reject(new Error("Auction form load timed out."));
      }, 20000);

      iframe.addEventListener("load", () => {
        window.clearTimeout(timeout);
        try {
          resolve(copyFrameDocument(iframe));
        } catch (error) {
          reject(error);
        } finally {
          cleanupFrame(iframe, form);
        }
      }, { once: true });

      form.method = method;
      form.action = url;
      form.target = iframe.name;
      form.style.display = "none";

      for (const [name, value] of body.entries()) {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = name;
        input.value = value;
        form.append(input);
      }

      document.documentElement.append(iframe, form);
      form.submit();
    });
  }

  function makeHiddenFrame() {
    const iframe = document.createElement("iframe");
    iframe.name = `glad-ah-scan-frame-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    iframe.style.cssText = "display:none !important;width:0;height:0;border:0;";
    return iframe;
  }

  function copyFrameDocument(iframe) {
    const doc = iframe.contentDocument;
    if (!doc || !doc.documentElement) {
      throw new Error("Could not read the loaded auction document.");
    }

    return new DOMParser().parseFromString(doc.documentElement.outerHTML, "text/html");
  }

  function cleanupFrame(iframe, form) {
    iframe.remove();
    if (form) form.remove();
  }

  function parseAuctionItemsFromDocument(doc, meta = {}) {
    return Array.from(doc.querySelectorAll(CARD_SELECTOR))
      .map((form, index) => {
        const icon = form.querySelector("[data-tooltip]");
        if (!icon) return null;

        const lines = parseTooltipLines(icon, doc);
        const parsed = parseStats(lines);

        return {
          auctionId: getAuctionId(form, index),
          category: meta.category || "",
          group: meta.group || "",
          itemType: meta.itemType || "",
          name: lines[0] || "Unknown item",
          priceGold: parseInteger(icon.dataset?.priceGold || icon.getAttribute("data-price-gold")),
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

  const api = {
    constants: {
      statNames: STAT_NAMES,
      mainScanTypes: MAIN_SCAN_TYPES,
      mercenaryEquipmentScanTypes: MERCENARY_EQUIPMENT_SCAN_TYPES
    },
    isAuctionPage,
    parseInteger,
    parseSignedBonus,
    parseDamageRange,
    parseTooltipLines,
    parseStats,
    parseAuctionItemsFromDocument,
    scanAllAuctionItems
  };

  window.GladiatusAuctionCore = api;

  if (shouldInstallPageBridge()) {
    installPageBridge(api);
  }

  function shouldInstallPageBridge() {
    const hasExtensionRuntime = typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
    return document.currentScript?.dataset.gladAuctionPageBridge === "1" || !hasExtensionRuntime;
  }

  function installPageBridge(coreApi) {
    if (window.__GladiatusAuctionCoreBridgeInstalled) return;
    window.__GladiatusAuctionCoreBridgeInstalled = true;

    window.addEventListener("message", async (event) => {
      if (event.source !== window || event.data?.source !== "glad-ah-extension" || !event.data?.id) return;

      const { id, method, args = [] } = event.data;
      try {
        if (typeof coreApi[method] !== "function") {
          throw new Error(`Unknown GladiatusAuctionCore method: ${method}`);
        }

        const result = await coreApi[method](...args);
        window.postMessage({ source: "glad-ah-page", id, ok: true, result }, "*");
      } catch (error) {
        window.postMessage({ source: "glad-ah-page", id, ok: false, error: error.message || String(error) }, "*");
      }
    });

    window.postMessage({ source: "glad-ah-page", type: "ready" }, "*");
  }
})();
