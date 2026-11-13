// Storage backward-readability rule (see docs/storage-compatibility.md): the
// IndexedDB Outbox and the chrome.storage keys written by an older Collector
// version must stay readable by every later version, with no format change. These
// fixtures are frozen literals shaped like what 0.2.0 wrote. Do not regenerate
// them from the current code.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { FakeIndexedDB } = require("./helpers/fake-indexeddb.cjs");

const ROOT = path.join(__dirname, "..");
const outboxSource = fs.readFileSync(path.join(ROOT, "outbox.js"), "utf8");
const hostClientSource = fs.readFileSync(path.join(ROOT, "host-client.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
vm.runInThisContext(outboxSource);

const QUOTE_ID = "11111111-2222-4333-8444-555555555555";
const CAPTURE_ID = "66666666-7777-4888-8999-aaaaaaaaaaaa";

// 0.2.0-shaped entries/summaries (IndexedDB "maginalia-collector-outbox", version 1).
const QUOTE_RECORD = {
  requestId: QUOTE_ID,
  createdAt: 1763000000000,
  kind: "quote",
  payload: { quote: "Selected test quotation", pageUrl: "https://example.com/a", title: "Sample Page", acquiredAt: "202611130900" },
  bytes: 300,
  localStatus: "pending",
  recipient: "private-shelf",
  recipientStatus: "not-sent"
};
const QUOTE_SUMMARY = {
  requestId: QUOTE_ID,
  createdAt: 1763000000000,
  kind: "quote",
  title: "Sample Page",
  pageUrl: "https://example.com/a",
  bytes: 300,
  localStatus: "pending",
  recipient: "private-shelf",
  recipientStatus: "not-sent"
};
const CAPTURE_RECORD = {
  requestId: CAPTURE_ID,
  createdAt: 1763000100000,
  kind: "capture",
  payload: { note: "capture placeholder" },
  bytes: 100,
  localStatus: "pending",
  recipient: "reviewer",
  recipientStatus: "not-sent"
};
const CAPTURE_SUMMARY = {
  requestId: CAPTURE_ID,
  createdAt: 1763000100000,
  kind: "capture",
  title: "",
  pageUrl: "",
  bytes: 100,
  localStatus: "pending",
  recipient: "reviewer",
  recipientStatus: "not-sent"
};

// Creates the stores through the current code, then writes the frozen 0.2.0 rows
// straight into them, as a profile that already held a 0.2.0 Outbox would.
async function seedOldOutbox() {
  const indexedDB = new FakeIndexedDB();
  const outbox = globalThis.CollectorOutbox.create({ indexedDB });
  await outbox.listPending();
  const stores = indexedDB.database.stores;
  stores.get("entries").values.set(QUOTE_ID, structuredClone(QUOTE_RECORD));
  stores.get("entries").values.set(CAPTURE_ID, structuredClone(CAPTURE_RECORD));
  stores.get("summaries").values.set(QUOTE_ID, structuredClone(QUOTE_SUMMARY));
  stores.get("summaries").values.set(CAPTURE_ID, structuredClone(CAPTURE_SUMMARY));
  stores.get("metadata").values.set("usage", { key: "usage", itemCount: 2, totalBytes: 400 });
  return indexedDB;
}

test("the Outbox database name, version, stores and keys are the 0.2.0 ones", () => {
  assert.match(outboxSource, /DATABASE_NAME = "maginalia-collector-outbox"/);
  assert.match(outboxSource, /DATABASE_VERSION = 1;/);
  assert.match(outboxSource, /ENTRY_STORE = "entries"/);
  assert.match(outboxSource, /SUMMARY_STORE = "summaries"/);
  assert.match(outboxSource, /METADATA_STORE = "metadata"/);
  assert.match(outboxSource, /USAGE_KEY = "usage"/);
  assert.match(outboxSource, /createObjectStore\(ENTRY_STORE, \{ keyPath: "requestId" \}\)/);
  assert.match(outboxSource, /createObjectStore\(METADATA_STORE, \{ keyPath: "key" \}\)/);
});

test("a 0.2.0 Outbox is listed, read and deleted by the current version", async () => {
  assert.equal(manifest.version, "0.3.0");
  const indexedDB = await seedOldOutbox();
  const outbox = globalThis.CollectorOutbox.create({ indexedDB });

  const queue = await outbox.listPending();
  assert.equal(queue.itemCount, 2);
  assert.equal(queue.totalBytes, 400);
  assert.deepEqual(queue.items.map((item) => item.requestId).sort(), [QUOTE_ID, CAPTURE_ID].sort());
  const quoteItem = queue.items.find((item) => item.requestId === QUOTE_ID);
  assert.equal(quoteItem.kind, "quote");
  assert.equal(quoteItem.title, "Sample Page");
  assert.equal(quoteItem.recipientStatus, "not-sent");

  const record = await outbox.getPending(QUOTE_ID);
  assert.equal(record.payload.quote, "Selected test quotation");
  assert.equal(record.payload.acquiredAt, "202611130900");

  // The same request ID is still recognised, so a resend stays idempotent.
  const again = await outbox.addPending({ requestId: QUOTE_ID, kind: "quote", payload: { quote: "different" } });
  assert.equal(again.alreadyQueued, true);

  assert.deepEqual({ ...(await outbox.deletePending(QUOTE_ID)) }, { deleted: true });
  const after = await outbox.listPending();
  assert.equal(after.itemCount, 1);
  assert.equal(after.totalBytes, 100);
});

test("the current version still adds to a 0.2.0 Outbox without rewriting old rows", async () => {
  const indexedDB = await seedOldOutbox();
  const outbox = globalThis.CollectorOutbox.create({ indexedDB });
  await outbox.addPending({ requestId: "99999999-aaaa-4bbb-8ccc-dddddddddddd", kind: "quote", payload: { quote: "new" } });

  assert.deepEqual(indexedDB.database.stores.get("entries").values.get(QUOTE_ID), QUOTE_RECORD);
  assert.deepEqual(indexedDB.database.stores.get("summaries").values.get(QUOTE_ID), QUOTE_SUMMARY);
  assert.equal((await outbox.listPending()).itemCount, 3);
});

test("the 0.2.0 chrome.storage.local Host profile key is still read, and only that shape", async () => {
  const context = vm.createContext({ TextEncoder, URL, setTimeout, clearTimeout, console });
  vm.runInContext(hostClientSource, context);
  const api = context.CollectorHostClient;
  assert.equal(api.hostProfileKey, "collector.host-profile");

  const stored = { "collector.host-profile": { hostName: "org.maginalia.smoke_test" } };
  const storage = { async get(key) { return { [key]: stored[key] }; } };
  assert.equal((await api.loadHostProfile(storage)).hostName, "org.maginalia.smoke_test");
  assert.equal(await api.resolveHostName(storage), "org.maginalia.smoke_test");

  const empty = { async get() { return {}; } };
  assert.equal(await api.resolveHostName(empty), "org.maginalia.collector");
});

test("the manifest keeps the fixed key, permissions and the 0.3.0 version", () => {
  assert.equal(manifest.version, "0.3.0");
  assert.deepEqual([...manifest.permissions].sort(), ["activeTab", "contextMenus", "nativeMessaging", "scripting", "storage"]);
  assert.equal(typeof manifest.key, "string");
});
