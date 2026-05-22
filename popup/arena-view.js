import { ARENA, nodes, saveStorage, setStatus } from "./runtime.js";
import {
  ARENA_PAGE_DEFINITIONS,
  DEFAULT_ARENA_CONSTRAINT,
  DEFAULT_ARENA_TERM,
  POPUP_STATE_KEY,
  cloneArenaFormula,
  getSelectedArenaFormula,
  makeNewArenaFormulaDraft,
  persistArenaFormulas,
  state,
  upsertArenaFormula,
  validateArenaFormula
} from "./store.js";

export function createArenaView({ render, showToast }) {
  function renderArenaPage() {
    renderArenaPageTabs();
    nodes.tabs.hidden = true;
    nodes.tabs.replaceChildren();

    if (state.popupState.arenaPageId === "formulas") {
      renderArenaFormulasPage();
      return;
    }

    renderArenaOpponentsPage();
  }

  function renderArenaPageTabs() {
    nodes.pageTabs.hidden = false;
    const fragment = document.createDocumentFragment();

    for (const page of ARENA_PAGE_DEFINITIONS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = page.id === state.popupState.arenaPageId ? "active" : "";
      button.dataset.pageId = page.id;
      button.textContent = page.label;
      fragment.append(button);
    }

    nodes.pageTabs.replaceChildren(fragment);
  }

  function renderArenaOpponentsPage() {
    renderArenaControls();

    if (!state.arenaResult) {
      nodes.summary.hidden = true;
      nodes.summary.textContent = "";
      setStatus("Open an arena opponent list, then scan.");
      nodes.results.innerHTML = '<div class="empty">Scan to fetch the visible opponent profiles and show stat totals next to their arena rows.</div>';
      return;
    }

    const scannedAt = state.arenaResult.scannedAt ? new Date(state.arenaResult.scannedAt).toLocaleTimeString() : "";
    const failed = state.arenaResult.failedCount ? ` ${state.arenaResult.failedCount} failed.` : "";
    setStatus(`Scanned ${state.arenaResult.opponentCount} opponents${scannedAt ? ` at ${scannedAt}` : ""}.${failed}`);
    nodes.summary.hidden = !state.arenaResult.bestName;
    nodes.summary.textContent = state.arenaResult.bestName
      ? `Lowest ${state.arenaResult.arenaKind === "team" ? "team" : "fighter"} score: ${state.arenaResult.bestName} (${ARENA.formatNumber(state.arenaResult.bestScore)})`
      : "";
    nodes.results.replaceChildren(renderArenaResults(state.arenaResult));
  }

  function renderArenaControls() {
    nodes.controls.hidden = false;
    const fragment = document.createDocumentFragment();

    const label = document.createElement("label");
    label.className = "filter-control";

    const text = document.createElement("span");
    text.textContent = "Formula";

    const select = document.createElement("select");
    select.dataset.arenaFormulaSelect = "1";
    select.disabled = !state.arenaFormulas.length;

    const enabled = state.arenaFormulas.filter((candidate) => candidate.enabled);
    const available = enabled.length ? enabled : state.arenaFormulas;
    for (const formula of available) {
      const option = document.createElement("option");
      option.value = formula.id;
      option.textContent = formula.name;
      select.append(option);
    }

    select.value = getSelectedArenaFormula().id;
    label.append(text, select);
    fragment.append(label);
    nodes.controls.replaceChildren(fragment);
  }

  function renderArenaFormulasPage() {
    setStatus("Create role-aware arena formulas. Enabled formulas can be selected before scanning opponents.");
    nodes.summary.hidden = true;
    nodes.summary.textContent = "";
    nodes.controls.hidden = true;
    nodes.controls.replaceChildren();
    nodes.results.replaceChildren(renderArenaFormulaManager());
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
    editor.dataset.formulaId = state.arenaFormulaDraft.id;

    const title = document.createElement("h2");
    title.textContent = state.arenaFormulaDraft.isNew ? "New arena formula" : "Edit arena formula";

    const nameLabel = document.createElement("label");
    nameLabel.className = "field-row";
    nameLabel.textContent = "Name";
    const nameInput = document.createElement("input");
    nameInput.name = "arena-name";
    nameInput.type = "text";
    nameInput.value = state.arenaFormulaDraft.name;
    nameLabel.append(nameInput);

    const enabledLabel = document.createElement("label");
    enabledLabel.className = "check-row";
    const enabledInput = document.createElement("input");
    enabledInput.name = "arena-enabled";
    enabledInput.type = "checkbox";
    enabledInput.checked = state.arenaFormulaDraft.enabled !== false;
    enabledLabel.append(enabledInput, document.createTextNode(" Enabled"));

    editor.append(title, nameLabel, enabledLabel);

    for (const sectionKey of ARENA.roleSectionKeys) {
      editor.append(renderArenaFormulaSectionEditor(sectionKey, state.arenaFormulaDraft.sections[sectionKey]));
    }

    const actions = document.createElement("div");
    actions.className = "editor-actions";

    const save = document.createElement("button");
    save.type = "button";
    save.dataset.action = "save-arena-formula";
    save.textContent = state.arenaFormulaDraft.isNew ? "Create formula" : "Save formula";

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

    if (!state.arenaFormulas.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No arena formulas yet.";
      list.append(empty);
      return list;
    }

    for (const formula of state.arenaFormulas) {
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

  async function onControlsInput(event) {
    const formulaSelect = event.target.closest("select[data-arena-formula-select]");
    if (!formulaSelect) return false;

    state.popupState.arenaFormulaId = formulaSelect.value;
    await saveStorage(POPUP_STATE_KEY, state.popupState);
    return true;
  }

  async function onResultsClick(event) {
    const actionNode = event.target.closest("[data-action]");
    if (!actionNode) return false;

    const action = actionNode.dataset.action;
    if (!isArenaFormulaAction(action)) return false;

    const sectionKey = actionNode.dataset.sectionKey;

    if (action === "add-arena-term") {
      syncArenaFormulaDraft();
      state.arenaFormulaDraft.sections[sectionKey].terms.push({ ...DEFAULT_ARENA_TERM });
      render();
      return true;
    }

    if (action === "remove-arena-term") {
      syncArenaFormulaDraft();
      state.arenaFormulaDraft.sections[sectionKey].terms.splice(Number(actionNode.dataset.index), 1);
      render();
      return true;
    }

    if (action === "add-arena-constraint") {
      syncArenaFormulaDraft();
      state.arenaFormulaDraft.sections[sectionKey].constraints.push({ ...DEFAULT_ARENA_CONSTRAINT });
      render();
      return true;
    }

    if (action === "remove-arena-constraint") {
      syncArenaFormulaDraft();
      state.arenaFormulaDraft.sections[sectionKey].constraints.splice(Number(actionNode.dataset.index), 1);
      render();
      return true;
    }

    if (action === "new-arena-formula") {
      state.arenaFormulaDraft = makeNewArenaFormulaDraft();
      render();
      return true;
    }

    if (action === "edit-arena-formula") {
      const formula = state.arenaFormulas.find((candidate) => candidate.id === actionNode.dataset.formulaId);
      if (formula) {
        state.arenaFormulaDraft = { ...cloneArenaFormula(formula), isNew: false };
        render();
      }
      return true;
    }

    if (action === "delete-arena-formula") {
      state.arenaFormulas = state.arenaFormulas.filter((formula) => formula.id !== actionNode.dataset.formulaId);
      if (state.arenaFormulaDraft.id === actionNode.dataset.formulaId) state.arenaFormulaDraft = makeNewArenaFormulaDraft();
      await persistArenaFormulas();
      render();
      return true;
    }

    if (action === "toggle-arena-formula") {
      state.arenaFormulas = state.arenaFormulas.map((formula) => formula.id === actionNode.dataset.formulaId
        ? { ...formula, enabled: actionNode.checked }
        : formula);
      await persistArenaFormulas();
      render();
      return true;
    }

    if (action === "save-arena-formula") {
      syncArenaFormulaDraft();
      const normalized = ARENA.normalizeArenaFormula(state.arenaFormulaDraft);
      const error = validateArenaFormula(normalized);
      if (error) {
        setStatus(error);
        return true;
      }

      state.arenaFormulas = upsertArenaFormula(state.arenaFormulas, normalized);
      state.arenaFormulaDraft = { ...cloneArenaFormula(normalized), isNew: false };
      state.popupState.arenaFormulaId = normalized.id;
      await persistArenaFormulas();
      await saveStorage(POPUP_STATE_KEY, state.popupState);
      render();
      if (showToast) showToast("✅ Arena formula saved");
      return true;
    }

    return false;
  }

  function onEditorInput(event) {
    if (!event.target.closest("#arena-formula-editor")) return false;
    syncArenaFormulaDraft();
    return true;
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

    state.arenaFormulaDraft = {
      ...state.arenaFormulaDraft,
      name: editor.querySelector("input[name='arena-name']")?.value || "",
      enabled: Boolean(editor.querySelector("input[name='arena-enabled']")?.checked),
      sections
    };
  }

  function isArenaFormulaAction(action) {
    return [
      "add-arena-term",
      "remove-arena-term",
      "add-arena-constraint",
      "remove-arena-constraint",
      "new-arena-formula",
      "edit-arena-formula",
      "delete-arena-formula",
      "toggle-arena-formula",
      "save-arena-formula"
    ].includes(action);
  }

  return {
    renderArenaPage,
    onControlsInput,
    onResultsClick,
    onEditorInput
  };
}
