importScripts("score-model.js", "arena-core.js", "arena-background-scan.js");

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GLAD_AH_REPAIR_AUCTION_CONTENT") {
    repairAuctionContent(_sender)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

    return true;
  }

  if (message?.type === "GLAD_ARENA_PASSIVE_CHECK") {
    log("passive arena check requested", { url: safeUrl(message.url) });
    arenaScanner().passiveCheck({
      url: message.url,
      preferredKind: message.preferredKind,
      force: Boolean(message.force)
    })
      .then((results) => sendResponse({ ok: true, results }))
      .catch((error) => {
        log("passive arena check failed", { url: safeUrl(message.url), error: error.message || String(error) });
        sendResponse({ ok: false, error: error.message || String(error) });
      });

    return true;
  }

  if (message?.type === "GLAD_ARENA_ENSURE_VISIBLE_SCAN") {
    log("visible arena scan ensure requested", { url: safeUrl(message.url), entries: message.entries?.length || 0 });
    arenaScanner().ensureVisibleScan({
      url: message.url,
      entries: message.entries,
      formula: message.formula
    })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => {
        log("visible arena scan ensure failed", { url: safeUrl(message.url), error: error.message || String(error) });
        sendResponse({ ok: false, error: error.message || String(error) });
      });

    return true;
  }

  if (message?.type === "GLAD_ARENA_FORCE_SCAN") {
    log("manual arena scan requested", { url: safeUrl(message.url), entries: message.entries?.length || 0 });
    arenaScanner().forceScan({
      url: message.url,
      entries: message.entries,
      formula: message.formula
    })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => {
        log("manual arena scan failed", { url: safeUrl(message.url), error: error.message || String(error) });
        sendResponse({ ok: false, error: error.message || String(error) });
      });

    return true;
  }

  if (message?.type === "GLAD_ARENA_FETCH_PROFILE") {
    log("profile fetch requested", { url: safeUrl(message.url) });
    arenaScanner().fetchProfileHtml(message.url)
      .then((html) => {
        log("profile fetch completed", { url: safeUrl(message.url), bytes: html.length });
        sendResponse({ ok: true, html });
      })
      .catch((error) => {
        log("profile fetch failed", { url: safeUrl(message.url), error: error.message || String(error) });
        sendResponse({ ok: false, error: error.message || String(error) });
      });

    return true;
  }

  if (message?.type === "GLAD_ARENA_FETCH_LIST") {
    log("arena list fetch requested", { url: safeUrl(message.url) });
    arenaScanner().fetchArenaListHtml(message.url)
      .then((html) => {
        log("arena list fetch completed", { url: safeUrl(message.url), bytes: html.length });
        sendResponse({ ok: true, html });
      })
      .catch((error) => {
        log("arena list fetch failed", { url: safeUrl(message.url), error: error.message || String(error) });
        sendResponse({ ok: false, error: error.message || String(error) });
      });

    return true;
  }

  return false;
});

const AUCTION_CONTENT_FILES = [
  "auction-schema.js",
  "score-model.js",
  "auction-model.js",
  "auction-core.js",
  "arena-core.js",
  "arena-scan.js",
  "auction-content.js",
  "arena-content.js"
];
const LOG_PREFIX = "[Gladiatus Background]";

async function repairAuctionContent(sender) {
  const tabId = sender?.tab?.id;
  if (!tabId) throw new Error("Cannot repair auction content without a sender tab.");
  if (!chrome.scripting?.executeScript) throw new Error("chrome.scripting is not available.");

  await chrome.scripting.executeScript({
    target: { tabId },
    files: AUCTION_CONTENT_FILES
  });
}

function arenaScanner() {
  if (!self.GladiatusArenaBackgroundScanner) {
    throw new Error("Arena background scanner failed to load.");
  }
  return self.GladiatusArenaBackgroundScanner;
}

function log(message, details = {}) {
  console.log(LOG_PREFIX, message, details);
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.searchParams.has("sh")) url.searchParams.set("sh", "[redacted]");
    return url.href;
  } catch {
    return String(value || "");
  }
}
