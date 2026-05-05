import { MODEL, SCHEMA, nodes, saveStorage, setStatus } from "./runtime.js";
import {
  ARMOR_PIECE_OPTIONS,
  DEFAULT_CONSTRAINT,
  DEFAULT_TERM,
  FILTER_VALUES_STORAGE_KEY,
  PAGE_DEFINITIONS,
  POPUP_STATE_KEY,
  VIEW_DEFINITIONS,
  cloneDefinition,
  getFilterValues,
  getPresetOptions,
  getSelectedArmorPiece,
  getSelectedPreset,
  getView,
  itemMatchesSelectedPiece,
  makeNewDefinitionDraft,
  persistCustomDefinitions,
  state,
  upsertDefinition,
  validateDefinition
} from "./store.js";

export function createAuctionView({ render, applyCurrentSortToPage }) {
  function renderPageTabs() {
    nodes.pageTabs.hidden = false;
    const fragment = document.createDocumentFragment();

    for (const page of PAGE_DEFINITIONS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = page.id === state.popupState.pageId ? "active" : "";
      button.dataset.pageId = page.id;
      button.textContent = page.label;
      fragment.append(button);
    }

    nodes.pageTabs.replaceChildren(fragment);
  }

  function renderItemsPage() {
    const items = state.scanResult?.items || [];
    const scannedAt = state.scanResult?.scannedAt ? new Date(state.scanResult.scannedAt).toLocaleTimeString() : "";

    if (state.scanResult) {
      const warnings = state.scanResult.scanWarnings?.length ? ` ${state.scanResult.scanWarnings.length} warning(s).` : "";
      setStatus(`Cached scan: ${items.length} items${scannedAt ? ` at ${scannedAt}` : ""}.${warnings}`);
    } else {
      setStatus("No cached scan. Tabs and sort presets still apply to the visible auction page.");
    }

    nodes.summary.hidden = !state.scanResult?.filterSummary && !state.scanResult?.scanWarnings?.length;
    nodes.summary.textContent = [
      state.scanResult?.filterSummary || "",
      ...(state.scanResult?.scanWarnings || []).map((warning) => `Warning: ${warning}`)
    ].filter(Boolean).join(" | ");
    nodes.tabs.hidden = false;
    nodes.controls.hidden = false;

    ensureValidView(items);
    renderItemTabs(items);
    renderControls();
    renderItems();
  }

  function renderFiltersPage() {
    setStatus("Create custom score filters. Enabled filters appear as presets for their selected item groups.");
    nodes.summary.hidden = true;
    nodes.summary.textContent = "";
    nodes.tabs.hidden = true;
    nodes.controls.hidden = true;
    nodes.controls.replaceChildren();
    nodes.results.replaceChildren(renderDefinitionManager());
  }

  function ensureValidView(items) {
    if (!items.length) {
      state.popupState.viewId = getView().id;
      return;
    }

    const currentView = getView();
    if (currentView && items.some(currentView.accepts)) return;

    const firstPopulated = VIEW_DEFINITIONS.find((view) => items.some(view.accepts));
    state.popupState.viewId = firstPopulated?.id || VIEW_DEFINITIONS[0].id;
  }

  function renderItemTabs(items) {
    const fragment = document.createDocumentFragment();

    for (const view of VIEW_DEFINITIONS) {
      const count = items.filter(view.accepts).length;
      const button = document.createElement("button");
      button.type = "button";
      button.className = view.id === state.popupState.viewId ? "active" : "";
      button.dataset.viewId = view.id;
      button.textContent = `${view.label} ${count}`;
      fragment.append(button);
    }

    nodes.tabs.replaceChildren(fragment);
  }

  function renderControls() {
    const view = getView();
    const selectedPresetId = getSelectedPreset(view).id;
    const fragment = document.createDocumentFragment();

    renderArmorPieceControl(fragment, view);

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
    nodes.controls.replaceChildren(fragment);
  }

  function renderArmorPieceControl(fragment, view) {
    if (view.id !== "armor") return;

    const items = (state.scanResult?.items || []).filter(view.accepts);
    const selected = getSelectedArmorPiece();
    const label = document.createElement("label");
    label.className = "filter-control";

    const text = document.createElement("span");
    text.textContent = "Piece";

    const select = document.createElement("select");
    select.dataset.armorPiece = "1";

    const all = document.createElement("option");
    all.value = "";
    all.textContent = `All armor ${items.length}`;
    select.append(all);

    for (const piece of ARMOR_PIECE_OPTIONS) {
      const count = items.filter((item) => String(item.itemType || "") === piece.itemType).length;
      const option = document.createElement("option");
      option.value = piece.itemType;
      option.textContent = `${piece.label} ${count}`;
      select.append(option);
    }

    select.value = selected;
    label.append(text, select);
    fragment.append(label);

    const separator = document.createElement("span");
    separator.className = "control-separator";
    separator.textContent = "|";
    fragment.append(separator);
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
    const items = (state.scanResult?.items || [])
      .filter(view.accepts)
      .filter((item) => itemMatchesSelectedPiece(item, view))
      .filter((item) => MODEL.itemMatchesFilters(item, view.id, filterValues))
      .filter((item) => !preset.matches || preset.matches(item))
      .map((item) => ({ item, score: preset.score(item) }))
      .sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        if ((a.item.level || 0) !== (b.item.level || 0)) return (b.item.level || 0) - (a.item.level || 0);
        return (a.item.name || "").localeCompare(b.item.name || "");
      });

    if (!items.length) {
      nodes.results.innerHTML = state.scanResult
        ? '<div class="empty">No items for this tab.</div>'
        : '<div class="empty">Choose a tab or sort preset to reorder the current auction page. Scan only when you want the full cached item list.</div>';
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const entry of items) {
      fragment.append(renderItem(entry.item, MODEL.formatScore(preset, entry.item, entry.score)));
    }
    nodes.results.replaceChildren(fragment);
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
    editor.dataset.definitionId = state.editorDraft.id;

    const title = document.createElement("h2");
    title.textContent = state.editorDraft.isNew ? "New custom filter" : "Edit custom filter";

    const nameLabel = document.createElement("label");
    nameLabel.className = "field-row";
    nameLabel.textContent = "Name";
    const nameInput = document.createElement("input");
    nameInput.name = "name";
    nameInput.type = "text";
    nameInput.value = state.editorDraft.name;
    nameLabel.append(nameInput);

    const enabledLabel = document.createElement("label");
    enabledLabel.className = "check-row";
    const enabledInput = document.createElement("input");
    enabledInput.name = "enabled";
    enabledInput.type = "checkbox";
    enabledInput.checked = state.editorDraft.enabled !== false;
    enabledLabel.append(enabledInput, document.createTextNode(" Enabled"));

    const applies = renderAppliesToEditor(state.editorDraft);
    const terms = renderTermsEditor(state.editorDraft);
    const constraints = renderConstraintsEditor(state.editorDraft);
    const actions = renderEditorActions(state.editorDraft);

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

    if (!state.customDefinitions.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No custom filters yet.";
      list.append(empty);
      return list;
    }

    for (const definition of state.customDefinitions) {
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

  async function onItemTabClick(event) {
    const button = event.target.closest("button[data-view-id]");
    if (!button) return false;

    state.popupState.viewId = button.dataset.viewId;
    await saveStorage(POPUP_STATE_KEY, state.popupState);
    render();
    applyCurrentSortToPage();
    return true;
  }

  async function onPresetClick(event) {
    const button = event.target.closest("button[data-preset-id]");
    if (!button) return false;

    state.popupState.presetByView = {
      ...state.popupState.presetByView,
      [state.popupState.viewId]: button.dataset.presetId
    };
    await saveStorage(POPUP_STATE_KEY, state.popupState);
    render();
    applyCurrentSortToPage();
    return true;
  }

  async function onFilterInput(event) {
    const armorPieceSelect = event.target.closest("select[data-armor-piece]");
    if (armorPieceSelect) {
      state.popupState.armorPiece = armorPieceSelect.value;
      await saveStorage(POPUP_STATE_KEY, state.popupState);
      renderItems();
      return true;
    }

    const input = event.target.closest("input[data-filter-id]");
    if (!input) return false;

    const view = getView();
    state.filterValuesByView = {
      ...state.filterValuesByView,
      [view.id]: {
        ...getFilterValues(view.id),
        [input.dataset.filterId]: input.value
      }
    };
    await saveStorage(FILTER_VALUES_STORAGE_KEY, MODEL.normalizeAllFilterValues(state.filterValuesByView));
    renderItems();
    applyCurrentSortToPage();
    return true;
  }

  async function onResultsClick(event) {
    const actionNode = event.target.closest("[data-action]");
    if (!actionNode) return false;

    const action = actionNode.dataset.action;
    if (!isAuctionDefinitionAction(action)) return false;

    if (action === "add-term") {
      syncEditorDraft();
      state.editorDraft.terms.push({ ...DEFAULT_TERM });
      render();
      return true;
    }

    if (action === "remove-term") {
      syncEditorDraft();
      state.editorDraft.terms.splice(Number(actionNode.dataset.index), 1);
      if (!state.editorDraft.terms.length) state.editorDraft.terms.push({ ...DEFAULT_TERM });
      render();
      return true;
    }

    if (action === "add-constraint") {
      syncEditorDraft();
      state.editorDraft.constraints.push({ ...DEFAULT_CONSTRAINT });
      render();
      return true;
    }

    if (action === "remove-constraint") {
      syncEditorDraft();
      state.editorDraft.constraints.splice(Number(actionNode.dataset.index), 1);
      render();
      return true;
    }

    if (action === "new-definition") {
      state.editorDraft = makeNewDefinitionDraft();
      render();
      return true;
    }

    if (action === "edit-definition") {
      const definition = state.customDefinitions.find((candidate) => candidate.id === actionNode.dataset.definitionId);
      if (definition) {
        state.editorDraft = { ...cloneDefinition(definition), isNew: false };
        render();
      }
      return true;
    }

    if (action === "delete-definition") {
      state.customDefinitions = state.customDefinitions.filter((definition) => definition.id !== actionNode.dataset.definitionId);
      if (state.editorDraft.id === actionNode.dataset.definitionId) state.editorDraft = makeNewDefinitionDraft();
      await persistCustomDefinitions();
      render();
      return true;
    }

    if (action === "toggle-definition") {
      state.customDefinitions = state.customDefinitions.map((definition) => definition.id === actionNode.dataset.definitionId
        ? { ...definition, enabled: actionNode.checked }
        : definition);
      await persistCustomDefinitions();
      render();
      return true;
    }

    if (action === "save-definition") {
      syncEditorDraft();
      const normalized = MODEL.normalizeCustomDefinition(state.editorDraft);
      const error = validateDefinition(normalized);
      if (error) {
        setStatus(error);
        return true;
      }

      state.customDefinitions = upsertDefinition(state.customDefinitions, normalized);
      state.editorDraft = { ...cloneDefinition(normalized), isNew: false };
      await persistCustomDefinitions();
      render();
      return true;
    }

    return false;
  }

  function onEditorInput(event) {
    if (!event.target.closest("#filter-editor")) return false;
    syncEditorDraft();
    return true;
  }

  function syncEditorDraft() {
    const editor = document.getElementById("filter-editor");
    if (!editor) return;

    state.editorDraft = {
      ...state.editorDraft,
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

  function isAuctionDefinitionAction(action) {
    return [
      "add-term",
      "remove-term",
      "add-constraint",
      "remove-constraint",
      "new-definition",
      "edit-definition",
      "delete-definition",
      "toggle-definition",
      "save-definition"
    ].includes(action);
  }

  return {
    renderPageTabs,
    renderItemsPage,
    renderFiltersPage,
    renderControls,
    renderItems,
    onItemTabClick,
    onPresetClick,
    onFilterInput,
    onResultsClick,
    onEditorInput
  };
}
