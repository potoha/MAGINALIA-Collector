const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const serviceWorker = fs.readFileSync(path.join(__dirname, "..", "service-worker.js"), "utf8");
const captureHtml = fs.readFileSync(path.join(__dirname, "..", "capture.html"), "utf8");
const captureScript = fs.readFileSync(path.join(__dirname, "..", "capture.js"), "utf8");
const menuId = "maginalia-collector-add-selection";
const storagePrefix = "collector.capture-transfer.";
const requestId = "00000000-0000-4000-8000-000000000001";
const extensionCaptureUrl = "chrome-extension://test/capture.html";
const defaultPageUrl = "https://example.com/article";
const defaultMetadata = {
  pageUrl: defaultPageUrl,
  title: "Page title",
  siteName: "Example Site",
  author: "",
  publishedAt: "",
  canonicalUrl: "https://example.com/canonical",
  selectionText: "sample quote"
};

function createHarness({
  contextMenus = true,
  tabs = true,
  denyContextMenus = false,
  storage = true,
  metadata = defaultMetadata,
  metadataError = null,
  failTabCreate = false,
  pageFixture = {}
} = {}) {
  const listeners = {};
  const activeMenus = new Map();
  const warnings = [];
  const session = new Map();
  const calls = {
    removeAll: 0,
    tabs: [],
    removedTabs: [],
    executeScript: [],
    sessionSet: [],
    sessionRemove: []
  };
  const chrome = {
    runtime: {
      lastError: null,
      getURL: (resource) => "chrome-extension://test/" + resource,
      onInstalled: { addListener: (listener) => { listeners.onInstalled = listener; } },
      onStartup: { addListener: (listener) => { listeners.onStartup = listener; } },
      onMessage: { addListener: (listener) => { listeners.onMessage = listener; } }
    }
  };

  if (contextMenus) {
    chrome.contextMenus = {
      removeAll(callback) {
        calls.removeAll += 1;
        if (denyContextMenus) {
          chrome.runtime.lastError = { message: "permission denied" };
          callback();
          chrome.runtime.lastError = null;
          return;
        }
        activeMenus.clear();
        callback();
      },
      create(properties, callback) {
        activeMenus.set(properties.id, properties);
        callback();
      },
      onClicked: { addListener: (listener) => { listeners.onClicked = listener; } }
    };
  }

  if (tabs) {
    chrome.tabs = {
      async create(properties) {
        calls.tabs.push(properties);
        if (failTabCreate) {
          throw new Error("tab creation failed");
        }
        return { id: 42 };
      },
      remove(tabId, callback) {
        calls.removedTabs.push(tabId);
        callback();
      }
    };
  }

  if (storage) {
    chrome.storage = {
      session: {
        async get(keys) {
          if (keys === null) {
            return Object.fromEntries(session);
          }
          const keyList = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(keyList.filter((key) => session.has(key)).map((key) => [key, session.get(key)]));
        },
        async set(values) {
          calls.sessionSet.push(values);
          for (const [key, value] of Object.entries(values)) {
            session.set(key, value);
          }
        },
        async remove(keys) {
          const keyList = Array.isArray(keys) ? keys : [keys];
          calls.sessionRemove.push(keyList);
          for (const key of keyList) {
            session.delete(key);
          }
        }
      }
    };
  }

  chrome.scripting = {
    async executeScript(details) {
      calls.executeScript.push(details);
      if (metadataError) {
        throw metadataError;
      }
      return [{ result: metadata }];
    }
  };

  const fixture = {
    title: "",
    url: defaultPageUrl,
    selectionText: "",
    canonicalHref: "",
    metaValues: {},
    ...pageFixture
  };
  const context = {
    chrome,
    URL,
    crypto: { randomUUID: () => requestId },
    document: {
      title: fixture.title,
      querySelector(selector) {
        if (selector === 'link[rel~="canonical"]') {
          return fixture.canonicalHref
            ? { getAttribute: (attribute) => attribute === "href" ? fixture.canonicalHref : null }
            : null;
        }
        return Object.hasOwn(fixture.metaValues, selector)
          ? { getAttribute: (attribute) => attribute === "content" ? fixture.metaValues[selector] : null }
          : null;
      }
    },
    location: { href: fixture.url },
    window: { getSelection: () => ({ toString: () => fixture.selectionText }) },
    console: { warn: (message) => warnings.push(message) }
  };
  vm.runInNewContext(serviceWorker, context);

  return { activeMenus, calls, context, listeners, session, warnings };
}

function clickSelection(harness, overrides = {}) {
  return harness.listeners.onClicked(
    {
      menuItemId: menuId,
      selectionText: "sample quote",
      pageUrl: defaultPageUrl,
      frameId: 0,
      editable: false,
      ...overrides
    },
    { id: 17, url: defaultPageUrl, title: "Tab title" }
  );
}

function consumeMessage(harness, request, senderUrl = extensionCaptureUrl + "?requestId=" + requestId) {
  return new Promise((resolve) => {
    const waiting = harness.listeners.onMessage(
      request,
      { url: senderUrl, tab: { id: 42 } },
      resolve
    );
    if (waiting !== true) {
      resolve({ ok: false });
    }
  });
}

test("registers one HTTP(S) selection-only menu on install and startup", () => {
  const harness = createHarness();

  harness.listeners.onInstalled();
  harness.listeners.onStartup();

  assert.equal(harness.calls.removeAll, 2);
  assert.equal(harness.activeMenus.size, 1);
  assert.equal(
    JSON.stringify(harness.activeMenus.get(menuId)),
    JSON.stringify({
      id: menuId,
      title: "本棚に追加",
      contexts: ["selection"],
      documentUrlPatterns: ["http://*/*", "https://*/*"]
    })
  );
  assert.deepEqual(harness.warnings, []);
});

test("reads explicit page metadata and keeps canonical URL separate from the visited URL", () => {
  const harness = createHarness({
    pageFixture: {
      title: "Fixture title",
      url: defaultPageUrl,
      selectionText: "quote",
      canonicalHref: "/canonical",
      metaValues: {
        'meta[property="og:site_name"]': "Fixture site",
        'meta[name="author"]': "A. Writer",
        'meta[property="article:published_time"]': "2026-10-13"
      }
    }
  });

  const metadata = JSON.parse(JSON.stringify(harness.context.readPageMetadata()));

  assert.deepEqual(metadata, {
    pageUrl: defaultPageUrl,
    title: "Fixture title",
    siteName: "Fixture site",
    author: "A. Writer",
    publishedAt: "2026-10-13",
    canonicalUrl: "https://example.com/canonical",
    selectionText: "quote"
  });
});

test("ignores unrelated context-menu events", async () => {
  const harness = createHarness();

  await harness.listeners.onClicked({
    menuItemId: "another-extension-item",
    selectionText: "sample quote"
  });

  assert.deepEqual(harness.calls.tabs, []);
  assert.equal(harness.session.size, 0);
});

test("opens a distinct missing-selection message without staging text", async () => {
  const harness = createHarness();

  await harness.listeners.onClicked({ menuItemId: menuId }, { id: 17, url: defaultPageUrl });

  assert.match(harness.calls.tabs[0].url, /capture\.html\?error=selection-missing$/);
  assert.equal(harness.session.size, 0);
});

test("does not capture text selected in an editable control", async () => {
  const harness = createHarness();

  await clickSelection(harness, { editable: true });

  assert.match(harness.calls.tabs[0].url, /capture\.html\?error=editable-selection$/);
  assert.equal(harness.calls.executeScript.length, 0);
  assert.equal(harness.session.size, 0);
});

test("stages the exact selection once in session storage and keeps it out of the URL", async () => {
  const harness = createHarness();
  const quote = "first line\n  second line";

  await clickSelection(harness, { selectionText: quote });

  assert.equal(harness.calls.executeScript.length, 1);
  assert.equal(harness.calls.executeScript[0].target.tabId, 17);
  assert.equal(typeof harness.calls.executeScript[0].func, "function");
  assert.equal(harness.calls.tabs.length, 1);
  assert.match(harness.calls.tabs[0].url, /capture\.html\?requestId=/);
  assert.equal(harness.calls.tabs[0].url.includes(quote), false);

  const url = new URL(harness.calls.tabs[0].url);
  const staged = harness.session.get(storagePrefix + url.searchParams.get("requestId"));
  assert.equal(staged.payload.quote, quote);
  assert.equal(staged.payload.pageUrl, defaultPageUrl);
  assert.equal(staged.payload.title, defaultMetadata.title);
  assert.equal(staged.payload.siteName, defaultMetadata.siteName);
  assert.equal(staged.payload.author, "");
  assert.equal(staged.payload.publishedAt, "");
  assert.equal(staged.payload.canonicalUrl, defaultMetadata.canonicalUrl);
  assert.equal(staged.payload.metadataStatus, "available");
  assert.match(staged.payload.acquiredAt, /^\d{12}$/);
  assert.equal(JSON.stringify(harness.calls.tabs).includes(quote), false);
  assert.equal(harness.warnings.join("\n").includes(quote), false);
});

test("the capture page can consume its own payload once and the staged record is removed", async () => {
  const harness = createHarness();
  const quote = "private selection";
  await clickSelection(harness, { selectionText: quote });

  const response = await consumeMessage(harness, {
    type: "collector:consume-capture",
    requestId
  });

  assert.equal(response.ok, true);
  assert.equal(response.payload.quote, quote);
  assert.equal(harness.session.has(storagePrefix + requestId), false);

  const secondRead = await consumeMessage(harness, {
    type: "collector:consume-capture",
    requestId
  });
  assert.equal(secondRead.ok, false);
});

test("does not expose staged text to a non-extension sender or a different capture token", async () => {
  const harness = createHarness();
  await clickSelection(harness);

  const nonExtension = await consumeMessage(
    harness,
    { type: "collector:consume-capture", requestId },
    "https://example.com/"
  );
  const wrongToken = await consumeMessage(
    harness,
    { type: "collector:consume-capture", requestId: "00000000-0000-4000-8000-000000000002" }
  );

  assert.equal(nonExtension.ok, false);
  assert.equal(wrongToken.ok, false);
  assert.equal(harness.session.has(storagePrefix + requestId), true);
});

test("labels page-access denial and still retains the quote for review", async () => {
  const harness = createHarness({
    metadataError: new Error("Cannot access contents of the url")
  });

  await clickSelection(harness, { selectionText: "still available" });

  const staged = harness.session.get(storagePrefix + requestId);
  assert.equal(staged.payload.quote, "still available");
  assert.equal(staged.payload.title, "Tab title");
  assert.equal(staged.payload.metadataStatus, "access-limited");
  assert.equal(staged.payload.author, "");
  assert.equal(staged.payload.publishedAt, "");
});

test("marks iframe and DOM-selection mismatch without replacing the captured quote", async () => {
  const harness = createHarness({
    metadata: { ...defaultMetadata, selectionText: "different text" }
  });

  await clickSelection(harness, {
    selectionText: "exact context-menu text",
    frameId: 4,
    frameUrl: "https://embed.example.net/frame"
  });

  const staged = harness.session.get(storagePrefix + requestId);
  assert.equal(staged.payload.quote, "exact context-menu text");
  assert.equal(staged.payload.isFrameSelection, true);
  assert.equal(staged.payload.frameUrl, "https://embed.example.net/frame");
  assert.equal(staged.payload.selectionMatches, false);
});

test("marks changed page metadata unavailable instead of mixing it with the clicked URL", async () => {
  const harness = createHarness({
    metadata: { ...defaultMetadata, pageUrl: "https://other.example/article" }
  });

  await clickSelection(harness);

  const staged = harness.session.get(storagePrefix + requestId);
  assert.equal(staged.payload.pageUrl, defaultPageUrl);
  assert.equal(staged.payload.title, "Tab title");
  assert.equal(staged.payload.siteName, "");
  assert.equal(staged.payload.canonicalUrl, "");
  assert.equal(staged.payload.metadataStatus, "page-changed");
});

test("reports an empty metadata result as unavailable, not as a changed page", async () => {
  const harness = createHarness({ metadata: null });

  await clickSelection(harness);

  const staged = harness.session.get(storagePrefix + requestId);
  assert.equal(staged.payload.pageUrl, defaultPageUrl);
  assert.equal(staged.payload.title, "Tab title");
  assert.equal(staged.payload.metadataStatus, "unavailable");
});

test("shows transfer unavailability when session storage is not supported", async () => {
  const harness = createHarness({ storage: false });

  await clickSelection(harness);

  assert.match(harness.calls.tabs[0].url, /capture\.html\?error=transfer-unavailable$/);
  assert.equal(harness.session.size, 0);
});

test("removes an expired one-time capture rather than returning it", async () => {
  const harness = createHarness();
  harness.session.set(storagePrefix + requestId, {
    payload: { quote: "expired" },
    expiresAt: Date.now() - 1
  });

  const response = await consumeMessage(harness, {
    type: "collector:consume-capture",
    requestId
  });

  assert.equal(response.ok, false);
  assert.equal(harness.session.has(storagePrefix + requestId), false);
});

test("only the extension capture page can close its own tab", async () => {
  const harness = createHarness();
  const response = await consumeMessage(
    harness,
    { type: "collector:close-capture" },
    extensionCaptureUrl + "?error=selection-missing"
  );
  const rejected = await consumeMessage(
    harness,
    { type: "collector:close-capture" },
    "https://example.com/"
  );

  assert.equal(response.ok, true);
  assert.deepEqual(harness.calls.removedTabs, [42]);
  assert.equal(rejected.ok, false);
});

test("capture page offers browser holding and a visible production Shelf save button", () => {
  assert.doesNotMatch(captureHtml, /<form\b/i);
  assert.match(captureHtml, /id="save-html"[^>]*disabled/);
  assert.match(captureHtml, /id="hold-in-browser"[^>]*type="button"/);
  assert.doesNotMatch(captureHtml, /id="hold-in-browser"[^>]*(disabled|hidden)/);
  assert.match(captureHtml, /id="save-to-shelf"[^>]*type="button"/);
  assert.doesNotMatch(captureHtml, /id="save-to-shelf"[^>]*(disabled|hidden)/);
  assert.doesNotMatch(captureHtml, /test-host-save|テストHost/);
  assert.match(captureHtml, /outbox\.js[\s\S]*capture\.js/);
  assert.match(captureHtml, /Private Shelf/);
  assert.match(captureScript, /addPending\(/);
  assert.match(captureScript, /collector:save-pending-quote/);
  assert.doesNotMatch(captureScript, /Host未接続のため送信処理は行っていません|collector:test-save/);
  assert.doesNotMatch(captureScript, /fetch\s*\(|XMLHttpRequest|storage\.(local|sync)|sendNativeMessage/i);
});

test("tolerates missing context-menu and tab APIs", async () => {
  const harness = createHarness({ contextMenus: false, tabs: false });

  assert.doesNotThrow(() => harness.listeners.onInstalled());
  assert.doesNotThrow(() => harness.listeners.onStartup());
  assert.equal(harness.listeners.onClicked, undefined);
});

test("tolerates a denied context-menu permission without creating a menu", () => {
  const harness = createHarness({ denyContextMenus: true });

  assert.doesNotThrow(() => harness.listeners.onInstalled());
  assert.equal(harness.activeMenus.size, 0);
  assert.equal(harness.warnings.length, 1);
});
