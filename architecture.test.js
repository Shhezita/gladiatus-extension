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

  for (const file of ["auction-schema.js", "score-model.js", "auction-model.js", "auction-core.js", "arena-core.js"]) {
    vm.runInContext(fs.readFileSync(path.join(rootDir, file), "utf8"), context, { filename: file });
  }

  return {
    schema: context.GladiatusAuctionSchema,
    score: context.GladiatusScoreModel,
    model: context.GladiatusAuctionModel,
    core: context.GladiatusAuctionCore,
    arena: context.GladiatusArenaCore
  };
}

function makeAuctionContentContext(listeners) {
  const context = {
    console: { ...console, error() {}, warn() {} },
    URL,
    clearTimeout() {},
    setTimeout(callback) {
      callback();
      return 1;
    },
    chrome: {
      runtime: {
        id: "test-extension",
        getURL(file) {
          return file;
        },
        onMessage: {
          addListener(listener) {
            listeners.push(listener);
          },
          removeListener(listener) {
            const index = listeners.indexOf(listener);
            if (index !== -1) listeners.splice(index, 1);
          }
        }
      },
      storage: {
        local: {
          async get() {
            return {};
          },
          async set() {}
        },
        onChanged: {
          addListener() {}
        }
      }
    },
    document: makeContentDocument(),
    location: { href: "https://s1.gladiatus.gameforge.com/game/index.php?mod=auction&itemType=2" },
    localStorage: {
      getItem() {
        return null;
      },
      setItem() {}
    },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
      }
      observe() {}
    }
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  return context;
}

function makeContentDocument() {
  const documentElement = makeElement("html");
  const head = makeElement("head");
  return {
    currentScript: null,
    documentElement,
    head,
    readyState: "complete",
    location: { href: "https://s1.gladiatus.gameforge.com/game/index.php?mod=auction&itemType=2" },
    addEventListener() {},
    createDocumentFragment() {
      return makeElement("#fragment");
    },
    createElement: makeElement,
    getElementById() {
      return null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
}

function makeElement(tagName) {
  return {
    tagName: String(tagName || "").toUpperCase(),
    className: "",
    dataset: {},
    disabled: false,
    hidden: false,
    id: "",
    style: {
      setProperty() {}
    },
    tBodies: [],
    append() {},
    appendChild() {},
    prepend() {},
    before() {},
    after() {},
    remove() {},
    replaceChildren() {},
    addEventListener() {},
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() {
        return false;
      }
    },
    closest() {
      return null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    set textContent(value) {
      this._textContent = String(value || "");
    },
    get textContent() {
      return this._textContent || "";
    },
    set innerHTML(value) {
      this._innerHTML = String(value || "");
      this._textContent = this._innerHTML.replace(/<[^>]+>/g, "");
    },
    get innerHTML() {
      return this._innerHTML || "";
    },
    get innerText() {
      return this.textContent;
    }
  };
}

const { schema, score, model, core, arena } = loadGlobals();

{
  assert.equal(core.version, "auction-core-v3");
  assert.equal(core.constants.pageBridgeRequestSource, "glad-ah-extension-v3");
  assert.equal(core.constants.pageBridgeResponseSource, "glad-ah-page-v3");
}

{
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, "manifest.json"), "utf8"));
  const mainEntry = manifest.content_scripts.find((entry) => entry.world === "MAIN");
  const isolatedEntries = manifest.content_scripts.filter((entry) => entry.world !== "MAIN");

  assert.deepEqual(mainEntry.js, ["auction-schema.js", "auction-core.js"]);
  assert.equal(isolatedEntries.length, 1);
  assert.deepEqual(isolatedEntries[0].js, [
    "auction-schema.js",
    "score-model.js",
    "auction-model.js",
    "auction-core.js",
    "arena-core.js",
    "auction-content.js",
    "arena-content.js"
  ]);
  assert.equal(fs.existsSync(path.join(rootDir, "content.js")), false);

  const referencedFiles = [
    ...manifest.content_scripts.flatMap((entry) => [...(entry.js || []), ...(entry.css || [])]),
    ...manifest.web_accessible_resources.flatMap((entry) => entry.resources || []),
    "popup.js",
    "popup/runtime.js",
    "popup/store.js",
    "popup/auction-view.js",
    "popup/arena-view.js"
  ];
  for (const file of referencedFiles) {
    assert.equal(fs.existsSync(path.join(rootDir, file)), true, `${file} is referenced but missing`);
  }

  const popupHtml = fs.readFileSync(path.join(rootDir, "popup.html"), "utf8");
  assert.match(popupHtml, /<script\s+src="auction-core\.js"><\/script>/);
  assert.match(popupHtml, /<script\s+type="module"\s+src="popup\.js"><\/script>/);
}

{
  const listeners = [];
  const context = makeAuctionContentContext(listeners);
  vm.runInContext(fs.readFileSync(path.join(rootDir, "auction-content.js"), "utf8"), context, { filename: "auction-content.js" });

  assert.equal(typeof context.__GladiatusAuctionMissingDependencyListener, "function");
  assert.equal(listeners.length, 1);

  for (const file of ["auction-schema.js", "score-model.js", "auction-model.js", "auction-core.js"]) {
    vm.runInContext(fs.readFileSync(path.join(rootDir, file), "utf8"), context, { filename: file });
  }
  vm.runInContext(fs.readFileSync(path.join(rootDir, "auction-content.js"), "utf8"), context, { filename: "auction-content.js" });

  assert.equal(context.__GladiatusAuctionMissingDependencyListener, undefined);
  assert.equal(listeners.length, 1);

  const responses = [];
  for (const listener of listeners) {
    listener({ type: "GLAD_AH_BOOT_V2" }, null, (response) => responses.push(response));
  }
  assert.deepEqual(JSON.parse(JSON.stringify(responses)), [{
    ok: true,
    isAuctionPage: true,
    hasPanel: false,
    itemForms: 0,
    hasFilterForm: false
  }]);
}

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
  assert.equal(core.parseSignedBonus("Agility +10% (+11)"), 11);
  assert.equal(core.parseSignedBonus("Agility +10%"), 0);
  assert.equal(core.parseSignedBonus("Dexterity +32% (+28),+4% (+4)"), 28);
}

{
  const parsed = core.parseStats([
    "Táliths Gladiator helmet of Martial Arts",
    "Damage +7",
    "Armour +813",
    "Strength +1",
    "Strength +20% (+9)",
    "Dexterity +20% (+18)",
    "Charisma +2",
    "Charisma +10% (+7)",
    "Critical attack value +7",
    "Level 64",
    "Value 4506"
  ]);
  const item = { viewId: "armor", stats: parsed.stats };
  const preset = model.getPreset("armor", "main").preset;

  assert.equal(parsed.stats.damageBonus, 7);
  assert.equal(parsed.stats.strength, 10);
  assert.equal(parsed.stats.dexterity, 18);
  assert.equal(parsed.stats.charisma, 9);
  assert.equal(parsed.stats.criticalattackvalue, 7);
  assert.equal(preset.score(item), 82);
}

{
  const parsed = core.parseStats([
    "Kerrannas Leather cap of Elimination",
    "Armour +443",
    "Strength +46% (+21)",
    "Dexterity +50% (+45)",
    "Agility +22% (+25)",
    "Charisma +4",
    "Critical attack value +10",
    "Level 67",
    "Value 4525"
  ]);
  const item = { viewId: "armor", stats: parsed.stats };
  const preset = model.getPreset("armor", "main").preset;

  assert.equal(parsed.stats.strength, 21);
  assert.equal(parsed.stats.dexterity, 45);
  assert.equal(parsed.stats.agility, 25);
  assert.equal(parsed.stats.charisma, 4);
  assert.equal(parsed.stats.criticalattackvalue, 10);
  assert.equal(preset.score(item), 86.8);
}

{
  const values = new Map([
    ["#char_level", "48"],
    ["#char_f0", "65"],
    ["#char_f1", "138"],
    ["#char_f2", "189"],
    ["#char_f3", "83"],
    ["#char_f4", "155"],
    ["#char_f5", "52"],
    ["#char_panzer", "3148"],
    ["#char_schaden", "108 - 125"],
    [".playername", "Ikarrus"]
  ]);
  const doc = {
    querySelector(selector) {
      return values.has(selector) ? { textContent: values.get(selector) } : null;
    }
  };
  const character = arena.parseCharacterFromDocument(doc, { id: "1185379", province: "60" });

  assert.equal(character.name, "Ikarrus");
  assert.equal(character.level, 48);
  assert.equal(character.stats.agility, 189);
  assert.equal(character.stats.damageAvg, 116.5);
  assert.equal(character.primaryStatSum, 682);
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

{
  const section = score.normalizeScoreSection({
    terms: [
      { stat: "agility", weight: 1 },
      { stat: "dexterity", weight: 1 },
      { stat: "damageAvg", weight: 10 }
    ]
  }, { statKeys: arena.statOrder });
  const character = { stats: { agility: 10, dexterity: 20, damageAvg: 3 } };

  assert.equal(score.score(character, section), 60);
}

{
  assert.equal(arena.parseRoleFromTooltipText("Dungeon Battle Quest: Direct attention to oneself"), "tank");
  assert.equal(arena.parseRoleFromTooltipText("Dungeon Battle Quest: Heal group members"), "healer");
  assert.equal(arena.parseRoleFromTooltipText("Samnit Quest: Dish out damage"), "damage");
  assert.equal(arena.parseRoleFromTooltipText("Standard Battle"), "duel");
}

{
  const formula = arena.normalizeArenaFormula({
    id: "test-team",
    name: "Test team",
    sections: {
      duel: { terms: [{ stat: "strength", weight: 1 }] },
      tank: { terms: [{ stat: "armour", weight: 0.01 }] },
      healer: { terms: [{ stat: "healing", weight: 1 }] },
      damage: { terms: [{ stat: "dexterity", weight: 1 }, { stat: "damageAvg", weight: 1 }] }
    }
  });
  const members = [
    { role: "tank", stats: { armour: 2000 } },
    { role: "healer", stats: { healing: 500 } },
    { role: "damage", stats: { dexterity: 100, damageAvg: 50 } },
    { role: "damage", stats: { dexterity: 80, damageAvg: 40 } },
    { role: "damage", stats: { dexterity: 70, damageAvg: 30 } }
  ];

  assert.equal(arena.scoreArenaTeam(members, formula).totalScore, 890);
}

{
  const formula = arena.normalizeArenaFormula({
    id: "empty-healer",
    name: "Empty healer",
    sections: {
      duel: { terms: [{ stat: "strength", weight: 1 }] },
      healer: { terms: [] }
    }
  });

  assert.equal(arena.scoreArenaCharacter({ role: "healer", stats: { strength: 999, healing: 500 } }, formula).score, 0);
  assert.equal(arena.scoreArenaCharacter({ role: "unknown", stats: { strength: 5 } }, formula).score, 5);
}

{
  const legacy = arena.normalizeArenaFormula({
    id: "legacy-standard",
    name: "Legacy standard",
    sections: {
      standard: { terms: [{ stat: "strength", weight: 2 }] }
    }
  });

  assert.equal(arena.scoreArenaCharacter({ role: "duel", stats: { strength: 4 } }, legacy).score, 8);
}

{
  const tabs = [
    { doll: 1, url: "doll1" },
    { doll: 2, url: "doll2" },
    { doll: 3, url: "doll3" },
    { doll: 4, url: "doll4" },
    { doll: 5, url: "doll5" },
    { doll: 6, url: "doll6" }
  ];

  assert.deepEqual(arena.teamDollTabs(tabs).map((tab) => tab.doll), [2, 3, 4, 5, 6]);
}

{
  assert.equal(arena.parseFightArgs("startGroupFight(this, 4078517)").arenaKind, "team");
  assert.equal(arena.parseFightArgs("startProvinciarumFight(this, 3, 219763, 55, 'en');").arenaKind, "team");
  assert.equal(arena.parseFightArgs("startProvinciarumFight(this, 2, 219763, 55, 'en');").arenaKind, "single");
}

{
  const makeRow = ({ href, name, onclick, cells }) => {
    const link = {
      textContent: name,
      getAttribute(attribute) {
        return attribute === "href" ? href : "";
      }
    };
    const attack = {
      getAttribute(attribute) {
        return attribute === "onclick" ? onclick : "";
      }
    };
    return {
      cells: cells.map((textContent) => ({ textContent })),
      querySelector(selector) {
        if (selector.startsWith("a[")) return link;
        if (selector.startsWith(".attack")) return attack;
        return null;
      }
    };
  };
  const rows = [
    makeRow({
      href: "https://s55-en.gladiatus.gameforge.com/game/index.php?mod=player&p=219763&language=en",
      name: "Morvisus",
      onclick: "startProvinciarumFight(this, 3, 219763, 55, 'en');",
      cells: ["Morvisus", "55", "55", ""]
    }),
    makeRow({
      href: "https://s47-en.gladiatus.gameforge.com/game/index.php?mod=player&p=4078517&sh=test",
      name: "namsis",
      onclick: "startGroupFight(this, 4078517)",
      cells: ["10", "namsis", ""]
    })
  ];
  const doc = {
    location: { href: "https://s47-en.gladiatus.gameforge.com/game/index.php?mod=arena&submod=serverArena&aType=3&sh=test" },
    querySelectorAll(selector) {
      return selector === "#content tr" ? rows : [];
    }
  };
  const entries = arena.readArenaOpponentEntries(doc);

  assert.equal(entries.length, 2);
  assert.equal(entries[0].opponent.arenaKind, "team");
  assert.equal(entries[1].opponent.arenaKind, "team");
}

console.log("architecture tests passed");
