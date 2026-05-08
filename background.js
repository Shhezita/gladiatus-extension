chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GLAD_AH_REPAIR_AUCTION_CONTENT") {
    repairAuctionContent(_sender)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

    return true;
  }

  if (message?.type === "GLAD_ARENA_FETCH_PROFILE") {
    log("profile fetch requested", { url: safeUrl(message.url) });
    fetchProfileHtml(message.url)
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
    fetchArenaListHtml(message.url)
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
const RETRYABLE_PROFILE_STATUSES = new Set([429, 500, 502, 503, 504]);
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

async function fetchProfileHtml(rawUrl) {
  return fetchGladiatusHtml(normalizeProfileUrl(rawUrl), "Profile");
}

async function fetchArenaListHtml(rawUrl) {
  return fetchGladiatusHtml(normalizeArenaListUrl(rawUrl), "Arena list");
}

async function fetchGladiatusHtml(url, label) {
  let lastStatus = 0;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    log(`${label} fetch attempt`, { attempt: attempt + 1, url: safeUrl(url.href) });
    const response = await fetch(url.href, { credentials: "include" });
    if (response.ok) {
      log(`${label} fetch HTTP ok`, { attempt: attempt + 1, url: safeUrl(url.href), status: response.status });
      return response.text();
    }

    lastStatus = response.status;
    log(`${label} fetch HTTP failed`, { attempt: attempt + 1, url: safeUrl(url.href), status: response.status });
    if (!RETRYABLE_PROFILE_STATUSES.has(response.status) || attempt === 3) {
      throw new Error(`${label} fetch failed with HTTP ${response.status}.`);
    }

    await delay(500 * (attempt + 1));
  }

  throw new Error(`${label} fetch failed with HTTP ${lastStatus || "unknown"}.`);
}

function normalizeProfileUrl(rawUrl) {
  const url = new URL(String(rawUrl || ""));
  if (url.protocol !== "https:") {
    throw new Error("Only HTTPS Gladiatus profile URLs can be fetched.");
  }

  if (!url.hostname.endsWith(".gladiatus.gameforge.com")) {
    throw new Error("Only Gladiatus profile URLs can be fetched.");
  }

  if (!url.pathname.endsWith("/game/index.php") || url.searchParams.get("mod") !== "player") {
    throw new Error("Only Gladiatus player profiles can be fetched.");
  }

  return url;
}

function normalizeArenaListUrl(rawUrl) {
  const url = new URL(String(rawUrl || ""));
  if (url.protocol !== "https:") {
    throw new Error("Only HTTPS Gladiatus arena URLs can be fetched.");
  }

  if (!url.hostname.endsWith(".gladiatus.gameforge.com")) {
    throw new Error("Only Gladiatus arena URLs can be fetched.");
  }

  if (!url.pathname.endsWith("/game/index.php") || url.searchParams.get("mod") !== "arena") {
    throw new Error("Only Gladiatus arena pages can be fetched.");
  }

  return url;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
