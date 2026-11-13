const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "outbox.js"), "utf8");
vm.runInThisContext(source);
const { FakeIndexedDB } = require("./helpers/fake-indexeddb.cjs");

const firstRequestId = "00000000-0000-4000-8000-000000000001";
const secondRequestId = "00000000-0000-4000-8000-000000000002";

function createOutbox(indexedDB = new FakeIndexedDB(), limits = {}) {
  return {
    indexedDB,
    outbox: globalThis.CollectorOutbox.create({ indexedDB, ...limits })
  };
}

function pending(requestId, quote, kind = "quote") {
  return {
    requestId,
    kind,
    payload: { quote },
    title: "Example page",
    pageUrl: "https://example.com/article"
  };
}

test("uses the approved queue size limits", () => {
  assert.equal(globalThis.CollectorOutbox.maxItemBytes, 16 * 1024 * 1024);
  assert.equal(globalThis.CollectorOutbox.maxTotalBytes, 128 * 1024 * 1024);
});

test("stores pending records locally with a stable request ID and separate recipient state", async () => {
  const { outbox, indexedDB } = createOutbox();
  const result = await outbox.addPending(pending(firstRequestId, "sample quote"));
  const duplicate = await outbox.addPending(pending(firstRequestId, "sample quote"));
  const retrieved = await outbox.getPending(firstRequestId);
  const restartedOutbox = globalThis.CollectorOutbox.create({ indexedDB });
  const afterRestart = await restartedOutbox.getPending(firstRequestId);
  const queue = await outbox.listPending();

  assert.equal(result.record.requestId, firstRequestId);
  assert.equal(result.record.localStatus, "pending");
  assert.equal(result.record.recipient, "private-shelf");
  assert.equal(result.record.recipientStatus, "not-sent");
  assert.equal(duplicate.alreadyQueued, true);
  assert.equal(duplicate.record.requestId, firstRequestId);
  assert.equal(retrieved.payload.quote, "sample quote");
  assert.equal(afterRestart.payload.quote, "sample quote");
  assert.equal(queue.itemCount, 1);
  assert.equal(queue.items[0].shelfStatus, undefined);
  assert.equal(queue.items[0].recipientStatus, "not-sent");
});

test("stores image blobs as pending Reviewer items without claiming they were sent", async () => {
  const { outbox } = createOutbox();
  const image = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/jpeg" });
  const result = await outbox.addPending({
    ...pending(firstRequestId, "", "capture"),
    payload: { image }
  });
  const queue = await outbox.listPending();

  assert.equal(result.record.kind, "capture");
  assert.equal(result.record.payload.image.size, 4);
  assert.equal(result.record.recipient, "reviewer");
  assert.equal(result.record.recipientStatus, "not-sent");
  assert.equal(queue.items[0].kind, "capture");
});

test("rejects an item above the configured per-record size limit", async () => {
  const { outbox, indexedDB } = createOutbox(undefined, { maxItemBytes: 100 });

  await assert.rejects(
    outbox.addPending(pending(firstRequestId, "x".repeat(200))),
    (error) => error.code === "item-too-large"
  );
  assert.equal(indexedDB.database, null);
});

test("enforces the aggregate limit and a confirmed deletion frees only that item", async () => {
  const { outbox: initialOutbox, indexedDB } = createOutbox(undefined, { maxTotalBytes: 10000 });
  await initialOutbox.addPending(pending(firstRequestId, "same sized quote"));
  const initialQueue = await initialOutbox.listPending();
  const constrainedOutbox = globalThis.CollectorOutbox.create({
    indexedDB,
    maxTotalBytes: initialQueue.totalBytes + 1
  });

  await assert.rejects(
    constrainedOutbox.addPending(pending(secondRequestId, "same sized quote")),
    (error) => error.code === "queue-full"
  );

  const deletion = await constrainedOutbox.deletePending(firstRequestId);
  assert.equal(deletion.deleted, true);
  assert.equal(await constrainedOutbox.getPending(firstRequestId), null);
  const addedAfterDelete = await constrainedOutbox.addPending(pending(secondRequestId, "same sized quote"));
  const finalQueue = await constrainedOutbox.listPending();

  assert.equal(addedAfterDelete.record.requestId, secondRequestId);
  assert.equal(finalQueue.itemCount, 1);
  assert.equal(finalQueue.items[0].requestId, secondRequestId);
});

test("reports browser storage quota failures and preserves existing queue entries", async () => {
  const { outbox, indexedDB } = createOutbox();
  await outbox.addPending(pending(firstRequestId, "existing item"));
  const beforeFailure = await outbox.listPending();
  const quotaError = new Error("quota");
  quotaError.name = "QuotaExceededError";
  indexedDB.failNextAdd = quotaError;

  await assert.rejects(
    outbox.addPending(pending(secondRequestId, "new item")),
    (error) => error.code === "storage-quota"
  );
  const queue = await outbox.listPending();
  assert.equal(queue.itemCount, beforeFailure.itemCount);
  assert.equal(queue.totalBytes, beforeFailure.totalBytes);
  assert.equal(queue.items[0].requestId, firstRequestId);
});

test("requires explicit, valid request IDs and reports unavailable IndexedDB", async () => {
  const { outbox } = createOutbox(null);
  await assert.rejects(
    outbox.addPending(pending("invalid", "sample quote")),
    (error) => error.code === "invalid-request-id"
  );
  await assert.rejects(
    outbox.addPending(pending(firstRequestId, "sample quote")),
    (error) => error.code === "storage-unavailable"
  );
});
