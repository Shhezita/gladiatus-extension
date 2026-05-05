import {
  ARENA,
  AUCTION_CONTENT_MESSAGES,
  MODEL,
  SCHEMA,
  getActiveTab,
  loadStorage,
  saveStorage,
  sendTabMessage
} from "./runtime.js";

export const SCAN_STORAGE_KEY = SCHEMA.storageKeys.scanResult;
export const SCAN_ARCHIVE_STORAGE_KEY = SCHEMA.storageKeys.scanArchive;
export const POPUP_STATE_KEY = SCHEMA.storageKeys.popupState;
export const FILTER_VALUES_STORAGE_KEY = MODEL.filterValuesStorageKey;
export const MAX_SCAN_ARCHIVES = 5;

export const VIEW_DEFINITIONS = MODEL.viewDefinitions;
export const PAGE_DEFINITIONS = [
  { id: "items", label: "Items" },
  { id: "filters", label: "Filters" }
];
export const ARENA_PAGE_DEFINITIONS = [
  { id: "opponents", label: "Opponents" },
  { id: "formulas", label: "Formulas" }
];
export const DEFAULT_TERM = { stat: "agility", weight: 1 };
export const DEFAULT_CONSTRAINT = { stat: "damageBonus", op: ">=", value: 0 };
export const DEFAULT_ARENA_TERM = { stat: "agility", weight: 1 };
export const DEFAULT_ARENA_CONSTRAINT = { stat: "level", op: ">=", value: 0 };
export const ARMOR_PIECE_OPTIONS = SCHEMA.mainScanCategories
  .filter((category) => category.viewId === "armor")
  .map((category) => ({ itemType: category.itemType, label: category.label }));

export const DEFAULT_POPUP_STATE = {
  pageId: "items",
  arenaPageId: "opponents",
  viewId: "weapons",
  armorPiece: "",
  presetByView: {},
  filterByView: {},
  arenaFormulaId: ""
};

export const state = {
  scanResult: null,
  arenaResult: null,
  customDefinitions: [],
  arenaFormulas: [],
  editorDraft: null,
  arenaFormulaDraft: null,
  popupState: normalizePopupState(),
  filterValuesByView: {},
  pageMode: "unsupported",
  activeTab: null
};

export function normalizePopupState(saved = {}) {
  const source = saved && typeof saved === "object" ? saved : {};
  return {
    ...DEFAULT_POPUP_STATE,
    ...source,
    presetByView: source.presetByView && typeof source.presetByView === "object" ? source.presetByView : {},
    filterByView: source.filterByView && typeof source.filterByView === "object" ? source.filterByView : {}
  };
}

export async function loadArenaFormulas() {
  const saved = await loadStorage(ARENA.formulasStorageKey);
  if (saved !== null) return ARENA.normalizeArenaFormulas(saved);

  const formulas = ARENA.normalizeArenaFormulas(saved);
  if (formulas.length) return formulas;

  const defaults = [ARENA.defaultArenaFormula()];
  await saveStorage(ARENA.formulasStorageKey, defaults);
  return defaults;
}

export async function persistCustomDefinitions() {
  state.customDefinitions = MODEL.normalizeCustomDefinitions(state.customDefinitions);
  await saveStorage(MODEL.customDefinitionsStorageKey, state.customDefinitions);
  await notifyActivePageDefinitionsChanged();
}

export async function persistArenaFormulas() {
  state.arenaFormulas = ARENA.normalizeArenaFormulas(state.arenaFormulas);
  await saveStorage(ARENA.formulasStorageKey, state.arenaFormulas);
}

export function normalizeScanResult(result) {
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

export function sortScanItems(items) {
  const categoryRank = new Map(SCHEMA.scanCategories.map((category, index) => [category.id, index]));

  return [...items].sort((a, b) => {
    const categoryDiff = (categoryRank.get(a.categoryId) ?? 999) - (categoryRank.get(b.categoryId) ?? 999);
    if (categoryDiff) return categoryDiff;
    if ((a.level || 0) !== (b.level || 0)) return (a.level || 0) - (b.level || 0);
    return (a.name || "").localeCompare(b.name || "");
  });
}

export async function archivePreviousScan(previous, next) {
  if (!previous?.items?.length) return;
  if (scanFingerprint(previous) === scanFingerprint(next)) return;

  const archive = await loadStorage(SCAN_ARCHIVE_STORAGE_KEY);
  const entries = Array.isArray(archive) ? archive : [];
  await saveStorage(SCAN_ARCHIVE_STORAGE_KEY, [
    compactScanArchive(previous, next),
    ...entries
  ].slice(0, MAX_SCAN_ARCHIVES));
}

export function scanFingerprint(scan) {
  return (scan?.items || [])
    .map((item) => `${item.categoryId || ""}:${item.auctionId || ""}:${item.name || ""}:${item.bidAmount || ""}:${item.priceGold || ""}`)
    .sort()
    .join("|");
}

export function compactScanArchive(scan, replacement) {
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

export function compactArchivedItem(item) {
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

export async function notifyActivePageDefinitionsChanged() {
  try {
    const tab = await getActiveTab();
    if (!tab?.id) return;
    await sendTabMessage(tab.id, {
      type: AUCTION_CONTENT_MESSAGES.customDefinitionsUpdated,
      definitions: state.customDefinitions
    });
  } catch {
    // The active tab does not need to be a Gladiatus auction page.
  }
}

export function makeNewDefinitionDraft() {
  return {
    id: `filter-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: "",
    appliesTo: [state.popupState.viewId || "armor"],
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

export function makeNewArenaFormulaDraft() {
  return {
    ...cloneArenaFormula(ARENA.defaultArenaFormula()),
    id: `arena-formula-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: "",
    isNew: true
  };
}

export function cloneDefinition(definition) {
  return {
    ...definition,
    appliesTo: [...definition.appliesTo],
    terms: definition.terms.map((term) => ({ ...term })),
    constraints: definition.constraints.map((constraint) => ({ ...constraint }))
  };
}

export function cloneArenaFormula(formula) {
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

export function validateDefinition(definition) {
  if (!definition.name.trim()) return "Custom filter needs a name.";
  if (!definition.appliesTo.length) return "Select at least one item group.";
  if (!definition.terms.length) return "Add at least one non-zero score term.";
  return "";
}

export function validateArenaFormula(formula) {
  if (!formula.name.trim()) return "Arena formula needs a name.";
  const hasAnyTerms = ARENA.roleSectionKeys.some((sectionKey) => formula.sections[sectionKey].terms.length);
  if (!hasAnyTerms) return "Add at least one non-zero score term.";
  return "";
}

export function upsertDefinition(definitions, definition) {
  const index = definitions.findIndex((candidate) => candidate.id === definition.id);
  if (index === -1) return [...definitions, definition];

  return definitions.map((candidate, candidateIndex) => candidateIndex === index ? definition : candidate);
}

export function upsertArenaFormula(formulas, formula) {
  const index = formulas.findIndex((candidate) => candidate.id === formula.id);
  if (index === -1) return [...formulas, formula];

  return formulas.map((candidate, candidateIndex) => candidateIndex === index ? formula : candidate);
}

export function getView() {
  return VIEW_DEFINITIONS.find((view) => view.id === state.popupState.viewId) || VIEW_DEFINITIONS[0];
}

export function getPresetOptions(view) {
  return MODEL.getViewPresetOptions(view.id, state.customDefinitions);
}

export function getSelectedPreset(view) {
  const presets = getPresetOptions(view);
  const selectedId = state.popupState.presetByView?.[view.id];
  return presets.find((preset) => preset.id === selectedId) || presets[0];
}

export function getFilterValues(viewId) {
  return MODEL.normalizeFilterValues(viewId, state.filterValuesByView[viewId]);
}

export function getSelectedArmorPiece() {
  return ARMOR_PIECE_OPTIONS.some((piece) => piece.itemType === state.popupState.armorPiece)
    ? state.popupState.armorPiece
    : "";
}

export function itemMatchesSelectedPiece(item, view) {
  if (view.id !== "armor") return true;
  const selectedPiece = getSelectedArmorPiece();
  return !selectedPiece || String(item.itemType || "") === selectedPiece;
}

export function getSelectedArenaFormula() {
  const enabled = state.arenaFormulas.filter((formula) => formula.enabled);
  const formulas = enabled.length ? enabled : state.arenaFormulas;
  return formulas.find((formula) => formula.id === state.popupState.arenaFormulaId)
    || formulas[0]
    || ARENA.defaultArenaFormula();
}
