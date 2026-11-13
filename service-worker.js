// Native Messaging is only reachable from the extension service worker or an
// extension page, so the Host bridge lives here rather than in page scripts.
if (typeof importScripts === "function") {
  try {
    importScripts("host-client.js", "outbox.js");
  } catch {
    console.warn("Collector helper client is unavailable.");
  }
}

const ADD_SELECTION_MENU_ID = "maginalia-collector-add-selection";
const CAPTURE_STORAGE_PREFIX = "collector.capture-transfer.";
const CAPTURE_TTL_MS = 5 * 60 * 1000;
const captureReadsInProgress = new Set();

function registerSelectionMenu() {
  const menus = chrome.contextMenus;
  if (!menus?.removeAll || !menus?.create) {
    return;
  }

  try {
    menus.removeAll(() => {
      if (chrome.runtime.lastError) {
        console.warn("Collector context menu registration is unavailable.");
        return;
      }

      try {
        menus.create(
          {
            id: ADD_SELECTION_MENU_ID,
            title: "本棚に追加",
            contexts: ["selection"],
            documentUrlPatterns: ["http://*/*", "https://*/*"]
          },
          () => {
            if (chrome.runtime.lastError) {
              console.warn("Collector context menu could not be registered.");
            }
          }
        );
      } catch {
        console.warn("Collector context menu could not be registered.");
      }
    });
  } catch {
    console.warn("Collector context menu registration is unavailable.");
  }
}

function isHttpUrl(value) {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }

  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function formatLocalAcquisitionTime(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    String(date.getFullYear()).padStart(4, "0") +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    pad(date.getHours()) +
    pad(date.getMinutes())
  );
}

function readPageMetadata() {
  const firstMetaValue = (selectors) => {
    for (const selector of selectors) {
      const value = document.querySelector(selector)?.getAttribute("content")?.trim();
      if (value) {
        return value;
      }
    }
    return "";
  };

  let canonicalUrl = "";
  const canonicalHref = document.querySelector('link[rel~="canonical"]')?.getAttribute("href");
  if (canonicalHref) {
    try {
      const candidate = new URL(canonicalHref, location.href);
      if (candidate.protocol === "http:" || candidate.protocol === "https:") {
        canonicalUrl = candidate.href;
      }
    } catch {
      canonicalUrl = "";
    }
  }

  return {
    pageUrl: location.href,
    title: document.title || "",
    siteName: firstMetaValue([
      'meta[property="og:site_name"]',
      'meta[name="application-name"]'
    ]),
    author: firstMetaValue([
      'meta[name="author"]',
      'meta[property="article:author"]',
      'meta[name="citation_author"]',
      'meta[name="dc.creator"]'
    ]),
    publishedAt: firstMetaValue([
      'meta[property="article:published_time"]',
      'meta[property="datePublished"]',
      'meta[name="citation_publication_date"]',
      'meta[name="date"]',
      'meta[name="dc.date"]'
    ]),
    canonicalUrl,
    selectionText: String(window.getSelection?.() ?? "")
  };
}

function isAccessLimitedError(error) {
  const message = typeof error?.message === "string" ? error.message : "";
  return /cannot access|permission|not allowed|restricted|cannot be scripted/i.test(message);
}

async function openCaptureError(reason) {
  if (!chrome.tabs?.create) {
    return;
  }

  try {
    await chrome.tabs.create({
      url: chrome.runtime.getURL("capture.html") + "?error=" + encodeURIComponent(reason),
      active: true
    });
  } catch {
    console.warn("Collector capture page could not be opened.");
  }
}

async function removeExpiredCaptureRecords() {
  const stored = await chrome.storage.session.get(null);
  const expiredKeys = Object.entries(stored)
    .filter(([key, record]) =>
      key.startsWith(CAPTURE_STORAGE_PREFIX) &&
      (!record || typeof record.expiresAt !== "number" || record.expiresAt <= Date.now())
    )
    .map(([key]) => key);

  if (expiredKeys.length > 0) {
    await chrome.storage.session.remove(expiredKeys);
  }
}

async function openSelectionCapture(info, tab) {
  if (info.menuItemId !== ADD_SELECTION_MENU_ID) {
    return;
  }

  const quote = info.selectionText;
  if (typeof quote !== "string" || quote.trim().length === 0) {
    await openCaptureError("selection-missing");
    return;
  }

  if (info.editable === true) {
    await openCaptureError("editable-selection");
    return;
  }

  const pageUrl = (typeof tab?.url === "string" && tab.url) || info.pageUrl || "";
  if (!isHttpUrl(pageUrl)) {
    await openCaptureError("page-unavailable");
    return;
  }

  if (!chrome.storage?.session || typeof chrome.storage.session.set !== "function") {
    await openCaptureError("transfer-unavailable");
    return;
  }

  const acquiredAt = formatLocalAcquisitionTime(new Date());
  const fallbackTitle = typeof tab?.title === "string" ? tab.title : "";
  let metadata = {
    title: fallbackTitle,
    siteName: "",
    author: "",
    publishedAt: "",
    canonicalUrl: ""
  };
  let metadataStatus = "available";
  let selectionMatches = null;

  if (!chrome.scripting?.executeScript || !Number.isInteger(tab?.id)) {
    metadataStatus = "access-limited";
  } else {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: readPageMetadata
      });
      const page = results?.[0]?.result;
      if (!page) {
        metadataStatus = "unavailable";
      } else if (page.pageUrl && page.pageUrl !== pageUrl) {
        metadataStatus = "page-changed";
      } else {
        metadata = {
          title: page.title || fallbackTitle,
          siteName: typeof page.siteName === "string" ? page.siteName : "",
          author: typeof page.author === "string" ? page.author : "",
          publishedAt: typeof page.publishedAt === "string" ? page.publishedAt : "",
          canonicalUrl: isHttpUrl(page.canonicalUrl) ? page.canonicalUrl : ""
        };
        selectionMatches =
          typeof page.selectionText === "string" ? page.selectionText === quote : null;
      }
    } catch (error) {
      metadataStatus = isAccessLimitedError(error) ? "access-limited" : "unavailable";
    }
  }

  const requestId = globalThis.crypto?.randomUUID?.();
  if (typeof requestId !== "string") {
    await openCaptureError("transfer-unavailable");
    return;
  }

  const storageKey = CAPTURE_STORAGE_PREFIX + requestId;
  const payload = {
    quote,
    pageUrl,
    title: metadata.title,
    siteName: metadata.siteName,
    author: metadata.author,
    publishedAt: metadata.publishedAt,
    canonicalUrl: metadata.canonicalUrl,
    frameUrl: typeof info.frameUrl === "string" ? info.frameUrl : "",
    isFrameSelection: Number.isInteger(info.frameId) && info.frameId > 0,
    selectionMatches,
    metadataStatus,
    acquiredAt
  };

  try {
    await removeExpiredCaptureRecords();
    await chrome.storage.session.set({
      [storageKey]: {
        payload,
        expiresAt: Date.now() + CAPTURE_TTL_MS
      }
    });
    await chrome.tabs.create({
      url: chrome.runtime.getURL("capture.html") + "?requestId=" + encodeURIComponent(requestId),
      active: true
    });
  } catch {
    try {
      await chrome.storage.session.remove(storageKey);
    } catch {
      // The session API may be unavailable; do not log capture data.
    }
    await openCaptureError("transfer-unavailable");
  }
}

function isCapturePageSender(sender) {
  return (
    typeof sender?.url === "string" &&
    sender.url.split("?")[0].split("#")[0] === chrome.runtime.getURL("capture.html")
  );
}

function isCaptureRequestSender(sender, requestId) {
  if (!isCapturePageSender(sender)) {
    return false;
  }

  try {
    const senderUrl = new URL(sender.url);
    return senderUrl.searchParams.get("requestId") === requestId;
  } catch {
    return false;
  }
}

async function consumeCapture(requestId) {
  if (
    typeof requestId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(requestId) ||
    captureReadsInProgress.has(requestId) ||
    !chrome.storage?.session
  ) {
    return null;
  }

  captureReadsInProgress.add(requestId);
  const storageKey = CAPTURE_STORAGE_PREFIX + requestId;
  try {
    const stored = await chrome.storage.session.get(storageKey);
    const record = stored[storageKey];
    await chrome.storage.session.remove(storageKey);
    if (
      !record ||
      typeof record.expiresAt !== "number" ||
      record.expiresAt <= Date.now() ||
      !record.payload
    ) {
      return null;
    }
    return record.payload;
  } finally {
    captureReadsInProgress.delete(requestId);
  }
}

function isExtensionPageSender(sender) {
  if (typeof sender?.url !== "string") {
    return false;
  }
  if (typeof chrome.runtime.id === "string" && sender.id !== chrome.runtime.id) {
    return false;
  }

  try {
    const senderUrl = new URL(sender.url);
    const extensionUrl = new URL(chrome.runtime.getURL(""));
    return senderUrl.protocol === "chrome-extension:" && senderUrl.origin === extensionUrl.origin;
  } catch {
    return false;
  }
}

function unavailableHostReport(code) {
  return {
    status: "unavailable",
    experimental: true,
    code,
    host: null,
    shelf: null,
    checks: []
  };
}

async function createConfiguredHostClient(api) {
  return api.createHostClient({
    hostName: await api.resolveHostName(chrome.storage?.local),
    sendNativeMessage: (name, message, callback) => {
      chrome.runtime.sendNativeMessage(name, message, callback);
    },
    getLastError: () => chrome.runtime.lastError,
    extensionVersion: ownExtensionVersion()
  });
}

function ownExtensionVersion() {
  try {
    return chrome.runtime.getManifest?.().version ?? "";
  } catch {
    return "";
  }
}

// Asks the Host for its health and configured Shelf. Nothing is written and
// nothing is sent from the Outbox, so a success here is not a Shelf save.
async function checkHostConnection() {
  const api = globalThis.CollectorHostClient;
  if (!api?.createHostClient) {
    return { ok: true, report: unavailableHostReport("native-messaging-unavailable") };
  }

  const client = await createConfiguredHostClient(api);
  return { ok: true, report: await client.checkCompatibility() };
}

const savesInProgress = new Set();

// Sends one pending Outbox quote to the Host exactly once, under its original
// request ID. The Outbox entry is deleted only after a validated committed or
// already-committed receipt. Every failure leaves the entry pending. Nothing here
// retries or deletes on its own; a resend is a new explicit user action with the
// same request ID, which the Host answers idempotently.
async function savePendingQuote(requestId) {
  const clientApi = globalThis.CollectorHostClient;
  const outboxApi = globalThis.CollectorOutbox;
  if (!clientApi?.createHostClient || !outboxApi?.create) return { ok: false, code: "native-messaging-unavailable" };
  if (savesInProgress.has(requestId)) return { ok: false, code: "save-in-progress" };

  savesInProgress.add(requestId);
  try {
    let item;
    const outbox = outboxApi.create();
    try {
      item = await outbox.getPending(requestId);
    } catch {
      return { ok: false, code: "outbox-unavailable" };
    }
    if (!item || item.requestId !== requestId || item.kind !== "quote" || !item.payload || typeof item.payload !== "object") {
      return { ok: false, code: "pending-quote-unavailable" };
    }

    const client = await createConfiguredHostClient(clientApi);
    const payload = item.payload;
    const quote = {
      requestId: item.requestId,
      quote: payload.quote,
      url: payload.pageUrl,
      getDate: payload.acquiredAt,
      ...(payload.title ? { title: payload.title } : {}),
      ...(payload.author ? { authors: [payload.author] } : {})
    };

    let saved;
    try {
      saved = await client.saveQuote(quote);
    } catch (error) {
      return { ok: false, code: typeof error?.code === "string" ? error.code : "host-save-failed" };
    }

    // saveQuote has already checked the receipt state, request ID, configured
    // Shelf ID and ID/digest patterns; check the binding to this entry once more.
    if (saved?.receipt?.requestId !== item.requestId) {
      return { ok: false, code: "invalid-response" };
    }

    let queueCleared = false;
    try {
      queueCleared = (await outbox.deletePending(item.requestId)).deleted === true;
    } catch {
      queueCleared = false;
    }
    // A durable Host receipt is authoritative for the Shelf. If the local cleanup
    // fails, the entry stays; a later resend returns already-committed.
    return {
      ok: true,
      result: queueCleared ? "saved" : "saved-but-local-pending",
      receipt: saved.receipt,
      shelf: { name: saved.shelf.name },
      queueCleared
    };
  } finally {
    savesInProgress.delete(requestId);
  }
}

function handleExtensionMessage(message, sender, sendResponse) {
  if (message?.type === "collector:host-check") {
    if (!isExtensionPageSender(sender)) {
      return false;
    }
    void checkHostConnection()
      .then((response) => sendResponse(response))
      .catch(() => sendResponse({ ok: false, code: "host-check-failed" }));
    return true;
  }

  if (message?.type === "collector:save-pending-quote") {
    if (!isCaptureRequestSender(sender, message.requestId)) return false;
    void savePendingQuote(message.requestId)
      .then((response) => sendResponse(response))
      .catch(() => sendResponse({ ok: false, code: "host-save-failed" }));
    return true;
  }

  if (message?.type === "collector:consume-capture") {
    if (!isCaptureRequestSender(sender, message.requestId)) {
      return false;
    }
    void consumeCapture(message.requestId)
      .then((payload) => sendResponse(payload ? { ok: true, payload } : { ok: false }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (
    message?.type === "collector:close-capture" &&
    isCapturePageSender(sender) &&
    Number.isInteger(sender.tab?.id)
  ) {
    try {
      chrome.tabs.remove(sender.tab.id, () => {
        sendResponse({ ok: !chrome.runtime.lastError });
      });
    } catch {
      sendResponse({ ok: false });
    }
    return true;
  }

  return false;
}

// Opens the first-run status page once, on a fresh install only. Updates and
// browser restarts do not reopen it; the popup links to it instead.
async function openOnboardingOnInstall(details) {
  if (details?.reason !== "install" || !chrome.tabs?.create) {
    return;
  }
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html"), active: true });
  } catch {
    console.warn("Collector first-run page could not be opened.");
  }
}

function handleInstalled(details) {
  registerSelectionMenu();
  void openOnboardingOnInstall(details);
}

chrome.runtime.onInstalled.addListener(handleInstalled);
chrome.runtime.onStartup.addListener(registerSelectionMenu);

if (chrome.contextMenus?.onClicked) {
  chrome.contextMenus.onClicked.addListener(openSelectionCapture);
}

if (chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener(handleExtensionMessage);
}
