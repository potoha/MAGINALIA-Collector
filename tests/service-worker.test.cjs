const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const serviceWorker = fs.readFileSync(path.join(__dirname, "..", "service-worker.js"), "utf8");
const menuId = "maginalia-collector-add-selection";

function createHarness({ contextMenus = true, tabs = true, denyContextMenus = false } = {}) {
  const listeners = {};
  const activeMenus = new Map();
  const warnings = [];
  const calls = { removeAll: 0, tabs: [] };
  const chrome = {
    runtime: {
      lastError: null,
      getURL: (resource) => `chrome-extension://test/${resource}`,
      onInstalled: { addListener: (listener) => { listeners.onInstalled = listener; } },
      onStartup: { addListener: (listener) => { listeners.onStartup = listener; } }
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
      create(properties, callback) {
        calls.tabs.push(properties);
        callback();
      }
    };
  }

  vm.runInNewContext(serviceWorker, {
    chrome,
    console: { warn: (message) => warnings.push(message) }
  });

  return { activeMenus, calls, listeners, warnings };
}

test("registers one selection-only menu on install and startup", () => {
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

test("ignores a context-menu event without nonblank selected text", () => {
  const harness = createHarness();

  harness.listeners.onClicked({ menuItemId: menuId });
  harness.listeners.onClicked({ menuItemId: menuId, selectionText: "   " });
  harness.listeners.onClicked({ menuItemId: "another-extension-item", selectionText: "sample" });

  assert.deepEqual(harness.calls.tabs, []);
});

test("opens the extension entry page without putting selected text in its URL", () => {
  const harness = createHarness();
  const selectedText = "synthetic private selection";

  harness.listeners.onClicked({ menuItemId: menuId, selectionText: selectedText });

  assert.equal(
    JSON.stringify(harness.calls.tabs),
    JSON.stringify([
      {
        url: "chrome-extension://test/popup.html?entry=selection",
        active: true
      }
    ])
  );
  assert.equal(JSON.stringify(harness.calls).includes(selectedText), false);
});

test("tolerates missing context-menu and tab APIs", () => {
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
