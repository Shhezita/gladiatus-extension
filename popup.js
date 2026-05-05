const SCHEMA = window.GladiatusAuctionSchema;
const SCORE = window.GladiatusScoreModel;
const MODEL = window.GladiatusAuctionModel;
const ARENA = window.GladiatusArenaCore;
if (!SCHEMA || !SCORE || !MODEL || !ARENA) {
  throw new Error("Gladiatus auction schema, score model, auction model, and arena core must load before the popup.");
}

const SCAN_STORAGE_KEY = SCHEMA.storageKeys.scanResult;
const SCAN_ARCHIVE_STORAGE_KEY = SCHEMA.storageKeys.scanArchive;
const POPUP_STATE_KEY = SCHEMA.storageKeys.popupState;
const FILTER_VALUES_STORAGE_KEY = MODEL.filterValuesStorageKey;
const MAX_SCAN_ARCHIVES = 5;

const titleNode = document.querySelector("h1");
const scanButton = document.getElementById("scan-button");
const statusNode = document.getElementById("status");
const pageTabsNode = document.getElementById("page-tabs");
const summaryNode = document.getElementById("summary");
const tabsNode = document.getElementById("tabs");
const controlsNode = document.getElementById("controls");
const resultsNode = document.getElementById("results");

const VIEW_DEFINITIONS = MODEL.viewDefinitions;
const PAGE_DEFINITIONS = [
  { id: "items", label: "Items" },
  { id: "filters", label: "Filters" }
];
const ARENA_PAGE_DEFINITIONS = [
  { id: "opponents", label: "Opponents" },
  { id: "formulas", label: "Formulas" }
];
const DEFAULT_TERM = { stat: "agility", weight: 1 };
const DEFAULT_CONSTRAINT = { stat: "damageBonus", op: ">=", value: 0 };
const DEFAULT_ARENA_TERM = { stat: "agility", weight: 1 };
const DEFAULT_ARENA_CONSTRAINT = { stat: "level", op: ">=", value: 0 };

let scanResult = null;
let arenaResult = null;
let customDefinitions = [];
let arenaFormulas = [];
let editorDraft = null;
let arenaFormulaDraft = null;
let popupState = { pageId: "items", arenaPageId: "opponents", viewId: "weapons", presetByView: {}, filterByView: {}, arenaFormulaId: "" };
let filterValuesByView = {};
let pageMode = "unsupported";
let activeTab = null;

scanButton.addEventListener("click", onScanButtonClick);
pageTabsNode.addEventListener("click", onPageTabClick);
tabsNode.addEventListener("click", onItemTabClick);
controlsNode.addEventListener("click", onPresetClick);
controlsNode.addEventListener("input", onFilterInput);
controlsNode.addEventListener("change", onFilterInput);
resultsNode.addEventListener("click", onResultsClick);
resultsNode.addEventListener("input", onEditorInput);
resultsNode.addEventListener("change", onEditorInput);

init();

async function init() {
  activeTab = await getActiveTab();
  pageMode = detectPageMode(activeTab?.url);
  popupState = { ...popupState, ...(await loadStorage(POPUP_STATE_KEY) || {}) };
  scanResult = await loadStorage(SCAN_STORAGE_KEY);
  arenaResult = await loadStorage(ARENA.resultsStorageKey);
  filterValuesByView = MODEL.normalizeAllFilterValues(await loadStorage(FILTER_VALUES_STORAGE_KEY) || popupState.filterByView);
  await saveStorage(FILTER_VALUES_STORAGE_KEY, filterValuesByView);
  customDefinitions = MODEL.normalizeCustomDefinitions(await loadStorage(MODEL.customDefinitionsStorageKey));
  arenaFormulas = await loadArenaFormulas();
  editorDraft = makeNewDefinitionDraft();
  arenaFormulaDraft = makeNewArenaFormulaDraft();
  subscribeToSharedFilterChanges();
  render();
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function detectPageMode(url) {
  if (ARENA.isArenaPageUrl(url)) return "arena";

  try {
    const parsed = new URL(url || "");
    if (parsed.hostname.endsWith(".gladiatus.gameforge.com")
      && parsed.pathname.endsWith("/game/index.php")
      && parsed.searchParams.get("mod") === "auction") {
      return "auction";
    }
  } catch {
    // Unsupported pages use the default mode.
  }

  return "unsupported";
}

function subscribeToSharedFilterChanges() {
  if (!chrome.storage?.onChanged) return;

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[FILTER_VALUES_STORAGE_KEY]) return;
    const nextValues = MODEL.normalizeAllFilterValues(changes[FILTER_VALUES_STORAGE_KEY].newValue);
    if (MODEL.filterValuesEqual(filterValuesByView, nextValues)) return;

    filterValuesByView = nextValues;
    if (popupState.pageId === "items") {
      renderControls();
      renderItems();
    }
  });
}

async function scanAuction() {
  scanButton.disabled = true;
  resultsNode.textContent = "";
  setStatus("Scanning auction categories...");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error("No active tab found.");
    if (detectPageMode(tab.url) !== "auction") throw new Error("Open a Gladiatus auction page before scanning.");

    const response = await sendAuctionScanMessage(tab);
    if (!response || !response.ok) {
      throw new Error(response?.error || `The auction page did not return scan results. Response: ${JSON.stringify(response)}`);
    }

    const previousScan = scanResult;
    scanResult = normalizeScanResult(response.result);
    await archivePreviousScan(previousScan, scanResult);
    await saveStorage(SCAN_STORAGE_KEY, scanResult);
    popupState.pageId = "items";
    await saveStorage(POPUP_STATE_KEY, popupState);
    render();
  } catch (error) {
    setStatus(error.message || String(error));
  } finally {
    scanButton.disabled = false;
  }
}

async function sendAuctionScanMessage(tab) {
  try {
    const response = await sendTabMessage(tab.id, { type: "GLAD_AH_SCAN_ALL" });
    if (response) return response;
  } catch (error) {
    await ensureAuctionContentScript(tab.id);
    return sendTabMessage(tab.id, { type: "GLAD_AH_SCAN_ALL" });
  }

  await ensureAuctionContentScript(tab.id);
  return sendTabMessage(tab.id, { type: "GLAD_AH_SCAN_ALL" });
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      resolve(response);
    });
  });
}

async function ensureAuctionContentScript(tabId) {
  if (!chrome.scripting?.executeScript) {
    throw new Error("Auction content script is not available on this tab. Reload the auction page after reloading the extension.");
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["auction-schema.js", "score-model.js", "auction-model.js", "auction-core.js", "content.js"]
  });
}

async function onScanButtonClick() {
  if (pageMode === "arena") {
    await scanArena();
    return;
  }

  await scanAuction();
}

async function scanArena() {
  scanButton.disabled = true;
  resultsNode.textContent = "";
  setStatus("Scanning arena opponents...");

  try {
    activeTab = await getActiveTab();
    if (!activeTab?.id) throw new Error("No active tab found.");
    if (detectPageMode(activeTab.url) !== "arena") throw new Error("Open a Gladiatus arena page before scanning opponents.");

    const response = await chrome.tabs.sendMessage(activeTab.id, {
      type: "GLAD_ARENA_SCAN_OPPONENTS",
      formula: getSelectedArenaFormula()
    });
    if (!response || !response.ok) {
      throw new Error(response?.error || "The arena page did not return scan results.");
    }

    arenaResult = response.result;
    await saveStorage(ARENA.resultsStorageKey, arenaResult);
    render();
  } catch (error) {
    setStatus(error.message || String(error));
  } finally {
    scanButton.disabled = false;
  }
}

function render() {
  configureHeader();

  if (pageMode === "arena") {
    renderArenaPage();
    return;
  }

  if (pageMode !== "auction") {
    renderUnsupportedPage();
    return;
  }

  renderPageTabs();

  if (popupState.pageId === "filters") {
    renderFiltersPage();
  } else {
    renderItemsPage();
  }
}

function configureHeader() {
  if (pageMode === "arena") {
    titleNode.textContent = "Arena scanner";
    scanButton.textContent = "Scan opponents";
    scanButton.hidden = false;
    return;
  }

  if (pageMode === "auction") {
    titleNode.textContent = "Auction scanner";
    scanButton.textContent = "Scan auction";
    scanButton.hidden = false;
    return;
  }

  titleNode.textContent = "Gladiatus helper";
  scanButton.hidden = true;
}

function renderPageTabs() {
  pageTabsNode.hidden = false;
  const fragment = document.createDocumentFragment();

  for (const page of PAGE_DEFINITIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = page.id === popupState.pageId ? "active" : "";
    button.dataset.pageId = page.id;
    button.textContent = page.label;
    fragment.append(button);
  }

  pageTabsNode.replaceChildren(fragment);
}

function renderItemsPage() {
  const items = scanResult?.items || [];
  const scannedAt = scanResult?.scannedAt ? new Date(scanResult.scannedAt).toLocaleTimeString() : "";

  if (scanResult) {
    const warnings = scanResult.scanWarnings?.length ? ` ${scanResult.scanWarnings.length} warning(s).` : "";
    setStatus(`Cached scan: ${items.length} items${scannedAt ? ` at ${scannedAt}` : ""}.${warnings}`);
  } else {
    setStatus("No cached scan. Tabs and sort presets still apply to the visible auction page.");
  }

  summaryNode.hidden = !scanResult?.filterSummary && !scanResult?.scanWarnings?.length;
  summaryNode.textContent = [
    scanResult?.filterSummary || "",
    ...(scanResult?.scanWarnings || []).map((warning) => `Warning: ${warning}`)
  ].filter(Boolean).join(" | ");
  tabsNode.hidden = false;
  controlsNode.hidden = false;

  ensureValidView(items);
  renderItemTabs(items);
  renderControls();
  renderItems();
}

function renderArenaPage() {
  renderArenaPageTabs();
  tabsNode.hidden = true;
  tabsNode.replaceChildren();

  if (popupState.arenaPageId === "formulas") {
    renderArenaFormulasPage();
    return;
  }

  renderArenaOpponentsPage();
}

function renderArenaPageTabs() {
  pageTabsNode.hidden = false;
  const fragment = document.createDocumentFragment();

  for (const page of ARENA_PAGE_DEFINITIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = page.id === popupState.arenaPageId ? "active" : "";
    button.dataset.pageId = page.id;
    button.textContent = page.label;
    fragment.append(button);
  }

  pageTabsNode.replaceChildren(fragment);
}

function renderArenaOpponentsPage() {
  renderArenaControls();

  if (!arenaResult) {
    summaryNode.hidden = true;
    summaryNode.textContent = "";
    setStatus("Open an arena opponent list, then scan.");
    resultsNode.innerHTML = '<div class="empty">Scan to fetch the visible opponent profiles and show stat totals next to their arena rows.</div>';
    return;
  }

  const scannedAt = arenaResult.scannedAt ? new Date(arenaResult.scannedAt).toLocaleTimeString() : "";
  const failed = arenaResult.failedCount ? ` ${arenaResult.failedCount} failed.` : "";
  setStatus(`Scanned ${arenaResult.opponentCount} opponents${scannedAt ? ` at ${scannedAt}` : ""}.${failed}`);
  summaryNode.hidden = !arenaResult.bestName;
  summaryNode.textContent = arenaResult.bestName
    ? `Lowest ${arenaResult.arenaKind === "team" ? "team" : "fighter"} score: ${arenaResult.bestName} (${ARENA.formatNumber(arenaResult.bestScore)})`
    : "";
  resultsNode.replaceChildren(renderArenaResults(arenaResult));
}

function renderArenaControls() {
  controlsNode.hidden = false;
  const fragment = document.createDocumentFragment();

  const label = document.createElement("label");
  label.className = "filter-control";

  const text = document.createElement("span");
  text.textContent = "Formula";

  const select = document.createElement("select");
  select.dataset.arenaFormulaSelect = "1";
  select.disabled = !arenaFormulas.length;

  const enabled = arenaFormulas.filter((candidate) => candidate.enabled);
  const available = enabled.length ? enabled : arenaFormulas;
  for (const formula of available) {
    const option = document.createElement("option");
    option.value = formula.id;
    option.textContent = formula.name;
    select.append(option);
  }

  select.value = getSelectedArenaFormula().id;
  label.append(text, select);
  fragment.append(label);
  controlsNode.replaceChildren(fragment);
}

function renderUnsupportedPage() {
  pageTabsNode.hidden = true;
  pageTabsNode.replaceChildren();
  summaryNode.hidden = true;
  summaryNode.textContent = "";
  tabsNode.hidden = true;
  tabsNode.replaceChildren();
  controlsNode.hidden = true;
  controlsNode.replaceChildren();
  setStatus("Open a Gladiatus auction or arena page.");
  resultsNode.innerHTML = '<div class="empty">This popup changes tools based on the active Gladiatus page.</div>';
}

function renderFiltersPage() {
  setStatus("Create custom score filters. Enabled filters appear as presets for their selected item groups.");
  summaryNode.hidden = true;
  summaryNode.textContent = "";
  tabsNode.hidden = true;
  controlsNode.hidden = true;
  controlsNode.replaceChildren();
  resultsNode.replaceChildren(renderDefinitionManager());
}

function renderArenaFormulasPage() {
  setStatus("Create role-aware arena formulas. Enabled formulas can be selected before scanning opponents.");
  summaryNode.hidden = true;
  summaryNode.textContent = "";
  controlsNode.hidden = true;
  controlsNode.replaceChildren();
  resultsNode.replaceChildren(renderArenaFormulaManager());
}

function renderArenaResults(result) {
  const list = document.createElement("section");
  list.className = "arena-results";

  const opponents = [...(result.opponents || [])].sort((a, b) => arenaScore(a) - arenaScore(b));
  for (const opponent of opponents) {
    list.append(renderArenaOpponent(opponent));
  }

  return list;
}

function renderArenaOpponent(result) {
  const node = document.createElement("article");
  node.className = "item arena-opponent";

  const detail = document.createElement("div");
  detail.className = "item-detail";

  const name = document.createElement("div");
  name.className = "item-name";
  name.textContent = result.displayName || result.character?.name || result.opponent?.name || "Unknown opponent";

  const scoreNode = document.createElement("div");
  scoreNode.className = "score";
  scoreNode.textContent = Number.isFinite(arenaScore(result))
    ? `${result.team ? "Team score" : "Power score"}: ${ARENA.formatNumber(arenaScore(result))}`
    : "Profile scan failed";

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = renderArenaMeta(result);

  const stats = document.createElement("div");
  stats.className = "stats";
  stats.textContent = renderArenaStats(result);

  detail.append(name, scoreNode, meta, stats);
  node.append(detail);
  return node;
}

function arenaScore(result) {
  return Number.isFinite(result.score) ? result.score : Number.POSITIVE_INFINITY;
}

function renderArenaMeta(result) {
  if (result.error) return result.error;
  if (result.team) {
    return [
      `${result.team.members.length} team members`,
      result.matches === false ? "Constraints not met" : "",
      result.opponent?.province ? `Province ${result.opponent.province}` : ""
    ].filter(Boolean).join(" | ");
  }
  if (!result.character) return "";

  return [
    result.character.level ? `Level ${result.character.level}` : "",
    result.character.province ? `Province ${result.character.province}` : "",
    `Damage ${ARENA.formatNumber(result.character.stats.damageAvg || 0)}`,
    `Armour ${result.character.stats.armour || 0}`,
    result.matches === false ? "Constraints not met" : ""
  ].filter(Boolean).join(" | ");
}

function renderArenaStats(result) {
  if (result.team) {
    return result.team.members
      .map((member) => `${member.roleLabel}: ${ARENA.formatNumber(member.formulaScore)} (${ARENA.formatCharacterStats(member)})`)
      .join(" / ");
  }
  return result.character ? ARENA.formatCharacterStats(result.character) : "";
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

function renderItemTabs(items) {
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

  for (const preset of getPresetOptions(view)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = preset.id === selectedPresetId ? "active" : "";
    button.dataset.presetId = preset.id;
    button.textContent = preset.label;
    fragment.append(button);
  }

  renderFilterControls(fragment, view);
  controlsNode.replaceChildren(fragment);
}

function renderFilterControls(fragment, view) {
  const filterValues = getFilterValues(view.id);
  const controls = MODEL.getFilterControlDescriptors(view.id, filterValues);
  if (!controls.length) return;

  const separator = document.createElement("span");
  separator.className = "control-separator";
  separator.textContent = "|";
  fragment.append(separator);

  for (const filter of controls) {
    const label = document.createElement("label");
    label.className = "filter-control";

    const text = document.createElement("span");
    text.textContent = filter.label;

    const input = document.createElement("input");
    input.type = filter.type;
    input.min = String(filter.min);
    input.step = String(filter.step);
    input.dataset.filterId = filter.id;
    input.value = filter.value;

    label.append(text, input);
    fragment.append(label);
  }
}

function renderItems() {
  const view = getView();
  const preset = getSelectedPreset(view);
  const filterValues = getFilterValues(view.id);
  const items = (scanResult?.items || [])
    .filter(view.accepts)
    .filter((item) => MODEL.itemMatchesFilters(item, view.id, filterValues))
    .filter((item) => !preset.matches || preset.matches(item))
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

function renderDefinitionManager() {
  const container = document.createElement("section");
  container.className = "definition-page";

  const editor = renderDefinitionEditor();
  const list = renderDefinitionList();
  container.append(editor, list);
  return container;
}

function renderDefinitionEditor() {
  const editor = document.createElement("section");
  editor.id = "filter-editor";
  editor.className = "definition-editor";
  editor.dataset.definitionId = editorDraft.id;

  const title = document.createElement("h2");
  title.textContent = editorDraft.isNew ? "New custom filter" : "Edit custom filter";

  const nameLabel = document.createElement("label");
  nameLabel.className = "field-row";
  nameLabel.textContent = "Name";
  const nameInput = document.createElement("input");
  nameInput.name = "name";
  nameInput.type = "text";
  nameInput.value = editorDraft.name;
  nameLabel.append(nameInput);

  const enabledLabel = document.createElement("label");
  enabledLabel.className = "check-row";
  const enabledInput = document.createElement("input");
  enabledInput.name = "enabled";
  enabledInput.type = "checkbox";
  enabledInput.checked = editorDraft.enabled !== false;
  enabledLabel.append(enabledInput, document.createTextNode(" Enabled"));

  const applies = renderAppliesToEditor(editorDraft);
  const terms = renderTermsEditor(editorDraft);
  const constraints = renderConstraintsEditor(editorDraft);
  const actions = renderEditorActions(editorDraft);

  editor.append(title, nameLabel, enabledLabel, applies, terms, constraints, actions);
  return editor;
}

function renderAppliesToEditor(definition) {
  const group = document.createElement("fieldset");
  group.className = "editor-group";

  const legend = document.createElement("legend");
  legend.textContent = "Applies to";
  group.append(legend);

  for (const view of VIEW_DEFINITIONS) {
    const label = document.createElement("label");
    label.className = "check-row";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = "appliesTo";
    input.value = view.id;
    input.checked = definition.appliesTo.includes(view.id);

    label.append(input, document.createTextNode(` ${view.label}`));
    group.append(label);
  }

  return group;
}

function renderTermsEditor(definition) {
  const section = document.createElement("section");
  section.className = "editor-group";

  const heading = document.createElement("div");
  heading.className = "editor-heading";
  heading.textContent = "Score terms";
  section.append(heading);

  definition.terms.forEach((term, index) => {
    section.append(renderTermRow(term, index));
  });

  const add = document.createElement("button");
  add.type = "button";
  add.dataset.action = "add-term";
  add.textContent = "Add term";
  section.append(add);
  return section;
}

function renderTermRow(term, index) {
  const row = document.createElement("div");
  row.className = "builder-row";
  row.dataset.termIndex = String(index);

  const stat = makeStatSelect("term-stat", term.stat);
  const weight = document.createElement("input");
  weight.name = "term-weight";
  weight.type = "number";
  weight.step = "0.1";
  weight.value = String(term.weight);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.dataset.action = "remove-term";
  remove.dataset.index = String(index);
  remove.textContent = "Remove";

  row.append(stat, weight, remove);
  return row;
}

function renderConstraintsEditor(definition) {
  const section = document.createElement("section");
  section.className = "editor-group";

  const heading = document.createElement("div");
  heading.className = "editor-heading";
  heading.textContent = "Constraints";
  section.append(heading);

  definition.constraints.forEach((constraint, index) => {
    section.append(renderConstraintRow(constraint, index));
  });

  const add = document.createElement("button");
  add.type = "button";
  add.dataset.action = "add-constraint";
  add.textContent = "Add constraint";
  section.append(add);
  return section;
}

function renderConstraintRow(constraint, index) {
  const row = document.createElement("div");
  row.className = "builder-row";
  row.dataset.constraintIndex = String(index);

  const stat = makeStatSelect("constraint-stat", constraint.stat);
  const op = document.createElement("select");
  op.name = "constraint-op";
  [">=", "<="].forEach((operator) => {
    const option = document.createElement("option");
    option.value = operator;
    option.textContent = operator;
    op.append(option);
  });
  op.value = constraint.op;

  const value = document.createElement("input");
  value.name = "constraint-value";
  value.type = "number";
  value.step = "0.1";
  value.value = String(constraint.value);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.dataset.action = "remove-constraint";
  remove.dataset.index = String(index);
  remove.textContent = "Remove";

  row.append(stat, op, value, remove);
  return row;
}

function renderEditorActions(definition) {
  const actions = document.createElement("div");
  actions.className = "editor-actions";

  const save = document.createElement("button");
  save.type = "button";
  save.dataset.action = "save-definition";
  save.textContent = definition.isNew ? "Create filter" : "Save filter";

  const reset = document.createElement("button");
  reset.type = "button";
  reset.dataset.action = "new-definition";
  reset.textContent = "New";

  actions.append(save, reset);
  return actions;
}

function renderDefinitionList() {
  const list = document.createElement("section");
  list.className = "definition-list";

  const title = document.createElement("h2");
  title.textContent = "Saved filters";
  list.append(title);

  if (!customDefinitions.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No custom filters yet.";
    list.append(empty);
    return list;
  }

  for (const definition of customDefinitions) {
    list.append(renderDefinitionCard(definition));
  }

  return list;
}

function renderDefinitionCard(definition) {
  const card = document.createElement("article");
  card.className = "definition-card";

  const title = document.createElement("div");
  title.className = "definition-title";
  title.textContent = definition.name;

  const enabled = document.createElement("label");
  enabled.className = "check-row";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = definition.enabled;
  checkbox.dataset.action = "toggle-definition";
  checkbox.dataset.definitionId = definition.id;
  enabled.append(checkbox, document.createTextNode(" Enabled"));

  const appliesTo = document.createElement("div");
  appliesTo.className = "definition-meta";
  appliesTo.textContent = definition.appliesTo
    .map((viewId) => MODEL.getView(viewId)?.label)
    .filter(Boolean)
    .join(", ");

  const formula = document.createElement("div");
  formula.className = "definition-formula";
  formula.textContent = MODEL.summarizeCustomDefinition(definition);

  const actions = document.createElement("div");
  actions.className = "definition-actions";

  const edit = document.createElement("button");
  edit.type = "button";
  edit.dataset.action = "edit-definition";
  edit.dataset.definitionId = definition.id;
  edit.textContent = "Edit";

  const remove = document.createElement("button");
  remove.type = "button";
  remove.dataset.action = "delete-definition";
  remove.dataset.definitionId = definition.id;
  remove.textContent = "Delete";

  actions.append(edit, remove);
  card.append(title, enabled, appliesTo, formula, actions);
  return card;
}

function makeStatSelect(name, selected) {
  const select = document.createElement("select");
  select.name = name;

  for (const stat of MODEL.statOptions) {
    const option = document.createElement("option");
    option.value = stat.key;
    option.textContent = stat.label;
    select.append(option);
  }

  select.value = selected;
  return select;
}

function renderArenaFormulaManager() {
  const container = document.createElement("section");
  container.className = "definition-page";
  container.append(renderArenaFormulaEditor(), renderArenaFormulaList());
  return container;
}

function renderArenaFormulaEditor() {
  const editor = document.createElement("section");
  editor.id = "arena-formula-editor";
  editor.className = "definition-editor";
  editor.dataset.formulaId = arenaFormulaDraft.id;

  const title = document.createElement("h2");
  title.textContent = arenaFormulaDraft.isNew ? "New arena formula" : "Edit arena formula";

  const nameLabel = document.createElement("label");
  nameLabel.className = "field-row";
  nameLabel.textContent = "Name";
  const nameInput = document.createElement("input");
  nameInput.name = "arena-name";
  nameInput.type = "text";
  nameInput.value = arenaFormulaDraft.name;
  nameLabel.append(nameInput);

  const enabledLabel = document.createElement("label");
  enabledLabel.className = "check-row";
  const enabledInput = document.createElement("input");
  enabledInput.name = "arena-enabled";
  enabledInput.type = "checkbox";
  enabledInput.checked = arenaFormulaDraft.enabled !== false;
  enabledLabel.append(enabledInput, document.createTextNode(" Enabled"));

  editor.append(title, nameLabel, enabledLabel);

  for (const sectionKey of ARENA.roleSectionKeys) {
    editor.append(renderArenaFormulaSectionEditor(sectionKey, arenaFormulaDraft.sections[sectionKey]));
  }

  const actions = document.createElement("div");
  actions.className = "editor-actions";

  const save = document.createElement("button");
  save.type = "button";
  save.dataset.action = "save-arena-formula";
  save.textContent = arenaFormulaDraft.isNew ? "Create formula" : "Save formula";

  const reset = document.createElement("button");
  reset.type = "button";
  reset.dataset.action = "new-arena-formula";
  reset.textContent = "New";

  actions.append(save, reset);
  editor.append(actions);
  return editor;
}

function renderArenaFormulaSectionEditor(sectionKey, section) {
  const group = document.createElement("section");
  group.className = "editor-group arena-formula-section";
  group.dataset.sectionKey = sectionKey;

  const heading = document.createElement("div");
  heading.className = "editor-heading";
  heading.textContent = ARENA.roleSectionLabels[sectionKey] || sectionKey;
  group.append(heading);

  const termsHeading = document.createElement("div");
  termsHeading.className = "editor-subheading";
  termsHeading.textContent = "Score terms";
  group.append(termsHeading);

  (section?.terms || []).forEach((term, index) => {
    group.append(renderArenaTermRow(sectionKey, term, index));
  });

  const addTerm = document.createElement("button");
  addTerm.type = "button";
  addTerm.dataset.action = "add-arena-term";
  addTerm.dataset.sectionKey = sectionKey;
  addTerm.textContent = "Add term";
  group.append(addTerm);

  const constraintsHeading = document.createElement("div");
  constraintsHeading.className = "editor-subheading";
  constraintsHeading.textContent = "Constraints";
  group.append(constraintsHeading);

  (section?.constraints || []).forEach((constraint, index) => {
    group.append(renderArenaConstraintRow(sectionKey, constraint, index));
  });

  const addConstraint = document.createElement("button");
  addConstraint.type = "button";
  addConstraint.dataset.action = "add-arena-constraint";
  addConstraint.dataset.sectionKey = sectionKey;
  addConstraint.textContent = "Add constraint";
  group.append(addConstraint);
  return group;
}

function renderArenaTermRow(sectionKey, term, index) {
  const row = document.createElement("div");
  row.className = "builder-row";
  row.dataset.sectionKey = sectionKey;
  row.dataset.arenaTermIndex = String(index);

  const stat = makeArenaStatSelect("arena-term-stat", term.stat);
  const weight = document.createElement("input");
  weight.name = "arena-term-weight";
  weight.type = "number";
  weight.step = "0.1";
  weight.value = String(term.weight);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.dataset.action = "remove-arena-term";
  remove.dataset.sectionKey = sectionKey;
  remove.dataset.index = String(index);
  remove.textContent = "Remove";

  row.append(stat, weight, remove);
  return row;
}

function renderArenaConstraintRow(sectionKey, constraint, index) {
  const row = document.createElement("div");
  row.className = "builder-row";
  row.dataset.sectionKey = sectionKey;
  row.dataset.arenaConstraintIndex = String(index);

  const stat = makeArenaStatSelect("arena-constraint-stat", constraint.stat);
  const op = document.createElement("select");
  op.name = "arena-constraint-op";
  [">=", "<="].forEach((operator) => {
    const option = document.createElement("option");
    option.value = operator;
    option.textContent = operator;
    op.append(option);
  });
  op.value = constraint.op;

  const value = document.createElement("input");
  value.name = "arena-constraint-value";
  value.type = "number";
  value.step = "0.1";
  value.value = String(constraint.value);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.dataset.action = "remove-arena-constraint";
  remove.dataset.sectionKey = sectionKey;
  remove.dataset.index = String(index);
  remove.textContent = "Remove";

  row.append(stat, op, value, remove);
  return row;
}

function makeArenaStatSelect(name, selected) {
  const select = document.createElement("select");
  select.name = name;

  for (const stat of ARENA.statOptions) {
    const option = document.createElement("option");
    option.value = stat.key;
    option.textContent = stat.label;
    select.append(option);
  }

  select.value = selected;
  return select;
}

function renderArenaFormulaList() {
  const list = document.createElement("section");
  list.className = "definition-list";

  const title = document.createElement("h2");
  title.textContent = "Saved arena formulas";
  list.append(title);

  if (!arenaFormulas.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No arena formulas yet.";
    list.append(empty);
    return list;
  }

  for (const formula of arenaFormulas) {
    list.append(renderArenaFormulaCard(formula));
  }

  return list;
}

function renderArenaFormulaCard(formula) {
  const card = document.createElement("article");
  card.className = "definition-card";

  const title = document.createElement("div");
  title.className = "definition-title";
  title.textContent = formula.name;

  const enabled = document.createElement("label");
  enabled.className = "check-row";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = formula.enabled;
  checkbox.dataset.action = "toggle-arena-formula";
  checkbox.dataset.formulaId = formula.id;
  enabled.append(checkbox, document.createTextNode(" Enabled"));

  const formulaText = document.createElement("div");
  formulaText.className = "definition-formula";
  formulaText.textContent = ARENA.formatArenaFormula(formula);

  const actions = document.createElement("div");
  actions.className = "definition-actions";

  const edit = document.createElement("button");
  edit.type = "button";
  edit.dataset.action = "edit-arena-formula";
  edit.dataset.formulaId = formula.id;
  edit.textContent = "Edit";

  const remove = document.createElement("button");
  remove.type = "button";
  remove.dataset.action = "delete-arena-formula";
  remove.dataset.formulaId = formula.id;
  remove.textContent = "Delete";

  actions.append(edit, remove);
  card.append(title, enabled, formulaText, actions);
  return card;
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

function onPageTabClick(event) {
  const button = event.target.closest("button[data-page-id]");
  if (!button) return;

  if (pageMode === "arena") {
    popupState.arenaPageId = button.dataset.pageId;
  } else {
    popupState.pageId = button.dataset.pageId;
  }
  saveStorage(POPUP_STATE_KEY, popupState);
  render();
}

function onItemTabClick(event) {
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

function onFilterInput(event) {
  const formulaSelect = event.target.closest("select[data-arena-formula-select]");
  if (formulaSelect) {
    popupState.arenaFormulaId = formulaSelect.value;
    saveStorage(POPUP_STATE_KEY, popupState);
    return;
  }

  const input = event.target.closest("input[data-filter-id]");
  if (!input) return;

  const view = getView();
  filterValuesByView = {
    ...filterValuesByView,
    [view.id]: {
      ...getFilterValues(view.id),
      [input.dataset.filterId]: input.value
    }
  };
  saveStorage(FILTER_VALUES_STORAGE_KEY, MODEL.normalizeAllFilterValues(filterValuesByView));
  renderItems();
  applyCurrentSortToPage();
}

async function onResultsClick(event) {
  const actionNode = event.target.closest("[data-action]");
  if (!actionNode) return;

  const action = actionNode.dataset.action;
  if (action.includes("-arena-") || action.startsWith("arena-") || action.endsWith("-arena-formula") || action === "save-arena-formula"
    || action === "new-arena-formula" || action === "edit-arena-formula"
    || action === "delete-arena-formula" || action === "toggle-arena-formula") {
    await handleArenaFormulaAction(actionNode, action);
    return;
  }

  if (action === "add-term") {
    syncEditorDraft();
    editorDraft.terms.push({ ...DEFAULT_TERM });
    render();
    return;
  }

  if (action === "remove-term") {
    syncEditorDraft();
    editorDraft.terms.splice(Number(actionNode.dataset.index), 1);
    if (!editorDraft.terms.length) editorDraft.terms.push({ ...DEFAULT_TERM });
    render();
    return;
  }

  if (action === "add-constraint") {
    syncEditorDraft();
    editorDraft.constraints.push({ ...DEFAULT_CONSTRAINT });
    render();
    return;
  }

  if (action === "remove-constraint") {
    syncEditorDraft();
    editorDraft.constraints.splice(Number(actionNode.dataset.index), 1);
    render();
    return;
  }

  if (action === "new-definition") {
    editorDraft = makeNewDefinitionDraft();
    render();
    return;
  }

  if (action === "edit-definition") {
    const definition = customDefinitions.find((candidate) => candidate.id === actionNode.dataset.definitionId);
    if (definition) {
      editorDraft = { ...cloneDefinition(definition), isNew: false };
      render();
    }
    return;
  }

  if (action === "delete-definition") {
    customDefinitions = customDefinitions.filter((definition) => definition.id !== actionNode.dataset.definitionId);
    if (editorDraft.id === actionNode.dataset.definitionId) editorDraft = makeNewDefinitionDraft();
    await persistCustomDefinitions();
    render();
    return;
  }

  if (action === "toggle-definition") {
    customDefinitions = customDefinitions.map((definition) => definition.id === actionNode.dataset.definitionId
      ? { ...definition, enabled: actionNode.checked }
      : definition);
    await persistCustomDefinitions();
    render();
    return;
  }

  if (action === "save-definition") {
    syncEditorDraft();
    const normalized = MODEL.normalizeCustomDefinition(editorDraft);
    const error = validateDefinition(normalized);
    if (error) {
      setStatus(error);
      return;
    }

    customDefinitions = upsertDefinition(customDefinitions, normalized);
    editorDraft = { ...cloneDefinition(normalized), isNew: false };
    await persistCustomDefinitions();
    render();
  }
}

async function handleArenaFormulaAction(actionNode, action) {
  const sectionKey = actionNode.dataset.sectionKey;

  if (action === "add-arena-term") {
    syncArenaFormulaDraft();
    arenaFormulaDraft.sections[sectionKey].terms.push({ ...DEFAULT_ARENA_TERM });
    render();
    return;
  }

  if (action === "remove-arena-term") {
    syncArenaFormulaDraft();
    arenaFormulaDraft.sections[sectionKey].terms.splice(Number(actionNode.dataset.index), 1);
    render();
    return;
  }

  if (action === "add-arena-constraint") {
    syncArenaFormulaDraft();
    arenaFormulaDraft.sections[sectionKey].constraints.push({ ...DEFAULT_ARENA_CONSTRAINT });
    render();
    return;
  }

  if (action === "remove-arena-constraint") {
    syncArenaFormulaDraft();
    arenaFormulaDraft.sections[sectionKey].constraints.splice(Number(actionNode.dataset.index), 1);
    render();
    return;
  }

  if (action === "new-arena-formula") {
    arenaFormulaDraft = makeNewArenaFormulaDraft();
    render();
    return;
  }

  if (action === "edit-arena-formula") {
    const formula = arenaFormulas.find((candidate) => candidate.id === actionNode.dataset.formulaId);
    if (formula) {
      arenaFormulaDraft = { ...cloneArenaFormula(formula), isNew: false };
      render();
    }
    return;
  }

  if (action === "delete-arena-formula") {
    arenaFormulas = arenaFormulas.filter((formula) => formula.id !== actionNode.dataset.formulaId);
    if (arenaFormulaDraft.id === actionNode.dataset.formulaId) arenaFormulaDraft = makeNewArenaFormulaDraft();
    await persistArenaFormulas();
    render();
    return;
  }

  if (action === "toggle-arena-formula") {
    arenaFormulas = arenaFormulas.map((formula) => formula.id === actionNode.dataset.formulaId
      ? { ...formula, enabled: actionNode.checked }
      : formula);
    await persistArenaFormulas();
    render();
    return;
  }

  if (action === "save-arena-formula") {
    syncArenaFormulaDraft();
    const normalized = ARENA.normalizeArenaFormula(arenaFormulaDraft);
    const error = validateArenaFormula(normalized);
    if (error) {
      setStatus(error);
      return;
    }

    arenaFormulas = upsertArenaFormula(arenaFormulas, normalized);
    arenaFormulaDraft = { ...cloneArenaFormula(normalized), isNew: false };
    popupState.arenaFormulaId = normalized.id;
    await persistArenaFormulas();
    await saveStorage(POPUP_STATE_KEY, popupState);
    render();
  }
}

function onEditorInput(event) {
  if (event.target.closest("#arena-formula-editor")) {
    syncArenaFormulaDraft();
    return;
  }

  if (event.target.closest("#filter-editor")) {
    syncEditorDraft();
  }
}

function syncEditorDraft() {
  const editor = document.getElementById("filter-editor");
  if (!editor) return;

  editorDraft = {
    ...editorDraft,
    name: editor.querySelector("input[name='name']")?.value || "",
    enabled: Boolean(editor.querySelector("input[name='enabled']")?.checked),
    appliesTo: Array.from(editor.querySelectorAll("input[name='appliesTo']:checked")).map((input) => input.value),
    terms: Array.from(editor.querySelectorAll("[data-term-index]")).map((row) => ({
      stat: row.querySelector("select[name='term-stat']")?.value || "agility",
      weight: Number(row.querySelector("input[name='term-weight']")?.value || 0)
    })),
    constraints: Array.from(editor.querySelectorAll("[data-constraint-index]")).map((row) => ({
      stat: row.querySelector("select[name='constraint-stat']")?.value || "damageBonus",
      op: row.querySelector("select[name='constraint-op']")?.value || ">=",
      value: Number(row.querySelector("input[name='constraint-value']")?.value || 0)
    }))
  };
}

function syncArenaFormulaDraft() {
  const editor = document.getElementById("arena-formula-editor");
  if (!editor) return;

  const sections = {};
  for (const sectionKey of ARENA.roleSectionKeys) {
    const group = editor.querySelector(`[data-section-key='${sectionKey}']`);
    sections[sectionKey] = {
      terms: Array.from(group?.querySelectorAll("[data-arena-term-index]") || []).map((row) => ({
        stat: row.querySelector("select[name='arena-term-stat']")?.value || "agility",
        weight: Number(row.querySelector("input[name='arena-term-weight']")?.value || 0)
      })),
      constraints: Array.from(group?.querySelectorAll("[data-arena-constraint-index]") || []).map((row) => ({
        stat: row.querySelector("select[name='arena-constraint-stat']")?.value || "level",
        op: row.querySelector("select[name='arena-constraint-op']")?.value || ">=",
        value: Number(row.querySelector("input[name='arena-constraint-value']")?.value || 0)
      }))
    };
  }

  arenaFormulaDraft = {
    ...arenaFormulaDraft,
    name: editor.querySelector("input[name='arena-name']")?.value || "",
    enabled: Boolean(editor.querySelector("input[name='arena-enabled']")?.checked),
    sections
  };
}

function validateDefinition(definition) {
  if (!definition.name.trim()) return "Custom filter needs a name.";
  if (!definition.appliesTo.length) return "Select at least one item group.";
  if (!definition.terms.length) return "Add at least one non-zero score term.";
  return "";
}

function validateArenaFormula(formula) {
  if (!formula.name.trim()) return "Arena formula needs a name.";
  const hasAnyTerms = ARENA.roleSectionKeys.some((sectionKey) => formula.sections[sectionKey].terms.length);
  if (!hasAnyTerms) return "Add at least one non-zero score term.";
  return "";
}

function upsertDefinition(definitions, definition) {
  const index = definitions.findIndex((candidate) => candidate.id === definition.id);
  if (index === -1) return [...definitions, definition];

  return definitions.map((candidate, candidateIndex) => candidateIndex === index ? definition : candidate);
}

function upsertArenaFormula(formulas, formula) {
  const index = formulas.findIndex((candidate) => candidate.id === formula.id);
  if (index === -1) return [...formulas, formula];

  return formulas.map((candidate, candidateIndex) => candidateIndex === index ? formula : candidate);
}

async function persistCustomDefinitions() {
  customDefinitions = MODEL.normalizeCustomDefinitions(customDefinitions);
  await saveStorage(MODEL.customDefinitionsStorageKey, customDefinitions);
  await notifyActivePageDefinitionsChanged();
}

async function persistArenaFormulas() {
  arenaFormulas = ARENA.normalizeArenaFormulas(arenaFormulas);
  await saveStorage(ARENA.formulasStorageKey, arenaFormulas);
}

function normalizeScanResult(result) {
  const items = sortScanItems(result?.items || []);
  const categoryIds = new Set(items.map((item) => item.categoryId).filter(Boolean));

  return {
    ...result,
    categoriesScanned: categoryIds.size || result?.categoriesScanned || 0,
    categoryIdsScanned: result?.categoryIdsScanned || Array.from(categoryIds),
    scanWarnings: result?.scanWarnings || [],
    items
  };
}

function sortScanItems(items) {
  const categoryRank = new Map(SCHEMA.scanCategories.map((category, index) => [category.id, index]));

  return [...items].sort((a, b) => {
    const categoryDiff = (categoryRank.get(a.categoryId) ?? 999) - (categoryRank.get(b.categoryId) ?? 999);
    if (categoryDiff) return categoryDiff;
    if ((a.level || 0) !== (b.level || 0)) return (a.level || 0) - (b.level || 0);
    return (a.name || "").localeCompare(b.name || "");
  });
}

async function archivePreviousScan(previous, next) {
  if (!previous?.items?.length) return;
  if (scanFingerprint(previous) === scanFingerprint(next)) return;

  const archive = await loadStorage(SCAN_ARCHIVE_STORAGE_KEY);
  const entries = Array.isArray(archive) ? archive : [];
  await saveStorage(SCAN_ARCHIVE_STORAGE_KEY, [
    compactScanArchive(previous, next),
    ...entries
  ].slice(0, MAX_SCAN_ARCHIVES));
}

function scanFingerprint(scan) {
  return (scan?.items || [])
    .map((item) => `${item.categoryId || ""}:${item.auctionId || ""}:${item.name || ""}:${item.bidAmount || ""}:${item.priceGold || ""}`)
    .sort()
    .join("|");
}

function compactScanArchive(scan, replacement) {
  return {
    archivedAt: new Date().toISOString(),
    scannedAt: scan.scannedAt || "",
    replacedByScannedAt: replacement?.scannedAt || "",
    itemCount: scan.items?.length || 0,
    categoriesScanned: scan.categoriesScanned || 0,
    categoryIdsScanned: scan.categoryIdsScanned || [],
    filterSummary: scan.filterSummary || "",
    scanWarnings: scan.scanWarnings || [],
    items: (scan.items || []).map(compactArchivedItem)
  };
}

function compactArchivedItem(item) {
  return {
    auctionId: item.auctionId || "",
    name: item.name || "",
    category: item.category || "",
    categoryId: item.categoryId || "",
    viewId: item.viewId || "",
    itemType: item.itemType || "",
    level: item.level || 0,
    itemValue: item.itemValue || 0,
    bidAmount: item.bidAmount || 0,
    priceGold: item.priceGold || 0,
    stats: item.stats || {}
  };
}

async function notifyActivePageDefinitionsChanged() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    await chrome.tabs.sendMessage(tab.id, {
      type: "GLAD_AH_CUSTOM_DEFINITIONS_UPDATED",
      definitions: customDefinitions
    });
  } catch {
    // The active tab does not need to be a Gladiatus auction page.
  }
}

function makeNewDefinitionDraft() {
  return {
    id: `filter-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: "",
    appliesTo: [popupState.viewId || "armor"],
    terms: [
      { stat: "agility", weight: 1 },
      { stat: "dexterity", weight: 1 },
      { stat: "damageBonus", weight: 10 }
    ],
    constraints: [],
    enabled: true,
    isNew: true
  };
}

async function loadArenaFormulas() {
  const saved = await loadStorage(ARENA.formulasStorageKey);
  if (saved !== null) return ARENA.normalizeArenaFormulas(saved);

  const formulas = ARENA.normalizeArenaFormulas(saved);
  if (formulas.length) return formulas;

  const defaults = [ARENA.defaultArenaFormula()];
  await saveStorage(ARENA.formulasStorageKey, defaults);
  return defaults;
}

function makeNewArenaFormulaDraft() {
  return {
    ...cloneArenaFormula(ARENA.defaultArenaFormula()),
    id: `arena-formula-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: "",
    isNew: true
  };
}

function cloneDefinition(definition) {
  return {
    ...definition,
    appliesTo: [...definition.appliesTo],
    terms: definition.terms.map((term) => ({ ...term })),
    constraints: definition.constraints.map((constraint) => ({ ...constraint }))
  };
}

function cloneArenaFormula(formula) {
  const normalized = ARENA.normalizeArenaFormula(formula) || ARENA.defaultArenaFormula();
  return {
    ...normalized,
    sections: Object.fromEntries(ARENA.roleSectionKeys.map((sectionKey) => [
      sectionKey,
      {
        terms: normalized.sections[sectionKey].terms.map((term) => ({ ...term })),
        constraints: normalized.sections[sectionKey].constraints.map((constraint) => ({ ...constraint }))
      }
    ]))
  };
}

function getView() {
  return VIEW_DEFINITIONS.find((view) => view.id === popupState.viewId) || VIEW_DEFINITIONS[0];
}

function getPresetOptions(view) {
  return MODEL.getViewPresetOptions(view.id, customDefinitions);
}

function getSelectedPreset(view) {
  const presets = getPresetOptions(view);
  const selectedId = popupState.presetByView?.[view.id];
  return presets.find((preset) => preset.id === selectedId) || presets[0];
}

function getFilterValues(viewId) {
  return MODEL.normalizeFilterValues(viewId, filterValuesByView[viewId]);
}

function getSelectedArenaFormula() {
  const enabled = arenaFormulas.filter((formula) => formula.enabled);
  const formulas = enabled.length ? enabled : arenaFormulas;
  return formulas.find((formula) => formula.id === popupState.arenaFormulaId)
    || formulas[0]
    || ARENA.defaultArenaFormula();
}

async function applyCurrentSortToPage() {
  const view = getView();
  const preset = getSelectedPreset(view);
  const filterValues = getFilterValues(view.id);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    await chrome.tabs.sendMessage(tab.id, {
      type: "GLAD_AH_APPLY_SORT",
      sortId: preset.isCustom ? preset.id : MODEL.presetSortId(view.id, preset.id),
      viewId: view.id,
      filterValues
    });
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
