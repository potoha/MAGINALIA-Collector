const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const hostClientSource = fs.readFileSync(path.join(__dirname, "..", "host-client.js"), "utf8");
const serviceWorkerSource = fs.readFileSync(path.join(__dirname, "..", "service-worker.js"), "utf8");
const PROTOCOL = "maginalia.collector.experimental.v1";
const HOST_NAME = "org.maginalia.smoke_test";
const PRODUCT_HOST_NAME = "org.maginalia.collector";
const SHELF_ID = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const RUNTIME_ID = "abcdefghijklmnopabcdefghijklmnop";

const healthyResponse = {
  protocol: PROTOCOL,
  ok: true,
  experimental: true,
  operations: ["health", "configured_shelf"],
  writesEnabled: false
};
const shelfResponse = {
  protocol: PROTOCOL,
  ok: true,
  shelf: { id: SHELF_ID, name: "私の本棚", type: "private", writesEnabled: false }
};

function createHarness({
  profile = { hostName: HOST_NAME },
  responses = {},
  lastError = null,
  pendingItem = null,
  deleteError = false,
  deleteResult = null,
  deferSave = false
} = {}) {
  const listeners = {};
  const requests = [];
  const deferred = [];
  let pending = pendingItem;
  let deleteFailuresLeft = deleteError === true ? Infinity : Number(deleteError) || 0;
  const chrome = {
    runtime: {
      id: RUNTIME_ID,
      lastError,
      getURL: (resource) => `chrome-extension://${RUNTIME_ID}/` + resource,
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener: (listener) => { listeners.onMessage = listener; } },
      sendNativeMessage(name, message, callback) {
        requests.push({ name, message });
        const configured = responses[message.operation];
        const response = typeof configured === "function" ? configured(message, requests.length) : configured;
        if (response === undefined) {
          throw new Error("unexpected operation: " + message.operation);
        }
        if (deferSave && message.operation === "save_web_quote") {
          deferred.push(() => callback(response));
          return;
        }
        callback(response);
      }
    },
    storage: {
      local: {
        async get(key) {
          return profile ? { [key]: profile } : {};
        }
      }
    }
  };

  const outbox = {
    async getPending(requestId) {
      return pending?.requestId === requestId ? pending : null;
    },
    async deletePending(requestId) {
      if (deleteFailuresLeft > 0) {
        deleteFailuresLeft -= 1;
        throw new Error("outbox cleanup failure");
      }
      if (deleteResult) return deleteResult;
      if (pending?.requestId !== requestId) return { deleted: false };
      pending = null;
      return { deleted: true };
    }
  };
  const context = vm.createContext({ chrome, URL, TextEncoder, setTimeout, clearTimeout, console, CollectorOutbox: { create: () => outbox } });
  vm.runInContext(hostClientSource, context);
  vm.runInContext(serviceWorkerSource, context);

  return {
    context,
    listeners,
    requests,
    deferred,
    get pending() { return pending; },
    get deleted() { return pendingItem !== null && pending === null; },
    saveRequests() { return requests.filter((request) => request.message.operation === "save_web_quote"); }
  };
}

function sendHostCheck(harness, sender = { id: RUNTIME_ID, url: `chrome-extension://${RUNTIME_ID}/popup.html` }) {
  return new Promise((resolve) => {
    const handled = harness.listeners.onMessage({ type: "collector:host-check" }, sender, resolve);
    if (handled !== true) {
      resolve({ ok: false, code: "rejected" });
    }
  });
}

function sendPendingQuote(
  harness,
  requestId,
  sender = { id: RUNTIME_ID, url: `chrome-extension://${RUNTIME_ID}/capture.html?requestId=${requestId}&from=outbox` },
  type = "collector:save-pending-quote"
) {
  return new Promise((resolve) => {
    const handled = harness.listeners.onMessage({ type, requestId }, sender, resolve);
    if (handled !== true) resolve({ ok: false, code: "rejected" });
  });
}

function receiptFor(requestId, state = "committed") {
  return {
    version: 1, state, requestId, shelfId: SHELF_ID,
    bookId: "book:01JBF5GD3RT8YCKM93Q5D9X0EX", annotationId: "ann:01JBF5GD3RT8YCKM93Q5D9X0EY",
    bookReused: false, annotationDigest: `sha256:${"a".repeat(64)}`,
    requestDigest: `sha256:${"b".repeat(64)}`, recordedAt: "2026-11-03T03:00:00.000Z"
  };
}

// saveResults lists the Host answer for each successive save_web_quote request:
// a receipt state string, a whole response object, or "error:<host code>".
function writeModeResponses(requestId, saveResults = ["committed"]) {
  let saveCount = 0;
  return {
    health: { ...healthyResponse, operations: ["health", "configured_shelf", "save_web_quote"], writesEnabled: true },
    configured_shelf: { protocol: PROTOCOL, ok: true, shelf: { id: SHELF_ID, name: "私の本棚", type: "private", writesEnabled: true } },
    save_web_quote: () => {
      const result = saveResults[Math.min(saveCount, saveResults.length - 1)];
      saveCount += 1;
      if (typeof result === "object") return result;
      return result.startsWith("error:")
        ? { protocol: PROTOCOL, ok: false, error: result.slice("error:".length) }
        : { protocol: PROTOCOL, ok: true, receipt: receiptFor(requestId, result) };
    }
  };
}

function pendingQuote(requestId) {
  return {
    requestId,
    kind: "quote",
    payload: { quote: "Selected test quotation", pageUrl: "https://example.com/", title: "Sample Page", acquiredAt: "202611031200" }
  };
}

test("an extension page can check the configured helper through the service worker", async () => {
  const harness = createHarness({
    responses: { health: healthyResponse, configured_shelf: shelfResponse }
  });

  const response = await sendHostCheck(harness);

  assert.equal(response.ok, true);
  assert.equal(response.report.status, "compatible");
  assert.equal(response.report.experimental, true);
  assert.equal(response.report.shelf.id, SHELF_ID);
  assert.equal(response.report.shelf.name, "私の本棚");
  assert.equal(response.report.host.writesEnabled, false);
  assert.deepEqual(
    Array.from(harness.requests, (request) => [request.name, request.message.operation]),
    [[HOST_NAME, "health"], [HOST_NAME, "configured_shelf"]]
  );
});

test("a web page sender cannot reach the helper", async () => {
  const harness = createHarness({
    responses: { health: healthyResponse, configured_shelf: shelfResponse }
  });

  const response = await sendHostCheck(harness, { id: RUNTIME_ID, url: "https://example.com/article", tab: { id: 7 } });

  assert.equal(response.ok, false);
  assert.equal(response.code, "rejected");
  assert.deepEqual(harness.requests, []);
});

test("another extension origin cannot reach the helper", async () => {
  const harness = createHarness({
    responses: { health: healthyResponse, configured_shelf: shelfResponse }
  });

  const response = await sendHostCheck(harness, {
    id: "ponmlkjihgfedcbaponmlkjihgfedcba",
    url: "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/popup.html"
  });

  assert.equal(response.ok, false);
  assert.equal(response.code, "rejected");
  assert.deepEqual(harness.requests, []);
});

test("contacts the fixed product Host name when no development override is stored", async () => {
  const harness = createHarness({
    profile: null,
    responses: { health: healthyResponse, configured_shelf: shelfResponse }
  });

  const response = await sendHostCheck(harness);

  assert.equal(response.ok, true);
  assert.equal(response.report.status, "compatible");
  assert.deepEqual(
    Array.from(harness.requests, (request) => request.name),
    [PRODUCT_HOST_NAME, PRODUCT_HOST_NAME]
  );
});

test("keeps a rejected caller distinguishable from a missing helper", async () => {
  const harness = createHarness({
    responses: { health: null, configured_shelf: null },
    lastError: { message: "Access to the specified native messaging host is forbidden." }
  });

  const response = await sendHostCheck(harness);

  assert.equal(response.report.status, "unavailable");
  assert.equal(response.report.code, "host-access-forbidden");
  assert.equal(response.report.shelf, null);
  assert.equal(response.report.checks.at(-1).status, "fail");
});

test("reports a Shelf identity mismatch as incompatible and never as success", async () => {
  const harness = createHarness({
    responses: {
      health: healthyResponse,
      configured_shelf: { protocol: PROTOCOL, ok: false, error: "shelf_identity_mismatch" }
    }
  });

  const response = await sendHostCheck(harness);

  assert.equal(response.report.status, "incompatible");
  assert.equal(response.report.code, "shelf-identity-mismatch");
  assert.equal(response.report.shelf, null);
});

test("the host check performs no outbox or storage mutation", async () => {
  const harness = createHarness({
    responses: { health: healthyResponse, configured_shelf: shelfResponse }
  });
  const mutations = [];
  harness.context.chrome.storage.local.set = async (...args) => { mutations.push(args); };
  harness.context.chrome.storage.local.remove = async (...args) => { mutations.push(args); };

  await sendHostCheck(harness);

  assert.deepEqual(mutations, []);
  assert.equal(harness.context.chrome.tabs, undefined);
});

test("one explicit save sends exactly one save_web_quote and clears the Outbox after a valid receipt", async () => {
  const requestId = "00000000-0000-4000-8000-000000000007";
  const harness = createHarness({ pendingItem: pendingQuote(requestId), responses: writeModeResponses(requestId) });

  const response = await sendPendingQuote(harness, requestId);

  assert.equal(response.ok, true);
  assert.equal(response.result, "saved");
  assert.equal(response.queueCleared, true);
  assert.equal(response.receipt.state, "committed");
  assert.equal(response.receipt.requestId, requestId);
  assert.deepEqual({ ...response.shelf }, { name: "私の本棚" });
  assert.equal(Object.hasOwn(response, "duplicateReceipt"), false);
  assert.equal(harness.deleted, true);
  assert.deepEqual(
    Array.from(harness.requests, (request) => request.message.operation),
    ["health", "configured_shelf", "save_web_quote"]
  );
  const [save] = harness.saveRequests();
  assert.equal(save.message.requestId, requestId);
  assert.equal(save.name, HOST_NAME);
  for (const request of harness.requests) {
    assert.equal(Object.hasOwn(request.message, "shelfRoot"), false);
    assert.equal(Object.hasOwn(request.message, "coordinationRoot"), false);
  }
});

test("an already-committed receipt also counts as saved and clears the Outbox", async () => {
  const requestId = "00000000-0000-4000-8000-00000000000a";
  const harness = createHarness({
    pendingItem: pendingQuote(requestId),
    responses: writeModeResponses(requestId, ["already-committed"])
  });

  const response = await sendPendingQuote(harness, requestId);

  assert.equal(response.ok, true);
  assert.equal(response.result, "saved");
  assert.equal(response.receipt.state, "already-committed");
  assert.equal(harness.deleted, true);
  assert.equal(harness.saveRequests().length, 1);
});

test("a committed receipt with a failing Outbox delete reports saved-but-local-pending and keeps the entry", async () => {
  const requestId = "00000000-0000-4000-8000-00000000000b";
  const harness = createHarness({
    pendingItem: pendingQuote(requestId),
    responses: writeModeResponses(requestId),
    deleteError: true
  });

  const response = await sendPendingQuote(harness, requestId);

  assert.equal(response.ok, true);
  assert.equal(response.result, "saved-but-local-pending");
  assert.equal(response.queueCleared, false);
  assert.equal(response.receipt.state, "committed");
  assert.equal(harness.deleted, false);
  assert.equal(harness.pending.requestId, requestId);
  assert.equal(harness.saveRequests().length, 1);
});

test("a delete that reports nothing deleted is not treated as a cleared Outbox", async () => {
  const requestId = "00000000-0000-4000-8000-00000000000c";
  const harness = createHarness({
    pendingItem: pendingQuote(requestId),
    responses: writeModeResponses(requestId),
    deleteResult: { deleted: false }
  });

  const response = await sendPendingQuote(harness, requestId);

  assert.equal(response.result, "saved-but-local-pending");
  assert.equal(response.queueCleared, false);
});

test("an explicit resend after a kept entry uses the same request ID and is answered idempotently", async () => {
  const requestId = "00000000-0000-4000-8000-00000000000d";
  const harness = createHarness({
    pendingItem: pendingQuote(requestId),
    responses: writeModeResponses(requestId, ["committed", "already-committed"]),
    deleteError: 1
  });

  const first = await sendPendingQuote(harness, requestId);
  assert.equal(first.result, "saved-but-local-pending");
  assert.equal(harness.saveRequests().length, 1);
  assert.equal(harness.pending.requestId, requestId);

  const second = await sendPendingQuote(harness, requestId);
  assert.equal(second.ok, true);
  assert.equal(second.result, "saved");
  assert.equal(second.receipt.state, "already-committed");
  assert.equal(harness.deleted, true);
  assert.deepEqual(harness.saveRequests().map((request) => request.message.requestId), [requestId, requestId]);
});

test("a failed first save keeps the entry; the explicit resend clears it on already-committed", async () => {
  const requestId = "00000000-0000-4000-8000-00000000000e";
  const harness = createHarness({
    pendingItem: pendingQuote(requestId),
    responses: writeModeResponses(requestId, ["error:save_failed", "already-committed"])
  });

  const first = await sendPendingQuote(harness, requestId);
  assert.equal(first.ok, false);
  assert.equal(first.code, "host-save-failed");
  assert.equal(harness.pending.requestId, requestId);
  assert.equal(harness.saveRequests().length, 1);

  const second = await sendPendingQuote(harness, requestId);
  assert.equal(second.result, "saved");
  assert.equal(harness.deleted, true);
  assert.equal(harness.saveRequests().length, 2);
});

test("each Host failure maps to a distinct client code and keeps the Outbox entry pending", async () => {
  const cases = [
    ["shelf_unconfigured", "shelf-not-configured"],
    ["configuration_unavailable", "shelf-configuration-unavailable"],
    ["shelf_identity_mismatch", "shelf-identity-mismatch"],
    ["shelf_identity_unavailable", "shelf-identity-unavailable"],
    ["shelf_unavailable", "shelf-unavailable"],
    ["host_configuration_or_origin_invalid", "host-configuration-invalid"],
    ["shelf_write_busy", "shelf-write-busy"],
    ["save_failed", "host-save-failed"],
    ["unsupported_operation", "unsupported-operation"]
  ];
  for (const [hostError, code] of cases) {
    const requestId = "00000000-0000-4000-8000-000000000010";
    const harness = createHarness({
      pendingItem: pendingQuote(requestId),
      responses: writeModeResponses(requestId, [`error:${hostError}`])
    });

    const response = await sendPendingQuote(harness, requestId);

    assert.equal(response.ok, false, hostError);
    assert.equal(response.code, code, hostError);
    assert.equal(harness.deleted, false, hostError);
    assert.equal(harness.saveRequests().length, 1, hostError);
  }
});

test("a missing Host registration keeps the entry and sends no quote", async () => {
  const requestId = "00000000-0000-4000-8000-000000000011";
  const harness = createHarness({
    pendingItem: pendingQuote(requestId),
    responses: { health: null },
    lastError: { message: "Specified native messaging host not found." }
  });

  const response = await sendPendingQuote(harness, requestId);

  assert.equal(response.ok, false);
  assert.equal(response.code, "host-not-registered");
  assert.equal(harness.deleted, false);
  assert.equal(harness.saveRequests().length, 0);
});

test("a configuration error reported before saving keeps the entry and never sends the quote", async () => {
  const requestId = "00000000-0000-4000-8000-000000000012";
  const responses = writeModeResponses(requestId);
  responses.configured_shelf = { protocol: PROTOCOL, ok: false, error: "shelf_identity_mismatch" };
  const harness = createHarness({ pendingItem: pendingQuote(requestId), responses });

  const response = await sendPendingQuote(harness, requestId);

  assert.equal(response.code, "shelf-identity-mismatch");
  assert.equal(harness.deleted, false);
  assert.equal(harness.saveRequests().length, 0);
});

test("a receipt in any other state, or bound to another request or Shelf, is rejected and keeps the entry", async () => {
  const requestId = "00000000-0000-4000-8000-000000000013";
  for (const receipt of [
    { protocol: PROTOCOL, ok: true, receipt: { ...receiptFor(requestId), state: "staged" } },
    { protocol: PROTOCOL, ok: true, receipt: receiptFor("00000000-0000-4000-8000-000000000099") },
    { protocol: PROTOCOL, ok: true, receipt: { ...receiptFor(requestId), shelfId: "00000000-0000-4000-8000-000000000000" } }
  ]) {
    const harness = createHarness({ pendingItem: pendingQuote(requestId), responses: writeModeResponses(requestId, [receipt]) });

    const response = await sendPendingQuote(harness, requestId);

    assert.equal(response.ok, false);
    assert.equal(response.code, "invalid-response");
    assert.equal(harness.deleted, false);
  }
});

test("a second save for the same request while one is in flight is refused, not sent", async () => {
  const requestId = "00000000-0000-4000-8000-000000000014";
  const harness = createHarness({ pendingItem: pendingQuote(requestId), responses: writeModeResponses(requestId), deferSave: true });

  const first = sendPendingQuote(harness, requestId);
  await new Promise((resolve) => setImmediate(resolve));
  const second = await sendPendingQuote(harness, requestId);
  assert.equal(second.ok, false);
  assert.equal(second.code, "save-in-progress");

  assert.equal(harness.deferred.length, 1);
  harness.deferred[0]();
  const firstResponse = await first;
  assert.equal(firstResponse.result, "saved");
  assert.equal(harness.saveRequests().length, 1);
});

test("a missing or non-quote Outbox entry is not sent", async () => {
  const requestId = "00000000-0000-4000-8000-000000000015";
  for (const pendingItem of [null, { ...pendingQuote(requestId), kind: "capture" }]) {
    const harness = createHarness({ pendingItem, responses: writeModeResponses(requestId) });
    const response = await sendPendingQuote(harness, requestId);
    assert.equal(response.ok, false);
    assert.equal(response.code, "pending-quote-unavailable");
    assert.deepEqual(harness.requests, []);
  }
});

test("a page outside the exact capture request cannot trigger saving", async () => {
  const requestId = "00000000-0000-4000-8000-000000000009";
  const harness = createHarness({ pendingItem: pendingQuote(requestId), responses: writeModeResponses(requestId) });

  for (const sender of [
    { id: RUNTIME_ID, url: "https://example.com/" },
    { id: RUNTIME_ID, url: `chrome-extension://${RUNTIME_ID}/popup.html` },
    { id: RUNTIME_ID, url: `chrome-extension://${RUNTIME_ID}/capture.html?requestId=00000000-0000-4000-8000-000000000001` }
  ]) {
    const response = await sendPendingQuote(harness, requestId, sender);
    assert.equal(response.ok, false);
    assert.equal(response.code, "rejected");
  }
  assert.deepEqual(harness.requests, []);
  assert.equal(harness.deleted, false);
});

test("the retired test-only save message is no longer handled", async () => {
  const requestId = "00000000-0000-4000-8000-000000000016";
  const harness = createHarness({ pendingItem: pendingQuote(requestId), responses: writeModeResponses(requestId) });

  const response = await sendPendingQuote(harness, requestId, undefined, "collector:test-save-pending-quote");

  assert.equal(response.code, "rejected");
  assert.deepEqual(harness.requests, []);
  assert.equal(harness.deleted, false);
});
