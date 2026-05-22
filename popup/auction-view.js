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

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (key === "className") el.className = value;
      else if (key === "dataset") Object.assign(el.dataset, value);
      else if (key === "style" && typeof value === "object") Object.assign(el.style, value);
      else if (key.startsWith("on") && typeof value === "function") {
        const eventName = key.slice(2).toLowerCase();
        el.addEventListener(eventName, value);
        if (eventName === "click") {
          let startY = 0;
          el.addEventListener("touchstart", (e) => { startY = e.changedTouches[0].screenY; }, { passive: true });
          el.addEventListener("touchend", (e) => {
            if (el.disabled || Math.abs(e.changedTouches[0].screenY - startY) > 10) return;
            e.preventDefault();
            value(e);
          });
        }
      }
      else if (key === "html") el.innerHTML = value;
      else el[key] = value;
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child != null && child !== false) {
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  }
  return el;
}

export function createAuctionView({ render, applyCurrentSortToPage }) {
  function renderPageTabs() {
    nodes.pageTabs.hidden = false;
    nodes.pageTabs.replaceChildren(...PAGE_DEFINITIONS.map(page => h("button", {
      type: "button",
      className: page.id === state.popupState.pageId ? "active" : "",
      dataset: { pageId: page.id }
    }, page.label)));
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
    nodes.tabs.replaceChildren(...VIEW_DEFINITIONS.map(view => {
      const count = items.filter(view.accepts).length;
      return h("button", {
        type: "button",
        className: view.id === state.popupState.viewId ? "active" : "",
        dataset: { viewId: view.id }
      }, `${view.label} ${count}`);
    }));
  }

  function renderControls() {
    const view = getView();
    const selectedPresetId = getSelectedPreset(view).id;
    const controls = [];

    const armorPiece = renderArmorPieceControl(view);
    if (armorPiece) controls.push(armorPiece);

    controls.push(h("span", { className: "control-label" }, "Sort"));

    for (const preset of getPresetOptions(view)) {
      controls.push(h("button", {
        type: "button",
        className: preset.id === selectedPresetId ? "active" : "",
        dataset: { presetId: preset.id }
      }, preset.label));
    }

    const filterControls = renderFilterControls(view);
    if (filterControls) controls.push(filterControls);

    nodes.controls.replaceChildren(...controls);
  }

  function renderArmorPieceControl(view) {
    if (view.id !== "armor") return null;

    const items = (state.scanResult?.items || []).filter(view.accepts);
    const selected = getSelectedArmorPiece();
    
    const options = [
      h("option", { value: "" }, `All armor ${items.length}`),
      ...ARMOR_PIECE_OPTIONS.map(piece => {
        const count = items.filter((item) => String(item.itemType || "") === piece.itemType).length;
        return h("option", { value: piece.itemType }, `${piece.label} ${count}`);
      })
    ];

    return h("span", {},
      h("label", { className: "filter-control" },
        h("span", {}, "Piece"),
        h("select", { dataset: { armorPiece: "1" }, value: selected }, ...options)
      ),
      h("span", { className: "control-separator" }, "|")
    );
  }

  function renderFilterControls(view) {
    const filterValues = getFilterValues(view.id);
    const controls = MODEL.getFilterControlDescriptors(view.id, filterValues);
    if (!controls.length) return null;

    return h("span", {},
      h("span", { className: "control-separator" }, "|"),
      ...controls.map(filter => h("label", { className: "filter-control" },
        h("span", {}, filter.label),
        h("input", {
          type: filter.type,
          min: String(filter.min),
          step: String(filter.step),
          dataset: { filterId: filter.id },
          value: filter.value
        })
      ))
    );
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

    nodes.results.replaceChildren(...items.map(entry => renderItem(entry.item, MODEL.formatScore(preset, entry.item, entry.score))));
  }

  function renderItem(item, scoreText) {
    const thumb = renderThumb(item);
    
    const meta = h("div", { className: "meta" }, [
      item.category,
      item.level ? `Level ${item.level}` : "",
      item.itemValue ? `Value ${item.itemValue}` : "",
      MODEL.priceLabel(item),
      MODEL.stat(item, "foodHealing") && MODEL.price(item)
        ? `Heals/gold ${MODEL.formatNumber(MODEL.stat(item, "foodHealing") / MODEL.price(item))}`
        : ""
    ].filter(Boolean).join(" | "));

    const stats = h("div", { className: "stats" }, MODEL.formatStats(item.stats || {}));

    const detail = h("div", { className: "item-detail" },
      h("div", { className: "item-name" }, item.name || "Unknown item"),
      h("div", { className: "score" }, scoreText),
      meta,
      stats
    );

    return h("article", { className: "item" }, thumb, detail);
  }

  function renderDefinitionManager() {
    return h("section", { className: "definition-page" },
      renderDefinitionEditor(),
      renderDefinitionList()
    );
  }

  function renderDefinitionEditor() {
    return h("section", { 
      id: "filter-editor",
      className: "definition-editor",
      dataset: { definitionId: state.editorDraft.id }
    },
      h("h2", {}, state.editorDraft.isNew ? "New custom filter" : "Edit custom filter"),
      h("label", { className: "field-row" }, 
        "Name",
        h("input", { name: "name", type: "text", value: state.editorDraft.name })
      ),
      h("label", { className: "check-row" },
        h("input", { name: "enabled", type: "checkbox", checked: state.editorDraft.enabled !== false }),
        " Enabled"
      ),
      renderAppliesToEditor(state.editorDraft),
      renderTermsEditor(state.editorDraft),
      renderConstraintsEditor(state.editorDraft),
      renderEditorActions(state.editorDraft)
    );
  }

  function renderAppliesToEditor(definition) {
    return h("fieldset", { className: "editor-group" },
      h("legend", {}, "Applies to"),
      ...VIEW_DEFINITIONS.map(view => h("label", { className: "check-row" },
        h("input", {
          type: "checkbox",
          name: "appliesTo",
          value: view.id,
          checked: definition.appliesTo.includes(view.id)
        }),
        ` ${view.label}`
      ))
    );
  }

  function renderTermsEditor(definition) {
    return h("section", { className: "editor-group" },
      h("div", { className: "editor-heading" }, "Score terms"),
      ...definition.terms.map((term, index) => renderTermRow(term, index)),
      h("button", { type: "button", dataset: { action: "add-term" } }, "Add term")
    );
  }

  function renderTermRow(term, index) {
    return h("div", { className: "builder-row", dataset: { termIndex: String(index) } },
      makeStatSelect("term-stat", term.stat),
      h("input", {
        name: "term-weight",
        type: "number",
        step: "0.1",
        value: String(term.weight)
      }),
      h("button", {
        type: "button",
        dataset: { action: "remove-term", index: String(index) }
      }, "Remove")
    );
  }

  function renderConstraintsEditor(definition) {
    return h("section", { className: "editor-group" },
      h("div", { className: "editor-heading" }, "Constraints"),
      ...definition.constraints.map((constraint, index) => renderConstraintRow(constraint, index)),
      h("button", { type: "button", dataset: { action: "add-constraint" } }, "Add constraint")
    );
  }

  function renderConstraintRow(constraint, index) {
    return h("div", { className: "builder-row", dataset: { constraintIndex: String(index) } },
      makeStatSelect("constraint-stat", constraint.stat),
      h("select", { name: "constraint-op", value: constraint.op },
        ...[">=", "<="].map(operator => h("option", { value: operator }, operator))
      ),
      h("input", {
        name: "constraint-value",
        type: "number",
        step: "0.1",
        value: String(constraint.value)
      }),
      h("button", {
        type: "button",
        dataset: { action: "remove-constraint", index: String(index) }
      }, "Remove")
    );
  }

  function renderEditorActions(definition) {
    return h("div", { className: "editor-actions" },
      h("button", { type: "button", dataset: { action: "save-definition" } }, definition.isNew ? "Create filter" : "Save filter"),
      h("button", { type: "button", dataset: { action: "new-definition" } }, "New")
    );
  }

  function renderDefinitionList() {
    return h("section", { className: "definition-list" },
      h("h2", {}, "Saved filters"),
      state.customDefinitions.length 
        ? state.customDefinitions.map(def => renderDefinitionCard(def))
        : h("div", { className: "empty" }, "No custom filters yet.")
    );
  }

  function renderDefinitionCard(definition) {
    return h("article", { className: "definition-card" },
      h("div", { className: "definition-title" }, definition.name),
      h("label", { className: "check-row" },
        h("input", {
          type: "checkbox",
          checked: definition.enabled,
          dataset: { action: "toggle-definition", definitionId: definition.id }
        }),
        " Enabled"
      ),
      h("div", { className: "definition-meta" },
        definition.appliesTo
          .map((viewId) => MODEL.getView(viewId)?.label)
          .filter(Boolean)
          .join(", ")
      ),
      h("div", { className: "definition-formula" }, MODEL.summarizeCustomDefinition(definition)),
      h("div", { className: "definition-actions" },
        h("button", { type: "button", dataset: { action: "edit-definition", definitionId: definition.id } }, "Edit"),
        h("button", { type: "button", dataset: { action: "delete-definition", definitionId: definition.id } }, "Delete")
      )
    );
  }

  function makeStatSelect(name, selected) {
    return h("select", { name, value: selected },
      ...MODEL.statOptions.map(stat => h("option", { value: stat.key }, stat.label))
    );
  }

  function renderThumb(item) {
    const thumb = h("div", { className: "item-thumb", title: item.name || "" });
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
