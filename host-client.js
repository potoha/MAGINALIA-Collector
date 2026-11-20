(() => {
  /**
   * Collector-side Native Messaging client for the MAGINALIA Collector Host.
   *
   * The Host is reached under the fixed name `org.maginalia.collector`. The Host
   * allows exactly one extension origin, derived from the public key committed in
   * manifest.json. A machine-local `collector.host-profile` storage entry can
   * override the name; only the disposable development and E2E tooling under
   * dev/ uses that override.
   *
   * The protocol name keeps its `experimental.v1` label. Its three operations (plus
   * the additive, connection-check-only host_info) and
   * their request and receipt shapes are fixed by the Collector and Host design
   * memos. The client sends a quote only through save_web_quote. It sends it only
   * after the Host reports that save_web_quote is enabled for the configured
   * Private Shelf. It accepts only a committed or already-committed receipt bound
   * to the same request ID and Shelf.
   *
   * This module never reads or changes the browser Outbox. A successful health or
   * configured_shelf response proves only that the Host answered; it is not a save.
   */
  const EXPERIMENTAL_PROTOCOL = "maginalia.collector.experimental.v1";
  const SUPPORTED_OPERATIONS = Object.freeze(["health", "configured_shelf", "save_web_quote"]);
  // `host_info` is additive to protocol v1: it is called only by the connection
  // check, and only when the Host lists it in `health.operations`. It is never part
  // of the save path.
  const HOST_INFO_OPERATION = "host_info";
  // Oldest Host version this extension works with. Hosts report `host.version` in
  // host_info; 0.2.0 is the Desktop payload Host version for alpha2. Raise only together with a
  // documented incompatible change.
  const MINIMUM_HOST_VERSION = "0.2.0";
  // Same shape the Host accepts: major.minor.patch with an optional short pre-release.
  const VERSION_PATTERN = /^[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,15})?$/;
  const VERSION_MAX_LENGTH = 32;
  const HOST_PROFILE_KEY = "collector.host-profile";
  const DEFAULT_HOST_NAME = "org.maginalia.collector";
  const DEFAULT_TIMEOUT_MS = 10000;
  // A save may wait for the Host's Shelf write lock and a durable multi-file write.
  // A timeout never proves failure: the entry stays pending and a resend with the
  // same request ID returns already-committed if the first write completed.
  const DEFAULT_SAVE_TIMEOUT_MS = 30000;
  const MAX_TIMEOUT_MS = 60000;
  const MAX_RESPONSE_BYTES = 64 * 1024;
  const MAX_REQUEST_BYTES = 64 * 1024;
  const HOST_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
  const SHELF_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const OPERATION_NAME_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;
  const HOST_ERROR_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
  const SHELF_TYPE_PATTERN = /^[a-z]{1,16}$/;
  const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
  const ABSOLUTE_PATH_PATTERN = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/;
  const encoder = new TextEncoder();

  // Host-reported failures are translated to client codes. Unlisted codes stay
  // visible as `host-error` with the original code preserved.
  const HOST_ERROR_CODES = Object.freeze({
    host_configuration_or_origin_invalid: "host-configuration-invalid",
    configuration_unavailable: "shelf-configuration-unavailable",
    shelf_unconfigured: "shelf-not-configured",
    shelf_identity_unavailable: "shelf-identity-unavailable",
    shelf_identity_mismatch: "shelf-identity-mismatch",
    shelf_unavailable: "shelf-unavailable",
    shelf_write_busy: "shelf-write-busy",
    unsupported_operation: "unsupported-operation",
    save_failed: "host-save-failed",
    invalid_request: "host-rejected-request",
    invalid_json: "host-protocol-error",
    invalid_frame_length: "host-protocol-error",
    truncated_frame: "host-protocol-error",
    response_too_large: "host-response-too-large"
  });

  function createError(code, details) {
    const error = new Error(code);
    error.code = code;
    if (details) {
      Object.assign(error, details);
    }
    return error;
  }

  function errorCode(error) {
    return typeof error?.code === "string" ? error.code : "invalid-response";
  }

  // Accepts plain objects from any realm, rejects arrays, class instances, Dates
  // and other non-record values that a hostile or buggy helper could send.
  function isPlainRecord(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || Object.getPrototypeOf(prototype) === null;
  }

  function hasExactKeys(value, expected) {
    if (!isPlainRecord(value)) {
      return false;
    }
    const keys = Object.keys(value);
    return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
  }

  function measureJsonBytes(value) {
    return encoder.encode(JSON.stringify(value)).byteLength;
  }

  function looksLikeAbsolutePath(value) {
    return ABSOLUTE_PATH_PATTERN.test(value);
  }

  // Chrome's Native Messaging failures arrive through chrome.runtime.lastError as
  // short English messages. Matching them is the only way to separate "not
  // installed" from "this extension is not allowed" from a transient failure.
  function transportErrorCode(message) {
    const text = typeof message === "string" ? message : "";
    if (/not found/i.test(text)) {
      return "host-not-registered";
    }
    if (/forbidden|access to the specified native messaging host/i.test(text)) {
      return "host-access-forbidden";
    }
    if (/exited/i.test(text)) {
      return "host-exited";
    }
    if (/communicat/i.test(text)) {
      return "host-communication-failed";
    }
    return "host-unreachable";
  }

  function isVersionString(value) {
    return typeof value === "string" && value.length <= VERSION_MAX_LENGTH && VERSION_PATTERN.test(value);
  }

  // Orders two version strings accepted by isVersionString. A pre-release sorts
  // before the same numeric version without one. Returns -1, 0 or 1.
  function compareVersions(left, right) {
    const parse = (value) => {
      const [numbers, ...rest] = value.split("-");
      return { numbers: numbers.split(".").map(Number), pre: rest.length > 0 ? rest.join("-") : null };
    };
    const a = parse(left);
    const b = parse(right);
    for (let index = 0; index < 3; index += 1) {
      if (a.numbers[index] !== b.numbers[index]) {
        return a.numbers[index] < b.numbers[index] ? -1 : 1;
      }
    }
    if (a.pre === b.pre) return 0;
    if (a.pre === null) return 1;
    if (b.pre === null) return -1;
    return a.pre < b.pre ? -1 : 1;
  }

  function normalizeHostName(value) {
    return typeof value === "string" && HOST_NAME_PATTERN.test(value) ? value : "";
  }

  function normalizeTimeout(value) {
    return Number.isSafeInteger(value) && value > 0 && value <= MAX_TIMEOUT_MS ? value : DEFAULT_TIMEOUT_MS;
  }

  function normalizeProtocol(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 128 && !CONTROL_CHARACTER_PATTERN.test(value)
      ? value
      : EXPERIMENTAL_PROTOCOL;
  }

  /**
   * Reads the optional machine-local Host profile override. The profile holds only
   * a Host name. It exists for the disposable development and E2E tooling, which
   * registers a unique test Host name; normal installs have no profile.
   */
  async function loadHostProfile(storage) {
    if (!storage || typeof storage.get !== "function") {
      return null;
    }

    let stored;
    try {
      stored = await storage.get(HOST_PROFILE_KEY);
    } catch {
      return null;
    }

    const profile = stored?.[HOST_PROFILE_KEY];
    if (!hasExactKeys(profile, ["hostName"])) {
      return null;
    }

    const hostName = normalizeHostName(profile.hostName);
    return hostName ? { hostName } : null;
  }

  /**
   * Returns the Host name to contact: a valid development override when one is
   * stored, otherwise the fixed product Host name.
   */
  async function resolveHostName(storage) {
    const profile = await loadHostProfile(storage);
    return profile?.hostName ?? DEFAULT_HOST_NAME;
  }

  function createHostClient({
    hostName = "",
    sendNativeMessage = null,
    getLastError = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    saveTimeoutMs = DEFAULT_SAVE_TIMEOUT_MS,
    protocol = EXPERIMENTAL_PROTOCOL,
    extensionVersion = ""
  } = {}) {
    const configuredHostName = normalizeHostName(hostName);
    const configuredExtensionVersion = isVersionString(extensionVersion) ? extensionVersion : "";
    const boundedTimeout = normalizeTimeout(timeoutMs);
    const boundedSaveTimeout = Number.isSafeInteger(saveTimeoutMs) && saveTimeoutMs > 0 && saveTimeoutMs <= MAX_TIMEOUT_MS
      ? saveTimeoutMs
      : DEFAULT_SAVE_TIMEOUT_MS;
    const expectedProtocol = normalizeProtocol(protocol);

    function send(operation, fields = {}, operationTimeout = boundedTimeout) {
      if (!configuredHostName) {
        return Promise.reject(createError("host-not-configured"));
      }
      if (typeof sendNativeMessage !== "function") {
        return Promise.reject(createError("native-messaging-unavailable"));
      }

      // Callers provide only fields admitted by the operation-specific validator.
      const request = { protocol: expectedProtocol, operation, ...fields };
      if (measureJsonBytes(request) > MAX_REQUEST_BYTES) {
        return Promise.reject(createError("host-request-too-large"));
      }

      return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;

        const settle = (finish, value) => {
          if (settled) {
            return;
          }
          settled = true;
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
          finish(value);
        };

        timer = setTimeout(() => settle(reject, createError("host-timeout")), operationTimeout);

        try {
          sendNativeMessage(configuredHostName, request, (response) => {
            if (settled) {
              return;
            }

            let lastError = null;
            try {
              lastError = typeof getLastError === "function" ? getLastError() : null;
            } catch {
              lastError = null;
            }

            if (lastError) {
              const message = typeof lastError.message === "string" ? lastError.message.slice(0, 200) : "";
              settle(reject, createError(transportErrorCode(message), { transportError: message }));
              return;
            }

            if (response === undefined || response === null) {
              settle(reject, createError("host-no-response"));
              return;
            }

            settle(resolve, response);
          });
        } catch {
          settle(reject, createError("native-messaging-unavailable"));
        }
      });
    }

    function readEnvelope(response) {
      if (!isPlainRecord(response)) {
        throw createError("invalid-response");
      }

      let bytes;
      try {
        bytes = measureJsonBytes(response);
      } catch {
        throw createError("invalid-response");
      }
      if (bytes > MAX_RESPONSE_BYTES) {
        throw createError("host-response-too-large");
      }

      if (response.protocol !== expectedProtocol) {
        throw createError("invalid-response");
      }

      if (response.ok === false) {
        if (!hasExactKeys(response, ["protocol", "ok", "error"])) {
          throw createError("invalid-response");
        }
        if (typeof response.error !== "string" || !HOST_ERROR_PATTERN.test(response.error)) {
          throw createError("invalid-response");
        }
        const code = HOST_ERROR_CODES[response.error] ?? "host-error";
        throw createError(code, { hostError: response.error });
      }

      if (response.ok !== true) {
        throw createError("invalid-response");
      }

      return response;
    }

    async function health() {
      const envelope = readEnvelope(await send("health"));
      if (!hasExactKeys(envelope, ["protocol", "ok", "experimental", "operations", "writesEnabled"])) {
        throw createError("invalid-response");
      }
      if (envelope.experimental !== true || typeof envelope.writesEnabled !== "boolean") {
        throw createError("invalid-response");
      }

      const operations = envelope.operations;
      if (!Array.isArray(operations) || operations.length === 0 || operations.length > 16) {
        throw createError("invalid-response");
      }
      for (const operation of operations) {
        if (typeof operation !== "string" || !OPERATION_NAME_PATTERN.test(operation)) {
          throw createError("invalid-response");
        }
      }
      if (new Set(operations).size !== operations.length) {
        throw createError("invalid-response");
      }

      return Object.freeze({
        protocol: expectedProtocol,
        operations: Object.freeze([...operations]),
        writesEnabled: envelope.writesEnabled
      });
    }

    /**
     * Asks the Host for its version and the oldest extension version it supports.
     * Strict like the other operations. A response under a different protocol
     * identifier means the Host is not the one this extension expects, so it is
     * reported as host-update-required. Nothing is written by this call on the
     * extension side; the Host may record that the extension made contact.
     */
    async function hostInfo() {
      if (!configuredExtensionVersion) {
        throw createError("invalid-request");
      }
      const response = await send(HOST_INFO_OPERATION, { extensionVersion: configuredExtensionVersion });
      if (isPlainRecord(response) && response.ok === true && typeof response.protocol === "string"
        && response.protocol !== expectedProtocol) {
        throw createError("host-update-required");
      }
      const envelope = readEnvelope(response);
      if (!hasExactKeys(envelope, ["protocol", "ok", "host"])) {
        throw createError("invalid-response");
      }
      const host = envelope.host;
      if (!hasExactKeys(host, ["version", "minimumExtensionVersion"])
        || !isVersionString(host.version) || !isVersionString(host.minimumExtensionVersion)) {
        throw createError("invalid-response");
      }
      return Object.freeze({ version: host.version, minimumExtensionVersion: host.minimumExtensionVersion });
    }

    async function configuredShelf() {
      const envelope = readEnvelope(await send("configured_shelf"));
      if (!hasExactKeys(envelope, ["protocol", "ok", "shelf"])) {
        throw createError("invalid-response");
      }

      const shelf = envelope.shelf;
      if (!hasExactKeys(shelf, ["id", "name", "type", "writesEnabled"])) {
        throw createError("invalid-response");
      }
      if (typeof shelf.id !== "string" || !SHELF_ID_PATTERN.test(shelf.id)) {
        throw createError("invalid-response");
      }
      if (
        typeof shelf.name !== "string" ||
        shelf.name.length === 0 ||
        shelf.name.length > 256 ||
        CONTROL_CHARACTER_PATTERN.test(shelf.name)
      ) {
        throw createError("invalid-response");
      }
      // The host must never disclose filesystem locations; treat a path-shaped
      // identifier or display name as a privacy regression, not as data.
      if (looksLikeAbsolutePath(shelf.id) || looksLikeAbsolutePath(shelf.name)) {
        throw createError("invalid-response");
      }
      if (typeof shelf.type !== "string" || !SHELF_TYPE_PATTERN.test(shelf.type)) {
        throw createError("invalid-response");
      }
      if (typeof shelf.writesEnabled !== "boolean") {
        throw createError("invalid-response");
      }

      return Object.freeze({
        id: shelf.id,
        name: shelf.name,
        type: shelf.type,
        writesEnabled: shelf.writesEnabled
      });
    }

    async function saveQuote({ requestId, quote, url, getDate, title, authors } = {}) {
      if (typeof requestId !== "string" || !SHELF_ID_PATTERN.test(requestId)) {
        throw createError("invalid-request");
      }
      if (typeof quote !== "string" || quote.trim().length === 0 || typeof url !== "string" || url.length > 8192
        || typeof getDate !== "string" || !/^\d{12}$/.test(getDate)) {
        throw createError("invalid-request");
      }
      try {
        const source = new URL(url);
        if (source.protocol !== "http:" && source.protocol !== "https:") throw createError("invalid-request");
      } catch { throw createError("invalid-request"); }
      if (title !== undefined && (typeof title !== "string" || title.length > 2048)) throw createError("invalid-request");
      if (authors !== undefined && (!Array.isArray(authors) || authors.length > 8
        || authors.some((author) => typeof author !== "string" || author.length === 0 || author.length > 512))) {
        throw createError("invalid-request");
      }

      const host = await health();
      if (!host.writesEnabled || !host.operations.includes("save_web_quote")) throw createError("host-save-disabled");
      const shelf = await configuredShelf();
      if (!shelf.writesEnabled || shelf.type !== "private") throw createError("host-save-disabled");

      const fields = {
        requestId,
        quote,
        url,
        getDate,
        ...(title ? { title } : {}),
        ...(authors === undefined ? {} : { authors })
      };
      const envelope = readEnvelope(await send("save_web_quote", fields, boundedSaveTimeout));
      if (!hasExactKeys(envelope, ["protocol", "ok", "receipt"])) throw createError("invalid-response");
      const receipt = envelope.receipt;
      const receiptKeys = ["version", "state", "requestId", "shelfId", "bookId", "annotationId", "bookReused", "annotationDigest", "requestDigest", "recordedAt"];
      if (!hasExactKeys(receipt, receiptKeys)
        || receipt.version !== 1
        || (receipt.state !== "committed" && receipt.state !== "already-committed")
        || receipt.requestId !== requestId
        || typeof receipt.shelfId !== "string" || receipt.shelfId.toLowerCase() !== shelf.id.toLowerCase()
        || typeof receipt.bookId !== "string" || !/^book:[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(receipt.bookId)
        || typeof receipt.annotationId !== "string" || !/^ann:[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(receipt.annotationId)
        || typeof receipt.bookReused !== "boolean"
        || typeof receipt.annotationDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(receipt.annotationDigest)
        || typeof receipt.requestDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(receipt.requestDigest)
        || typeof receipt.recordedAt !== "string" || !Number.isFinite(Date.parse(receipt.recordedAt))) {
        throw createError("invalid-response");
      }
      return Object.freeze({ shelf, receipt: Object.freeze({ ...receipt }) });
    }

    /**
     * Verifies that this client and the installed Host agree on the protocol and
     * that the configured Private Shelf validates. Never throws: the caller renders
     * the report, including failures. Nothing is written.
     */
    async function checkCompatibility() {
      const checks = [];
      const addCheck = (id, status, code) => {
        checks.push(code ? { id, status, code } : { id, status });
      };
      const createReport = (status, code) => {
        const report = { status, experimental: true, host: null, shelf: null, checks };
        if (code) {
          report.code = code;
        }
        return report;
      };

      if (!configuredHostName) {
        addCheck("host-configured", "fail", "host-not-configured");
        return createReport("unavailable", "host-not-configured");
      }
      addCheck("host-configured", "pass");

      let hostStatus;
      try {
        hostStatus = await health();
      } catch (error) {
        const code = errorCode(error);
        addCheck("health", "fail", code);
        return createReport("unavailable", code);
      }
      addCheck("health", "pass");
      addCheck("protocol", "pass");

      // An older Host that does not list host_info is skipped silently: the existing
      // behaviour stays. Without a valid own version nothing can be sent either.
      if (hostStatus.operations.includes(HOST_INFO_OPERATION) && configuredExtensionVersion) {
        let info;
        try {
          info = await hostInfo();
        } catch (error) {
          const code = errorCode(error);
          addCheck("host-info", "fail", code);
          const report = createReport("incompatible", code);
          report.host = hostStatus;
          return report;
        }
        let incompatibility = "";
        if (compareVersions(configuredExtensionVersion, info.minimumExtensionVersion) < 0) {
          incompatibility = "extension-update-required";
        } else if (compareVersions(info.version, MINIMUM_HOST_VERSION) < 0) {
          incompatibility = "host-update-required";
        }
        if (incompatibility) {
          addCheck("host-info", "fail", incompatibility);
          const report = createReport("incompatible", incompatibility);
          report.host = hostStatus;
          return report;
        }
        addCheck("host-info", "pass");
      }

      if (!hostStatus.operations.includes("configured_shelf")) {
        addCheck("configured-shelf-operation", "fail", "unsupported-operation");
        const report = createReport("incompatible", "unsupported-operation");
        report.host = hostStatus;
        return report;
      }
      addCheck("configured-shelf-operation", "pass");

      let shelf;
      try {
        shelf = await configuredShelf();
      } catch (error) {
        const code = errorCode(error);
        addCheck("configured-shelf", "fail", code);
        const report = createReport("incompatible", code);
        report.host = hostStatus;
        return report;
      }
      addCheck("configured-shelf", "pass");
      addCheck("shelf-identity", "pass");

      const report = createReport("compatible");
      report.host = hostStatus;
      report.shelf = shelf;
      return report;
    }

    return Object.freeze({ health, hostInfo, configuredShelf, saveQuote, checkCompatibility, hostName: configuredHostName });
  }

  globalThis.CollectorHostClient = Object.freeze({
    createHostClient,
    loadHostProfile,
    resolveHostName,
    defaultHostName: DEFAULT_HOST_NAME,
    protocol: EXPERIMENTAL_PROTOCOL,
    operations: SUPPORTED_OPERATIONS,
    hostInfoOperation: HOST_INFO_OPERATION,
    minimumHostVersion: MINIMUM_HOST_VERSION,
    isVersionString,
    compareVersions,
    hostProfileKey: HOST_PROFILE_KEY,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    defaultSaveTimeoutMs: DEFAULT_SAVE_TIMEOUT_MS,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    maxRequestBytes: MAX_REQUEST_BYTES
  });
})();
