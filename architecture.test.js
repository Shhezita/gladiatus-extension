const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const rootDir = __dirname;

function makeDocument(forms = []) {
  return {
    currentScript: null,
    location: { href: "https://s1.gladiatus.gameforge.com/game/index.php?mod=auction&itemType=2" },
    createElement() {
      let text = "";
      return {
        set innerHTML(value) {
          text = String(value || "")
            .replace(/<[^>]+>/g, "")
            .replace(/&nbsp;/g, " ");
        },
        get textContent() {
          return text;
        },
        get innerText() {
          return text;
        }
      };
    },
    querySelectorAll(selector) {
      return selector === "form[id^='auctionForm']" ? forms : [];
    }
  };
}

function makeForm({ tooltipLines, auctionId = "auction-1", priceGold = "1.234", bidAmount = "222" }) {
  const ownerDocument = makeDocument();
  const tooltip = JSON.stringify([tooltipLines.map((line) => [line])]);
  const icon = {
    dataset: { tooltip, priceGold },
    className: "item-i-1",
    ownerDocument,
    getAttribute(name) {
      const attrs = {
        "data-tooltip": tooltip,
        "data-price-gold": priceGold,
        "data-content-type": "item",
        "data-basis": "test",
        style: "background-image:url(/cdn/item.png)"
      };
      return attrs[name] || "";
    },
    querySelector() {
      return null;
    }
  };

  return {
    ownerDocument,
    querySelector(selector) {
      if (selector === "[data-tooltip]") return icon;
      if (selector === "input[name='auctionid']") return { value: auctionId };
      if (selector === "input[name='bid_amount']") return { value: bidAmount };
      return null;
    }
  };
}

function loadGlobals() {
  const context = {
    console,
    URL,
    chrome: { runtime: { id: "test-extension" } },
    document: makeDocument()
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);

  for (const file of ["auction-schema.js", "auction-model.js", "auction-core.js"]) {
    vm.runInContext(fs.readFileSync(path.join(rootDir, file), "utf8"), context, { filename: file });
  }

  return {
    schema: context.GladiatusAuctionSchema,
    model: context.GladiatusAuctionModel,
    core: context.GladiatusAuctionCore
  };
}

const { schema, model, core } = loadGlobals();

{
  const parsed = core.parseStats([
    "Damage 56 - 71,+7 - 9",
    "Strength +11% (+5)",
    "Using: +10 Damage",
    "Using: Heals 798 of life",
    "Life points: 2130",
    "Healing +87,+11",
    "Intelligence +21",
    "Level 88",
    "Value 1.234"
  ]);

  assert.equal(parsed.stats.damageMin, 56);
  assert.equal(parsed.stats.damageMax, 71);
  assert.equal(parsed.stats.damageAvg, 63.5);
  assert.equal(parsed.stats.strength, 5);
  assert.equal(parsed.stats.damageBonus, 10);
  assert.equal(parsed.stats.foodHealing, 798);
  assert.equal(parsed.stats.lifepoints, 2130);
  assert.equal(parsed.stats.healing, 87);
  assert.equal(parsed.stats.intelligence, 21);
  assert.equal(parsed.level, 88);
  assert.equal(parsed.itemValue, 1234);
}

{
  const form = makeForm({
    tooltipLines: ["Shield of Tests", "Damage +6", "Agility +12", "Level 40", "Value 999"]
  });
  const doc = makeDocument([form]);
  form.ownerDocument = doc;
  const [item] = core.parseAuctionItemsFromDocument(doc, { categoryId: "main:2" });

  assert.equal(item.auctionId, "auction-1");
  assert.equal(item.categoryId, "main:2");
  assert.equal(item.viewId, "armor");
  assert.equal(item.category, "Shields");
  assert.equal(item.itemType, "2");
  assert.equal(item.stats.damageBonus, 6);
  assert.equal(item.stats.agility, 12);
}

{
  const renamedLabelItem = {
    category: "Changed Human Label",
    viewId: "armor",
    stats: { damageBonus: 6 }
  };
  assert.equal(model.getView("armor").accepts(renamedLabelItem), true);
  assert.equal(model.getView("weapons").accepts(renamedLabelItem), false);
}

{
  const filters = model.normalizeAllFilterValues({ armor: { minDamageBonus: "5" } });
  assert.equal(schema.storageKeys.filterValues, "glad-ah-filter-values-v1");
  assert.equal(filters.armor.minDamageBonus, "5");
  assert.equal(model.filterValuesEqual(filters, { armor: { minDamageBonus: "5" } }), true);
  assert.equal(model.itemMatchesFilters({ viewId: "armor", stats: { damageBonus: 6 } }, "armor", filters.armor), true);
  assert.equal(model.itemMatchesFilters({ viewId: "armor", stats: { damageBonus: 4 } }, "armor", filters.armor), false);

  const [control] = model.getFilterControlDescriptors("armor", filters.armor);
  assert.equal(control.id, "minDamageBonus");
  assert.equal(control.value, "5");
}

{
  const customDefinition = model.normalizeCustomDefinition({
    id: "armor-dps",
    name: "Armor DPS",
    appliesTo: ["armor"],
    terms: [
      { stat: "agility", weight: 1 },
      { stat: "damageBonus", weight: 10 }
    ],
    constraints: [{ stat: "damageBonus", op: ">=", value: 5 }],
    enabled: true
  });
  const item = { viewId: "armor", stats: { agility: 12, damageBonus: 6 } };

  assert.equal(model.scoreCustomDefinition(item, customDefinition), 72);
  assert.equal(model.itemMatchesCustomDefinition(item, customDefinition), true);
  assert.equal(model.itemMatchesCustomDefinition({ viewId: "armor", stats: { damageBonus: 4 } }, customDefinition), false);
}

console.log("architecture tests passed");
