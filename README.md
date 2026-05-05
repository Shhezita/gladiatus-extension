# Gladiatus Auction Helper

A small local Chrome extension that adds a sort bar and scanner popup to the Gladiatus auction house.

It reads the visible auction item tooltip data from `data-tooltip`, parses stat lines such as `Strength +11% (+5)` or `Damage 50 - 62`, and reorders the current auction page in the browser. It works across auction item types because the parser reads the item tooltip data for each visible listing instead of assuming weapons, shields, helmets, or any other category.

It does not bid, buy, call non-game APIs, or send data anywhere. The popup scanner only requests Gladiatus auction pages using the same logged-in tab session and caches the last scan in local extension storage.

## Load In Chrome

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder: `/Users/jankohuic/dev/gladiatus`.
5. Open the Gladiatus auction house and use the injected `Auction sorter` bar, or open the extension popup and click `Scan auction`.

## Notes

- Open the extension popup on an auction page and click `Scan auction` to fetch all auction categories with your current name, minimum-level, and quality filters.
- The popup persists the last scan, so closing and reopening it keeps the scanned item list until the next scan.
- Popup tabs group results into Weapons, Armor, Food, Upgrades, and Mercenaries. Each tab keeps its own selected sort preset.
- Popup tab and preset clicks also apply the same sort to the visible auction page when the active tab is a Gladiatus auction page.
- Popup item rows show thumbnails when the game exposes an image URL or inline icon background style in the auction markup.
- Default popup sorting is average weapon damage, food healing per gold, armor main-character score, upgrade damage, and mercenary agility.
- The in-page auction sorter uses those same defaults for each auction item type, then remembers manual sort changes per item type.
- Armor main-character score is `agility + dexterity + ((damage bonus + strength / 10) * 8)`.
- Sorting affects only the currently visible auction page.
- Use the game filter first for item type, level, and quality, then sort the visible results by Strength, Dexterity, Agility, Constitution, Charisma, Intelligence, Life points, Health, Armour, Damage bonus, weapon damage, Block value, Healing, Threat, and related values.
- `High first` is the default for stats. `Immediate gold` defaults to low first.
- The selected sort stat and sort direction are persisted across auction filter reloads.
- If you change files while the extension is already loaded, click the extension reload button on `chrome://extensions`, then refresh the Gladiatus page.

## DevTools API

The shared scanner/parser is exposed on the auction page as:

```js
window.GladiatusAuctionCore
```

Useful calls:

```js
await window.GladiatusAuctionCore.scanAllAuctionItems()
window.GladiatusAuctionCore.parseStats(["Healing +87,+11", "Intelligence +21"])
```

The popup uses the same page-level API through a content-script bridge. The core API is loaded in Chrome's MAIN world so DevTools and the extension exercise the same code. The scan API first tries normal page fetches and falls back to hidden same-origin iframe/form loads when fetches are blocked.

## Parsed Tooltip Formats

- Equippable weapons: `Damage 56 - 71` and compound durability lines like `Damage 56 - 71,+7 - 9`; the base range before the comma is used for sorting.
- Non-weapon equipment: flat damage lines like `Damage +7`, `Damage +5,0`, and `Damage +8,+1`; the base value before the comma is used for sorting.
- Upgrades: usage lines like `Using: +10 Damage` or `Using: +6 Charisma`.
- Food: usage lines like `Using: Heals 798 of life`; only the first healed-life number is counted, so intelligence/vitality breakdown numbers in the same sentence are ignored.
- Mercenary contracts: absolute stat lines like `Life points: 2130` and `Strength: 98`.
- Mercenary equipment: regular equipment stats plus fields like `Threat`, `Block value`, `Healing`, and critical values.
