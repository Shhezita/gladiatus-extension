(() => {
  if (globalThis.GladiatusAuctionModel) return;

  const STRENGTH_PER_DAMAGE = 10;
  const MAIN_DAMAGE_WEIGHT = 8;

  const STAT_LABELS = {
    damageMin: "DMG min",
    damageMax: "DMG max",
    damageAvg: "DMG avg",
    damageBonus: "DMG +",
    strength: "Str",
    dexterity: "Dex",
    agility: "Agi",
    constitution: "Con",
    charisma: "Cha",
    intelligence: "Int",
    lifepoints: "Life",
    health: "Health",
    foodHealing: "Heals",
    armour: "Armour",
    blockvalue: "Block",
    healing: "Healing",
    criticalattackvalue: "Crit atk",
    criticalhealingvalue: "Crit heal",
    criticaldamage: "Crit dmg",
    threat: "Threat",
    hardeningvalue: "Hardening"
  };

  const STAT_ORDER = [
    "damageMin",
    "damageMax",
    "damageAvg",
    "damageBonus",
    "strength",
    "dexterity",
    "agility",
    "constitution",
    "charisma",
    "intelligence",
    "lifepoints",
    "health",
    "foodHealing",
    "armour",
    "blockvalue",
    "healing",
    "criticalattackvalue",
    "criticalhealingvalue",
    "criticaldamage",
    "threat",
    "hardeningvalue"
  ];

  const WEAPON_CATEGORIES = new Set(["Weapons", "Mercenary Weapons"]);
  const ARMOR_CATEGORIES = new Set([
    "Shields",
    "Chest Armour",
    "Helmets",
    "Gloves",
    "Shoes",
    "Rings",
    "Amulets",
    "Mercenary Shields",
    "Mercenary Chest Armour",
    "Mercenary Helmets",
    "Mercenary Gloves",
    "Mercenary Shoes",
    "Mercenary Rings",
    "Mercenary Amulets"
  ]);
  const UPGRADE_CATEGORIES = new Set(["Upgrades", "Reinforcements"]);

  const VIEW_DEFINITIONS = [
    {
      id: "weapons",
      label: "Weapons",
      defaultItemType: "1",
      accepts: (item) => hasCategory(WEAPON_CATEGORIES, item),
      presets: [
        { id: "avgDamage", label: "Average damage", score: (item) => stat(item, "damageAvg") },
        { id: "maxDamage", label: "Max damage", score: (item) => stat(item, "damageMax") },
        { id: "damageValue", label: "Damage / gold", score: (item) => safeDivide(stat(item, "damageAvg"), price(item)) }
      ]
    },
    {
      id: "armor",
      label: "Armor",
      defaultItemType: "2",
      accepts: (item) => hasCategory(ARMOR_CATEGORIES, item),
      presets: [
        { id: "main", label: "Main: Agi/Dex + dmg x8", score: mainCharacterScore },
        { id: "tank", label: "Tank utility", score: tankScore },
        { id: "healing", label: "Healing", score: (item) => stat(item, "healing") },
        { id: "block", label: "Block", score: (item) => stat(item, "blockvalue") },
        { id: "threat", label: "Threat", score: (item) => stat(item, "threat") }
      ]
    },
    {
      id: "food",
      label: "Food",
      defaultItemType: "7",
      accepts: (item) => item.category === "Usable" && stat(item, "foodHealing") > 0,
      presets: [
        { id: "efficiency", label: "Health / gold", score: (item) => safeDivide(stat(item, "foodHealing"), price(item)) },
        { id: "healing", label: "Total healing", score: (item) => stat(item, "foodHealing") },
        { id: "cheap", label: "Cheapest", score: (item) => -price(item), display: (item) => `Price: ${formatNumber(price(item))}` }
      ]
    },
    {
      id: "upgrades",
      label: "Upgrades",
      defaultItemType: "12",
      accepts: (item) => hasCategory(UPGRADE_CATEGORIES, item),
      presets: [
        { id: "damage", label: "Damage", score: (item) => stat(item, "damageBonus") },
        { id: "agility", label: "Agility", score: (item) => stat(item, "agility") },
        { id: "dexterity", label: "Dexterity", score: (item) => stat(item, "dexterity") },
        { id: "strength", label: "Strength", score: (item) => stat(item, "strength") }
      ]
    },
    {
      id: "mercenaries",
      label: "Mercenaries",
      defaultItemType: "15",
      accepts: (item) => item.category === "Mercenary Contracts",
      presets: [
        { id: "agility", label: "Agility", score: (item) => stat(item, "agility") },
        { id: "dexStrength", label: "Dexterity + strength", score: (item) => stat(item, "dexterity") + stat(item, "strength") }
      ]
    }
  ];

  function presetSortId(viewId, presetId) {
    return `preset:${viewId}:${presetId}`;
  }

  function getPreset(viewId, presetId) {
    const view = VIEW_DEFINITIONS.find((candidate) => candidate.id === viewId);
    const preset = view?.presets.find((candidate) => candidate.id === presetId);
    return view && preset ? { view, preset } : null;
  }

  function getPresetSortOptions() {
    return VIEW_DEFINITIONS.flatMap((view) => view.presets.map((preset) => ({
      id: presetSortId(view.id, preset.id),
      label: `${view.label}: ${preset.label}`,
      group: "Preset scores",
      viewId: view.id,
      presetId: preset.id,
      get: preset.score,
      display: preset.display
    })));
  }

  function defaultPresetForView(viewId) {
    const view = VIEW_DEFINITIONS.find((candidate) => candidate.id === viewId) || VIEW_DEFINITIONS[0];
    return presetSortId(view.id, view.presets[0].id);
  }

  function defaultPresetForItemType(itemType) {
    const type = String(itemType || "");
    if (type === "1") return defaultPresetForView("weapons");
    if (type === "7") return defaultPresetForView("food");
    if (type === "11" || type === "12") return defaultPresetForView("upgrades");
    if (type === "15") return defaultPresetForView("mercenaries");
    return defaultPresetForView("armor");
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

  function hasCategory(categories, item) {
    return categories.has(item?.category);
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

  function formatNumber(value) {
    if (!Number.isFinite(value)) return "0";
    if (Number.isInteger(value)) return String(value);
    return value >= 10 ? value.toFixed(1) : value.toFixed(3);
  }

  globalThis.GladiatusAuctionModel = {
    statLabels: STAT_LABELS,
    statOrder: STAT_ORDER,
    strengthPerDamage: STRENGTH_PER_DAMAGE,
    mainDamageWeight: MAIN_DAMAGE_WEIGHT,
    viewDefinitions: VIEW_DEFINITIONS,
    defaultPresetForItemType,
    defaultPresetForView,
    formatNumber,
    formatScore,
    formatStats,
    getPreset,
    getPresetSortOptions,
    presetSortId,
    price,
    priceLabel,
    stat
  };
})();
