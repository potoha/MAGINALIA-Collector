const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const hostClientSource = fs.readFileSync(path.join(__dirname, "..", "host-client.js"), "utf8");
const serviceWorkerSource = fs.readFileSync(path.join(__dirname, "..", "service-worker.js"), "utf8");
const PROTOCOL = "maginalia.collector.experimental.v1";
const HOST_NAME = "org.maginalia.smoke_test";
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

function createHarness({ profile = { hostName: HOST_NAME }, responses = {}, lastError = null, pendingItem = null, deleteError = false } = {}) {
  const listeners = {};
  const requests = [];
  let deleted = false;
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
      return pendingItem?.requestId === requestId ? pendingItem : null;
    },
    async deletePending(requestId) {
      if (deleteError) throw new Error("outbox cleanup failure");
      if (pendingItem?.requestId !== requestId) return { deleted: false };
      deleted = true;
      return { deleted: true };
    }
  };
  const context = vm.createContext({ chrome, URL, TextEncoder, setTimeout, clearTimeout, console, CollectorOutbox: { create: () => outbox } });
  vm.runInContext(hostClientSource, context);
  vm.runInContext(serviceWorkerSource, context);

  return { context, listeners, requests, get deleted() { return deleted; } };
}

function sendHostCheck(harness, sender = { id: RUNTIME_ID, url: `chrome-extension://${RUNTIME_ID}/popup.html` }) {
  return new Promise((resolve) => {
    const handled = harness.listeners.onMessage({ type: "collector:host-check" }, sender, resolve);
    if (handled !== true) {
      resolve({ ok: false, code: "rejected" });
    }
  });
}

function sendPendingQuote(harness, requestId, sender = { id: RUNTIME_ID, url: `chrome-extension://${RUNTIME_ID}/capture.html?requestId=${requestId}` }) {
  return new Promise((resolve) => {
    const handled = harness.listeners.onMessage({ type: "collector:test-save-pending-quote", requestId }, sender, resolve);
    if (handled !== true) resolve({ ok: false, code: "rejected" });
  });
}

function writeModeResponses(requestId, { firstState = "committed", duplicateState = "already-committed", failure = false } = {}) {
  const receipt = (state) => ({
    version: 1, state, requestId, shelfId: SHELF_ID,
    bookId: "book:01JBF5GD3RT8YCKM93Q5D9X0EX", annotationId: "ann:01JBF5GD3RT8YCKM93Q5D9X0EY",
    bookReused: false, annotationDigest: `sha256:${"a".repeat(64)}`,
    requestDigest: `sha256:${"b".repeat(64)}`, recordedAt: "2026-11-03T03:00:00.000Z"
  });
  return {
    health: { ...healthyResponse, operations: ["health", "configured_shelf", "save_web_quote"], writesEnabled: true },
    configured_shelf: { protocol: PROTOCOL, ok: true, shelf: { id: SHELF_ID, name: "私の本棚", type: "private", writesEnabled: true } },
    save_web_quote: (_message, count) => failure
      ? { protocol: PROTOCOL, ok: false, error: "save_failed" }
      : { protocol: PROTOCOL, ok: true, receipt: receipt(count <= 3 ? firstState : duplicateState) }
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

test("reports a missing host profile without contacting anything", async () => {
  const harness = createHarness({ profile: null, responses: {} });

  const response = await sendHostCheck(harness);

  assert.equal(response.ok, true);
  assert.equal(response.report.status, "unavailable");
  assert.equal(response.report.code, "host-not-configured");
  assert.deepEqual(harness.requests, []);
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

test("a valid persistent receipt and idempotent resend are required before clearing the Outbox", async () => {
  const requestId = "00000000-0000-4000-8000-000000000007";
  const harness = createHarness({
    pendingItem: {
      requestId,
      kind: "quote",
      payload: { quote: "Selected test quotation", pageUrl: "https://example.com/", title: "Sample Page", acquiredAt: "202611031200" }
    },
    responses: writeModeResponses(requestId)
  });

  const response = await sendPendingQuote(harness, requestId);

  assert.equal(response.ok, true);
  assert.equal(response.receipt.state, "committed");
  assert.equal(response.duplicateReceipt.state, "already-committed");
  assert.equal(response.queueCleared, true);
  assert.equal(harness.deleted, true);
  assert.equal(harness.requests.filter((request) => request.message.operation === "save_web_quote").length, 2);
  for (const request of harness.requests) {
    assert.equal(Object.hasOwn(request.message, "shelfRoot"), false);
    assert.equal(Object.hasOwn(request.message, "coordinationRoot"), false);
  }
});

test("Host failure keeps the browser Outbox item pending", async () => {
  const requestId = "00000000-0000-4000-8000-000000000008";
  const harness = createHarness({
    pendingItem: {
      requestId,
      kind: "quote",
      payload: { quote: "Selected test quotation", pageUrl: "https://example.com/", acquiredAt: "202611031200" }
    },
    responses: writeModeResponses(requestId, { failure: true })
  });

  const response = await sendPendingQuote(harness, requestId);

  assert.equal(response.ok, false);
  assert.equal(response.code, "host-save-failed");
  assert.equal(harness.deleted, false);
  assert.equal(harness.requests.some((request) => request.message.operation === "save_web_quote"), true);
});

test("a page outside the exact capture request cannot trigger test Host saving", async () => {
  const requestId = "00000000-0000-4000-8000-000000000009";
  const harness = createHarness({
    pendingItem: { requestId, kind: "quote", payload: { quote: "Selected test quotation", pageUrl: "https://example.com/", acquiredAt: "202611031200" } },
    responses: writeModeResponses(requestId)
  });
  const response = await sendPendingQuote(harness, requestId, { id: RUNTIME_ID, url: "https://example.com/" });

  assert.equal(response.ok, false);
  assert.deepEqual(harness.requests, []);
  assert.equal(harness.deleted, false);
});
