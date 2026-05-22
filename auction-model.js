(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : window;
  const SCHEMA = root.GladiatusAuctionSchema;
  const SCORE = root.GladiatusScoreModel;
  if (!SCHEMA) {
    return;
  }
  if (!SCORE) {
    throw new Error("GladiatusScoreModel must load before GladiatusAuctionModel.");
  }

  if (root.GladiatusAuctionModel) return;

  const STRENGTH_PER_DAMAGE = 10;
  const MAIN_DAMAGE_WEIGHT = 8;
  const CUSTOM_DEFINITIONS_STORAGE_KEY = SCHEMA.storageKeys.customDefinitions;
  const FILTER_VALUES_STORAGE_KEY = SCHEMA.storageKeys.filterValues;
  const CUSTOM_SORT_PREFIX = "custom:";
  const STAT_LABELS = SCHEMA.statLabels;
  const STAT_ORDER = SCHEMA.statOrder;

  function defineItemView(definition) {
    return {
      filters: [],
      presets: [],
      ...definition
    };
  }

  function defineScorePreset(definition) {
    return { ...definition };
  }

  function defineMinimumStatFilter({ id, label, statKey, options, defaultStat, defaultValue = 0, min = 0, step = 1 }) {
    if (options) {
      return [
        {
          id: `${id}_stat`,
          label: `${label} stat`,
          defaultValue: defaultStat || options[0].value,
          type: "select",
          options,
          predicate: () => true,
          describe: () => null
        },
        {
          id: `${id}_val`,
          label: `${label} value`,
          defaultValue,
          min,
          step,
          type: "number",
          predicate: (item, value, allValues) => {
            const selectedStat = allValues[`${id}_stat`] || defaultStat || options[0].value;
            return stat(item, selectedStat) >= numericFilterValue(value, defaultValue);
          },
          describe: (value, allValues) => {
            const selectedStat = allValues[`${id}_stat`] || defaultStat || options[0].value;
            const statLabel = options.find(o => o.value === selectedStat)?.label || selectedStat;
            return `${statLabel}: ${formatNumber(numericFilterValue(value, defaultValue))}+`;
          }
        }
      ];
    }
    return [{
      id,
      label,
      defaultValue,
      min,
      step,
      type: "number",
      predicate: (item, value) => stat(item, statKey) >= numericFilterValue(value, defaultValue),
      describe: (value) => `${label}: ${formatNumber(numericFilterValue(value, defaultValue))}+`
    }];
  }

  const VIEW_DEFINITIONS = [
    defineItemView({
      id: "weapons",
      label: "Weapons",
      defaultItemType: "1",
      accepts: (item) => acceptsView("weapons", item),
      presets: [
        defineScorePreset({ id: "avgDamage", label: "Average damage", score: (item) => stat(item, "damageAvg") }),
        defineScorePreset({ id: "maxDamage", label: "Max damage", score: (item) => stat(item, "damageMax") }),
        defineScorePreset({ id: "damageValue", label: "Damage / gold", score: (item) => safeDivide(stat(item, "damageAvg"), price(item)) })
      ]
    }),
    defineItemView({
      id: "armor",
      label: "Armor",
      defaultItemType: "2",
      accepts: (item) => acceptsView("armor", item),
      presets: [
        defineScorePreset({ id: "main", label: "Main: Agi/Dex + dmg x8", score: mainCharacterScore }),
        defineScorePreset({ id: "tank", label: "Tank utility", score: tankScore }),
        defineScorePreset({ id: "healing", label: "Healing", score: (item) => stat(item, "healing") }),
        defineScorePreset({ id: "block", label: "Block", score: (item) => stat(item, "blockvalue") }),
        defineScorePreset({ id: "threat", label: "Threat", score: (item) => stat(item, "threat") })
      ],
      filters: [
        ...defineMinimumStatFilter({
          id: "armorFilter",
          label: "Min stat filter",
          options: [
            { value: "damageBonus", label: "Min damage" },
            { value: "blockvalue", label: "Block value" },
            { value: "hardeningvalue", label: "Hardening value" }
          ],
          defaultStat: "damageBonus"
        })
      ]
    }),
    defineItemView({
      id: "food",
      label: "Food",
      defaultItemType: "7",
      accepts: (item) => acceptsView("food", item) && stat(item, "foodHealing") > 0,
      presets: [
        defineScorePreset({ id: "efficiency", label: "Health / gold", score: (item) => safeDivide(stat(item, "foodHealing"), price(item)) }),
        defineScorePreset({ id: "healing", label: "Total healing", score: (item) => stat(item, "foodHealing") }),
        defineScorePreset({ id: "cheap", label: "Cheapest", score: (item) => -price(item), display: (item) => `Price: ${formatNumber(price(item))}` })
      ]
    }),
    defineItemView({
      id: "upgrades",
      label: "Upgrades",
      defaultItemType: "12",
      accepts: (item) => acceptsView("upgrades", item),
      presets: [
        defineScorePreset({ id: "damage", label: "Damage", score: (item) => stat(item, "damageBonus") }),
        defineScorePreset({ id: "agility", label: "Agility", score: (item) => stat(item, "agility") }),
        defineScorePreset({ id: "dexterity", label: "Dexterity", score: (item) => stat(item, "dexterity") }),
        defineScorePreset({ id: "strength", label: "Strength", score: (item) => stat(item, "strength") })
      ]
    }),
    defineItemView({
      id: "mercenaries",
      label: "Mercenaries",
      defaultItemType: "15",
      accepts: (item) => acceptsView("mercenaries", item),
      presets: [
        defineScorePreset({ id: "agility", label: "Agility", score: (item) => stat(item, "agility") }),
        defineScorePreset({ id: "dexStrength", label: "Dexterity + strength", score: (item) => stat(item, "dexterity") + stat(item, "strength") })
      ]
    })
  ];

  function presetSortId(viewId, presetId) {
    return `preset:${viewId}:${presetId}`;
  }

  function customSortId(definitionId) {
    return `${CUSTOM_SORT_PREFIX}${definitionId}`;
  }

  function customDefinitionIdFromSortId(sortId) {
    return String(sortId || "").startsWith(CUSTOM_SORT_PREFIX)
      ? String(sortId).slice(CUSTOM_SORT_PREFIX.length)
      : "";
  }

  function getPreset(viewId, presetId, customDefinitions = []) {
    const customDefinitionId = customDefinitionIdFromSortId(presetId);
    if (customDefinitionId) {
      const customPreset = getCustomPresetForView(viewId, customDefinitionId, customDefinitions);
      return customPreset ? { view: getView(viewId), preset: customPreset } : null;
    }

    const view = getView(viewId);
    const preset = view?.presets.find((candidate) => candidate.id === presetId);
    return view && preset ? { view, preset } : null;
  }

  function getView(viewId) {
    return VIEW_DEFINITIONS.find((candidate) => candidate.id === viewId) || null;
  }

  function getViewForItemType(itemType) {
    return getView(defaultViewIdForItemType(itemType));
  }

  function getViewPresetOptions(viewId, customDefinitions = []) {
    const view = getView(viewId);
    if (!view) return [];

    return [
      ...view.presets,
      ...getCustomPresetOptionsForView(viewId, customDefinitions)
    ];
  }

  function getPresetSortOptions(customDefinitions = []) {
    return [
      ...VIEW_DEFINITIONS.flatMap((view) => view.presets.map((preset) => ({
        id: presetSortId(view.id, preset.id),
        label: `${view.label}: ${preset.label}`,
        group: "Preset scores",
        viewId: view.id,
        presetId: preset.id,
        get: preset.score,
        display: preset.display
      }))),
      ...getCustomDefinitionSortOptions(customDefinitions)
    ];
  }

  function defaultPresetForView(viewId) {
    const view = VIEW_DEFINITIONS.find((candidate) => candidate.id === viewId) || VIEW_DEFINITIONS[0];
    return presetSortId(view.id, view.presets[0].id);
  }

  function defaultPresetForItemType(itemType) {
    return defaultPresetForView(defaultViewIdForItemType(itemType));
  }

  function defaultViewIdForItemType(itemType) {
    return SCHEMA.defaultViewIdForItemType(itemType) || "armor";
  }

  function defaultFilterValuesForView(viewId) {
    const view = getView(viewId);
    if (!view) return {};

    return Object.fromEntries(view.filters.map((filter) => [filter.id, filter.defaultValue]));
  }

  function normalizeFilterValues(viewId, values) {
    return {
      ...defaultFilterValuesForView(viewId),
      ...(values && typeof values === "object" ? values : {})
    };
  }

  function normalizeAllFilterValues(valuesByView) {
    const source = valuesByView && typeof valuesByView === "object" ? valuesByView : {};
    return Object.fromEntries(VIEW_DEFINITIONS.map((view) => [
      view.id,
      normalizeFilterValues(view.id, source[view.id])
    ]));
  }

  function filterValuesEqual(left, right) {
    return JSON.stringify(normalizeAllFilterValues(left)) === JSON.stringify(normalizeAllFilterValues(right));
  }

  function getFilterControlDescriptors(viewId, values) {
    const view = getView(viewId);
    if (!view?.filters.length) return [];

    const normalizedValues = normalizeFilterValues(viewId, values);
    return view.filters.map((filter) => ({
      id: filter.id,
      label: filter.label,
      type: filter.type || "number",
      min: filter.min ?? 0,
      step: filter.step ?? 1,
      value: normalizedValues[filter.id] ?? filter.defaultValue ?? 0,
      defaultValue: filter.defaultValue ?? 0
    }));
  }

  function itemMatchesFilters(item, viewId, values) {
    const view = getView(viewId);
    if (!view?.filters.length) return true;

    const normalizedValues = normalizeFilterValues(viewId, values);
    return view.filters.every((filter) => filter.predicate(item, normalizedValues[filter.id]));
  }

  function normalizeCustomDefinitions(definitions) {
    return SCORE.normalizeDefinitions(definitions, customDefinitionOptions());
  }

  function normalizeCustomDefinition(definition) {
    return SCORE.normalizeDefinition(definition, customDefinitionOptions());
  }

  function customDefinitionOptions() {
    return {
      defaultName: "Untitled filter",
      idPrefix: "filter",
      statKeys: STAT_ORDER,
      validAppliesTo: VIEW_DEFINITIONS.map((view) => view.id)
    };
  }

  function getCustomPresetOptionsForView(viewId, customDefinitions = []) {
    return normalizeCustomDefinitions(customDefinitions)
      .filter((definition) => definition.enabled && definition.appliesTo.includes(viewId))
      .map((definition) => ({
        id: customSortId(definition.id),
        label: definition.name,
        score: (item) => scoreCustomDefinition(item, definition),
        matches: (item) => itemMatchesCustomDefinition(item, definition),
        customDefinitionId: definition.id,
        isCustom: true
      }));
  }

  function getCustomPresetForView(viewId, definitionId, customDefinitions = []) {
    return getCustomPresetOptionsForView(viewId, customDefinitions)
      .find((preset) => preset.customDefinitionId === definitionId) || null;
  }

  function getCustomDefinitionSortOptions(customDefinitions = []) {
    return normalizeCustomDefinitions(customDefinitions)
      .filter((definition) => definition.enabled)
      .flatMap((definition) => definition.appliesTo.map((viewId) => ({
        id: customSortId(definition.id),
        label: definition.name,
        group: "Custom scores",
        viewId,
        customDefinitionId: definition.id,
        get: (item) => scoreCustomDefinition(item, definition),
        matches: (item) => itemMatchesCustomDefinition(item, definition)
      })));
  }

  function scoreCustomDefinition(item, definition) {
    const normalized = normalizeCustomDefinition(definition);
    return normalized ? SCORE.score(item, normalized, stat) : 0;
  }

  function itemMatchesCustomDefinition(item, definition) {
    const normalized = normalizeCustomDefinition(definition);
    if (!normalized) return false;

    return SCORE.matches(item, normalized, stat);
  }

  function summarizeCustomDefinition(definition) {
    const normalized = normalizeCustomDefinition(definition);
    if (!normalized) return "";

    return SCORE.summarizeDefinition(normalized, STAT_LABELS);
  }

  function describeActiveFilters(viewId, values) {
    const view = getView(viewId);
    if (!view?.filters.length) return [];

    const normalizedValues = normalizeFilterValues(viewId, values);
    return view.filters
      .filter((filter) => numericFilterValue(normalizedValues[filter.id], filter.defaultValue) !== numericFilterValue(filter.defaultValue, 0))
      .map((filter) => filter.describe(normalizedValues[filter.id]));
  }

  function formatStats(stats) {
    const parts = [];

    for (const key of STAT_ORDER) {
      const value = stats?.[key];
      if (!value) continue;
      parts.push(`${STAT_LABELS[key] || key}: ${formatNumber(value)}`);
    }

    return parts.length ? parts.join(", ") : "No parsed stats";
  }

  function formatScore(option, item, score) {
    return option.display ? option.display(item, score) : `${option.label}: ${formatNumber(score)}`;
  }

  function mainCharacterScore(item) {
    const damageEquivalent = stat(item, "damageBonus") + stat(item, "strength") / STRENGTH_PER_DAMAGE;
    return stat(item, "agility") + stat(item, "dexterity") + damageEquivalent * MAIN_DAMAGE_WEIGHT;
  }

  function tankScore(item) {
    return stat(item, "healing") + stat(item, "blockvalue") + stat(item, "hardeningvalue") + stat(item, "threat");
  }

  function acceptsView(viewId, item) {
    return getItemViewId(item) === viewId;
  }

  function getItemViewId(item) {
    if (item?.viewId) return item.viewId;

    const byCategoryId = SCHEMA.viewIdForCategoryId(item?.categoryId);
    if (byCategoryId) return byCategoryId;

    const byItemType = SCHEMA.defaultViewIdForItemType(item?.itemType);
    if (byItemType) return byItemType;

    return SCHEMA.legacyViewIdForCategoryLabel(item?.category);
  }

  function stat(item, key) {
    return Number(item?.stats?.[key]) || 0;
  }

  function price(item) {
    return Number(item?.priceGold || item?.bidAmount || 0) || 0;
  }

  function priceLabel(item) {
    if (Number(item?.priceGold)) return `Immediate ${formatNumber(Number(item.priceGold))}`;
    if (Number(item?.bidAmount)) return `Bid ${formatNumber(Number(item.bidAmount))}`;
    return "";
  }

  function safeDivide(numerator, denominator) {
    return denominator > 0 ? numerator / denominator : 0;
  }

  function numericFilterValue(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function formatNumber(value) {
    if (!Number.isFinite(value)) return "0";
    if (Number.isInteger(value)) return String(value);
    return value >= 10 ? value.toFixed(1) : value.toFixed(3);
  }

  root.GladiatusAuctionModel = {
    statLabels: STAT_LABELS,
    statOptions: SCHEMA.statOptions,
    statOrder: STAT_ORDER,
    customDefinitionsStorageKey: CUSTOM_DEFINITIONS_STORAGE_KEY,
    filterValuesStorageKey: FILTER_VALUES_STORAGE_KEY,
    strengthPerDamage: STRENGTH_PER_DAMAGE,
    mainDamageWeight: MAIN_DAMAGE_WEIGHT,
    viewDefinitions: VIEW_DEFINITIONS,
    customDefinitionIdFromSortId,
    customSortId,
    defaultPresetForItemType,
    defaultPresetForView,
    defaultFilterValuesForView,
    defaultViewIdForItemType,
    defineItemView,
    defineMinimumStatFilter,
    defineScorePreset,
    describeActiveFilters,
    formatNumber,
    formatScore,
    formatStats,
    getView,
    getViewForItemType,
    getFilterControlDescriptors,
    getItemViewId,
    getPreset,
    getViewPresetOptions,
    getPresetSortOptions,
    getCustomDefinitionSortOptions,
    itemMatchesFilters,
    itemMatchesCustomDefinition,
    filterValuesEqual,
    normalizeAllFilterValues,
    normalizeFilterValues,
    normalizeCustomDefinition,
    normalizeCustomDefinitions,
    presetSortId,
    price,
    priceLabel,
    scoreCustomDefinition,
    summarizeCustomDefinition,
    stat
  };
})();
