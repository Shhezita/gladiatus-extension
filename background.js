chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GLAD_AH_REPAIR_AUCTION_CONTENT") {
    repairAuctionContent(_sender)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

    return true;
  }

  if (message?.type !== "GLAD_ARENA_FETCH_PROFILE") return false;

  fetchProfileHtml(message.url)
    .then((html) => sendResponse({ ok: true, html }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

  return true;
});

const AUCTION_CONTENT_FILES = [
  "auction-schema.js",
  "score-model.js",
  "auction-model.js",
  "auction-core.js",
  "arena-core.js",
  "auction-content.js",
  "arena-content.js"
];
const RETRYABLE_PROFILE_STATUSES = new Set([429, 500, 502, 503, 504]);

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
  const url = normalizeProfileUrl(rawUrl);
  let lastStatus = 0;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url.href, { credentials: "include" });
    if (response.ok) return response.text();

    lastStatus = response.status;
    if (!RETRYABLE_PROFILE_STATUSES.has(response.status) || attempt === 3) {
      throw new Error(`Profile fetch failed with HTTP ${response.status}.`);
    }

    await delay(500 * (attempt + 1));
  }

  throw new Error(`Profile fetch failed with HTTP ${lastStatus || "unknown"}.`);
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
