export const SCHEMA = window.GladiatusAuctionSchema;
export const SCORE = window.GladiatusScoreModel;
export const MODEL = window.GladiatusAuctionModel;
export const CORE = window.GladiatusAuctionCore;
export const ARENA = window.GladiatusArenaCore;

if (!SCHEMA || !SCORE || !MODEL || !CORE || !ARENA) {
  throw new Error("Gladiatus auction schema, score model, auction model, auction core, and arena core must load before the popup.");
}

export const AUCTION_CONTENT_MESSAGES = {
  applySort: "GLAD_AH_APPLY_SORT_V2",
  boot: "GLAD_AH_BOOT_V2",
  customDefinitionsUpdated: "GLAD_AH_CUSTOM_DEFINITIONS_UPDATED_V2",
  scanAll: "GLAD_AH_SCAN_ALL_V2"
};

export const nodes = {
  title: document.querySelector("h1"),
  scanButton: document.getElementById("scan-button"),
  status: document.getElementById("status"),
  pageTabs: document.getElementById("page-tabs"),
  summary: document.getElementById("summary"),
  tabs: document.getElementById("tabs"),
  controls: document.getElementById("controls"),
  results: document.getElementById("results")
};

export async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

export function detectPageMode(url) {
  if (ARENA.isArenaPageUrl(url)) return "arena";

  try {
    const parsed = new URL(url || "");
    if (parsed.hostname.endsWith(".gladiatus.gameforge.com")
      && parsed.pathname.endsWith("/game/index.php")
      && parsed.searchParams.get("mod") === "auction") {
      return "auction";
    }
  } catch {
  }

  return "unsupported";
}

export async function sendAuctionScanMessage(tab) {
  try {
    const response = await sendTabMessage(tab.id, { type: AUCTION_CONTENT_MESSAGES.scanAll });
    if (response) return response;
  } catch {
    await ensureAuctionContentScript(tab.id);
    return sendTabMessage(tab.id, { type: AUCTION_CONTENT_MESSAGES.scanAll });
  }

  await ensureAuctionContentScript(tab.id);
  return sendTabMessage(tab.id, { type: AUCTION_CONTENT_MESSAGES.scanAll });
}

export async function ensureAuctionPageUi(tab) {
  try {
    const response = await sendTabMessage(tab.id, { type: AUCTION_CONTENT_MESSAGES.boot });
    if (response?.ok) return response;
  } catch {
  }

  await ensureAuctionContentScript(tab.id);
  return sendTabMessage(tab.id, { type: AUCTION_CONTENT_MESSAGES.boot });
}

export async function scanArenaOpponents(tab, formula) {
  return sendTabMessage(tab.id, {
    type: "GLAD_ARENA_SCAN_OPPONENTS",
    formula
  });
}

export function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      resolve(response);
    });
  });
}

export async function ensureAuctionContentScript(tabId) {
  if (!chrome.scripting?.executeScript) {
    throw new Error("Auction content script is not available on this tab. Reload the auction page after reloading the extension.");
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["auction-schema.js", "score-model.js", "auction-model.js", "auction-core.js", "arena-core.js", "arena-scan.js", "auction-content.js", "arena-content.js"]
  });
}

export async function loadStorage(key) {
  const result = await chrome.storage.local.get(key);
  return result[key] ?? null;
}

export async function saveStorage(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

export function setStatus(text) {
  nodes.status.textContent = text;
}

export function showToast(message) {
  let container = document.getElementById("glad-toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "glad-toast-container";
    container.className = "glad-toast-container";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.className = "glad-toast";
  toast.innerHTML = `<span class="glad-toast-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span> <span>${message}</span>`;
  
  container.appendChild(toast);
  
  setTimeout(() => {
    if (toast.parentElement) {
      toast.remove();
    }
  }, 2900);
}
