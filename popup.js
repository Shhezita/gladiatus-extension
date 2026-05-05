const SCHEMA = window.GladiatusAuctionSchema;
const MODEL = window.GladiatusAuctionModel;
if (!SCHEMA || !MODEL) {
  throw new Error("Gladiatus auction schema and model must load before the popup.");
}

const SCAN_STORAGE_KEY = SCHEMA.storageKeys.scanResult;
const POPUP_STATE_KEY = SCHEMA.storageKeys.popupState;
const FILTER_VALUES_STORAGE_KEY = MODEL.filterValuesStorageKey;

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
const DEFAULT_TERM = { stat: "agility", weight: 1 };
const DEFAULT_CONSTRAINT = { stat: "damageBonus", op: ">=", value: 0 };

let scanResult = null;
let customDefinitions = [];
let editorDraft = null;
let popupState = { pageId: "items", viewId: "weapons", presetByView: {}, filterByView: {} };
let filterValuesByView = {};

scanButton.addEventListener("click", scanAuction);
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
  popupState = { ...popupState, ...(await loadStorage(POPUP_STATE_KEY) || {}) };
  scanResult = await loadStorage(SCAN_STORAGE_KEY);
  filterValuesByView = MODEL.normalizeAllFilterValues(await loadStorage(FILTER_VALUES_STORAGE_KEY) || popupState.filterByView);
  await saveStorage(FILTER_VALUES_STORAGE_KEY, filterValuesByView);
  customDefinitions = MODEL.normalizeCustomDefinitions(await loadStorage(MODEL.customDefinitionsStorageKey));
  editorDraft = makeNewDefinitionDraft();
  subscribeToSharedFilterChanges();
  render();
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

    const response = await chrome.tabs.sendMessage(tab.id, { type: "GLAD_AH_SCAN_ALL" });
    if (!response || !response.ok) {
      throw new Error(response?.error || "The auction page did not return scan results.");
    }

    scanResult = response.result;
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

function render() {
  renderPageTabs();

  if (popupState.pageId === "filters") {
    renderFiltersPage();
  } else {
    renderItemsPage();
  }
}

function renderPageTabs() {
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
    setStatus(`Cached scan: ${items.length} items${scannedAt ? ` at ${scannedAt}` : ""}.`);
  } else {
    setStatus("No cached scan. Tabs and sort presets still apply to the visible auction page.");
  }

  summaryNode.hidden = !scanResult?.filterSummary;
  summaryNode.textContent = scanResult?.filterSummary || "";
  tabsNode.hidden = false;
  controlsNode.hidden = false;

  ensureValidView(items);
  renderItemTabs(items);
  renderControls();
  renderItems();
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

  popupState.pageId = button.dataset.pageId;
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

function onEditorInput(event) {
  if (!event.target.closest("#filter-editor")) return;
  syncEditorDraft();
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

function validateDefinition(definition) {
  if (!definition.name.trim()) return "Custom filter needs a name.";
  if (!definition.appliesTo.length) return "Select at least one item group.";
  if (!definition.terms.length) return "Add at least one non-zero score term.";
  return "";
}

function upsertDefinition(definitions, definition) {
  const index = definitions.findIndex((candidate) => candidate.id === definition.id);
  if (index === -1) return [...definitions, definition];

  return definitions.map((candidate, candidateIndex) => candidateIndex === index ? definition : candidate);
}

async function persistCustomDefinitions() {
  customDefinitions = MODEL.normalizeCustomDefinitions(customDefinitions);
  await saveStorage(MODEL.customDefinitionsStorageKey, customDefinitions);
  await notifyActivePageDefinitionsChanged();
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

function cloneDefinition(definition) {
  return {
    ...definition,
    appliesTo: [...definition.appliesTo],
    terms: definition.terms.map((term) => ({ ...term })),
    constraints: definition.constraints.map((constraint) => ({ ...constraint }))
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
