# Issue #3: Local Host Design and Technical Verification

**Status:** Design proposal for Product Owner review. No new product, Shelf, `.magicap`, or host contract is approved by this document.

**Scope:** Collector Issue #3 only. Parent `main` was verified at `9b796c45a015d3daecda0774e6ec272a16f25f74`; this work is on `codex/collector-local-host-design`.

## Recommendation

Use Chrome Native Messaging as the first integration path. Package a narrowly scoped native host with the installed Desktop and register it for the exact, fixed Collector extension ID. The extension service worker should start the host only for explicit user actions. A one-request `sendNativeMessage` exchange is the best initial fit; it launches a host process for the request and avoids a resident server. Keep the message API limited to status, the configured Private Shelf, a web-quote write, and (only after a separate queue contract exists) capture staging.

This is a recommendation, not an adoption decision. Native Messaging requires the extension's `nativeMessaging` permission, a host manifest with an exact `allowed_origins` entry, and installer-managed host registration. Chrome restricts this permission to extension pages and the service worker; content scripts must send through the service worker, which must validate the sender and payload. Chrome's protocol is UTF-8 JSON with a 32-bit native-endian length prefix, with a 1 MiB host-to-Chrome message limit and a 64 MiB extension-to-host limit. These constraints make small control messages and one-way image/package staging feasible, but do not prove the production flow works in Chrome. [Chrome Native Messaging documentation](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)

An authenticated loopback API remains technically possible, but it adds listener lifetime, port selection, local-origin/CSRF controls, and credential handling. A resident listener conflicts with Issue #3's correction that normal saves must not require Desktop startup or an always-on HTTP service. No loopback implementation is recommended for this slice.

## Current evidence and contract boundaries

- The current Collector manifest has no `nativeMessaging` permission. Its capture outbox is IndexedDB keyed by a stable `requestId`; records are marked `pending` and `not-sent`. It supports quotes and image blobs, but has no host bridge or Shelf acknowledgement path.
- The current Desktop's `shelf_location.yml` is machine-local configuration under the Electron `userData` root. It stores one `private_shelf.registry` absolute path and does not store a stable Shelf ID. `applicationIdentity.userDataPath` is captured before Electron's name/path pinning step to preserve the existing profile, so a host must not guess the path from the product name or current working directory.
- Desktop's configured-Shelf path is opened through `LibraryService`, which validates the Shelf contract and reads the typed folder marker. The accepted MAGINALIA IDE D068 / ADR 0017 contract assigns a stable UUID to a `shelf`-typed `.magi` marker. Marker filenames may be renamed; conflicting valid markers are a recovery state. Normal open must not silently create a new identity.
- The existing Reviewer-to-Shelf materializer uses `library.json`'s `booksPath` and `annotationsPath`, validates/contains directories, creates versioned entity files using temporary writes plus no-replace links, and skips unsafe symlink paths. Its `writeQueue` is explicitly process-local to the Desktop single-instance main process. It does not serialize a second native-host process, and its individual file writes do not make a multi-file Book/Annotation operation transactional.
- The current Reviewer importer accepts `.magicap` through `POST /api/import` while its FastAPI process is running. The inspected code writes a temporary upload and calls the importer. No offline watched-folder receiver was found in the inspected Reviewer/Desktop paths. A file placed in an arbitrary folder is not evidence of Reviewer acceptance.
- The current canonical Shelf format is v0.4; website quotes use a `website` Book and a non-empty Annotation with its own stable ID and local acquisition time. `.magicap` v3 preserves website provenance and image bytes; captures remain unverified until human review. The Collector requirements v0.2 at `e925fcf4fc96416127da1cb8e9199b021e4bc409` still describes a proposed connection API. Issue #3's 2026-10-13 correction supersedes its prior assumption that normal saving may depend on a running Desktop API. The requirements document was not changed here.

References: [Collector requirements v0.2](https://github.com/potoha/MAGINALIA_IDE/blob/main/plan/30_MAGINALIA_COLLECTOR_REQUIREMENTS.md), [Shelf JSON v0.4](https://github.com/potoha/MAGINALIA_IDE/blob/main/docs/shelf-json-contract.md), [`.magicap` v3](https://github.com/potoha/MAGINALIA_IDE/blob/main/docs/magicap-contract-v3.md), [ADR 0017](https://github.com/potoha/MAGINALIA_IDE/blob/main/docs/decisions/0017-typed-magi-folder-marker.md), and [Decision Log D068](https://github.com/potoha/MAGINALIA_IDE/blob/main/plan/09_DECISION_LOG.md).

## Proposed host flow

1. On an explicit save action, the extension service worker sends a versioned message to the registered host. It sends a stable `requestId`, an operation, and only the operation's data. It never sends a filesystem path or arbitrary file operation.
2. The host checks the caller extension ID against its own exact allowlist, validates the message schema and size, and reads a Desktop-owned host configuration descriptor. The descriptor points to the existing Desktop `userData` location; it is machine-local integration configuration, not portable Shelf data.
3. The host reads the one explicitly configured Private Shelf path from Desktop configuration. It reopens the target defensively, confirms the `shelf.magi` marker has type `shelf` and the expected stable ID, then validates `library.json`, configured child directories, permissions, and symlink/reparse-point boundaries. The host returns an opaque Shelf ID and display name, never a path.
4. For a quote write, the host uses the same Shelf writer and cross-process coordinator as Desktop. It validates and writes only Shelf v0.4 fields. It returns a local durable-write receipt only after all required data and idempotency state have been committed.
5. For an image capture, the host does not claim Reviewer acceptance. Until Desktop/Reviewer defines a durable pending-capture contract and consumer, the Collector keeps the item in its existing browser outbox. If a later contract adds a host spool, its receipt must say `durably-staged` / `awaiting-reviewer-import`; only an importer receipt can mean Reviewer accepted it.

The first version should list only the one configured Private Shelf supported by Desktop today. It should not scan drives, enumerate arbitrary paths, or invent multi-Shelf discovery. If multiple registered Shelves become a product requirement, Desktop must first define the registry and ownership contract.

## Shelf discovery and failure behavior

Desktop can be off for ordinary saves because its configuration and Shelf are files; however, the current host has no reliable way to discover the Electron profile path. Desktop/Installer must provide a stable, versioned descriptor at a per-user location known to the host. It must be updated when the configured Shelf changes and protected by the current user's filesystem permissions. The host must not infer this location from `cwd`, search parent folders, or scan the computer.

The configured path is a locator, not identity. The host must compare its resolved Shelf marker with the expected stable Shelf UUID. It must fail closed when configuration is absent/invalid, the path is missing or moved, the marker is absent/corrupt/conflicting, the identity differs, the Shelf is unreadable, or the filesystem denies writes. It must not create a marker, adopt a folder, choose the first of several discovered candidates, or silently replace the configured path. Recovery should ask the user to repair/select the Shelf through the Desktop's existing configuration flow; supporting repair while Desktop is off requires a separate approved UI/contract.

Possible response codes for review (names are proposals, not contract): `host-config-missing`, `shelf-not-configured`, `shelf-unavailable`, `shelf-marker-invalid`, `shelf-marker-conflict`, `shelf-identity-mismatch`, `shelf-not-writable`, `unsupported-contract`, and `request-id-conflict`.

## Cross-process writes, atomicity, and retries

The current Desktop queue prevents overlap only inside the Desktop process. Its no-replace file creation is useful protection against overwriting an existing entity, but two independent processes can both inspect state and race to create related Book and Annotation files. Host-side path checks also need to operate on validated handles, not only `realpath` strings, so a directory/reparse-point swap cannot redirect a later write.

Before a host can write Shelf data, Desktop and the host need one shared cross-process write boundary keyed by the stable Shelf UUID. That boundary must cover reading existing Books, reusing a matching Book, choosing IDs, writing canonical files/assets, and recording the operation receipt. Preserve no-replace creation and reject conflicts; do not rely on separate in-memory queues. The shared implementation can be a common writer module or a single documented OS-lock protocol implemented by both processes; the exact mechanism is an implementation decision for the Desktop workstream.

Multi-file writes are not made transactional by atomic creation of each file. The Desktop work must define recovery for a crash between Book and Annotation creation and make retries idempotent. A proposed policy is a durable application-owned operation ledger mapping `requestId` and payload digest to the committed Shelf IDs. Repeating the same ID and digest returns the original receipt; reusing the ID with different data is a conflict. This ledger is coordination metadata outside canonical research records, but its owner, location, retention, backup/move behavior, and recovery are unresolved. An alternative is to use a canonical deterministic entity ID if MAGINALIA IDE accepts that identity rule. Do not add a noncanonical `requestId` field to Shelf JSON.

## Reviewer pending state and acknowledgement semantics

There are three different states:

1. **Browser-local pending:** the current Collector outbox has persisted the item; it is not yet sent to a host.
2. **Host-local staged:** a future approved capture queue has durably stored the `.magicap` package; it is waiting for an importer. This must not be called Reviewer accepted.
3. **Reviewer imported:** the real Reviewer importer confirms a package/import ID. Only this state may be called accepted by Reviewer.

While Reviewer is stopped, retain the capture in the existing browser outbox with its original `requestId`; do not delete it or mark it accepted. A Desktop-owned spool could survive browser-profile loss and support later delivery, but it requires a versioned contract for spool location, package validation, package ID idempotency, retention/deletion, importer wake-up, and acknowledgement. The current Reviewer API is an HTTP upload into a running service and supplies no such offline receiver. That integration is a separate Desktop/Reviewer dependency, not part of this Collector-only design gate.

## Message envelope proposal

This illustrates the boundary only; field names and version are not approved:

```json
{
  "protocolVersion": 1,
  "requestId": "<stable UUID for this logical action>",
  "operation": "listShelves",
  "payload": {}
}
```

```json
{
  "protocolVersion": 1,
  "requestId": "<same UUID>",
  "ok": true,
  "result": {
    "shelves": [
      { "shelfId": "<stable UUID>", "displayName": "Private Shelf", "state": "ready", "writable": true }
    ]
  }
}
```

Proposed operations are `getStatus`, `listShelves`, `saveWebQuote`, `getOperationStatus`, and a disabled-until-contracted `stageReviewerCapture`. Quote payloads contain user-confirmed text, URL and allowed v0.4 source metadata; they contain no paths. Success responses distinguish `shelf-write-committed`, `duplicate-confirmed`, `durably-staged`, and `reviewer-imported`. Errors include the same `requestId`, a stable error code, and retryability. Logs must omit quote text, capture bytes, and browsing history.

## Dependencies and Product Owner decisions

**Desktop / Installer:** define and maintain the host-visible userData descriptor; install, update, and uninstall the host and per-user browser registration; choose a shared cross-process writer/lock and operation-ledger strategy; ensure the same shelf identity/path checks are used; provide user repair for moved/missing Shelf configuration.

**Reviewer:** if offline capture delivery is required, define the durable queue contract and import consumer/receipt. Otherwise keep Reviewer captures in Collector's browser-local outbox until the existing HTTP importer is available.

**Collector:** add `nativeMessaging` only after the extension ID and host registration strategy are settled; route calls through the service worker; validate request/response schemas; keep the current outbox record until host acknowledgement; display local Shelf save and Reviewer import as distinct results.

Product Owner decisions before implementation: (1) stable extension ID and initial browser/distribution targets; (2) allowed host lifetime and exact Native Messaging packaging/registration; (3) one configured Private Shelf for the first release versus a future multi-Shelf registry; (4) descriptor ownership and moved-Shelf repair behavior; (5) shared lock and idempotency metadata ownership/retention; (6) whether an offline Reviewer spool is in scope and what `staged` versus `imported` means in UI; and (7) host/protocol version compatibility policy. The 2026-10-13 Issue correction should be written back to the canonical requirements plan separately; this Collector change does not edit MAGINALIA IDE or Desktop.

## Technical verification and acceptance

| Item | Result | Evidence / limit |
|---|---|---|
| Parent branch SHA | PASS | `origin/main` and the worktree HEAD both equal `9b796c45a015d3daecda0774e6ec272a16f25f74`. |
| Windows Native Messaging frame | PASS (synthetic host only) | A temporary echo host read a UTF-8 JSON request with a 32-bit little-endian byte length, returned a framed response with the same request ID/operation, and exited with code 0. The caller-origin argument was supplied by the local test command; Chrome did not invoke it. |
| Real Chrome Native Messaging launch/response | NOT VERIFIED | The previous Chrome 155 attempt did not load the unpacked test extension. On resume, the browser-use policy blocked `chrome://extensions` (only HTTP(S) URLs are allowed) and explicitly disallowed alternate browser-command/CDP paths. No policy bypass was attempted. |
| Desktop-off Shelf discovery, real Shelf write, cross-process collision/recovery | NOT VERIFIED | Source inspection informed the proposal; no production host was implemented and no Shelf was read or modified. |
| Reviewer-offline staging and subsequent real import | NOT VERIFIED | No offline receiver exists in the inspected code; no Reviewer was exercised. |
| Installer registration/unregistration and a new-profile install | NOT VERIFIED | No product installer/registration changes were made. |

The temporary test host/profile cleanup is recorded in the implementation handoff. It is not a product acceptance item; do not infer cleanup from the synthetic protocol PASS.
