# Agent Notes

This repo is a local Chrome MV3 extension for improving Gladiatus auction and arena workflows. Keep changes small, inspect the current code first, and preserve the separation between parsing, scoring, page injection, and popup UI.

## Live Browser Work

- Use Chrome DevTools MCP for live Gladiatus inspection. The in-app/browser-use browser does not share the logged-in game session reliably.
- If DevTools MCP reports a closed selected page, ask for an MCP/app reset instead of guessing from stale state.
- Before a full app reset, try MCP-level recovery (`list_pages`, `select_page`, `new_page`, `navigate_page`). If every call fails with the closed-page error, inspect local processes and restart only the Chrome child owned by `chrome-devtools-mcp` rather than the user's normal Chrome. It uses a separate profile under `~/.cache/chrome-devtools-mcp/chrome-profile` and can get stuck on a closed target after tabs are closed.
- Prefer inspecting the real DOM and network behavior before changing scraper logic. The game is stateful and the auction markup can differ between Gladiator and Mercenary necessities.
- Do not automate bids, purchases, login, CAPTCHA, or account-changing actions.

## Website Facts

- Auction pages are under `https://*.gladiatus.gameforge.com/game/index.php?mod=auction`.
- The main auction group is `Gladiator necessities`; the mercenary equipment group is `Mercenary necessities` and uses `ttype=3`.
- Current known item type values:
  - Main: `1` weapons, `2` shields, `3` chest, `4` helmets, `5` gloves, `8` shoes, `6` rings, `9` amulets, `7` usable/food, `11` reinforcements, `12` upgrades, `15` mercenary contracts.
  - Mercenary equipment: `1`, `2`, `3`, `4`, `5`, `8`, `6`, `9` with `ttype=3`.
- Auction item data lives in `.auction_item_div` forms. The actual item icon has `data-tooltip`, `data-price-gold`, icon class/style, and sometimes image data.
- Tooltip JSON is the source of truth for item names and stats. Examples include `Damage 56 - 71`, `Damage +6`, `Strength +11% (+5)`, `Using: +10 Damage`, and `Using: Heals 798 of life`.
- Percentage stat lines usually include the effective value in parentheses. Use that parenthesized value; do not treat a bare `+10%` as `+10` stat points.
- POSTing auction filters needs the live page form's `csrf_token`. Documents parsed from fetched HTML may not include that token because game JS adds it.
- Arena opponent pages expose profile links in rows with `.attack` controls. Do not click the attack divs.
- Public player profile pages expose character stats through stable ids: `#char_f0` through `#char_f5`, `#char_panzer`, `#char_schaden`, and `#char_level`.
- Arena pages can list opponents from another province, so content-script fetches may hit cross-origin/CORS limits. Use the extension background fetch bridge for profile HTML.

## Architecture

- `auction-schema.js` owns stable contracts: storage keys, stat keys/labels/order, auction category ids, and group/view mapping.
- `auction-core.js` owns website-facing logic: tooltip parsing, stat extraction, auction document loading, and scan orchestration. It exposes `window.GladiatusAuctionCore`.
- `auction-model.js` owns scoring/filtering rules and custom definition normalization/evaluation. Add score presets and filter controls here, not in UI files.
- `content.js` owns the injected auction-page sorter, storage syncing, and the bridge from isolated content script to page-world core APIs.
- `popup.js`, `popup.html`, and `popup.css` own the extension popup UI, cached scan browsing, and custom filter manager.
- `arena-core.js` owns arena opponent/profile parsing and `ArenaCharacter` scoring helpers.
- `arena-content.js` owns arena-page opponent scanning and row annotations.
- `background.js` owns cross-origin Gladiatus profile HTML fetches for arena scans. It should stay a narrow fetch bridge, not a parser.
- `styles.css` is only for injected page UI.
- `manifest.json` loads `auction-schema.js` and `auction-core.js` in the MAIN world, then loads schema/model/core/content plus arena modules in the isolated content-script world.

## Design Principles

- Keep parser/scanner logic reusable from DevTools and from the extension popup. If a behavior is hard to test in DevTools, move it behind a small public API instead of duplicating it.
- Keep built-in presets code-defined and custom filters storage-defined. Custom filters are structured linear combinations plus simple constraints, not free-text expressions.
- Scanned items should carry stable `categoryId`, `viewId`, `group`, `itemType`, and `ttype` metadata so UI labels can change without breaking filtering.
- Favor adding small helpers to schema/model/core over leaking game-specific selectors or scoring formulas into popup/content UI code.
- Preserve local-only behavior: use the logged-in game tab/session and `chrome.storage.local`; do not send data to external services.
- Keep arena and auction feature paths separate unless a shared contract genuinely belongs in schema or storage.

## Verification

Run these after changes:

```sh
for file in auction-schema.js auction-core.js auction-model.js arena-core.js content.js arena-content.js background.js popup.js architecture.test.js; do node --check "$file"; done
node architecture.test.js
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest ok')"
git diff --check
```

For browser checks, reload the unpacked extension in `chrome://extensions`, refresh the Gladiatus auction page, then inspect with Chrome DevTools MCP.
