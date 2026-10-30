(() => {
  /**
   * Collector-side Native Messaging client for the MAGINALIA local helper.
   *
   * The helper protocol, descriptor, host name and shelf identity expectation used
   * by the current development helper are EXPERIMENTAL. ADR 0019 / D070 accepts the
   * architecture direction only; registration, packaging, identity binding and the
   * protocol itself are not approved product contracts yet. Everything specific to
   * the current experiment is kept here so it can be replaced in one place.
   *
   * This module never writes to a Shelf, never stages a capture and never reads from
   * the outbox. A successful response proves only that the configured helper answered.
   */
  const EXPERIMENTAL_PROTOCOL = "maginalia.collector.experimental.v1";
  const SUPPORTED_OPERATIONS = Object.freeze(["health", "configured_shelf"]);
  const HOST_PROFILE_KEY = "collector.host-profile";
  const DEFAULT_TIMEOUT_MS = 10000;
  const MAX_TIMEOUT_MS = 60000;
  const MAX_RESPONSE_BYTES = 64 * 1024;
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
    unsupported_operation: "unsupported-operation",
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
   * Reads the machine-local helper profile. The profile holds only the host name;
   * no extension identity or registration detail is baked into this repository.
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

  function createHostClient({
    hostName = "",
    sendNativeMessage = null,
    getLastError = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    protocol = EXPERIMENTAL_PROTOCOL
  } = {}) {
    const configuredHostName = normalizeHostName(hostName);
    const boundedTimeout = normalizeTimeout(timeoutMs);
    const expectedProtocol = normalizeProtocol(protocol);

    function send(operation) {
      if (!configuredHostName) {
        return Promise.reject(createError("host-not-configured"));
      }
      if (typeof sendNativeMessage !== "function") {
        return Promise.reject(createError("native-messaging-unavailable"));
      }

      // Exactly two fields: the experimental helper rejects unknown keys.
      const request = { protocol: expectedProtocol, operation };

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

        timer = setTimeout(() => settle(reject, createError("host-timeout")), boundedTimeout);

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

    /**
     * Verifies that this client and the installed helper agree on the experimental
     * contract. Never throws: the caller renders the report, including failures.
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

    return Object.freeze({ health, configuredShelf, checkCompatibility, hostName: configuredHostName });
  }

  globalThis.CollectorHostClient = Object.freeze({
    createHostClient,
    loadHostProfile,
    protocol: EXPERIMENTAL_PROTOCOL,
    operations: SUPPORTED_OPERATIONS,
    hostProfileKey: HOST_PROFILE_KEY,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    maxResponseBytes: MAX_RESPONSE_BYTES
  });
})();
