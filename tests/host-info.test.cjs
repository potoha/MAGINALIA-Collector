const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "host-client.js"), "utf8");
const PROTOCOL = "maginalia.collector.experimental.v1";
const HOST_NAME = "org.maginalia.smoke_test";
const SHELF_ID = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

function loadApi() {
  const context = { TextEncoder, URL, setTimeout, clearTimeout, console };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.CollectorHostClient;
}

function healthResponse(overrides = {}) {
  return { protocol: PROTOCOL, ok: true, experimental: true, operations: ["health", "configured_shelf"], writesEnabled: false, ...overrides };
}

function shelfResponse(shelfOverrides = {}) {
  return { protocol: PROTOCOL, ok: true, shelf: { id: SHELF_ID, name: "Private Shelf", type: "private", writesEnabled: false, ...shelfOverrides } };
}

function hostInfoResponse(host = {}, overrides = {}) {
  return { protocol: PROTOCOL, ok: true, host: { version: "0.2.0", minimumExtensionVersion: "0.2.0", ...host }, ...overrides };
}

function createClient(responder, { extensionVersion } = {}) {
  const api = loadApi();
  const requests = [];
  const client = api.createHostClient({
    hostName: HOST_NAME,
    extensionVersion,
    getLastError: () => null,
    sendNativeMessage(hostName, message, callback) {
      requests.push(message);
      callback(responder(message));
    }
  });
  return { api, client, requests };
}

function infoResponder(infoResponse, operations = ["health", "configured_shelf", "host_info"]) {
  return (message) => {
    if (message.operation === "health") return healthResponse({ operations });
    if (message.operation === "host_info") return infoResponse;
    return shelfResponse();
  };
}

function rejectsWithCode(promise, code) {
  return assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

test("host_info sends exactly the protocol, operation and own extension version", async () => {
  const { client, requests } = createClient(infoResponder(hostInfoResponse()), { extensionVersion: "0.3.0" });

  const info = await client.hostInfo();

  assert.deepEqual({ ...info }, { version: "0.2.0", minimumExtensionVersion: "0.2.0" });
  assert.deepEqual(requests.map((message) => ({ ...message })), [
    { protocol: PROTOCOL, operation: "host_info", extensionVersion: "0.3.0" }
  ]);
});

test("host_info validates the response strictly", async () => {
  const bad = [
    hostInfoResponse({ extra: 1 }),
    hostInfoResponse({ version: "latest" }),
    hostInfoResponse({ minimumExtensionVersion: 2 }),
    hostInfoResponse({ version: "1.2.3.4" }),
    hostInfoResponse({}, { extra: true }),
    { protocol: PROTOCOL, ok: true },
    { protocol: PROTOCOL, ok: true, host: [] },
    hostInfoResponse({}, { padding: "x".repeat(70 * 1024) })
  ];
  for (const response of bad) {
    const { client } = createClient(() => response, { extensionVersion: "0.3.0" });
    await assert.rejects(client.hostInfo(), (error) => ["invalid-response", "host-response-too-large"].includes(error.code));
  }
});

test("host_info maps a Host error and a protocol mismatch", async () => {
  const refused = createClient(() => ({ protocol: PROTOCOL, ok: false, error: "unsupported_operation" }), { extensionVersion: "0.3.0" });
  await rejectsWithCode(refused.client.hostInfo(), "unsupported-operation");

  const other = createClient(() => hostInfoResponse({}, { protocol: "maginalia.collector.experimental.v2" }), { extensionVersion: "0.3.0" });
  await rejectsWithCode(other.client.hostInfo(), "host-update-required");
});

test("host_info is not sent without a valid own extension version", async () => {
  for (const extensionVersion of [undefined, "", "v0.3", "0.3.0\n", 3]) {
    const { client, requests } = createClient(infoResponder(hostInfoResponse()), { extensionVersion });
    await rejectsWithCode(client.hostInfo(), "invalid-request");
    assert.equal(requests.length, 0);
  }
});

test("the connection check calls host_info after health when the Host lists it", async () => {
  const { client, requests } = createClient(infoResponder(hostInfoResponse()), { extensionVersion: "0.3.0" });

  const report = await client.checkCompatibility();

  assert.equal(report.status, "compatible");
  assert.deepEqual(requests.map((message) => message.operation), ["health", "host_info", "configured_shelf"]);
  assert.deepEqual(JSON.parse(JSON.stringify(report.checks.map((check) => [check.id, check.status]))), [
    ["host-configured", "pass"], ["health", "pass"], ["protocol", "pass"], ["host-info", "pass"],
    ["configured-shelf-operation", "pass"], ["configured-shelf", "pass"], ["shelf-identity", "pass"]
  ]);
});

test("the connection check skips host_info silently when an older Host does not list it", async () => {
  const { client, requests } = createClient(infoResponder(hostInfoResponse(), ["health", "configured_shelf"]), { extensionVersion: "0.3.0" });

  const report = await client.checkCompatibility();

  assert.equal(report.status, "compatible");
  assert.deepEqual(requests.map((message) => message.operation), ["health", "configured_shelf"]);
  assert.equal(report.checks.some((check) => check.id === "host-info"), false);
});

test("the connection check without a valid own version keeps the old behaviour", async () => {
  const { client, requests } = createClient(infoResponder(hostInfoResponse()));
  assert.equal((await client.checkCompatibility()).status, "compatible");
  assert.deepEqual(requests.map((message) => message.operation), ["health", "configured_shelf"]);
});

test("an extension older than the Host minimum is reported as extension-update-required", async () => {
  const { client, requests } = createClient(infoResponder(hostInfoResponse({ minimumExtensionVersion: "0.4.0" })), { extensionVersion: "0.3.0" });

  const report = await client.checkCompatibility();

  assert.equal(report.status, "incompatible");
  assert.equal(report.code, "extension-update-required");
  assert.equal(report.shelf, null);
  assert.deepEqual({ ...report.checks.at(-1) }, { id: "host-info", status: "fail", code: "extension-update-required" });
  assert.deepEqual(requests.map((message) => message.operation), ["health", "host_info"]);
});

test("a Host older than this extension expects, or a host_info protocol mismatch, is host-update-required", async () => {
  assert.equal(loadApi().minimumHostVersion, "0.1.0");
  const older = createClient(infoResponder(hostInfoResponse({ version: "0.0.9" })), { extensionVersion: "0.3.0" });
  const olderReport = await older.client.checkCompatibility();
  assert.equal(olderReport.status, "incompatible");
  assert.equal(olderReport.code, "host-update-required");

  const mismatch = createClient(infoResponder(hostInfoResponse({}, { protocol: "maginalia.collector.experimental.v2" })), { extensionVersion: "0.3.0" });
  const mismatchReport = await mismatch.client.checkCompatibility();
  assert.equal(mismatchReport.status, "incompatible");
  assert.equal(mismatchReport.code, "host-update-required");
});

test("the extension check wins when both versions are outdated", async () => {
  const { client } = createClient(infoResponder(hostInfoResponse({ version: "0.0.9", minimumExtensionVersion: "9.0.0" })), { extensionVersion: "0.3.0" });
  assert.equal((await client.checkCompatibility()).code, "extension-update-required");
});

test("an equal or newer extension and a newer Host remain compatible", async () => {
  for (const [ext, info] of [["0.2.0", { minimumExtensionVersion: "0.2.0" }], ["1.0.0", { minimumExtensionVersion: "0.9.9", version: "3.0.0" }]]) {
    const { client } = createClient(infoResponder(hostInfoResponse(info)), { extensionVersion: ext });
    assert.equal((await client.checkCompatibility()).status, "compatible");
  }
});

test("a malformed host_info answer makes the check incompatible, not compatible", async () => {
  const { client } = createClient(infoResponder(hostInfoResponse({ extra: 1 })), { extensionVersion: "0.3.0" });
  const report = await client.checkCompatibility();
  assert.equal(report.status, "incompatible");
  assert.equal(report.code, "invalid-response");
  assert.equal(report.checks.at(-1).id, "host-info");
});

test("version comparison orders numbers numerically and pre-releases first", () => {
  const { compareVersions, isVersionString } = loadApi();
  assert.equal(compareVersions("0.10.0", "0.9.0"), 1);
  assert.equal(compareVersions("0.3.0", "0.3.0"), 0);
  assert.equal(compareVersions("0.3.0-rc.1", "0.3.0"), -1);
  assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
  assert.equal(isVersionString("0.3.0"), true);
  assert.equal(isVersionString("0.3"), false);
  assert.equal(isVersionString("0.3.0+build"), false);
});

test("saveQuote never calls host_info", async () => {
  const requestId = "00000000-0000-4000-8000-000000000009";
  const { client, requests } = createClient((message) => {
    if (message.operation === "health") return healthResponse({ operations: ["health", "configured_shelf", "save_web_quote", "host_info"], writesEnabled: true });
    if (message.operation === "configured_shelf") return shelfResponse({ writesEnabled: true });
    return { protocol: PROTOCOL, ok: false, error: "save_failed" };
  }, { extensionVersion: "0.3.0" });
  await assert.rejects(client.saveQuote({ requestId, quote: "q", url: "https://example.com/", getDate: "202611130900" }));
  assert.equal(requests.some((message) => message.operation === "host_info"), false);
});
