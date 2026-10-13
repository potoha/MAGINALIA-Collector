(() => {
  const DATABASE_NAME = "maginalia-collector-outbox";
  const DATABASE_VERSION = 1;
  const ENTRY_STORE = "entries";
  const SUMMARY_STORE = "summaries";
  const METADATA_STORE = "metadata";
  const USAGE_KEY = "usage";
  const MAX_ITEM_BYTES = 16 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
  const REQUEST_ID_PATTERN = /^[0-9a-f-]{36}$/i;
  const encoder = new TextEncoder();

  function createError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }

  function measureValueBytes(value, ancestors = new Set()) {
    if (value === null || value === undefined) {
      return 1;
    }

    if (typeof value === "string") {
      return encoder.encode(value).byteLength;
    }

    if (typeof value === "boolean") {
      return 1;
    }

    if (typeof value === "number" || typeof value === "bigint") {
      return 8;
    }

    if (typeof value !== "object") {
      throw createError("invalid-record");
    }

    if (typeof Blob !== "undefined" && value instanceof Blob) {
      return value.size + encoder.encode(value.type).byteLength;
    }

    if (value instanceof ArrayBuffer) {
      return value.byteLength;
    }

    if (ArrayBuffer.isView(value)) {
      return value.byteLength;
    }

    if (value instanceof Date) {
      return 8;
    }

    if (ancestors.has(value)) {
      throw createError("invalid-record");
    }

    ancestors.add(value);
    let total = 2;
    if (Array.isArray(value)) {
      for (const item of value) {
        total += measureValueBytes(item, ancestors);
      }
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        ancestors.delete(value);
        throw createError("invalid-record");
      }
      for (const [key, item] of Object.entries(value)) {
        total += encoder.encode(key).byteLength + 1 + measureValueBytes(item, ancestors);
      }
    }
    ancestors.delete(value);
    return total;
  }

  function normalizeStorageError(error) {
    if (error?.code) {
      return error;
    }
    if (error?.name === "QuotaExceededError") {
      return createError("storage-quota");
    }
    return createError("storage-failed");
  }

  function createOutbox({
    indexedDB = globalThis.indexedDB,
    maxItemBytes = MAX_ITEM_BYTES,
    maxTotalBytes = MAX_TOTAL_BYTES
  } = {}) {
    let databasePromise;

    function openDatabase() {
      if (databasePromise) {
        return databasePromise;
      }

      if (!indexedDB || typeof indexedDB.open !== "function") {
        return Promise.reject(createError("storage-unavailable"));
      }

      databasePromise = new Promise((resolve, reject) => {
        let request;
        try {
          request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        } catch {
          reject(createError("storage-unavailable"));
          return;
        }

        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(ENTRY_STORE)) {
            database.createObjectStore(ENTRY_STORE, { keyPath: "requestId" });
          }
          if (!database.objectStoreNames.contains(SUMMARY_STORE)) {
            database.createObjectStore(SUMMARY_STORE, { keyPath: "requestId" });
          }
          if (!database.objectStoreNames.contains(METADATA_STORE)) {
            const metadata = database.createObjectStore(METADATA_STORE, { keyPath: "key" });
            metadata.put({ key: USAGE_KEY, itemCount: 0, totalBytes: 0 });
          }
        };

        request.onsuccess = () => {
          const database = request.result;
          database.onversionchange = () => database.close();
          resolve(database);
        };

        request.onerror = () => {
          databasePromise = null;
          reject(normalizeStorageError(request.error));
        };

        request.onblocked = () => {
          databasePromise = null;
          reject(createError("storage-blocked"));
        };
      });

      return databasePromise;
    }

    function runTransaction(storeNames, mode, run) {
      return openDatabase().then((database) => new Promise((resolve, reject) => {
        let transaction;
        let result;
        let failure;

        try {
          transaction = database.transaction(storeNames, mode);
          run(transaction, (value) => { result = value; }, (error) => {
            failure = error;
            try {
              transaction.abort();
            } catch {
              reject(error);
            }
          });
        } catch (error) {
          reject(normalizeStorageError(error));
          return;
        }

        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => {
          failure ||= normalizeStorageError(transaction.error);
        };
        transaction.onabort = () => reject(failure || normalizeStorageError(transaction.error));
      }));
    }

    function addPending({ requestId, kind = "quote", payload, title = "", pageUrl = "" }) {
      if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) {
        return Promise.reject(createError("invalid-request-id"));
      }
      if ((kind !== "quote" && kind !== "capture") || !payload || typeof payload !== "object" || Array.isArray(payload)) {
        return Promise.reject(createError("invalid-record"));
      }

      const createdAt = Date.now();
      const summary = {
        requestId,
        createdAt,
        kind,
        title: typeof title === "string" ? title : "",
        pageUrl: typeof pageUrl === "string" ? pageUrl : "",
        bytes: 0,
        localStatus: "pending",
        recipient: kind === "quote" ? "private-shelf" : "reviewer",
        recipientStatus: "not-sent"
      };
      const record = {
        requestId,
        createdAt,
        kind,
        payload,
        bytes: 0,
        localStatus: "pending",
        recipient: kind === "quote" ? "private-shelf" : "reviewer",
        recipientStatus: "not-sent"
      };

      let bytes;
      try {
        bytes = measureValueBytes({ ...record, summary });
      } catch (error) {
        return Promise.reject(error?.code ? error : createError("invalid-record"));
      }
      if (bytes > maxItemBytes) {
        return Promise.reject(createError("item-too-large"));
      }
      record.bytes = bytes;
      summary.bytes = bytes;

      return runTransaction(
        [ENTRY_STORE, SUMMARY_STORE, METADATA_STORE],
        "readwrite",
        (transaction, setResult, abort) => {
          const entries = transaction.objectStore(ENTRY_STORE);
          const summaries = transaction.objectStore(SUMMARY_STORE);
          const metadata = transaction.objectStore(METADATA_STORE);
          let existing;
          let usage;
          let entryLoaded = false;
          let usageLoaded = false;

          const insertWhenReady = () => {
            if (!entryLoaded || !usageLoaded) {
              return;
            }
            if (existing) {
              setResult({ record: existing, alreadyQueued: true });
              return;
            }
            if (!usage || !Number.isSafeInteger(usage.totalBytes) || !Number.isSafeInteger(usage.itemCount)) {
              abort(createError("storage-failed"));
              return;
            }
            if (usage.totalBytes + bytes > maxTotalBytes) {
              abort(createError("queue-full"));
              return;
            }

            try {
              entries.add(record);
              summaries.add(summary);
              metadata.put({
                key: USAGE_KEY,
                itemCount: usage.itemCount + 1,
                totalBytes: usage.totalBytes + bytes
              });
              setResult({ record, alreadyQueued: false });
            } catch (error) {
              abort(normalizeStorageError(error));
            }
          };

          const existingRequest = entries.get(requestId);
          existingRequest.onsuccess = () => {
            existing = existingRequest.result;
            entryLoaded = true;
            insertWhenReady();
          };
          existingRequest.onerror = () => abort(normalizeStorageError(existingRequest.error));

          const usageRequest = metadata.get(USAGE_KEY);
          usageRequest.onsuccess = () => {
            usage = usageRequest.result;
            usageLoaded = true;
            insertWhenReady();
          };
          usageRequest.onerror = () => abort(normalizeStorageError(usageRequest.error));
        }
      );
    }

    function listPending() {
      return runTransaction([SUMMARY_STORE, METADATA_STORE], "readonly", (transaction, setResult, abort) => {
        const summariesRequest = transaction.objectStore(SUMMARY_STORE).getAll();
        const usageRequest = transaction.objectStore(METADATA_STORE).get(USAGE_KEY);
        let summaries;
        let usage;
        let summariesLoaded = false;
        let usageLoaded = false;
        const finishWhenReady = () => {
          if (!summariesLoaded || !usageLoaded) {
            return;
          }
          if (!usage || !Number.isSafeInteger(usage.totalBytes) || !Number.isSafeInteger(usage.itemCount)) {
            abort(createError("storage-failed"));
            return;
          }
          summaries.sort((left, right) => right.createdAt - left.createdAt);
          setResult({
            items: summaries,
            itemCount: usage.itemCount,
            totalBytes: usage.totalBytes,
            maxItemBytes,
            maxTotalBytes
          });
        };
        summariesRequest.onsuccess = () => {
          summaries = summariesRequest.result;
          summariesLoaded = true;
          finishWhenReady();
        };
        summariesRequest.onerror = () => abort(normalizeStorageError(summariesRequest.error));
        usageRequest.onsuccess = () => {
          usage = usageRequest.result;
          usageLoaded = true;
          finishWhenReady();
        };
        usageRequest.onerror = () => abort(normalizeStorageError(usageRequest.error));
      });
    }

    function getPending(requestId) {
      if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) {
        return Promise.reject(createError("invalid-request-id"));
      }
      return runTransaction([ENTRY_STORE], "readonly", (transaction, setResult, abort) => {
        const request = transaction.objectStore(ENTRY_STORE).get(requestId);
        request.onsuccess = () => setResult(request.result || null);
        request.onerror = () => abort(normalizeStorageError(request.error));
      });
    }

    function deletePending(requestId) {
      if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) {
        return Promise.reject(createError("invalid-request-id"));
      }

      return runTransaction(
        [ENTRY_STORE, SUMMARY_STORE, METADATA_STORE],
        "readwrite",
        (transaction, setResult, abort) => {
          const entries = transaction.objectStore(ENTRY_STORE);
          const summaries = transaction.objectStore(SUMMARY_STORE);
          const metadata = transaction.objectStore(METADATA_STORE);
          let record;
          let usage;
          let recordLoaded = false;
          let usageLoaded = false;
          const deleteWhenReady = () => {
            if (!recordLoaded || !usageLoaded) {
              return;
            }
            if (!record) {
              setResult({ deleted: false });
              return;
            }
            if (!usage || !Number.isSafeInteger(usage.totalBytes) || !Number.isSafeInteger(usage.itemCount)) {
              abort(createError("storage-failed"));
              return;
            }

            try {
              entries.delete(requestId);
              summaries.delete(requestId);
              metadata.put({
                key: USAGE_KEY,
                itemCount: Math.max(0, usage.itemCount - 1),
                totalBytes: Math.max(0, usage.totalBytes - record.bytes)
              });
              setResult({ deleted: true });
            } catch (error) {
              abort(normalizeStorageError(error));
            }
          };

          const recordRequest = entries.get(requestId);
          recordRequest.onsuccess = () => {
            record = recordRequest.result;
            recordLoaded = true;
            deleteWhenReady();
          };
          recordRequest.onerror = () => abort(normalizeStorageError(recordRequest.error));

          const usageRequest = metadata.get(USAGE_KEY);
          usageRequest.onsuccess = () => {
            usage = usageRequest.result;
            usageLoaded = true;
            deleteWhenReady();
          };
          usageRequest.onerror = () => abort(normalizeStorageError(usageRequest.error));
        }
      );
    }

    return Object.freeze({ addPending, getPending, listPending, deletePending });
  }

  globalThis.CollectorOutbox = Object.freeze({
    create: createOutbox,
    maxItemBytes: MAX_ITEM_BYTES,
    maxTotalBytes: MAX_TOTAL_BYTES
  });
})();
