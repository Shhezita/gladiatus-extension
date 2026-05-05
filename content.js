(() => {
  const UI_ID = "glad-ah-sorter";
  const BADGE_CLASS = "glad-ah-score";
  const CARD_SELECTOR = "form[id^='auctionForm']";
  const SCHEMA = window.GladiatusAuctionSchema;
  const MODEL = window.GladiatusAuctionModel;
  const CORE = window.GladiatusAuctionCore;
  if (!SCHEMA || !MODEL || !CORE) {
    if (!isAuctionPageUrl(window.location.href)) return;
    throw new Error("Gladiatus auction schema, model, and core must load before the content script.");
  }
  if (window.__GladiatusAuctionContentLoaded && typeof window.__GladiatusAuctionBoot === "function") {
    window.__GladiatusAuctionBoot();
    return;
  }
  window.__GladiatusAuctionContentLoaded = true;

  function isAuctionPageUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname.endsWith(".gladiatus.gameforge.com")
        && parsed.pathname.endsWith("/game/index.php")
        && parsed.searchParams.get("mod") === "auction";
    } catch {
      return false;
    }
  }

  const BASE_SORT_OPTIONS = [
    { id: "original", label: "Original order", group: "Base fields", get: (item) => -item.originalIndex },
    { id: "primaryTotal", label: "Primary stat total", group: "Base fields", get: (item) => sumKeys(item.stats, SCHEMA.primaryStatKeys) },
    ...makeBaseStatSortOptions(),
    { id: "level", label: "Level", group: "Base fields", get: (item) => item.level || 0 },
    { id: "itemValue", label: "Item value", group: "Base fields", get: (item) => item.itemValue || 0 },
    { id: "buyoutGold", label: "Immediate gold", group: "Base fields", get: (item) => item.priceGold || 0, defaultAscending: true }
  ];
  let customDefinitions = [];
  const STORAGE_KEY = SCHEMA.storageKeys.sortState;
  const FILTER_VALUES_STORAGE_KEY = MODEL.filterValuesStorageKey;
  const PAGE_SCHEMA_SCRIPT_ID = "glad-ah-page-schema";
  const PAGE_CORE_SCRIPT_ID = "glad-ah-page-core";

  const initialState = readSortState();
  let selectedSort = initialState.selectedSort;
  let descending = initialState.descending;
  let filterValuesByView = MODEL.normalizeAllFilterValues(initialState.filterValuesByView);
  let sortContextKey = getSortContextKey();
  let bootTimer = 0;
  let refreshTimer = 0;
  let lastItemSetSignature = "";
  let pageCoreLoadPromise = null;

  function makeBaseStatSortOptions() {
    const keys = [
      "strength",
      "dexterity",
      "agility",
      "constitution",
      "charisma",
      "intelligence",
      "lifepoints",
      "damageBonus",
      "health",
      "armour",
      "blockvalue",
      "healing",
      "criticalattackvalue",
      "criticalhealingvalue",
      "criticaldamage",
      "threat",
      "hardeningvalue",
      "damageAvg",
      "damageMax"
    ];
    const groups = {
      damageAvg: "Base fields",
      damageMax: "Base fields",
      blockvalue: "Tank stats",
      healing: "Tank stats",
      criticalhealingvalue: "Tank stats",
      threat: "Tank stats",
      hardeningvalue: "Tank stats"
    };

    return keys.map((key) => ({
      id: key,
      label: longStatLabel(key),
      group: groups[key] || "Base stats",
      get: (item) => MODEL.stat(item, key)
    }));
  }

  function longStatLabel(key) {
    const labels = {
      damageAvg: "Damage average",
      damageMax: "Damage max",
      damageBonus: "Damage bonus",
      lifepoints: "Life points",
      blockvalue: "Block value",
      criticalattackvalue: "Critical attack",
      criticalhealingvalue: "Critical healing",
      criticaldamage: "Critical damage"
    };
    return labels[key] || SCHEMA.statLabel(key);
  }

  function getSortOptions() {
    return [...MODEL.getPresetSortOptions(customDefinitions), ...BASE_SORT_OPTIONS];
  }

  async function loadCustomDefinitions() {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      customDefinitions = [];
      return;
    }

    const result = await chrome.storage.local.get(MODEL.customDefinitionsStorageKey);
    customDefinitions = MODEL.normalizeCustomDefinitions(result[MODEL.customDefinitionsStorageKey]);
  }

  function refreshStateFromStorage() {
    const state = readSortState();
    selectedSort = state.selectedSort;
    descending = state.descending;
  }

  function ensurePageCoreInjected() {
    if (typeof chrome === "undefined" || !chrome.runtime?.getURL) return Promise.resolve();
    if (document.getElementById(PAGE_CORE_SCRIPT_ID)) return Promise.resolve();
    if (pageCoreLoadPromise) return pageCoreLoadPromise;

    pageCoreLoadPromise = injectPageScript("auction-schema.js", PAGE_SCHEMA_SCRIPT_ID)
      .then(() => injectPageScript("auction-core.js", PAGE_CORE_SCRIPT_ID, { gladAuctionPageBridge: "1" }));

    return pageCoreLoadPromise;
  }

  function injectPageScript(file, id, dataset = {}) {
    if (document.getElementById(id)) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.id = id;
      script.src = chrome.runtime.getURL(file);
      Object.assign(script.dataset, dataset);
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Could not inject ${file}.`));
      (document.head || document.documentElement).append(script);
    });
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
    const defaults = {
      selectedSort: getContextDefaultSortId(),
      descending: true,
      filterValuesByView: {}
    };

    try {
      const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null");
      if (!saved || typeof saved !== "object") return defaults;
      const filterValuesByView = saved.filterByView && typeof saved.filterByView === "object" ? saved.filterByView : {};

      const contextState = saved.byItemType?.[getSortContextKey()];
      if (!contextState || typeof contextState !== "object") {
        return { ...defaults, filterValuesByView };
      }

      const selectedOption = getSortOptions().find((option) => option.id === contextState.selectedSort && isSortOptionVisibleForCurrentView(option));
      if (!selectedOption) return { ...defaults, filterValuesByView };

      return {
        selectedSort: selectedOption.id,
        descending: typeof contextState.descending === "boolean" ? contextState.descending : !selectedOption.defaultAscending,
        filterValuesByView
      };
    } catch {
      return defaults;
    }
  }

  function getContextDefaultSortId() {
    return MODEL.defaultPresetForItemType(getCurrentItemType());
  }

  function getCurrentView() {
    return MODEL.getViewForItemType(getCurrentItemType()) || MODEL.getView("armor");
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

  function getFilterValues(viewId) {
    return MODEL.normalizeFilterValues(viewId, filterValuesByView[viewId]);
  }

  function setFilterValue(viewId, filterId, value) {
    filterValuesByView = {
      ...filterValuesByView,
      [viewId]: {
        ...getFilterValues(viewId),
        [filterId]: value
      }
    };
  }

  function setFilterValues(viewId, values) {
    filterValuesByView = {
      ...filterValuesByView,
      [viewId]: MODEL.normalizeFilterValues(viewId, values)
    };
  }

  async function loadSharedFilterValues() {
    const legacy = readSortState().filterValuesByView;
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      return MODEL.normalizeAllFilterValues(legacy);
    }

    const result = await chrome.storage.local.get(FILTER_VALUES_STORAGE_KEY);
    return MODEL.normalizeAllFilterValues(result[FILTER_VALUES_STORAGE_KEY] || legacy);
  }

  async function saveSharedFilterValues() {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return;
    await chrome.storage.local.set({ [FILTER_VALUES_STORAGE_KEY]: MODEL.normalizeAllFilterValues(filterValuesByView) });
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

  function getAuctionTable() {
    const firstForm = document.querySelector(CARD_SELECTOR);
    return firstForm ? firstForm.closest("table") : null;
  }

  function getCurrentCategoryMeta() {
    const ttype = new URL(window.location.href).searchParams.get("ttype") || "";
    return SCHEMA.getCategoryForItemType(getCurrentItemType(), ttype) || {
      itemType: getCurrentItemType(),
      ttype,
      viewId: MODEL.getViewForItemType(getCurrentItemType())?.id || "armor"
    };
  }

  function collectItems() {
    const seenCells = new Set();
    const meta = getCurrentCategoryMeta();
    return Array.from(document.querySelectorAll(CARD_SELECTOR))
      .map((form, index) => {
        const cell = form.closest("td");
        if (!cell || seenCells.has(cell)) return null;
        seenCells.add(cell);

        if (!cell.dataset.gladAhOriginalIndex) {
          cell.dataset.gladAhOriginalIndex = String(index);
        }

        const parsedItem = CORE.parseAuctionItemFromForm(form, index, meta);
        if (!parsedItem) return null;

        const originalIndex = Number.parseInt(cell.dataset.gladAhOriginalIndex, 10) || index;

        return {
          ...parsedItem,
          cell,
          form,
          icon: form.querySelector("[data-tooltip]"),
          originalIndex
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
    const options = getSortOptions();
    return options.find((option) => option.id === selectedSort && isSortOptionVisibleForCurrentView(option)) || options[0];
  }

  function isSortOptionVisibleForCurrentView(option) {
    return !option.viewId || option.viewId === getCurrentView().id;
  }

  function getVisibleSortOptions() {
    return getSortOptions().filter(isSortOptionVisibleForCurrentView);
  }

  function refreshSortContext() {
    const nextContextKey = getSortContextKey();
    if (nextContextKey === sortContextKey) return;

    sortContextKey = nextContextKey;
    const state = readSortState();
    selectedSort = state.selectedSort;
    descending = state.descending;
    renderSortSelectOptions();
    syncSortSelect();
    updateOrderButton();
    renderFilterControls();
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
    const view = getCurrentView();
    const filterValues = getFilterValues(view.id);
    const visibleItems = [];
    const hiddenItems = [];

    for (const item of items) {
      const matchesViewFilters = MODEL.itemMatchesFilters(item, view.id, filterValues);
      const matchesSelectedPreset = !option.matches || option.matches(item);
      if (matchesViewFilters && matchesSelectedPreset) {
        visibleItems.push(item);
      } else {
        hiddenItems.push(item);
      }
    }

    visibleItems.sort((a, b) => {
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
    appendTwoColumnRows(visibleItems, tbody);
    appendHiddenStash(hiddenItems, tbody);
    clearBadges(items);
    updateBadges(visibleItems, option);
    updateItemCount(visibleItems.length, items.length);
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
      item.cell.classList.remove("glad-ah-filtered-hidden");
      if (index % 2 === 0) {
        row = document.createElement("tr");
        tbody.append(row);
      }
      row.append(item.cell);
    });
  }

  function appendHiddenStash(items, tbody) {
    if (!items.length) return;

    const row = document.createElement("tr");
    row.className = "glad-ah-filter-stash";
    tbody.append(row);

    items.forEach((item) => {
      item.cell.classList.add("glad-ah-filtered-hidden");
      row.append(item.cell);
    });
  }

  function clearBadges(items) {
    items.forEach((item) => {
      item.cell.querySelectorAll(`.${BADGE_CLASS}`).forEach((badge) => badge.remove());
    });
  }

  function updateBadges(items, option) {
    items.forEach((item) => {
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

  function updateItemCount(count, total = count) {
    const countNode = document.querySelector(`#${UI_ID} .glad-ah-count`);
    if (countNode) countNode.textContent = count === total ? `${count} items` : `${count} / ${total} items`;
  }

  function formatScore(score) {
    return Number.isInteger(score) ? String(score) : score.toFixed(1);
  }

  function makeSelect() {
    const select = document.createElement("select");
    select.id = "glad-ah-sort-field";
    renderSortSelectOptions(select);
    select.addEventListener("change", () => {
      applySortSelection(select.value);
    });
    return select;
  }

  function renderSortSelectOptions(select = document.getElementById("glad-ah-sort-field")) {
    if (!select) return;

    select.replaceChildren();
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
  }

  function groupSortOptions() {
    const groups = new Map();

    getVisibleSortOptions().forEach((option) => {
      const group = option.group || "Other";
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(option);
    });

    return groups.entries();
  }

  function applySortSelection(sortId) {
    const option = getSortOptions().find((candidate) => candidate.id === sortId && isSortOptionVisibleForCurrentView(candidate));
    if (!option || !isSortOptionVisibleForCurrentView(option)) return;

    selectedSort = option.id;
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

  function makeFilterControls() {
    const controls = document.createElement("span");
    controls.id = "glad-ah-filter-controls";
    renderFilterControls(controls);
    return controls;
  }

  function renderFilterControls(container = document.getElementById("glad-ah-filter-controls")) {
    if (!container) return;

    const view = getCurrentView();
    const filterValues = getFilterValues(view.id);
    const controls = MODEL.getFilterControlDescriptors(view.id, filterValues);
    container.replaceChildren();

    if (!controls.length) return;

    const title = document.createElement("span");
    title.className = "glad-ah-filter-title";
    title.textContent = "Filters";
    container.append(title);

    for (const filter of controls) {
      const label = document.createElement("label");
      label.className = "glad-ah-filter-control";

      const text = document.createElement("span");
      text.textContent = filter.label;

      const input = document.createElement("input");
      input.type = filter.type;
      input.min = String(filter.min);
      input.step = String(filter.step);
      input.dataset.viewId = view.id;
      input.dataset.filterId = filter.id;
      input.value = filter.value;
      input.addEventListener("input", () => {
        setFilterValue(view.id, filter.id, input.value);
        saveSharedFilterValues().catch(() => {});
        sortItems();
      });

      label.append(text, input);
      container.append(label);
    }
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
    const filterControls = makeFilterControls();

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

    panel.append(title, label, select, orderButton, filterControls, applyButton, count);
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
  window.__GladiatusAuctionBoot = boot;

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

  async function initialize() {
    await loadCustomDefinitions();
    filterValuesByView = await loadSharedFilterValues();
    await saveSharedFilterValues();
    refreshStateFromStorage();

    if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local") return;

        if (changes[MODEL.customDefinitionsStorageKey]) {
          customDefinitions = MODEL.normalizeCustomDefinitions(changes[MODEL.customDefinitionsStorageKey].newValue);
          refreshStateFromStorage();
          renderSortSelectOptions();
          syncSortSelect();
          updateOrderButton();
          renderFilterControls();
          sortItems();
        }

        if (changes[FILTER_VALUES_STORAGE_KEY]) {
          const nextValues = MODEL.normalizeAllFilterValues(changes[FILTER_VALUES_STORAGE_KEY].newValue);
          if (MODEL.filterValuesEqual(filterValuesByView, nextValues)) return;

          filterValuesByView = nextValues;
          renderFilterControls();
          sortItems();
        }
      });
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
    } else {
      boot();
    }

    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "GLAD_AH_APPLY_SORT") {
        const option = getSortOptions().find((candidate) => candidate.id === message.sortId && isSortOptionVisibleForCurrentView(candidate));
        if (!option) {
          sendResponse({ ok: false, error: "Unknown auction sort preset." });
          return false;
        }

        if (message.viewId && message.filterValues) {
          setFilterValues(message.viewId, message.filterValues);
          saveSharedFilterValues().catch(() => {});
        }
        applySortSelection(option.id);
        renderFilterControls();
        sendResponse({ ok: true });
        return false;
      }

      if (message?.type === "GLAD_AH_CUSTOM_DEFINITIONS_UPDATED") {
        customDefinitions = MODEL.normalizeCustomDefinitions(message.definitions);
        refreshStateFromStorage();
        renderSortSelectOptions();
        syncSortSelect();
        updateOrderButton();
        renderFilterControls();
        sortItems();
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

  initialize().catch(() => {
    boot();
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
})();
