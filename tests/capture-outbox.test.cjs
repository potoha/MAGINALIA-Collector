const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const captureScript = fs.readFileSync(path.join(__dirname, "..", "capture.js"), "utf8");
const popupScript = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");
const requestId = "00000000-0000-4000-8000-000000000001";

class MockElement {
  constructor(id) {
    this.id = id;
    this.value = "";
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.className = "";
    this.children = [];
    this.listeners = new Map();
    this.fieldsets = [];
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

  querySelectorAll(selector) {
    return selector === "fieldset" ? this.fieldsets : [];
  }

  focus() {
    this.focused = true;
  }

  get childElementCount() {
    return this.children.length;
  }
}

function createDocument(ids) {
  const elements = new Map(ids.map((id) => [id, new MockElement(id)]));
  return {
    elements,
    document: {
      getElementById(id) {
        if (!elements.has(id)) {
          elements.set(id, new MockElement(id));
        }
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

const captureIds = [
  "heading", "save-status", "capture-entry", "capture-error", "error-heading", "error-message",
  "review-notices", "review-notices-list", "cancel", "error-close", "add-to-shelf", "page-title",
  "site-name", "page-url", "author", "published-at", "quote", "acquired-at", "canonical-field",
  "canonical-url", "frame-url-field", "frame-url", "comment"
];

function createCaptureHarness(addPending) {
  const { document, elements } = createDocument(captureIds);
  const fieldsets = [new MockElement("fieldset-source"), new MockElement("fieldset-quote")];
  elements.get("capture-entry").fieldsets = fieldsets;
  const payload = {
    quote: "original quote",
    pageUrl: "https://example.com/article",
    title: "Example page",
    siteName: "Example",
    author: "Writer",
    publishedAt: "2026-10-01",
    canonicalUrl: "https://example.com/canonical",
    acquiredAt: "202610130900",
    metadataStatus: "available",
    selectionMatches: true,
    isFrameSelection: false
  };
  const messages = [];
  const windowState = {
    closeCalls: 0,
    confirmAnswers: [true],
    listeners: new Map(),
    dispatchBeforeUnload() {
      let prevented = false;
      const event = {
        preventDefault() { prevented = true; },
        returnValue: undefined
      };
      this.listeners.get("beforeunload")?.(event);
      return { prevented, returnValue: event.returnValue };
    }
  };
  const chrome = {
    runtime: {
      lastError: null,
      getManifest() { return { permissions: ["storage"] }; },
      sendMessage(message, callback) {
        messages.push(message);
        if (message.type === "collector:consume-capture") {
          callback({ ok: true, payload });
        }
      }
    }
  };
  const context = vm.createContext({
    document,
    chrome,
    window: {
      location: { search: `?requestId=${requestId}` },
      confirm() { return windowState.confirmAnswers.shift() ?? true; },
      close() { windowState.closeCalls += 1; },
      addEventListener(type, callback) { windowState.listeners.set(type, callback); }
    },
    CollectorOutbox: { create: () => ({ addPending }) },
    URLSearchParams
  });
  vm.runInContext(captureScript, context);
  return { elements, fieldsets, messages, windowState };
}

test("capture review queues edited values with the original fixed request ID", async () => {
  let resolveAdd;
  let queuedInput;
  const addResult = new Promise((resolve) => { resolveAdd = resolve; });
  const harness = createCaptureHarness((input) => {
    queuedInput = input;
    return addResult;
  });
  harness.elements.get("quote").value = "edited quote";
  harness.elements.get("comment").value = "local comment";

  harness.elements.get("add-to-shelf").listeners.get("click")();
  assert.equal(queuedInput.requestId, requestId);
  assert.equal(queuedInput.kind, undefined);
  assert.equal(queuedInput.payload.originalQuote, "original quote");
  assert.equal(queuedInput.payload.quote, "edited quote");
  assert.equal(queuedInput.payload.comment, "local comment");
  assert.deepEqual(harness.messages.map((message) => message.type), ["collector:consume-capture"]);

  resolveAdd({ alreadyQueued: false });
  await flushUi();
  assert.match(harness.elements.get("save-status").textContent, /ブラウザー内に保留しました/);
  assert.match(harness.elements.get("save-status").textContent, /Private Shelfにはまだ保存されていません/);
  assert.equal(harness.elements.get("add-to-shelf").disabled, true);
  assert.equal(harness.fieldsets.every((fieldset) => fieldset.disabled), true);
});

test("capture queue failures leave the editable form available and explain capacity errors", async () => {
  const harness = createCaptureHarness(async () => {
    const error = new Error("full");
    error.code = "queue-full";
    throw error;
  });
  harness.elements.get("quote").value = "keep this text";

  harness.elements.get("add-to-shelf").listeners.get("click")();
  await flushUi();

  assert.equal(harness.elements.get("quote").value, "keep this text");
  assert.equal(harness.elements.get("add-to-shelf").disabled, false);
  assert.match(harness.elements.get("save-status").textContent, /上限128 MiB/);
  assert.match(harness.elements.get("save-status").textContent, /入力内容はこの画面に残っています/);
});

test("closing an unqueued review asks before discarding it", async () => {
  const harness = createCaptureHarness(async () => ({ alreadyQueued: false }));
  harness.windowState.confirmAnswers = [false, true];

  assert.deepEqual(harness.windowState.dispatchBeforeUnload(), { prevented: true, returnValue: "" });
  harness.elements.get("cancel").listeners.get("click")();
  await flushUi();
  assert.equal(harness.windowState.closeCalls, 0);
  assert.deepEqual(harness.windowState.dispatchBeforeUnload(), { prevented: true, returnValue: "" });
  assert.deepEqual(harness.messages.map((message) => message.type), ["collector:consume-capture"]);

  harness.elements.get("cancel").listeners.get("click")();
  await flushUi();
  assert.equal(harness.windowState.closeCalls, 1);
  assert.deepEqual(harness.windowState.dispatchBeforeUnload(), { prevented: false, returnValue: undefined });
  assert.deepEqual(
    harness.messages.map((message) => message.type),
    ["collector:consume-capture", "collector:close-capture"]
  );
});

test("popup distinguishes pending data from Shelf receipt and requires confirmation before deletion", async () => {
  const ids = ["heading", "status", "details", "permission-status", "queue-usage", "queue-empty", "queue-list"];
  const { document, elements } = createDocument(ids);
  const items = [{
    requestId,
    createdAt: Date.now(),
    kind: "quote",
    title: "Example page",
    pageUrl: "https://example.com/article",
    bytes: 200,
    localStatus: "pending",
    recipientStatus: "not-sent"
  }];
  const calls = { deletes: [], confirms: [] };
  let confirmAnswer = false;
  const outbox = {
    async listPending() {
      return { items: [...items], itemCount: items.length, totalBytes: 200 };
    },
    async deletePending(id) {
      calls.deletes.push(id);
      items.splice(0, items.length);
      return { deleted: true };
    }
  };
  const context = vm.createContext({
    document,
    chrome: {
      runtime: { lastError: null },
      permissions: { contains(_permissions, callback) { callback(true); } }
    },
    window: { confirm(message) { calls.confirms.push(message); return confirmAnswer; } },
    CollectorOutbox: { create: () => outbox }
  });
  vm.runInContext(popupScript, context);
  await flushUi();

  const item = elements.get("queue-list").children[0];
  const state = item.children.find((child) => child.className === "queue-item-state");
  const removeButton = item.children.at(-1);
  assert.match(elements.get("status").textContent, /Private Shelfへの保存は未完了です/);
  assert.match(state.textContent, /Private Shelf未保存/);
  assert.match(elements.get("queue-usage").textContent, /1 件/);

  removeButton.listeners.get("click")();
  await flushUi();
  assert.equal(calls.deletes.length, 0);
  assert.match(calls.confirms[0], /削除後は元に戻せません/);

  confirmAnswer = true;
  removeButton.listeners.get("click")();
  await flushUi();
  assert.deepEqual(calls.deletes, [requestId]);
  assert.equal(elements.get("queue-empty").hidden, false);
  assert.equal(elements.get("queue-empty").textContent, "保留中の引用はありません。");
});
