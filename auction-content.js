(() => {
  const CONTENT_VERSION = "auction-content-split-v2";
  const UI_ID = "glad-ah-sorter";
  const BADGE_CLASS = "glad-ah-score";
  const CARD_SELECTOR = "form[id^='auctionForm']";
  const MESSAGE_TYPES = {
    applySort: new Set(["GLAD_AH_APPLY_SORT", "GLAD_AH_APPLY_SORT_V2"]),
    boot: new Set(["GLAD_AH_BOOT", "GLAD_AH_BOOT_V2"]),
    customDefinitionsUpdated: new Set(["GLAD_AH_CUSTOM_DEFINITIONS_UPDATED", "GLAD_AH_CUSTOM_DEFINITIONS_UPDATED_V2"]),
    repair: new Set(["GLAD_AH_REPAIR_AUCTION_CONTENT"]),
    scanAll: new Set(["GLAD_AH_SCAN_ALL", "GLAD_AH_SCAN_ALL_V2"])
  };

  if (!isAuctionPageUrl(window.location.href)) return;

  const missingDependencies = getMissingDependencies();
  if (missingDependencies.length) {
    registerMissingDependencyDiagnostics(missingDependencies);
    requestDependencyRepair(missingDependencies);
    return;
  }
  clearMissingDependencyDiagnostics();

  const { SCHEMA, MODEL, CORE } = getDependencies();

  if (window.__GladiatusAuctionContentLoaded
    && window.__GladiatusAuctionContentVersion === CONTENT_VERSION
    && typeof window.__GladiatusAuctionBoot === "function") {
    window.__GladiatusAuctionBoot();
    return;
  }
  window.__GladiatusAuctionContentLoaded = true;
  window.__GladiatusAuctionContentVersion = CONTENT_VERSION;

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

  function getMissingDependencies() {
    const dependencies = getDependencies();
    const missing = [];
    if (!dependencies.SCHEMA) missing.push("auction-schema.js");
    if (!dependencies.SCORE) missing.push("score-model.js");
    if (!dependencies.MODEL) missing.push("auction-model.js");
    if (!dependencies.CORE) missing.push("auction-core.js");
    return missing;
  }

  function getDependencies() {
    return {
      SCHEMA: window.GladiatusAuctionSchema,
      SCORE: window.GladiatusScoreModel,
      MODEL: window.GladiatusAuctionModel,
      CORE: window.GladiatusAuctionCore
    };
  }

  function registerMissingDependencyDiagnostics(missing) {
    if (typeof chrome === "undefined" || !chrome.runtime?.onMessage) return;
    if (window.__GladiatusAuctionMissingDependencyListener) return;

    const listener = (message, _sender, sendResponse) => {
      if (!isAuctionMessage(message)) return false;
      const nextMissing = getMissingDependencies();
      if (!nextMissing.length) {
        clearMissingDependencyDiagnostics();
        return false;
      }

      sendResponse({ ok: false, error: formatMissingDependencyError(nextMissing) });
      return false;
    };
    window.__GladiatusAuctionMissingDependencyListener = listener;
    chrome.runtime.onMessage.addListener(listener);
  }

  function requestDependencyRepair(missing) {
    if (window.__GladiatusAuctionRepairRequested) return;
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;

    window.__GladiatusAuctionRepairRequested = true;
    chrome.runtime.sendMessage({
      type: "GLAD_AH_REPAIR_AUCTION_CONTENT",
      missing
    }, () => {
      if (chrome.runtime.lastError) {
        window.__GladiatusAuctionRepairRequested = false;
      }
    });
  }

  function clearMissingDependencyDiagnostics() {
    const listener = window.__GladiatusAuctionMissingDependencyListener;
    if (!listener || typeof chrome === "undefined" || !chrome.runtime?.onMessage) return;
    chrome.runtime.onMessage.removeListener(listener);
    delete window.__GladiatusAuctionMissingDependencyListener;
    delete window.__GladiatusAuctionRepairRequested;
  }

  function isAuctionMessage(message) {
    return isMessageType(message, MESSAGE_TYPES.boot)
      || isMessageType(message, MESSAGE_TYPES.scanAll)
      || isMessageType(message, MESSAGE_TYPES.applySort)
      || isMessageType(message, MESSAGE_TYPES.customDefinitionsUpdated);
  }

  function isMessageType(message, types) {
    return types.has(message?.type);
  }

  function formatMissingDependencyError(missing) {
    return `Auction content script dependencies missing: ${missing.join(", ")}. Reload the unpacked extension and refresh this auction tab.`;
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
  const PAGE_BRIDGE_REQUEST_SOURCE = CORE.constants.pageBridgeRequestSource || "glad-ah-extension";
  const PAGE_BRIDGE_RESPONSE_SOURCE = CORE.constants.pageBridgeResponseSource || "glad-ah-page";
  const PAGE_SCHEMA_SCRIPT_ID = `glad-ah-page-schema-${CORE.version || CONTENT_VERSION}`;
  const PAGE_CORE_SCRIPT_ID = `glad-ah-page-core-${CORE.version || CONTENT_VERSION}`;

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
        if (event.source !== window || event.data?.source !== PAGE_BRIDGE_RESPONSE_SOURCE || event.data.id !== id) return;

        window.clearTimeout(timeout);
        window.removeEventListener("message", onMessage);

        if (event.data.ok) {
          resolve(event.data.result);
        } else {
          reject(new Error(event.data.error || "The auction scanner failed."));
        }
      }

      window.addEventListener("message", onMessage);
      window.postMessage({ source: PAGE_BRIDGE_REQUEST_SOURCE, id, method, args }, "*");
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

  function getAuctionFilterForm() {
    return Array.from(document.querySelectorAll("#content form, form"))
      .find((form) => form.querySelector("select[name='itemType']")) || null;
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
    const fragment = document.createDocumentFragment();
    let row = null;
    items.forEach((item, index) => {
      item.cell.classList.remove("glad-ah-filtered-hidden");
      if (index % 2 === 0) {
        row = document.createElement("tr");
        fragment.append(row);
      }
      row.append(item.cell);
    });
    tbody.append(fragment);
  }

  function appendHiddenStash(items, tbody) {
    if (!items.length) return;

    const row = document.createElement("tr");
    row.className = "glad-ah-filter-stash";

    items.forEach((item) => {
      item.cell.classList.add("glad-ah-filtered-hidden");
      row.append(item.cell);
    });

    tbody.append(row);
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
    const anchor = table || getAuctionFilterForm() || document.querySelector("#content");
    if (!anchor) return;

    const panel = document.createElement("div");
    panel.id = UI_ID;

    const title = document.createElement("strong");
    title.style.display = "inline-flex";
    title.style.alignItems = "center";
    title.style.gap = "6px";
    title.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color: var(--glad-border-focus);"><path d="m14.5 16 3.5-3.5L14.5 9"/><path d="M9.5 8 6 11.5l3.5 3.5"/><path d="M16 4v16M8 4v16"/></svg> Auction Sorter`;

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
    insertPanel(panel, table, anchor);
    updateOrderButton();
    sortItems();
  }

  function insertPanel(panel, table, anchor) {
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

    if (anchor.tagName === "FORM") {
      anchor.after(panel);
      return;
    }

    anchor.prepend(panel);
  }

  function boot() {
    window.clearTimeout(bootTimer);
    bootTimer = window.setTimeout(() => {
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
      if (isMessageType(message, MESSAGE_TYPES.applySort)) {
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

      if (isMessageType(message, MESSAGE_TYPES.customDefinitionsUpdated)) {
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

      if (isMessageType(message, MESSAGE_TYPES.boot)) {
        boot();
        sendResponse({
          ok: true,
          isAuctionPage: isAuctionPage(),
          hasPanel: Boolean(document.getElementById(UI_ID)),
          itemForms: document.querySelectorAll(CARD_SELECTOR).length,
          hasFilterForm: Boolean(getAuctionFilterForm())
        });
        return false;
      }

      if (!isMessageType(message, MESSAGE_TYPES.scanAll)) return false;

      handleScanAll()
        .then((result) => sendResponse({ ok: true, result }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

      return true;
    });
  }

  const observer = new MutationObserver(() => {
    scheduleRefresh();
  });

  function getAuctionFilterFingerprint() {
    const form = getAuctionFilterForm();
    if (!form) return "";
    const valueOf = (selector, fallback = "") => form.querySelector(selector)?.value ?? fallback;
    return JSON.stringify({
      ttype: new URL(window.location.href).searchParams.get("ttype") || "main",
      itemType: valueOf("select[name='itemType']"),
      qry: valueOf("input[name='qry']"),
      itemLevel: valueOf("select[name='itemLevel']", "39"),
      itemQuality: valueOf("select[name='itemQuality']", "-1"),
      signature: getItemSetSignature()
    });
  }

  async function handleScanAll() {
    if (!chrome.storage?.local) return callPageCore("scanAllAuctionItems");

    const fingerprint = getAuctionFilterFingerprint();
    const LOCK_TIMEOUT_MS = 5 * 60 * 1000;
    const CACHE_KEY = "glad-ah-scan-cache-v2";

    const stored = await chrome.storage.local.get(CACHE_KEY);
    const cache = stored[CACHE_KEY] || {};

    if (cache.result && cache.fingerprint === fingerprint) {
      return cache.result;
    }

    const now = Date.now();
    const lockStartedAt = Date.parse(cache.lock?.startedAt || "");
    if (cache.lock?.id && Number.isFinite(lockStartedAt) && now - lockStartedAt < LOCK_TIMEOUT_MS) {
      throw new Error("Scan in progress");
    }

    const lockId = `${now}-${Math.random().toString(36).slice(2)}`;
    cache.lock = { id: lockId, startedAt: new Date(now).toISOString() };
    await chrome.storage.local.set({ [CACHE_KEY]: cache });

    const confirmed = await chrome.storage.local.get(CACHE_KEY);
    if (confirmed[CACHE_KEY]?.lock?.id !== lockId) {
      throw new Error("Scan in progress");
    }

    try {
      const result = await callPageCore("scanAllAuctionItems");
      const nextCache = await chrome.storage.local.get(CACHE_KEY);
      const updated = nextCache[CACHE_KEY] || {};
      updated.fingerprint = fingerprint;
      updated.result = result;
      delete updated.lock;
      await chrome.storage.local.set({ [CACHE_KEY]: updated });
      return result;
    } catch (error) {
      const nextCache = await chrome.storage.local.get(CACHE_KEY);
      const updated = nextCache[CACHE_KEY] || {};
      if (updated.lock?.id === lockId) {
        delete updated.lock;
        await chrome.storage.local.set({ [CACHE_KEY]: updated });
      }
      throw error;
    }
  }

  initialize().catch(() => {
    boot();
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
})();
