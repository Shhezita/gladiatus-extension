# Gladiatus Auction Sorter

A small local Chrome extension that adds a sort bar to the Gladiatus auction house.

It reads the visible auction item tooltip data from `data-tooltip`, parses stat lines such as `Strength +11% (+5)` or `Damage 50 - 62`, and reorders the current auction page in the browser. It works across auction item types because the parser reads the item tooltip data for each visible listing instead of assuming weapons, shields, helmets, or any other category.

It does not bid, buy, call extra APIs, or send data anywhere.

## Load In Chrome

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder: `/Users/jankohuic/dev/gladiatus`.
5. Open the Gladiatus auction house and use the injected `Auction sorter` bar.

## Notes

- Sorting affects only the currently visible auction page.
- Use the game filter first for item type, level, and quality, then sort the visible results by Strength, Dexterity, Agility, Constitution, Charisma, Intelligence, Life points, Health, Armour, Damage bonus, weapon damage, Block value, Healing, Threat, and related values.
- `High first` is the default for stats. `Immediate gold` defaults to low first.
- If you change files while the extension is already loaded, click the extension reload button on `chrome://extensions`, then refresh the Gladiatus page.

## Parsed Tooltip Formats

- Equippable weapons: `Damage 56 - 71` and compound durability lines like `Damage 56 - 71,+7 - 9`.
- Non-weapon equipment: flat damage lines like `Damage +7`, `Damage +5,0`, and `Damage +8,+1`.
- Upgrades: usage lines like `Using: +10 Damage` or `Using: +6 Charisma`.
- Mercenary contracts: absolute stat lines like `Life points: 2130` and `Strength: 98`.
- Mercenary equipment: regular equipment stats plus fields like `Threat`, `Block value`, `Healing`, and critical values.
