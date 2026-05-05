(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : window;
  if (root.GladiatusAuctionSchema) return;

  const storageKeys = {
    customDefinitions: "glad-ah-custom-definitions-v1",
    filterValues: "glad-ah-filter-values-v1",
    popupState: "glad-ah-popup-state-v1",
    scanArchive: "glad-ah-scan-archive-v1",
    scanResult: "glad-ah-last-scan-v1",
    sortState: "glad-ah-sorter-state-v1"
  };

  const tooltipStatNames = [
    "Strength",
    "Dexterity",
    "Agility",
    "Constitution",
    "Charisma",
    "Intelligence",
    "Life points",
    "Damage",
    "Health",
    "Armour",
    "Block value",
    "Healing",
    "Critical attack value",
    "Critical healing value",
    "Critical damage",
    "Threat",
    "Hardening value"
  ];

  const statLabels = {
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

  const statOrder = [
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

  const primaryStatKeys = [
    "strength",
    "dexterity",
    "agility",
    "constitution",
    "charisma",
    "intelligence"
  ];

  const mainScanCategories = [
    defineCategory("main", "1", "Weapons", "Gladiator necessities", "weapons"),
    defineCategory("main", "2", "Shields", "Gladiator necessities", "armor"),
    defineCategory("main", "3", "Chest Armour", "Gladiator necessities", "armor"),
    defineCategory("main", "4", "Helmets", "Gladiator necessities", "armor"),
    defineCategory("main", "5", "Gloves", "Gladiator necessities", "armor"),
    defineCategory("main", "8", "Shoes", "Gladiator necessities", "armor"),
    defineCategory("main", "6", "Rings", "Gladiator necessities", "armor"),
    defineCategory("main", "9", "Amulets", "Gladiator necessities", "armor"),
    defineCategory("main", "7", "Usable", "Gladiator necessities", "food"),
    defineCategory("main", "11", "Reinforcements", "Gladiator necessities", "upgrades"),
    defineCategory("main", "12", "Upgrades", "Gladiator necessities", "upgrades"),
    defineCategory("main", "15", "Mercenary Contracts", "Gladiator necessities", "mercenaries")
  ];

  const mercenaryEquipmentScanCategories = [
    defineCategory("mercenary", "1", "Mercenary Weapons", "Mercenary necessities", "weapons", "3"),
    defineCategory("mercenary", "2", "Mercenary Shields", "Mercenary necessities", "armor", "3"),
    defineCategory("mercenary", "3", "Mercenary Chest Armour", "Mercenary necessities", "armor", "3"),
    defineCategory("mercenary", "4", "Mercenary Helmets", "Mercenary necessities", "armor", "3"),
    defineCategory("mercenary", "5", "Mercenary Gloves", "Mercenary necessities", "armor", "3"),
    defineCategory("mercenary", "8", "Mercenary Shoes", "Mercenary necessities", "armor", "3"),
    defineCategory("mercenary", "6", "Mercenary Rings", "Mercenary necessities", "armor", "3"),
    defineCategory("mercenary", "9", "Mercenary Amulets", "Mercenary necessities", "armor", "3")
  ];

  const scanCategories = [
    ...mainScanCategories,
    ...mercenaryEquipmentScanCategories
  ];
  const categoryById = new Map(scanCategories.map((category) => [category.id, category]));
  const legacyViewByCategoryLabel = new Map(scanCategories.map((category) => [category.label, category.viewId]));

  function defineCategory(namespace, itemType, label, group, viewId, ttype = "") {
    return {
      id: `${namespace}:${itemType}`,
      namespace,
      value: itemType,
      itemType,
      label,
      group,
      viewId,
      ttype
    };
  }

  function keyForTooltipStat(name) {
    return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function defaultViewIdForItemType(itemType) {
    const type = String(itemType || "");
    if (type === "1") return "weapons";
    if (type === "7") return "food";
    if (type === "11" || type === "12") return "upgrades";
    if (type === "15") return "mercenaries";
    return type ? "armor" : "";
  }

  function getScanCategory(categoryId) {
    return categoryById.get(String(categoryId || "")) || null;
  }

  function getCategoryForItemType(itemType, ttype = "") {
    const namespace = String(ttype || "") === "3" ? "mercenary" : "main";
    return getScanCategory(`${namespace}:${String(itemType || "")}`)
      || getScanCategory(`main:${String(itemType || "")}`);
  }

  function viewIdForCategoryId(categoryId) {
    return getScanCategory(categoryId)?.viewId || "";
  }

  function legacyViewIdForCategoryLabel(label) {
    return legacyViewByCategoryLabel.get(String(label || "")) || "";
  }

  function statLabel(key) {
    return statLabels[key] || key;
  }

  root.GladiatusAuctionSchema = {
    storageKeys,
    tooltipStatNames,
    statLabels,
    statOrder,
    statOptions: statOrder.map((key) => ({ key, label: statLabel(key) })),
    primaryStatKeys,
    mainScanCategories,
    mercenaryEquipmentScanCategories,
    scanCategories,
    defaultViewIdForItemType,
    getCategoryForItemType,
    getScanCategory,
    keyForTooltipStat,
    legacyViewIdForCategoryLabel,
    statLabel,
    viewIdForCategoryId
  };
})();
