import { createArenaView } from "./popup/arena-view.js";
import { createAuctionView } from "./popup/auction-view.js";
import {
  ARENA,
  AUCTION_CONTENT_MESSAGES,
  MODEL,
  detectPageMode,
  ensureAuctionPageUi,
  getActiveTab,
  loadStorage,
  nodes,
  saveStorage,
  scanArenaOpponents,
  sendAuctionScanMessage,
  sendTabMessage,
  setStatus
} from "./popup/runtime.js";
import {
  FILTER_VALUES_STORAGE_KEY,
  POPUP_STATE_KEY,
  SCAN_STORAGE_KEY,
  archivePreviousScan,
  getFilterValues,
  getSelectedArenaFormula,
  getSelectedPreset,
  getView,
  loadArenaFormulas,
  makeNewArenaFormulaDraft,
  makeNewDefinitionDraft,
  normalizePopupState,
  normalizeScanResult,
  state
} from "./popup/store.js";

const auctionView = createAuctionView({ render, applyCurrentSortToPage });
const arenaView = createArenaView({ render });

nodes.scanButton.addEventListener("click", onScanButtonClick);
nodes.pageTabs.addEventListener("click", onPageTabClick);
nodes.tabs.addEventListener("click", onItemTabClick);
nodes.controls.addEventListener("click", onPresetClick);
nodes.controls.addEventListener("input", onControlInput);
nodes.controls.addEventListener("change", onControlInput);
nodes.results.addEventListener("click", onResultsClick);
nodes.results.addEventListener("input", onEditorInput);
nodes.results.addEventListener("change", onEditorInput);

init();

async function init() {
  state.activeTab = await getActiveTab();
  state.pageMode = detectPageMode(state.activeTab?.url);
  state.popupState = normalizePopupState(await loadStorage(POPUP_STATE_KEY));
  state.scanResult = await loadStorage(SCAN_STORAGE_KEY);
  state.arenaResult = await loadStorage(ARENA.resultsStorageKey);
  state.filterValuesByView = MODEL.normalizeAllFilterValues(await loadStorage(FILTER_VALUES_STORAGE_KEY) || state.popupState.filterByView);
  await saveStorage(FILTER_VALUES_STORAGE_KEY, state.filterValuesByView);
  state.customDefinitions = MODEL.normalizeCustomDefinitions(await loadStorage(MODEL.customDefinitionsStorageKey));
  state.arenaFormulas = await loadArenaFormulas();
  state.editorDraft = makeNewDefinitionDraft();
  state.arenaFormulaDraft = makeNewArenaFormulaDraft();
  subscribeToSharedFilterChanges();
  render();
  if (state.pageMode === "auction" && state.activeTab?.id) {
    ensureAuctionPageUi(state.activeTab).catch(() => {});
  }
}

function subscribeToSharedFilterChanges() {
  if (!chrome.storage?.onChanged) return;

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[FILTER_VALUES_STORAGE_KEY]) return;
    const nextValues = MODEL.normalizeAllFilterValues(changes[FILTER_VALUES_STORAGE_KEY].newValue);
    if (MODEL.filterValuesEqual(state.filterValuesByView, nextValues)) return;

    state.filterValuesByView = nextValues;
    if (state.popupState.pageId === "items") {
      auctionView.renderControls();
      auctionView.renderItems();
    }
  });
}

async function scanAuction() {
  nodes.scanButton.disabled = true;
  nodes.results.textContent = "";
  setStatus("Scanning auction categories...");

  try {
    const tab = await getActiveTab();
    if (!tab || !tab.id) throw new Error("No active tab found.");
    if (detectPageMode(tab.url) !== "auction") throw new Error("Open a Gladiatus auction page before scanning.");

    const response = await sendAuctionScanMessage(tab);
    if (!response || !response.ok) {
      throw new Error(response?.error || `The auction page did not return scan results. Response: ${JSON.stringify(response)}`);
    }

    const previousScan = state.scanResult;
    state.scanResult = normalizeScanResult(response.result);
    await archivePreviousScan(previousScan, state.scanResult);
    await saveStorage(SCAN_STORAGE_KEY, state.scanResult);
    state.popupState.pageId = "items";
    await saveStorage(POPUP_STATE_KEY, state.popupState);
    render();
  } catch (error) {
    setStatus(error.message || String(error));
  } finally {
    nodes.scanButton.disabled = false;
  }
}

async function onScanButtonClick() {
  if (state.pageMode === "arena") {
    await scanArena();
    return;
  }

  await scanAuction();
}

async function scanArena() {
  nodes.scanButton.disabled = true;
  nodes.results.textContent = "";
  setStatus("Scanning arena opponents...");

  try {
    state.activeTab = await getActiveTab();
    if (!state.activeTab?.id) throw new Error("No active tab found.");
    if (detectPageMode(state.activeTab.url) !== "arena") throw new Error("Open a Gladiatus arena page before scanning opponents.");

    const response = await scanArenaOpponents(state.activeTab, getSelectedArenaFormula());
    if (!response || !response.ok) {
      throw new Error(response?.error || "The arena page did not return scan results.");
    }

    state.arenaResult = response.result;
    await saveStorage(ARENA.resultsStorageKey, state.arenaResult);
    render();
  } catch (error) {
    setStatus(error.message || String(error));
  } finally {
    nodes.scanButton.disabled = false;
  }
}

function render() {
  configureHeader();

  if (state.pageMode === "arena") {
    arenaView.renderArenaPage();
    return;
  }

  if (state.pageMode !== "auction") {
    renderUnsupportedPage();
    return;
  }

  auctionView.renderPageTabs();

  if (state.popupState.pageId === "filters") {
    auctionView.renderFiltersPage();
  } else {
    auctionView.renderItemsPage();
  }
}

function configureHeader() {
  if (state.pageMode === "arena") {
    nodes.title.textContent = "Arena scanner";
    nodes.scanButton.textContent = "Scan opponents";
    nodes.scanButton.hidden = false;
    return;
  }

  if (state.pageMode === "auction") {
    nodes.title.textContent = "Auction scanner";
    nodes.scanButton.textContent = "Scan auction";
    nodes.scanButton.hidden = false;
    return;
  }

  nodes.title.textContent = "Gladiatus helper";
  nodes.scanButton.hidden = true;
}

function renderUnsupportedPage() {
  nodes.pageTabs.hidden = true;
  nodes.pageTabs.replaceChildren();
  nodes.summary.hidden = true;
  nodes.summary.textContent = "";
  nodes.tabs.hidden = true;
  nodes.tabs.replaceChildren();
  nodes.controls.hidden = true;
  nodes.controls.replaceChildren();
  setStatus("Open a Gladiatus auction or arena page.");
  nodes.results.innerHTML = '<div class="empty">This popup changes tools based on the active Gladiatus page.</div>';
}

async function onPageTabClick(event) {
  const button = event.target.closest("button[data-page-id]");
  if (!button) return;

  if (state.pageMode === "arena") {
    state.popupState.arenaPageId = button.dataset.pageId;
  } else {
    state.popupState.pageId = button.dataset.pageId;
  }
  await saveStorage(POPUP_STATE_KEY, state.popupState);
  render();
}

async function onItemTabClick(event) {
  await auctionView.onItemTabClick(event);
}

async function onPresetClick(event) {
  await auctionView.onPresetClick(event);
}

async function onControlInput(event) {
  if (state.pageMode === "arena" && await arenaView.onControlsInput(event)) return;
  await auctionView.onFilterInput(event);
}

async function onResultsClick(event) {
  if (state.pageMode === "arena" && await arenaView.onResultsClick(event)) return;
  await auctionView.onResultsClick(event);
}

function onEditorInput(event) {
  if (state.pageMode === "arena" && arenaView.onEditorInput(event)) return;
  auctionView.onEditorInput(event);
}

async function applyCurrentSortToPage() {
  const view = getView();
  const preset = getSelectedPreset(view);
  const filterValues = getFilterValues(view.id);

  try {
    const tab = await getActiveTab();
    if (!tab?.id) return;
    await sendTabMessage(tab.id, {
      type: AUCTION_CONTENT_MESSAGES.applySort,
      sortId: preset.isCustom ? preset.id : MODEL.presetSortId(view.id, preset.id),
      viewId: view.id,
      filterValues
    });
  } catch {
    // The popup can still browse cached scan results when the active tab is not an auction page.
  }
}
