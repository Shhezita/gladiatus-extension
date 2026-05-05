const SCAN_STORAGE_KEY = "glad-ah-last-scan-v1";
const POPUP_STATE_KEY = "glad-ah-popup-state-v1";

const scanButton = document.getElementById("scan-button");
const statusNode = document.getElementById("status");
const summaryNode = document.getElementById("summary");
const tabsNode = document.getElementById("tabs");
const controlsNode = document.getElementById("controls");
const resultsNode = document.getElementById("results");

const MODEL = window.GladiatusAuctionModel;
const VIEW_DEFINITIONS = MODEL.viewDefinitions;

let scanResult = null;
let popupState = { viewId: "weapons", presetByView: {} };

scanButton.addEventListener("click", scanAuction);
tabsNode.addEventListener("click", onTabClick);
controlsNode.addEventListener("click", onPresetClick);

init();

async function init() {
  popupState = { ...popupState, ...(await loadStorage(POPUP_STATE_KEY) || {}) };
  scanResult = await loadStorage(SCAN_STORAGE_KEY);
  render();
}

async function scanAuction() {
  scanButton.disabled = true;
  resultsNode.textContent = "";
  setStatus("Scanning auction categories...");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error("No active tab found.");

    const response = await chrome.tabs.sendMessage(tab.id, { type: "GLAD_AH_SCAN_ALL" });
    if (!response || !response.ok) {
      throw new Error(response?.error || "The auction page did not return scan results.");
    }

    scanResult = response.result;
    await saveStorage(SCAN_STORAGE_KEY, scanResult);
    render();
  } catch (error) {
    setStatus(error.message || String(error));
  } finally {
    scanButton.disabled = false;
  }
}

function render() {
  const items = scanResult?.items || [];
  const scannedAt = scanResult?.scannedAt ? new Date(scanResult.scannedAt).toLocaleTimeString() : "";

  if (scanResult) {
    setStatus(`Cached scan: ${items.length} items${scannedAt ? ` at ${scannedAt}` : ""}.`);
  } else {
    setStatus("No cached scan. Tabs and sort presets still apply to the visible auction page.");
  }

  summaryNode.hidden = !scanResult?.filterSummary;
  summaryNode.textContent = scanResult?.filterSummary || "";
  tabsNode.hidden = false;
  controlsNode.hidden = false;

  ensureValidView(items);
  renderTabs(items);
  renderControls();
  renderItems();
}

function ensureValidView(items) {
  if (!items.length) {
    popupState.viewId = getView().id;
    return;
  }

  const currentView = getView();
  if (currentView && items.some(currentView.accepts)) return;

  const firstPopulated = VIEW_DEFINITIONS.find((view) => items.some(view.accepts));
  popupState.viewId = firstPopulated?.id || VIEW_DEFINITIONS[0].id;
}

function renderTabs(items) {
  const fragment = document.createDocumentFragment();

  for (const view of VIEW_DEFINITIONS) {
    const count = items.filter(view.accepts).length;
    const button = document.createElement("button");
    button.type = "button";
    button.className = view.id === popupState.viewId ? "active" : "";
    button.dataset.viewId = view.id;
    button.textContent = `${view.label} ${count}`;
    fragment.append(button);
  }

  tabsNode.replaceChildren(fragment);
}

function renderControls() {
  const view = getView();
  const selectedPresetId = getSelectedPreset(view).id;
  const fragment = document.createDocumentFragment();

  const label = document.createElement("span");
  label.className = "control-label";
  label.textContent = "Sort";
  fragment.append(label);

  for (const preset of view.presets) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = preset.id === selectedPresetId ? "active" : "";
    button.dataset.presetId = preset.id;
    button.textContent = preset.label;
    fragment.append(button);
  }

  controlsNode.replaceChildren(fragment);
}

function renderItems() {
  const view = getView();
  const preset = getSelectedPreset(view);
  const items = (scanResult?.items || [])
    .filter(view.accepts)
    .map((item) => ({ item, score: preset.score(item) }))
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      if ((a.item.level || 0) !== (b.item.level || 0)) return (b.item.level || 0) - (a.item.level || 0);
      return (a.item.name || "").localeCompare(b.item.name || "");
    });

  if (!items.length) {
    resultsNode.innerHTML = scanResult
      ? '<div class="empty">No items for this tab.</div>'
      : '<div class="empty">Choose a tab or sort preset to reorder the current auction page. Scan only when you want the full cached item list.</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const entry of items) {
    fragment.append(renderItem(entry.item, MODEL.formatScore(preset, entry.item, entry.score)));
  }
  resultsNode.replaceChildren(fragment);
}

function renderItem(item, scoreText) {
  const node = document.createElement("article");
  node.className = "item";

  const thumb = renderThumb(item);
  const detail = document.createElement("div");
  detail.className = "item-detail";

  const name = document.createElement("div");
  name.className = "item-name";
  name.textContent = item.name || "Unknown item";

  const scoreNode = document.createElement("div");
  scoreNode.className = "score";
  scoreNode.textContent = scoreText;

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = [
    item.category,
    item.level ? `Level ${item.level}` : "",
    item.itemValue ? `Value ${item.itemValue}` : "",
    MODEL.priceLabel(item),
    MODEL.stat(item, "foodHealing") && MODEL.price(item)
      ? `Heals/gold ${MODEL.formatNumber(MODEL.stat(item, "foodHealing") / MODEL.price(item))}`
      : ""
  ].filter(Boolean).join(" | ");

  const stats = document.createElement("div");
  stats.className = "stats";
  stats.textContent = MODEL.formatStats(item.stats || {});

  detail.append(name, scoreNode, meta, stats);
  node.append(thumb, detail);
  return node;
}

function renderThumb(item) {
  const thumb = document.createElement("div");
  thumb.className = "item-thumb";
  thumb.title = item.name || "";

  applyIconStyle(thumb, item.imageStyle || "");
  if (item.imageSrc) {
    thumb.style.backgroundImage = `url("${String(item.imageSrc).replace(/"/g, "%22")}")`;
  }

  if (!thumb.style.backgroundImage) {
    thumb.textContent = (item.name || "?").trim().slice(0, 1);
  }

  return thumb;
}

function applyIconStyle(node, styleText) {
  const allowedProperties = new Set([
    "background-color",
    "background-image",
    "background-position",
    "background-repeat",
    "background-size"
  ]);

  String(styleText || "").split(";").forEach((declaration) => {
    const separator = declaration.indexOf(":");
    if (separator === -1) return;

    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    if (!allowedProperties.has(property) || !value) return;

    node.style.setProperty(property, value);
  });
}

function onTabClick(event) {
  const button = event.target.closest("button[data-view-id]");
  if (!button) return;

  popupState.viewId = button.dataset.viewId;
  saveStorage(POPUP_STATE_KEY, popupState);
  render();
  applyCurrentSortToPage();
}

function onPresetClick(event) {
  const button = event.target.closest("button[data-preset-id]");
  if (!button) return;

  popupState.presetByView = {
    ...popupState.presetByView,
    [popupState.viewId]: button.dataset.presetId
  };
  saveStorage(POPUP_STATE_KEY, popupState);
  render();
  applyCurrentSortToPage();
}

function getView() {
  return VIEW_DEFINITIONS.find((view) => view.id === popupState.viewId) || VIEW_DEFINITIONS[0];
}

function getSelectedPreset(view) {
  const selectedId = popupState.presetByView?.[view.id];
  return view.presets.find((preset) => preset.id === selectedId) || view.presets[0];
}

async function applyCurrentSortToPage() {
  const view = getView();
  const preset = getSelectedPreset(view);
  const sortId = MODEL.presetSortId(view.id, preset.id);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    await chrome.tabs.sendMessage(tab.id, { type: "GLAD_AH_APPLY_SORT", sortId });
  } catch {
    // The popup can still browse cached scan results when the active tab is not an auction page.
  }
}

async function loadStorage(key) {
  const result = await chrome.storage.local.get(key);
  return result[key] || null;
}

async function saveStorage(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

function setStatus(text) {
  statusNode.textContent = text;
}
