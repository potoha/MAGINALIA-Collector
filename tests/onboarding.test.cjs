const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const onboardingScript = fs.readFileSync(path.join(ROOT, "onboarding.js"), "utf8");
const onboardingHtml = fs.readFileSync(path.join(ROOT, "onboarding.html"), "utf8");
const serviceWorkerScript = fs.readFileSync(path.join(ROOT, "service-worker.js"), "utf8");
const popupScript = fs.readFileSync(path.join(ROOT, "popup.js"), "utf8");
const popupHtml = fs.readFileSync(path.join(ROOT, "popup.html"), "utf8");
const SHELF_ID = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const GUIDANCE_IDS = [
  "guide-host-missing",
  "guide-shelf-unconfigured",
  "guide-identity-mismatch",
  "guide-other",
  "guide-extension-update",
  "guide-host-update",
  "ready-guidance"
];

class MockElement {
  constructor(id) {
    this.id = id;
    this.textContent = "";
    this.className = "";
    this.hidden = id.startsWith("guide-") || id === "ready-guidance";
    this.disabled = false;
    this.children = [];
    this.listeners = new Map();
  }

  addEventListener(type, callback) {
    this.listeners.set(type, callback);
  }

  append(child) {
    this.children.push(child);
  }

  replaceChildren(...children) {
    this.children = children;
  }
}

function createDocument() {
  const elements = new Map();
  return {
    elements,
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, new MockElement(id));
        return elements.get(id);
      },
      createElement(tagName) {
        return new MockElement(tagName);
      }
    }
  };
}

function flushUi() {
  return new Promise((resolve) => setImmediate(resolve));
}

function runOnboarding(responses) {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const { document, elements } = createDocument();
  const messages = [];
  const context = vm.createContext({
    document,
    console,
    chrome: {
      runtime: {
        lastError: null,
        sendMessage(message, callback) {
          messages.push(message);
          callback(queue.length > 1 ? queue.shift() : queue[0]);
        }
      }
    }
  });
  vm.runInContext(onboardingScript, context);
  return { elements, messages };
}

function report(status, extra = {}) {
  return { ok: true, report: { status, experimental: true, host: null, shelf: null, checks: [], ...extra } };
}

function writableReport(name = "研究の本棚") {
  return report("compatible", {
    host: { protocol: "maginalia.collector.experimental.v1", operations: ["health", "configured_shelf", "save_web_quote"], writesEnabled: true },
    shelf: { id: SHELF_ID, name, type: "private", writesEnabled: true }
  });
}

function visibleGuidance(elements) {
  return GUIDANCE_IDS.filter((id) => elements.get(id) && elements.get(id).hidden === false);
}

function allText(elements) {
  return Array.from(elements.values(), (element) => element.textContent).join("\n");
}

test("a ready Host and Shelf show the display name only and the next step", async () => {
  const { elements, messages } = runOnboarding(writableReport());
  await flushUi();

  assert.deepEqual(messages.map((message) => message.type), ["collector:host-check"]);
  assert.match(elements.get("host-status").textContent, /接続できました/);
  assert.equal(elements.get("shelf-status").textContent, "「研究の本棚」に保存します。");
  assert.match(elements.get("overall-status").textContent, /準備ができました/);
  assert.deepEqual(visibleGuidance(elements), ["ready-guidance"]);
  assert.equal(allText(elements).includes(SHELF_ID), false);
});

test("an unregistered Host shows the 未登録 guidance and no Shelf result", async () => {
  const { elements } = runOnboarding(report("unavailable", { code: "host-not-registered" }));
  await flushUi();

  assert.match(elements.get("host-status").textContent, /未登録/);
  assert.match(elements.get("shelf-status").textContent, /まだ確認できません/);
  assert.doesNotMatch(elements.get("overall-status").textContent, /準備ができました/);
  assert.deepEqual(visibleGuidance(elements), ["guide-host-missing"]);
});

test("an unconfigured Shelf shows the 未設定 guidance", async () => {
  const { elements } = runOnboarding(report("incompatible", { code: "shelf-not-configured" }));
  await flushUi();

  assert.match(elements.get("host-status").textContent, /接続できました/);
  assert.match(elements.get("shelf-status").textContent, /未設定/);
  assert.deepEqual(visibleGuidance(elements), ["guide-shelf-unconfigured"]);
});

test("a Shelf identity mismatch shows the 識別子不一致 guidance and never reads as ready", async () => {
  const { elements } = runOnboarding(report("incompatible", { code: "shelf-identity-mismatch" }));
  await flushUi();

  assert.match(elements.get("shelf-status").textContent, /識別子が一致しません/);
  assert.deepEqual(visibleGuidance(elements), ["guide-identity-mismatch"]);
  assert.doesNotMatch(elements.get("overall-status").textContent, /準備ができました/);
});

test("a configured Shelf that does not accept saves is not reported as ready", async () => {
  const response = writableReport();
  response.report.host.writesEnabled = false;
  const { elements } = runOnboarding(response);
  await flushUi();

  assert.match(elements.get("shelf-status").textContent, /いまは保存を受け付けていません/);
  assert.deepEqual(visibleGuidance(elements), ["guide-shelf-unconfigured"]);
  assert.doesNotMatch(elements.get("overall-status").textContent, /準備ができました/);
});

test("a missing Service Worker answer is shown as unknown, not as success", async () => {
  const { elements } = runOnboarding(null);
  await flushUi();

  assert.match(elements.get("overall-status").textContent, /確認できませんでした/);
  assert.deepEqual(visibleGuidance(elements), ["guide-other"]);
});

test("もう一度確認 runs the read-only check again and updates the result", async () => {
  const { elements, messages } = runOnboarding([report("unavailable", { code: "host-not-registered" }), writableReport()]);
  await flushUi();
  assert.deepEqual(visibleGuidance(elements), ["guide-host-missing"]);

  elements.get("recheck").listeners.get("click")();
  await flushUi();

  assert.equal(messages.length, 2);
  assert.ok(messages.every((message) => message.type === "collector:host-check"));
  assert.deepEqual(visibleGuidance(elements), ["ready-guidance"]);
});

test("the first-run page offers no Shelf list, picker or switching and sends no quote", () => {
  assert.doesNotMatch(onboardingHtml, /<select\b|type="radio"|<form\b|<input\b/i);
  assert.doesNotMatch(onboardingScript, /save-pending-quote|sendNativeMessage|CollectorOutbox|storage\.(local|sync|session)/);
  for (const anchor of ["#shelf-setup", "#identity-mismatch"]) {
    assert.match(onboardingHtml, new RegExp(`docs/install-guide-ja\\.md${anchor}`));
  }
  assert.match(onboardingHtml, /target="_blank" rel="noopener noreferrer"/);
});

test("the Desktop-bundled path: no standalone Host installer link, setup is done from MAGINALIA", () => {
  assert.doesNotMatch(onboardingHtml, /#host-install|インストーラー/);
  assert.match(onboardingHtml, /「ファイル」→「Collector 連携を設定…」/);
  assert.match(onboardingHtml, /「Collector 連携を確認・修復…」/);
});

test("an outdated extension shows its own state and guidance, never ready", async () => {
  const { elements } = runOnboarding(report("incompatible", { code: "extension-update-required" }));
  await flushUi();

  assert.match(elements.get("host-status").textContent, /Collector の版が古い/);
  assert.match(elements.get("overall-status").textContent, /まだ本棚に保存できません/);
  assert.doesNotMatch(elements.get("overall-status").textContent, /準備ができました/);
  assert.deepEqual(visibleGuidance(elements), ["guide-extension-update"]);
  assert.match(onboardingHtml, /id="guide-extension-update"[\s\S]*「Collector 連携を確認・修復…」/);
  assert.doesNotMatch(allText(elements), /successfully|please/i);
});

test("an outdated Host or protocol mismatch tells the user to update MAGINALIA", async () => {
  const { elements } = runOnboarding(report("incompatible", { code: "host-update-required" }));
  await flushUi();

  assert.match(elements.get("host-status").textContent, /版が合いません/);
  assert.deepEqual(visibleGuidance(elements), ["guide-host-update"]);
  assert.match(onboardingHtml, /id="guide-host-update"[\s\S]*MAGINALIAを最新の版に更新してください/);
  assert.doesNotMatch(elements.get("overall-status").textContent, /準備ができました/);
});

test("the two compatibility states are distinct from each other and from Shelf problems", async () => {
  const states = [];
  for (const code of ["extension-update-required", "host-update-required", "shelf-not-configured"]) {
    const { elements } = runOnboarding(report("incompatible", { code }));
    await flushUi();
    states.push(`${elements.get("host-status").textContent}|${visibleGuidance(elements).join()}`);
  }
  assert.equal(new Set(states).size, 3);
});

test("a clear recheck after an update removes the compatibility guidance", async () => {
  const { elements } = runOnboarding([report("incompatible", { code: "extension-update-required" }), writableReport()]);
  await flushUi();
  elements.get("recheck").listeners.get("click")();
  await flushUi();
  assert.deepEqual(visibleGuidance(elements), ["ready-guidance"]);
});

async function runPopupCheck(response) {
  const { document, elements } = createDocument();
  const context = vm.createContext({
    document,
    console,
    chrome: {
      runtime: {
        lastError: null,
        getURL: (resource) => "chrome-extension://test/" + resource,
        sendMessage(_message, callback) { callback(response); }
      },
      tabs: { async create() {} },
      permissions: { contains(_permissions, callback) { callback(true); } }
    },
    window: { confirm() { return false; } },
    CollectorOutbox: { create: () => ({ async listPending() { return { items: [], itemCount: 0, totalBytes: 0 }; } }) },
    URLSearchParams,
    Intl
  });
  vm.runInContext(popupScript, context);
  await flushUi();
  elements.get("host-check-button").listeners.get("click")();
  await flushUi();
  return elements;
}

test("the popup shows a dedicated message for each compatibility outcome and no failure list", async () => {
  const extension = await runPopupCheck(report("incompatible", { code: "extension-update-required" }));
  assert.match(extension.get("host-check-status").textContent, /Collector の版が古い.*「ファイル」→「Collector 連携を確認・修復…」/);
  assert.equal(extension.get("host-check-status").className, "host-check-summary is-error");
  assert.equal(extension.get("host-check-failure-list").children.length, 0);

  const host = await runPopupCheck(report("incompatible", { code: "host-update-required" }));
  assert.match(host.get("host-check-status").textContent, /版が合わない.*MAGINALIAを最新の版に更新してください/);
  assert.equal(host.get("host-check-failure-list").children.length, 0);
  assert.notEqual(extension.get("host-check-status").textContent, host.get("host-check-status").textContent);
});

test("the popup still lists failed checks for other incompatible outcomes", async () => {
  const elements = await runPopupCheck(report("incompatible", {
    code: "shelf-identity-mismatch",
    checks: [{ id: "configured-shelf", status: "fail", code: "shelf-identity-mismatch" }]
  }));
  assert.equal(elements.get("host-check-failure-list").children.length, 1);
});

test("the popup and first-run copy avoid the standalone Host installer wording", () => {
  assert.doesNotMatch(popupScript, /連携プログラムを導入/);
  assert.doesNotMatch(onboardingScript, /入れ直して/);
});

function createServiceWorker() {
  const listeners = {};
  const tabs = [];
  const chrome = {
    runtime: {
      lastError: null,
      getURL: (resource) => "chrome-extension://test/" + resource,
      onInstalled: { addListener: (listener) => { listeners.onInstalled = listener; } },
      onStartup: { addListener: (listener) => { listeners.onStartup = listener; } },
      onMessage: { addListener() {} }
    },
    contextMenus: {
      removeAll(callback) { callback(); },
      create(_properties, callback) { callback(); },
      onClicked: { addListener() {} }
    },
    tabs: { async create(options) { tabs.push(options); } }
  };
  vm.runInContext(serviceWorkerScript, vm.createContext({ chrome, console, URL }));
  return { listeners, tabs };
}

test("a fresh install opens the first-run page once; updates and restarts do not", async () => {
  const install = createServiceWorker();
  install.listeners.onInstalled({ reason: "install" });
  await flushUi();
  assert.deepEqual(install.tabs.map((tab) => tab.url), ["chrome-extension://test/onboarding.html"]);

  const update = createServiceWorker();
  update.listeners.onInstalled({ reason: "update", previousVersion: "0.1.0" });
  update.listeners.onStartup();
  await flushUi();
  assert.deepEqual(update.tabs, []);
});

test("the popup keeps the connection check and links to the first-run page", async () => {
  assert.match(popupHtml, /MAGINALIAとの接続/);
  assert.match(popupHtml, /id="host-check-button"/);
  assert.match(popupHtml, /id="open-onboarding"/);

  const { document, elements } = createDocument();
  const tabs = [];
  const context = vm.createContext({
    document,
    console,
    chrome: {
      runtime: { lastError: null, getURL: (resource) => "chrome-extension://test/" + resource },
      tabs: { async create(options) { tabs.push(options); } },
      permissions: { contains(_permissions, callback) { callback(true); } }
    },
    window: { confirm() { return false; } },
    CollectorOutbox: { create: () => ({ async listPending() { return { items: [], itemCount: 0, totalBytes: 0 }; } }) },
    URLSearchParams,
    Intl
  });
  vm.runInContext(popupScript, context);
  await flushUi();

  elements.get("open-onboarding").listeners.get("click")();
  await flushUi();
  assert.deepEqual(tabs.map((tab) => tab.url), ["chrome-extension://test/onboarding.html"]);
});
