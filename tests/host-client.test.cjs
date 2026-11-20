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
  return {
    protocol: PROTOCOL,
    ok: true,
    experimental: true,
    operations: ["health", "configured_shelf"],
    writesEnabled: false,
    ...overrides
  };
}

function shelfResponse(shelfOverrides = {}, overrides = {}) {
  return {
    protocol: PROTOCOL,
    ok: true,
    shelf: {
      id: SHELF_ID,
      name: "Private Shelf",
      type: "private",
      writesEnabled: false,
      ...shelfOverrides
    },
    ...overrides
  };
}

// Mirrors chrome.runtime.sendNativeMessage: the callback receives the response and
// chrome.runtime.lastError is read separately inside the callback.
function createTransport(responder) {
  const requests = [];
  return {
    requests,
    sendNativeMessage(hostName, message, callback) {
      requests.push({ hostName, message });
      const outcome = responder(message, requests.length);
      if (outcome === undefined) {
        return;
      }
      callback(outcome);
    }
  };
}

function createClient(responder, { hostName = HOST_NAME, getLastError = () => null, timeoutMs } = {}) {
  const api = loadApi();
  const transport = createTransport(responder);
  const client = api.createHostClient({
    hostName,
    sendNativeMessage: transport.sendNativeMessage,
    getLastError,
    timeoutMs
  });
  return { api, client, transport };
}

function rejectsWithCode(promise, code) {
  return assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

test("exposes the experimental protocol without claiming it is a product contract", () => {
  const api = loadApi();

  assert.equal(api.protocol, PROTOCOL);
  assert.deepEqual(Array.from(api.operations), ["health", "configured_shelf", "save_web_quote"]);
  assert.equal(api.hostProfileKey, "collector.host-profile");
  assert.equal(source.includes("nativeMessaging"), false);
});

test("sends exactly the two fields the experimental helper accepts", async () => {
  const { client, transport } = createClient(() => healthResponse());

  await client.health();

  assert.equal(transport.requests.length, 1);
  assert.equal(transport.requests[0].hostName, HOST_NAME);
  assert.deepEqual(Object.keys(transport.requests[0].message), ["protocol", "operation"]);
  assert.equal(transport.requests[0].message.protocol, PROTOCOL);
  assert.equal(transport.requests[0].message.operation, "health");
});

test("normalizes a valid health response and keeps it immutable", async () => {
  const { client } = createClient(() => healthResponse());

  const result = await client.health();

  assert.equal(result.protocol, PROTOCOL);
  assert.deepEqual(Array.from(result.operations), ["health", "configured_shelf"]);
  assert.equal(result.writesEnabled, false);
  assert.equal(Object.isFrozen(result), true);
});

test("rejects health responses that are not shaped like the experimental contract", async () => {
  const cases = [
    { reason: "unknown field", response: healthResponse({ extra: true }) },
    { reason: "missing writesEnabled", response: { protocol: PROTOCOL, ok: true, experimental: true, operations: ["health"] } },
    { reason: "not experimental", response: healthResponse({ experimental: false }) },
    { reason: "protocol mismatch", response: healthResponse({ protocol: "maginalia.collector.v9" }) },
    { reason: "duplicate operations", response: healthResponse({ operations: ["health", "health"] }) },
    { reason: "bad operation name", response: healthResponse({ operations: ["Health"] }) },
    { reason: "empty operations", response: healthResponse({ operations: [] }) },
    { reason: "writesEnabled not boolean", response: healthResponse({ writesEnabled: "false" }) }
  ];

  for (const { reason, response } of cases) {
    const { client } = createClient(() => response);
    await rejectsWithCode(client.health(), "invalid-response");
    assert.ok(reason);
  }
});

test("reads the configured Shelf as an opaque identity without any filesystem path", async () => {
  const { client, transport } = createClient(() => shelfResponse());

  const shelf = await client.configuredShelf();

  assert.equal(transport.requests[0].message.operation, "configured_shelf");
  assert.deepEqual({ ...shelf }, { id: SHELF_ID, name: "Private Shelf", type: "private", writesEnabled: false });
  assert.equal(JSON.stringify(shelf).includes(":\\"), false);
});

test("refuses a Shelf payload that leaks a path-shaped identity", async () => {
  for (const shelfOverrides of [{ name: "C:\\Users\\someone\\Shelf" }, { id: "\\\\server\\share" }, { name: "/home/user/shelf" }]) {
    const { client } = createClient(() => shelfResponse(shelfOverrides));
    await rejectsWithCode(client.configuredShelf(), "invalid-response");
  }
});

test("refuses a Shelf payload with extra fields or a non-UUID identifier", async () => {
  const cases = [
    shelfResponse({ path: "C:\\shelf" }),
    shelfResponse({ id: "not-a-uuid" }),
    shelfResponse({ name: "" }),
    shelfResponse({ type: "PROJECT" })
  ];

  for (const response of cases) {
    const { client } = createClient(() => response);
    await rejectsWithCode(client.configuredShelf(), "invalid-response");
  }
});

test("translates host error codes into distinct client failures", async () => {
  const cases = [
    ["shelf_identity_mismatch", "shelf-identity-mismatch"],
    ["shelf_unconfigured", "shelf-not-configured"],
    ["shelf_identity_unavailable", "shelf-identity-unavailable"],
    ["shelf_unavailable", "shelf-unavailable"],
    ["shelf_write_busy", "shelf-write-busy"],
    ["save_failed", "host-save-failed"],
    ["configuration_unavailable", "shelf-configuration-unavailable"],
    ["host_configuration_or_origin_invalid", "host-configuration-invalid"],
    ["unsupported_operation", "unsupported-operation"],
    ["invalid_request", "host-rejected-request"],
    ["invalid_json", "host-protocol-error"],
    ["truncated_frame", "host-protocol-error"],
    ["response_too_large", "host-response-too-large"]
  ];

  for (const [hostError, expectedCode] of cases) {
    const { client } = createClient(() => ({ protocol: PROTOCOL, ok: false, error: hostError }));
    await rejectsWithCode(client.health(), expectedCode);
  }
});

test("keeps an unrecognized host error code visible instead of inventing success", async () => {
  const { client } = createClient(() => ({ protocol: PROTOCOL, ok: false, error: "future_failure" }));

  await assert.rejects(client.health(), (error) => {
    assert.equal(error.code, "host-error");
    assert.equal(error.hostError, "future_failure");
    return true;
  });
});

test("rejects a malformed error envelope", async () => {
  for (const response of [
    { protocol: PROTOCOL, ok: false },
    { protocol: PROTOCOL, ok: false, error: "Bad Code" },
    { protocol: PROTOCOL, ok: false, error: "shelf_unavailable", extra: 1 },
    { protocol: PROTOCOL, ok: "true" }
  ]) {
    const { client } = createClient(() => response);
    await rejectsWithCode(client.health(), "invalid-response");
  }
});

test("separates a missing registration from a rejected caller and a transient failure", async () => {
  const cases = [
    ["Specified native messaging host not found.", "host-not-registered"],
    ["Access to the specified native messaging host is forbidden.", "host-access-forbidden"],
    ["Native host has exited.", "host-exited"],
    ["Error when communicating with the native messaging host.", "host-communication-failed"],
    ["Something else broke.", "host-unreachable"]
  ];

  for (const [message, expectedCode] of cases) {
    const { client } = createClient(() => null, { getLastError: () => ({ message }) });
    await assert.rejects(client.health(), (error) => {
      assert.equal(error.code, expectedCode);
      return true;
    });
  }
});

test("reports a missing native messaging API without throwing", async () => {
  const api = loadApi();
  const client = api.createHostClient({ hostName: HOST_NAME, sendNativeMessage: null });

  await rejectsWithCode(client.health(), "native-messaging-unavailable");

  const throwing = api.createHostClient({
    hostName: HOST_NAME,
    sendNativeMessage: () => {
      throw new TypeError("sendNativeMessage is not a function");
    }
  });
  await rejectsWithCode(throwing.health(), "native-messaging-unavailable");
});

test("does not call the helper at all when no host profile is configured", async () => {
  const { client, transport } = createClient(() => healthResponse(), { hostName: "" });

  await rejectsWithCode(client.health(), "host-not-configured");
  assert.equal(transport.requests.length, 0);

  const report = await client.checkCompatibility();
  assert.equal(report.status, "unavailable");
  assert.equal(report.code, "host-not-configured");
  assert.equal(report.host, null);
});

test("distinguishes an empty response from a successful one", async () => {
  const { client } = createClient(() => null);
  await rejectsWithCode(client.health(), "host-no-response");
});

test("bounds the accepted response size", async () => {
  const { client } = createClient(() => healthResponse({ padding: "x".repeat(70 * 1024) }));
  await rejectsWithCode(client.health(), "host-response-too-large");
});

test("times out a silent helper and ignores the late response", async () => {
  const api = loadApi();
  let lateCallback = null;
  const client = api.createHostClient({
    hostName: HOST_NAME,
    timeoutMs: 10,
    sendNativeMessage: (hostName, message, callback) => {
      lateCallback = callback;
    }
  });

  await rejectsWithCode(client.health(), "host-timeout");
  assert.equal(typeof lateCallback, "function");
  assert.doesNotThrow(() => lateCallback(healthResponse()));
});

test("reports compatibility only after health and the configured Shelf both validate", async () => {
  const { client, transport } = createClient((message) =>
    message.operation === "health" ? healthResponse() : shelfResponse()
  );

  const report = await client.checkCompatibility();

  assert.equal(report.status, "compatible");
  assert.equal(report.experimental, true);
  assert.equal(report.code, undefined);
  assert.equal(report.host.protocol, PROTOCOL);
  assert.equal(report.shelf.name, "Private Shelf");
  assert.deepEqual(Array.from(report.checks, (check) => [check.id, check.status]), [
    ["host-configured", "pass"],
    ["health", "pass"],
    ["protocol", "pass"],
    ["configured-shelf-operation", "pass"],
    ["configured-shelf", "pass"],
    ["shelf-identity", "pass"]
  ]);
  assert.deepEqual(Array.from(transport.requests, (request) => request.message.operation), ["health", "configured_shelf"]);
});

test("keeps quote saving disabled when the Host reports its normal read-only mode", async () => {
  const { client, transport } = createClient((message) =>
    message.operation === "health" ? healthResponse() : shelfResponse()
  );

  await rejectsWithCode(client.saveQuote({
    requestId: "00000000-0000-4000-8000-000000000004",
    quote: "Selected test quotation",
    url: "https://example.com/",
    getDate: "202611031200"
  }), "host-save-disabled");
  assert.deepEqual(Array.from(transport.requests, (item) => item.message.operation), ["health"]);
});

test("accepts only a persistent receipt bound to the request and configured Shelf", async () => {
  const requestId = "00000000-0000-4000-8000-000000000005";
  const receipt = {
    version: 1,
    state: "committed",
    requestId,
    shelfId: SHELF_ID,
    bookId: "book:01JBF5GD3RT8YCKM93Q5D9X0EX",
    annotationId: "ann:01JBF5GD3RT8YCKM93Q5D9X0EY",
    bookReused: false,
    annotationDigest: `sha256:${"a".repeat(64)}`,
    requestDigest: `sha256:${"b".repeat(64)}`,
    recordedAt: "2026-11-03T03:00:00.000Z"
  };
  const { client, transport } = createClient((message) => {
    if (message.operation === "health") return healthResponse({ operations: ["health", "configured_shelf", "save_web_quote"], writesEnabled: true });
    if (message.operation === "configured_shelf") return shelfResponse({ writesEnabled: true });
    return { protocol: PROTOCOL, ok: true, receipt };
  });

  const result = await client.saveQuote({ requestId, quote: "Selected test quotation", url: "https://example.com/", getDate: "202611031200" });

  assert.equal(result.receipt.state, "committed");
  assert.equal(result.receipt.requestId, requestId);
  assert.equal(result.shelf.id, SHELF_ID);
  assert.deepEqual(Array.from(transport.requests, (item) => item.message.operation), ["health", "configured_shelf", "save_web_quote"]);
  const save = transport.requests.at(-1).message;
  assert.equal(save.quote, "Selected test quotation");
  assert.equal(save.url, "https://example.com/");
  assert.equal(Object.hasOwn(save, "shelfRoot"), false);
  assert.equal(Object.hasOwn(save, "coordinationRoot"), false);
});

test("retains pending data on malformed or mismatched Host receipts", async () => {
  const requestId = "00000000-0000-4000-8000-000000000006";
  const baseReceipt = {
    version: 1, state: "committed", requestId, shelfId: SHELF_ID,
    bookId: "book:01JBF5GD3RT8YCKM93Q5D9X0EX", annotationId: "ann:01JBF5GD3RT8YCKM93Q5D9X0EY",
    bookReused: false, annotationDigest: `sha256:${"a".repeat(64)}`,
    requestDigest: `sha256:${"b".repeat(64)}`, recordedAt: "2026-11-03T03:00:00.000Z"
  };
  const responses = [
    { ...baseReceipt, requestId: "00000000-0000-4000-8000-000000000099" },
    { ...baseReceipt, shelfId: "750e8400-e29b-41d4-a716-446655440000" },
    { ...baseReceipt, annotationId: "not-an-annotation" }
  ];
  for (const receipt of responses) {
    const { client } = createClient((message) => {
      if (message.operation === "health") return healthResponse({ operations: ["health", "configured_shelf", "save_web_quote"], writesEnabled: true });
      if (message.operation === "configured_shelf") return shelfResponse({ writesEnabled: true });
      return { protocol: PROTOCOL, ok: true, receipt };
    });
    await rejectsWithCode(client.saveQuote({ requestId, quote: "Selected test quotation", url: "https://example.com/", getDate: "202611031200" }), "invalid-response");
  }
});

test("marks a helper without the configured Shelf operation as incompatible", async () => {
  const { client } = createClient(() => healthResponse({ operations: ["health"] }));

  const report = await client.checkCompatibility();

  assert.equal(report.status, "incompatible");
  assert.equal(report.code, "unsupported-operation");
  assert.equal(report.shelf, null);
  assert.equal(report.checks.at(-1).id, "configured-shelf-operation");
  assert.equal(report.checks.at(-1).status, "fail");
});

test("surfaces a configured Shelf identity mismatch as a distinct failed check", async () => {
  const { client } = createClient((message) =>
    message.operation === "health"
      ? healthResponse()
      : { protocol: PROTOCOL, ok: false, error: "shelf_identity_mismatch" }
  );

  const report = await client.checkCompatibility();

  assert.equal(report.status, "incompatible");
  assert.equal(report.code, "shelf-identity-mismatch");
  assert.equal(report.host.writesEnabled, false);
  assert.equal(report.shelf, null);
  assert.deepEqual({ ...report.checks.at(-1) }, { id: "configured-shelf", status: "fail", code: "shelf-identity-mismatch" });
});

test("reports an unregistered helper as unavailable rather than incompatible", async () => {
  const { client } = createClient(() => null, {
    getLastError: () => ({ message: "Specified native messaging host not found." })
  });

  const report = await client.checkCompatibility();

  assert.equal(report.status, "unavailable");
  assert.equal(report.code, "host-not-registered");
  assert.equal(report.shelf, null);
});

test("loads only a bare host name from machine-local storage", async () => {
  const api = loadApi();
  const storage = {
    async get(key) {
      assert.equal(key, "collector.host-profile");
      return { "collector.host-profile": { hostName: HOST_NAME } };
    }
  };

  assert.deepEqual({ ...(await api.loadHostProfile(storage)) }, { hostName: HOST_NAME });
  assert.equal(await api.loadHostProfile(null), null);
  assert.equal(await api.loadHostProfile({}), null);
  assert.equal(await api.loadHostProfile({ async get() { throw new Error("denied"); } }), null);
});

test("uses the fixed product Host name unless a valid development override is stored", async () => {
  const api = loadApi();
  assert.equal(api.defaultHostName, "org.maginalia.collector");
  assert.equal(await api.resolveHostName(null), "org.maginalia.collector");
  assert.equal(await api.resolveHostName({ async get() { return {}; } }), "org.maginalia.collector");
  assert.equal(await api.resolveHostName({ async get() { throw new Error("denied"); } }), "org.maginalia.collector");
  assert.equal(
    await api.resolveHostName({ async get() { return { "collector.host-profile": { hostName: "bad name" } }; } }),
    "org.maginalia.collector"
  );
  assert.equal(
    await api.resolveHostName({ async get() { return { "collector.host-profile": { hostName: HOST_NAME } }; } }),
    HOST_NAME
  );
});

test("gives a save request a longer bounded timeout than read-only checks", async () => {
  const api = loadApi();
  assert.equal(api.defaultTimeoutMs, 10000);
  assert.equal(api.defaultSaveTimeoutMs, 30000);
  const requestId = "00000000-0000-4000-8000-000000000006";
  const client = api.createHostClient({
    hostName: HOST_NAME,
    timeoutMs: 1000,
    saveTimeoutMs: 15,
    sendNativeMessage: (_name, message, callback) => {
      if (message.operation === "health") {
        callback(healthResponse({ operations: ["health", "configured_shelf", "save_web_quote"], writesEnabled: true }));
      } else if (message.operation === "configured_shelf") {
        callback(shelfResponse({ writesEnabled: true }));
      }
      // save_web_quote never answers: the client must time out, not report success.
    }
  });
  await rejectsWithCode(client.saveQuote({
    requestId,
    quote: "Selected test quotation",
    url: "https://example.com/",
    getDate: "202611031200"
  }), "host-timeout");
});

test("ignores a host profile that carries extra fields or an invalid name", async () => {
  const api = loadApi();
  const cases = [
    { "collector.host-profile": { hostName: HOST_NAME, allowedOrigin: "chrome-extension://abc/" } },
    { "collector.host-profile": { hostName: "" } },
    { "collector.host-profile": { hostName: "bad name" } },
    { "collector.host-profile": { hostName: "C:\\host.exe" } },
    { "collector.host-profile": "org.maginalia.smoke_test" },
    {}
  ];

  for (const record of cases) {
    const storage = { async get() { return record; } };
    assert.equal(await api.loadHostProfile(storage), null);
  }
});

test("contains no write, network, outbox or storage-mutation path", () => {
  assert.doesNotMatch(source, /fetch\s*\(|XMLHttpRequest|WebSocket/);
  assert.doesNotMatch(source, /storage\.(local|session|sync)\.set|indexedDB|CollectorOutbox/);
  assert.doesNotMatch(source, /saveWebQuote|send_quote|writeFile|fs\./);
});
