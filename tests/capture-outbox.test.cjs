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
  "review-notices", "review-notices-list", "cancel", "error-close", "hold-in-browser", "page-title",
  "site-name", "page-url", "author", "published-at", "quote", "acquired-at", "canonical-field",
  "canonical-url", "frame-url-field", "frame-url", "comment", "save-to-shelf", "shelf-status",
  "outbox-recovery-notice"
];

function createCaptureHarness(addPending, {
  search = `?requestId=${requestId}`,
  pendingItem = null,
  manifestPermissions = ["storage"],
  hostCheckResponse = null,
  saveResponse = null
} = {}) {
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
  const outboxCalls = { reads: [], adds: [], deletes: [] };
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
      getManifest() { return { permissions: manifestPermissions }; },
      sendMessage(message, callback) {
        messages.push(message);
        if (message.type === "collector:consume-capture") {
          callback({ ok: true, payload });
        } else if (message.type === "collector:host-check") {
          callback(hostCheckResponse);
        } else if (message.type === "collector:save-pending-quote") {
          if (typeof saveResponse === "function") saveResponse(message, callback);
          else callback(saveResponse);
        }
      }
    }
  };
  const outboxApi = {
    async addPending(input) {
      outboxCalls.adds.push(input);
      return addPending(input);
    },
    async getPending(id) {
      outboxCalls.reads.push(id);
      return pendingItem?.requestId === id ? pendingItem : null;
    },
    async deletePending(id) {
      outboxCalls.deletes.push(id);
      return { deleted: true };
    }
  };
  const context = vm.createContext({
    document,
    chrome,
    URL,
    window: {
      location: { search },
      confirm() { return windowState.confirmAnswers.shift() ?? true; },
      close() { windowState.closeCalls += 1; },
      addEventListener(type, callback) { windowState.listeners.set(type, callback); }
    },
    CollectorOutbox: { create: () => outboxApi },
    URLSearchParams
  });
  vm.runInContext(captureScript, context);
  return { elements, fieldsets, messages, outboxCalls, windowState };
}

// The page asks the Service Worker for a read-only Host check on load; that check
// never sends a quote, so the flow assertions below leave it out.
function nonCheckMessages(harness) {
  return harness.messages.map((message) => message.type).filter((type) => type !== "collector:host-check");
}

function saveMessages(harness) {
  return harness.messages.filter((message) => message.type === "collector:save-pending-quote");
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

  harness.elements.get("hold-in-browser").listeners.get("click")();
  assert.equal(queuedInput.requestId, requestId);
  assert.equal(queuedInput.kind, undefined);
  assert.equal(queuedInput.payload.originalQuote, "original quote");
  assert.equal(queuedInput.payload.quote, "edited quote");
  assert.equal(queuedInput.payload.comment, "local comment");
  assert.deepEqual(nonCheckMessages(harness), ["collector:consume-capture"]);

  resolveAdd({ alreadyQueued: false });
  await flushUi();
  assert.match(harness.elements.get("save-status").textContent, /ブラウザー内に保留しました/);
  assert.match(harness.elements.get("save-status").textContent, /本棚にはまだ保存されていません/);
  assert.equal(harness.elements.get("hold-in-browser").disabled, true);
  assert.equal(harness.fieldsets.every((fieldset) => fieldset.disabled), true);
});

test("capture queue failures leave the editable form available and explain capacity errors", async () => {
  const harness = createCaptureHarness(async () => {
    const error = new Error("full");
    error.code = "queue-full";
    throw error;
  });
  harness.elements.get("quote").value = "keep this text";

  harness.elements.get("hold-in-browser").listeners.get("click")();
  await flushUi();

  assert.equal(harness.elements.get("quote").value, "keep this text");
  assert.equal(harness.elements.get("hold-in-browser").disabled, false);
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
  assert.deepEqual(nonCheckMessages(harness), ["collector:consume-capture"]);

  harness.elements.get("cancel").listeners.get("click")();
  await flushUi();
  assert.equal(harness.windowState.closeCalls, 1);
  assert.deepEqual(harness.windowState.dispatchBeforeUnload(), { prevented: false, returnValue: undefined });
  assert.deepEqual(nonCheckMessages(harness), ["collector:consume-capture", "collector:close-capture"]);
});

function compatibleWriteReport(shelfName = "研究の本棚") {
  return {
    ok: true,
    report: {
      status: "compatible",
      host: { writesEnabled: true, operations: ["health", "configured_shelf", "save_web_quote"] },
      shelf: { name: shelfName, type: "private", writesEnabled: true }
    }
  };
}

function savedResponse(result = "saved", state = "committed", id = requestId) {
  return {
    ok: true,
    result,
    queueCleared: result === "saved",
    receipt: { state, requestId: id },
    shelf: { name: "研究の本棚" }
  };
}

function pendingQuoteRecord(id = requestId, overrides = {}) {
  const payload = {
    originalQuote: "Original quote",
    quote: "Edited quote with exact whitespace\n",
    title: "Stored page title",
    siteName: "Example site",
    pageUrl: "https://example.com/article?source=stored",
    author: "Stored author",
    publishedAt: "2026-10-01",
    canonicalUrl: "https://example.com/canonical",
    frameUrl: "",
    isFrameSelection: false,
    selectionMatches: true,
    metadataStatus: "available",
    acquiredAt: "202610130907",
    comment: "Stored comment",
    ...overrides
  };
  return {
    requestId: id,
    kind: "quote",
    localStatus: "pending",
    recipient: "private-shelf",
    recipientStatus: "not-sent",
    payload
  };
}

test("restores the same pending quote from IndexedDB without consuming session data or sending it", async () => {
  const record = pendingQuoteRecord();
  const harness = createCaptureHarness(async () => ({ alreadyQueued: true }), {
    search: `?requestId=${requestId}&from=outbox`,
    pendingItem: record
  });

  await flushUi();

  assert.deepEqual(harness.outboxCalls.reads, [requestId]);
  assert.deepEqual(harness.outboxCalls.adds, []);
  assert.deepEqual(nonCheckMessages(harness), []);
  assert.equal(harness.elements.get("capture-entry").hidden, false);
  assert.equal(harness.elements.get("heading").textContent, "保留中の引用を確認");
  assert.equal(harness.elements.get("page-title").value, record.payload.title);
  assert.equal(harness.elements.get("page-url").value, record.payload.pageUrl);
  assert.equal(harness.elements.get("quote").value, record.payload.quote);
  assert.equal(harness.elements.get("comment").value, record.payload.comment);
  assert.equal(harness.elements.get("acquired-at").textContent, "2026-10-13 09:07（ローカル時刻）");
  assert.equal(harness.elements.get("quote").readOnly, true);
  assert.equal(harness.elements.get("hold-in-browser").hidden, true);
  assert.equal(harness.elements.get("outbox-recovery-notice").hidden, false);
  assert.deepEqual(harness.windowState.dispatchBeforeUnload(), { prevented: false, returnValue: undefined });
});

test("recovery resend is only sent after an explicit click and keeps the original request ID", async () => {
  const record = pendingQuoteRecord();
  const harness = createCaptureHarness(async () => ({ alreadyQueued: true }), {
    search: `?requestId=${requestId}&from=outbox`,
    pendingItem: record,
    hostCheckResponse: compatibleWriteReport(),
    saveResponse: { ok: false, code: "host-save-failed" }
  });

  await flushUi();
  assert.deepEqual(saveMessages(harness), []);
  assert.equal(harness.elements.get("save-to-shelf").hidden, false);

  harness.elements.get("save-to-shelf").listeners.get("click")();
  await flushUi();

  assert.deepEqual(saveMessages(harness).map((message) => message.requestId), [requestId]);
  assert.deepEqual(harness.outboxCalls.adds, []);
  assert.deepEqual(harness.outboxCalls.deletes, []);
  assert.match(harness.elements.get("save-status").textContent, /保留したままです/);
  assert.equal(harness.elements.get("save-to-shelf").textContent, "もう一度保存");
  assert.equal(harness.elements.get("save-to-shelf").disabled, false);

  harness.elements.get("save-to-shelf").listeners.get("click")();
  await flushUi();
  assert.deepEqual(saveMessages(harness).map((message) => message.requestId), [requestId, requestId]);
});

test("missing, capture-kind, or corrupt Outbox records fail closed without deletion", async () => {
  const cases = [
    null,
    { ...pendingQuoteRecord(), kind: "capture" },
    pendingQuoteRecord(requestId, { acquiredAt: "202613320099" })
  ];

  for (const pendingItem of cases) {
    const harness = createCaptureHarness(async () => ({ alreadyQueued: true }), {
      search: `?requestId=${requestId}&from=outbox`,
      pendingItem
    });
    await flushUi();

    assert.equal(harness.elements.get("capture-entry").hidden, true);
    assert.equal(harness.elements.get("capture-error").hidden, false);
    assert.match(harness.elements.get("error-message").textContent, /保留データは削除されていません/);
    assert.deepEqual(harness.outboxCalls.adds, []);
    assert.deepEqual(harness.outboxCalls.deletes, []);
    assert.deepEqual(harness.messages, []);
  }
});

test("an invalid recovery request ID is rejected before reading the Outbox", async () => {
  const harness = createCaptureHarness(async () => ({ alreadyQueued: true }), {
    search: "?requestId=not-a-request-id&from=outbox",
    pendingItem: pendingQuoteRecord()
  });

  await flushUi();

  assert.deepEqual(harness.outboxCalls.reads, []);
  assert.equal(harness.elements.get("capture-entry").hidden, true);
  assert.match(harness.elements.get("error-message").textContent, /識別情報を確認できません/);
  assert.deepEqual(harness.outboxCalls.deletes, []);
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
  const calls = { deletes: [], confirms: [], tabs: [] };
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
      runtime: {
        lastError: null,
        getURL(path) { return `chrome-extension://test/${path}`; }
      },
      tabs: {
        async create(options) { calls.tabs.push(options); }
      },
      permissions: { contains(_permissions, callback) { callback(true); } }
    },
    window: { confirm(message) { calls.confirms.push(message); return confirmAnswer; } },
    CollectorOutbox: { create: () => outbox },
    URLSearchParams
  });
  vm.runInContext(popupScript, context);
  await flushUi();

  const item = elements.get("queue-list").children[0];
  const state = item.children.find((child) => child.className === "queue-item-state");
  const removeButton = item.children.at(-1);
  assert.match(elements.get("status").textContent, /Private Shelfへの保存は未完了です/);
  assert.match(state.textContent, /Private Shelf未保存/);
  assert.match(elements.get("queue-usage").textContent, /1 件/);

  const openButton = item.children.find((child) => child.textContent === "保留を開く");
  openButton.listeners.get("click")();
  await flushUi();
  assert.equal(calls.tabs.length, 1);
  assert.match(calls.tabs[0].url, new RegExp(`requestId=${requestId}`));
  assert.match(calls.tabs[0].url, /from=outbox/);

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

test("capture queue cards do not expose a Shelf retry action", async () => {
  const ids = ["heading", "status", "details", "permission-status", "queue-usage", "queue-empty", "queue-list"];
  const { document, elements } = createDocument(ids);
  const outbox = {
    async listPending() {
      return {
        items: [{ requestId, createdAt: Date.now(), kind: "capture", title: "Image", pageUrl: "https://example.com/" }],
        itemCount: 1,
        totalBytes: 100
      };
    },
    async deletePending() { return { deleted: false }; }
  };
  const context = vm.createContext({
    document,
    chrome: {
      runtime: { lastError: null, getURL(path) { return `chrome-extension://test/${path}`; } },
      tabs: { async create() { throw new Error("must not open Shelf retry"); } },
      permissions: { contains(_permissions, callback) { callback(true); } }
    },
    window: { confirm() { return false; } },
    CollectorOutbox: { create: () => outbox },
    URLSearchParams
  });
  vm.runInContext(popupScript, context);
  await flushUi();

  const item = elements.get("queue-list").children[0];
  assert.equal(item.children.some((child) => child.textContent === "保留を開く"), false);
  assert.equal(item.children.at(-1).textContent, "この引用を削除");
});

test("the production save button is visible on a fresh capture and the Host check explains why saving is unavailable", async () => {
  const harness = createCaptureHarness(async () => ({ alreadyQueued: false }), {
    hostCheckResponse: { ok: true, report: { status: "unavailable", code: "host-not-registered", host: null, shelf: null, checks: [] } }
  });
  await flushUi();

  const button = harness.elements.get("save-to-shelf");
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, false);
  assert.match(harness.elements.get("shelf-status").textContent, /いまは本棚に保存できません/);
  assert.match(harness.elements.get("shelf-status").textContent, /登録されていません/);
  assert.deepEqual(saveMessages(harness), []);
  assert.deepEqual(harness.outboxCalls.adds, []);
});

test("the Host check names the configured Shelf without exposing an identifier", async () => {
  const harness = createCaptureHarness(async () => ({ alreadyQueued: false }), {
    hostCheckResponse: compatibleWriteReport("研究の本棚")
  });
  await flushUi();

  assert.equal(harness.elements.get("shelf-status").textContent, "MAGINALIAの本棚「研究の本棚」に保存できます。");
});

test("one click holds the quote, sends one save with the request ID, and shows 保存中 then 保存しました", async () => {
  let finishSave;
  const harness = createCaptureHarness(async () => ({ alreadyQueued: false }), {
    hostCheckResponse: compatibleWriteReport(),
    saveResponse: (_message, callback) => { finishSave = callback; }
  });
  await flushUi();
  const button = harness.elements.get("save-to-shelf");

  button.listeners.get("click")();
  await flushUi();
  assert.equal(harness.outboxCalls.adds.length, 1);
  assert.equal(harness.outboxCalls.adds[0].requestId, requestId);
  assert.deepEqual(saveMessages(harness).map((message) => message.requestId), [requestId]);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "保存中…");
  assert.equal(harness.elements.get("cancel").disabled, true);
  assert.deepEqual(harness.windowState.dispatchBeforeUnload(), { prevented: true, returnValue: "" });

  button.listeners.get("click")();
  await flushUi();
  assert.equal(saveMessages(harness).length, 1);

  finishSave(savedResponse());
  await flushUi();
  assert.equal(button.textContent, "保存しました");
  assert.equal(button.disabled, true);
  assert.match(harness.elements.get("save-status").textContent, /^保存しました。/);
  assert.equal(harness.elements.get("hold-in-browser").hidden, true);
  assert.deepEqual(harness.outboxCalls.deletes, []);
  assert.deepEqual(harness.windowState.dispatchBeforeUnload(), { prevented: false, returnValue: undefined });

  button.listeners.get("click")();
  await flushUi();
  assert.equal(saveMessages(harness).length, 1);
});

test("a saved receipt whose local cleanup failed is shown as saved-but-local-pending, not as plain success", async () => {
  const harness = createCaptureHarness(async () => ({ alreadyQueued: false }), {
    hostCheckResponse: compatibleWriteReport(),
    saveResponse: savedResponse("saved-but-local-pending")
  });
  await flushUi();

  harness.elements.get("save-to-shelf").listeners.get("click")();
  await flushUi();

  const status = harness.elements.get("save-status").textContent;
  assert.match(status, /本棚には保存済みですが、この端末の保留が残っています/);
  assert.equal(harness.elements.get("save-to-shelf").textContent, "もう一度保存");
  assert.equal(harness.elements.get("save-to-shelf").disabled, false);
  assert.deepEqual(harness.outboxCalls.deletes, []);
});

test("each save failure shows cause-specific copy, keeps the quote pending, and never reads as success", async () => {
  const cases = [
    ["host-not-registered", /連携プログラムがこのパソコンに登録されていません/],
    ["shelf-not-configured", /保存先の本棚がまだ設定されていません/],
    ["shelf-identity-mismatch", /識別子が一致しません/],
    ["shelf-write-busy", /ほかの処理が使用中/],
    ["host-timeout", /時間内に応答がありませんでした/],
    ["host-save-failed", /書き込みを完了できませんでした/],
    ["future-unknown-code", /本棚に保存できませんでした/]
  ];
  for (const [code, pattern] of cases) {
    const harness = createCaptureHarness(async () => ({ alreadyQueued: false }), {
      hostCheckResponse: compatibleWriteReport(),
      saveResponse: { ok: false, code }
    });
    await flushUi();

    harness.elements.get("save-to-shelf").listeners.get("click")();
    await flushUi();

    const status = harness.elements.get("save-status").textContent;
    assert.match(status, pattern, code);
    assert.match(status, /保留したままです/, code);
    assert.doesNotMatch(status, /保存しました/, code);
    assert.notEqual(harness.elements.get("save-to-shelf").textContent, "保存しました", code);
    assert.equal(harness.elements.get("save-to-shelf").disabled, false, code);
    assert.deepEqual(harness.outboxCalls.deletes, [], code);
  }
});

test("an ok response without a durable receipt for this request is treated as a failure", async () => {
  for (const response of [
    { ...savedResponse(), receipt: { state: "staged", requestId } },
    { ...savedResponse(), receipt: { state: "committed", requestId: "00000000-0000-4000-8000-000000000099" } },
    { ...savedResponse(), receipt: null },
    { ...savedResponse(), result: "unexpected" }
  ]) {
    const harness = createCaptureHarness(async () => ({ alreadyQueued: false }), {
      hostCheckResponse: compatibleWriteReport(),
      saveResponse: response
    });
    await flushUi();

    harness.elements.get("save-to-shelf").listeners.get("click")();
    await flushUi();

    assert.doesNotMatch(harness.elements.get("save-status").textContent, /保存しました/);
    assert.match(harness.elements.get("save-status").textContent, /保存できたとは判断していません/);
  }
});

test("a save is not sent when the quote cannot first be held in the browser", async () => {
  const harness = createCaptureHarness(async () => {
    const error = new Error("quota");
    error.code = "storage-quota";
    throw error;
  }, { hostCheckResponse: compatibleWriteReport(), saveResponse: savedResponse() });
  await flushUi();

  harness.elements.get("save-to-shelf").listeners.get("click")();
  await flushUi();

  assert.deepEqual(saveMessages(harness), []);
  assert.match(harness.elements.get("save-status").textContent, /保存領域が不足/);
});
